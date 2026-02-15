import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";

type RerunRequest = {
  force?: boolean;
};

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const DEV_RUNS_DIR = path.join(process.cwd(), "uploads", "dev-runs");

function sanitizeDirSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function severityFromReason(reason: string) {
  const upper = reason.toUpperCase();
  if (
    upper.includes("UNKNOWN") ||
    upper.includes("MISMATCH") ||
    upper.includes("LOW") ||
    upper.includes("FAIL")
  ) {
    return "high" as const;
  }
  if (
    upper.includes("MISSING") ||
    upper.includes("UNCERTAIN") ||
    upper.includes("OUTLIER")
  ) {
    return "medium" as const;
  }
  return "low" as const;
}

function groupWarnings(
  warnings: Array<{ rawLine: string; reason: string; confidence: number }>
) {
  const grouped: Record<
    "high" | "medium" | "low",
    Array<{ reason: string; count: number; samples: string[] }>
  > = {
    high: [],
    medium: [],
    low: [],
  };

  const cache = new Map<
    string,
    { severity: "high" | "medium" | "low"; reason: string; count: number; samples: string[] }
  >();
  for (const warning of warnings) {
    const severity = severityFromReason(warning.reason);
    const key = `${severity}:${warning.reason}`;
    const row =
      cache.get(key) || {
        severity,
        reason: warning.reason,
        count: 0,
        samples: [],
      };
    row.count += 1;
    if (row.samples.length < 3 && warning.rawLine) {
      row.samples.push(warning.rawLine.slice(0, 160));
    }
    cache.set(key, row);
  }

  for (const row of cache.values()) {
    grouped[row.severity].push({
      reason: row.reason,
      count: row.count,
      samples: row.samples,
    });
  }

  for (const severity of ["high", "medium", "low"] as const) {
    grouped[severity].sort((a, b) => b.count - a.count);
  }

  return grouped;
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveByHashOrLegacyId(
  fileHash: string,
  entries: Awaited<ReturnType<typeof readIndex>>
) {
  return entries.find(
    (entry) => entry.contentHash === fileHash || `id:${entry.id}` === fileHash
  );
}

async function ensureTextCache(fileId: string, request: Request, force: boolean) {
  const textPath = path.join(TEXT_CACHE_DIR, `${fileId}.txt`);
  if (!force && (await fileExists(textPath))) {
    return;
  }

  const origin = new URL(request.url).origin;
  const textRes = await fetch(`${origin}/api/parse/pdf-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, force }),
  });

  const textData = (await textRes.json()) as
    | { ok: true }
    | { ok: false; error?: { message?: string } };

  if (!textRes.ok || !textData.ok) {
    throw new Error(textData.ok ? "PDF text parse failed." : textData.error?.message || "PDF text parse failed.");
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ fileHash: string }> }
) {
  const rejected = rejectIfProdApi();
  if (rejected) return rejected;

  const { fileHash } = await params;
  if (!fileHash) {
    return NextResponse.json(
      { ok: false, error: { code: "BAD_REQUEST", message: "fileHash is required." } },
      { status: 400 }
    );
  }

  let body: RerunRequest = {};
  try {
    const raw = (await request.json()) as RerunRequest;
    body = raw || {};
  } catch {
    // Optional body; keep defaults when not provided.
  }

  const force = body.force === true;

  try {
    const entries = await readIndex();
    const indexEntry = resolveByHashOrLegacyId(fileHash, entries);
    if (!indexEntry) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "File not found in index." } },
        { status: 404 }
      );
    }

    await ensureTextCache(indexEntry.id, request, force);

    const parsed = await loadParsedTransactions(indexEntry.id);
    const analysis = await loadCategorizedTransactionsForScope({
      fileId: indexEntry.id,
      scope: "file",
      bankId: indexEntry.bankId,
      accountId: indexEntry.accountId,
    });

    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const fileHashDir = sanitizeDirSegment(indexEntry.contentHash || `id:${indexEntry.id}`);
    const runDir = path.join(DEV_RUNS_DIR, fileHashDir, runId);

    await fs.mkdir(runDir, { recursive: true });

    const output = {
      ok: true,
      runId,
      fileHash: indexEntry.contentHash || `id:${indexEntry.id}`,
      fileId: indexEntry.id,
      generatedAt: new Date().toISOString(),
      debug: {
        templateType: analysis.templateType,
        continuity: analysis.quality.balanceContinuityPassRate,
        checked: analysis.quality.balanceContinuityChecked,
        dedupedCount: analysis.dedupedCount,
        warningCount: analysis.warnings.length,
        needsReview: analysis.needsReview,
        needsReviewReasons: analysis.quality.needsReviewReasons,
      },
      parsed,
      transactionsSample: analysis.transactions.slice(0, 50),
      warningsGrouped: groupWarnings(analysis.warnings),
      warningsSample: analysis.warnings.slice(0, 50),
    };

    await fs.writeFile(
      path.join(runDir, "rerun-output.json"),
      JSON.stringify(output, null, 2),
      "utf8"
    );

    return NextResponse.json({
      ok: true,
      runId,
      runPath: path.join("uploads", "dev-runs", fileHashDir, runId),
      debug: output.debug,
      sampleTransactions: output.transactionsSample,
      warningsGrouped: output.warningsGrouped,
      warningsSample: output.warningsSample,
    });
  } catch (err) {
    console.error("/api/dev/file/[fileHash]/rerun failed", err);
    return NextResponse.json(
      {
        ok: false,
        error: { code: "IO_FAIL", message: "Failed to rerun parse in dev mode." },
      },
      { status: 500 }
    );
  }
}
