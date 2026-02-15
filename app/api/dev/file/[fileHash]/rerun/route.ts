import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";
import { detectDevTemplate } from "@/lib/templates/registry";
import { DevTemplateWarning } from "@/lib/templates/types";
import { anzTemplateV1 } from "@/lib/templates/anz_v1";

type RerunRequest = {
  force?: boolean;
  runLegacyCommBankParser?: boolean;
};

type LegacyWarning = { rawLine: string; reason: string; confidence: number };

type WarningGroup = {
  reason: string;
  count: number;
  samples: string[];
};

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const SEGMENT_CACHE_DIR = path.join(process.cwd(), "uploads", "segment-cache");
const PARSED_CACHE_DIR = path.join(process.cwd(), "uploads", "parsed-cache");
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

function severityFromTemplateWarning(warning: DevTemplateWarning) {
  if (warning.severity === "critical") return "high" as const;
  if (warning.severity === "warning") return "medium" as const;
  return "low" as const;
}

function buildGroupedWarnings(
  rows: Array<{ severity: "high" | "medium" | "low"; reason: string; sample?: string }>
) {
  const grouped: Record<"high" | "medium" | "low", WarningGroup[]> = {
    high: [],
    medium: [],
    low: [],
  };

  const cache = new Map<
    string,
    { severity: "high" | "medium" | "low"; reason: string; count: number; samples: string[] }
  >();

  for (const row of rows) {
    const key = `${row.severity}:${row.reason}`;
    const existing =
      cache.get(key) || {
        severity: row.severity,
        reason: row.reason,
        count: 0,
        samples: [],
      };
    existing.count += 1;
    if (row.sample && existing.samples.length < 3) {
      existing.samples.push(row.sample.slice(0, 160));
    }
    cache.set(key, existing);
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

function groupLegacyWarnings(warnings: LegacyWarning[]) {
  return buildGroupedWarnings(
    warnings.map((warning) => ({
      severity: severityFromReason(warning.reason),
      reason: warning.reason,
      sample: warning.rawLine,
    }))
  );
}

function groupTemplateWarnings(warnings: DevTemplateWarning[]) {
  return buildGroupedWarnings(
    warnings.map((warning) => ({
      severity: severityFromTemplateWarning(warning),
      reason: warning.code,
      sample: warning.rawLine,
    }))
  );
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
    throw new Error(
      textData.ok ? "PDF text parse failed." : textData.error?.message || "PDF text parse failed."
    );
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
  const runLegacyCommBankParser = body.runLegacyCommBankParser === true;

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

    const textPath = path.join(TEXT_CACHE_DIR, `${indexEntry.id}.txt`);
    const text = await fs.readFile(textPath, "utf8");
    const textPreview = text.slice(0, 2000);

    const detected = detectDevTemplate(text);
    const isLikelyAnzFile =
      /\banz\b/i.test(indexEntry.originalName || "") ||
      /ACCOUNT STATEMENT/i.test(text) ||
      /BRANCH NUMBER \(BSB\)/i.test(text);

    let debug: Record<string, unknown>;
    let sampleTransactions: Array<Record<string, unknown>> = [];
    let warningsGrouped: ReturnType<typeof groupLegacyWarnings>;
    let warningsSample: Array<Record<string, unknown>> = [];
    let coverage: { startDate?: string; endDate?: string } | undefined;
    let parsedMeta: Record<string, unknown> | undefined;
    let detectedOut = detected.detection;

    if (detected.template || isLikelyAnzFile) {
      const selectedTemplate = detected.template || anzTemplateV1;
      const selectedDetection = selectedTemplate.detect(text);
      const parsed = selectedTemplate.parse({
        fileId: indexEntry.id,
        fileHash: indexEntry.contentHash,
        fileName: indexEntry.originalName,
        text,
      });

      sampleTransactions = parsed.transactions.slice(0, 50) as Array<Record<string, unknown>>;
      warningsGrouped = groupTemplateWarnings(parsed.warnings);
      warningsSample = parsed.warnings.slice(0, 50).map((item) => ({
        reason: item.code,
        message: item.message,
        severity: item.severity,
        rawLine: item.rawLine,
        confidence: item.confidence,
      }));
      coverage = parsed.coverage;

      const criticalReasons = parsed.warnings
        .filter((item) => item.severity === "critical")
        .map((item) => item.code);
      const continuityFail =
        parsed.debug.checkedCount >= 5 && parsed.debug.continuityRatio < 0.995;

      debug = {
        templateType: parsed.templateId,
        bankId: parsed.bankId,
        accountId: parsed.accountId,
        mode: parsed.mode,
        confidence: selectedDetection.confidence,
        continuity: parsed.debug.continuityRatio,
        checked: parsed.debug.checkedCount,
        dedupedCount: 0,
        warningCount: parsed.warnings.length,
        needsReview: criticalReasons.length > 0 || continuityFail,
        needsReviewReasons: [...new Set(criticalReasons)],
      };

      parsedMeta = {
        bankId: parsed.bankId,
        accountId: parsed.accountId,
        templateId: parsed.templateId,
        mode: parsed.mode,
        detection: selectedDetection,
      };
      detectedOut = {
        ...selectedDetection,
        matched: true,
      };
    } else {
      if (!runLegacyCommBankParser) {
        const unknownWarnings: DevTemplateWarning[] = [
          {
            code: "TEMPLATE_NOT_DETECTED",
            message:
              "No matching dev template was detected. Enable legacy CommBank parser fallback if needed.",
            severity: "warning",
            confidence: detected.detection.confidence,
          },
        ];
        warningsGrouped = groupTemplateWarnings(unknownWarnings);
        warningsSample = unknownWarnings.map((item) => ({
          reason: item.code,
          message: item.message,
          severity: item.severity,
          confidence: item.confidence,
        }));
        debug = {
          templateType: "unknown",
          bankId: "unknown",
          accountId: indexEntry.accountId || "default",
          mode: "unknown",
          confidence: detected.detection.confidence,
          continuity: 0,
          checked: 0,
          dedupedCount: 0,
          warningCount: unknownWarnings.length,
          needsReview: true,
          needsReviewReasons: ["TEMPLATE_NOT_DETECTED"],
        };
        parsedMeta = {
          detection: detected.detection,
          legacyFallbackUsed: false,
        };
      } else {
      const parsed = await loadParsedTransactions(indexEntry.id);
      const analysis = await loadCategorizedTransactionsForScope({
        fileId: indexEntry.id,
        scope: "file",
        accountId: indexEntry.accountId,
      });

      sampleTransactions = analysis.transactions.slice(0, 50);
      warningsGrouped = groupLegacyWarnings(analysis.warnings);
      warningsSample = analysis.warnings.slice(0, 50);

      debug = {
        templateType: analysis.templateType,
        bankId: indexEntry.bankId || "cba",
        accountId: indexEntry.accountId || "default",
        mode: "legacy",
        confidence: 1,
        continuity: analysis.quality.balanceContinuityPassRate,
        checked: analysis.quality.balanceContinuityChecked,
        dedupedCount: analysis.dedupedCount,
        warningCount: analysis.warnings.length,
        needsReview: analysis.needsReview,
        needsReviewReasons: analysis.quality.needsReviewReasons,
      };

      parsedMeta = {
        parsed,
        legacyFallbackUsed: true,
      };
      detectedOut = {
        ...detected.detection,
        matched: false,
      };
      }
    }

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
      detected: {
        matched: detectedOut.matched,
        bankId: detectedOut.bankId,
        templateId: detectedOut.templateId,
        mode: detectedOut.mode,
        confidence: detectedOut.confidence,
        evidence: detectedOut.evidence,
      },
      accountId: (debug.accountId as string) || indexEntry.accountId || "default",
      coverage,
      debug,
      sampleTransactions,
      warningsGrouped,
      warningsSample,
      rawArtifacts: {
        textPreview,
      },
      artifacts: {
        hasText: true,
        hasSegment: await fileExists(path.join(SEGMENT_CACHE_DIR, `${indexEntry.id}.json`)),
        hasParsed: await fileExists(path.join(PARSED_CACHE_DIR, `${indexEntry.id}.json`)),
      },
      parsedMeta,
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
      detected: output.detected,
      accountId: output.accountId,
      coverage: output.coverage,
      debug: output.debug,
      sampleTransactions: output.sampleTransactions,
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
