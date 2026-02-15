import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";
import { detectDevTemplate } from "@/lib/templates/registry";
import {
  DevTemplateTransaction,
  DevTemplateWarning,
} from "@/lib/templates/types";
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

type DevTxRow = {
  tableIndex: number;
  id?: string;
  date: string;
  description: string;
  debit?: number;
  credit?: number;
  balance?: number;
  amount: number;
  direction: "debit" | "credit";
  confidence?: number;
  source: {
    fileId?: string;
    fileHash?: string;
    rowIndex?: number;
    lineIndex?: number;
  };
  rawLine: string;
  rawLines: string[];
};

type DevWarningRow = {
  warningIndex: number;
  reason: string;
  message?: string;
  severity: "high" | "medium" | "low";
  confidence?: number;
  rawLine?: string;
  lineIndex?: number;
  txnIndex?: number;
};

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const SEGMENT_CACHE_DIR = path.join(process.cwd(), "uploads", "segment-cache");
const PARSED_CACHE_DIR = path.join(process.cwd(), "uploads", "parsed-cache");
const DEV_RUNS_DIR = path.join(process.cwd(), "uploads", "dev-runs");
const MAX_TRANSACTIONS = 300;
const MAX_PARSED_LINES = 2000;

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

function buildGroupedWarnings(rows: DevWarningRow[]) {
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
    if (row.rawLine && existing.samples.length < 3) {
      existing.samples.push(row.rawLine.slice(0, 160));
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

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readSegmentPreview(fileId: string) {
  const segmentPath = path.join(SEGMENT_CACHE_DIR, `${fileId}.json`);
  try {
    const raw = await fs.readFile(segmentPath, "utf8");
    const parsed = JSON.parse(raw) as { sectionText?: string };
    return (parsed.sectionText || "").slice(0, 4000);
  } catch {
    return "";
  }
}

function buildParsedLines(text: string, maxLines = MAX_PARSED_LINES) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .slice(0, maxLines)
    .map((line, idx) => ({ lineIndex: idx + 1, text: line }));
}

function resolveByHashOrLegacyId(
  fileHash: string,
  entries: Awaited<ReturnType<typeof readIndex>>
) {
  return entries.find(
    (entry) => entry.contentHash === fileHash || `id:${entry.id}` === fileHash
  );
}

function normalizeRaw(rawLine?: string, fallbackLines?: string[]) {
  if (rawLine && rawLine.trim()) return rawLine;
  if (Array.isArray(fallbackLines) && fallbackLines.length > 0) {
    return fallbackLines.join("\n");
  }
  return "";
}

function normalizeTemplateTransactions(transactions: DevTemplateTransaction[]) {
  return transactions.slice(0, MAX_TRANSACTIONS).map((tx, idx) => {
    const debit =
      typeof tx.debit === "number"
        ? tx.debit
        : tx.amount < 0
          ? Math.abs(tx.amount)
          : undefined;
    const credit =
      typeof tx.credit === "number"
        ? tx.credit
        : tx.amount > 0
          ? Math.abs(tx.amount)
          : undefined;
    const rawLine = normalizeRaw(tx.rawLine, tx.rawLines);
    const rawLines = Array.isArray(tx.rawLines)
      ? tx.rawLines
      : rawLine
        ? rawLine.split("\n")
        : [];

    return {
      tableIndex: idx + 1,
      id: tx.id,
      date: String(tx.date || "").slice(0, 10),
      description: tx.descriptionRaw || "",
      debit,
      credit,
      balance: typeof tx.balance === "number" ? tx.balance : undefined,
      amount: tx.amount,
      direction: tx.amount >= 0 ? "credit" : "debit",
      confidence: tx.confidence,
      source: {
        fileId: tx.source?.fileId,
        fileHash: tx.source?.fileHash,
        rowIndex: tx.source?.rowIndex,
        lineIndex: tx.source?.rowIndex,
      },
      rawLine,
      rawLines,
    } satisfies DevTxRow;
  });
}

function normalizeMainStoreTransactions(transactions: Array<Record<string, unknown>>) {
  return transactions.slice(0, MAX_TRANSACTIONS).map((tx, idx) => {
    const amount = Number(tx.amount || 0);
    const rawLine =
      typeof tx.quality === "object" && tx.quality !== null
        ? String((tx.quality as { rawLine?: string }).rawLine || "")
        : String((tx.rawLine as string) || "");
    const lineIndex =
      typeof tx.source === "object" && tx.source !== null
        ? Number((tx.source as { lineIndex?: number }).lineIndex || 0) || undefined
        : undefined;
    const rawLines = rawLine ? rawLine.split("\n") : [];

    return {
      tableIndex: idx + 1,
      id: String(tx.id || ""),
      date: String(tx.date || "").slice(0, 10),
      description: String(tx.descriptionRaw || tx.description || ""),
      debit: amount < 0 ? Math.abs(amount) : undefined,
      credit: amount > 0 ? Math.abs(amount) : undefined,
      balance:
        typeof tx.balance === "number" && Number.isFinite(tx.balance)
          ? (tx.balance as number)
          : undefined,
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      confidence:
        typeof tx.quality === "object" && tx.quality !== null
          ? (tx.quality as { confidence?: number }).confidence
          : undefined,
      source: {
        fileId:
          typeof tx.source === "object" && tx.source !== null
            ? ((tx.source as { fileId?: string }).fileId || undefined)
            : undefined,
        fileHash: undefined,
        rowIndex: lineIndex,
        lineIndex,
      },
      rawLine,
      rawLines,
    } satisfies DevTxRow;
  });
}

function fuzzyNormalize(value: string) {
  return value
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 .#_-]/g, "")
    .trim();
}

function linkWarningsToTransactions(
  warnings: DevWarningRow[],
  transactions: DevTxRow[]
) {
  return warnings.map((warning, warningIndex) => {
    let txnIndex: number | undefined;
    let lineIndex = warning.lineIndex;

    if (typeof lineIndex === "number") {
      const byLine = transactions.findIndex(
        (tx) =>
          tx.source.lineIndex === lineIndex || tx.source.rowIndex === lineIndex
      );
      if (byLine >= 0) txnIndex = byLine;
    }

    if (txnIndex === undefined && warning.rawLine) {
      const needle = fuzzyNormalize(warning.rawLine);
      if (needle) {
        const byRaw = transactions.findIndex((tx) => {
          const hay = fuzzyNormalize(tx.rawLine || tx.description || "");
          return hay.includes(needle) || needle.includes(hay);
        });
        if (byRaw >= 0) {
          txnIndex = byRaw;
          lineIndex =
            transactions[byRaw].source.lineIndex || transactions[byRaw].source.rowIndex;
        }
      }
    }

    return {
      ...warning,
      warningIndex,
      txnIndex,
      lineIndex,
    };
  });
}

function normalizeTemplateWarnings(warnings: DevTemplateWarning[], transactions: DevTxRow[]) {
  const normalized = warnings.map((warning, idx) => ({
    warningIndex: idx,
    reason: warning.code,
    message: warning.message,
    severity: severityFromTemplateWarning(warning),
    confidence: warning.confidence,
    rawLine: warning.rawLine,
    lineIndex: warning.lineIndex,
  }));
  return linkWarningsToTransactions(normalized, transactions);
}

function normalizeLegacyWarnings(warnings: LegacyWarning[], transactions: DevTxRow[]) {
  const normalized = warnings.map((warning, idx) => ({
    warningIndex: idx,
    reason: warning.reason,
    message: warning.reason,
    severity: severityFromReason(warning.reason),
    confidence: warning.confidence,
    rawLine: warning.rawLine,
    lineIndex: undefined,
  }));
  return linkWarningsToTransactions(normalized, transactions);
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
    const parsedLines = buildParsedLines(text);
    const sectionTextPreview = await readSegmentPreview(indexEntry.id);

    const detected = detectDevTemplate(text);
    const isLikelyAnzFile =
      /\banz\b/i.test(indexEntry.originalName || "") ||
      /ACCOUNT STATEMENT/i.test(text) ||
      /BRANCH NUMBER \(BSB\)/i.test(text);

    let debug: Record<string, unknown>;
    let transactions: DevTxRow[] = [];
    let warnings: DevWarningRow[] = [];
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

      transactions = normalizeTemplateTransactions(parsed.transactions);
      warnings = normalizeTemplateWarnings(parsed.warnings, transactions);
      coverage = parsed.coverage;

      const criticalReasons = warnings
        .filter((item) => item.severity === "high")
        .map((item) => item.reason);
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
        warningCount: warnings.length,
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

        warnings = normalizeTemplateWarnings(unknownWarnings, transactions);
        debug = {
          templateType: "unknown",
          bankId: "unknown",
          accountId: indexEntry.accountId || "default",
          mode: "unknown",
          confidence: detected.detection.confidence,
          continuity: 0,
          checked: 0,
          dedupedCount: 0,
          warningCount: warnings.length,
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

        transactions = normalizeMainStoreTransactions(
          analysis.transactions as Array<Record<string, unknown>>
        );
        warnings = normalizeLegacyWarnings(analysis.warnings, transactions);

        debug = {
          templateType: analysis.templateType,
          bankId: indexEntry.bankId || "cba",
          accountId: indexEntry.accountId || "default",
          mode: "legacy",
          confidence: 1,
          continuity: analysis.quality.balanceContinuityPassRate,
          checked: analysis.quality.balanceContinuityChecked,
          dedupedCount: analysis.dedupedCount,
          warningCount: warnings.length,
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

    const warningsGrouped = buildGroupedWarnings(warnings);

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
      transactions,
      warnings,
      warningsGrouped,
      sampleTransactions: transactions.slice(0, 50),
      warningsSample: warnings.slice(0, 50),
      rawArtifacts: {
        textPreview,
        sectionTextPreview,
        parsedLines,
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
      transactions: output.transactions,
      warnings: output.warnings,
      warningsGrouped: output.warningsGrouped,
      sampleTransactions: output.sampleTransactions,
      warningsSample: output.warningsSample,
      rawArtifacts: output.rawArtifacts,
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
