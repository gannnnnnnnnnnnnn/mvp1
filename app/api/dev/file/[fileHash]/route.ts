import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const SEGMENT_CACHE_DIR = path.join(process.cwd(), "uploads", "segment-cache");
const PARSED_CACHE_DIR = path.join(process.cwd(), "uploads", "parsed-cache");

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

function resolveByHashOrLegacyId(fileHash: string, entries: Awaited<ReturnType<typeof readIndex>>) {
  return entries.find(
    (entry) => entry.contentHash === fileHash || `id:${entry.id}` === fileHash
  );
}

export async function GET(
  _request: Request,
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

  try {
    const entries = await readIndex();
    const indexEntry = resolveByHashOrLegacyId(fileHash, entries);
    if (!indexEntry) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "File not found in index." } },
        { status: 404 }
      );
    }

    const analysis = await loadCategorizedTransactionsForScope({
      fileId: indexEntry.id,
      scope: "file",
      accountId: indexEntry.accountId,
    });

    const textPath = path.join(TEXT_CACHE_DIR, `${indexEntry.id}.txt`);
    const segmentPath = path.join(SEGMENT_CACHE_DIR, `${indexEntry.id}.json`);
    const parsedPath = path.join(PARSED_CACHE_DIR, `${indexEntry.id}.json`);

    const textPreview = (await fs.readFile(textPath, "utf8").catch(() => "")).slice(0, 2000);

    return NextResponse.json({
      ok: true,
      indexEntry: {
        ...indexEntry,
        fileHash: indexEntry.contentHash || `id:${indexEntry.id}`,
      },
      debug: {
        templateType: analysis.templateType,
        continuity: analysis.quality.balanceContinuityPassRate,
        checked: analysis.quality.balanceContinuityChecked,
        dedupedCount: analysis.dedupedCount,
        warningCount: analysis.warnings.length,
        needsReview: analysis.needsReview,
        needsReviewReasons: analysis.quality.needsReviewReasons,
      },
      transactions: analysis.transactions.slice(0, 50),
      warningsGrouped: groupWarnings(analysis.warnings),
      warningsSample: analysis.warnings.slice(0, 50),
      artifacts: {
        hasText: await fileExists(textPath),
        hasSegment: await fileExists(segmentPath),
        hasParsed: await fileExists(parsedPath),
      },
      rawArtifacts: {
        textPreview,
      },
    });
  } catch (err) {
    console.error("/api/dev/file/[fileHash] failed", err);
    return NextResponse.json(
      { ok: false, error: { code: "IO_FAIL", message: "Failed to build file inspector." } },
      { status: 500 }
    );
  }
}
