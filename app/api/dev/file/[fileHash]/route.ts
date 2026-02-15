import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const SEGMENT_CACHE_DIR = path.join(process.cwd(), "uploads", "segment-cache");
const PARSED_CACHE_DIR = path.join(process.cwd(), "uploads", "parsed-cache");
const DEV_RUNS_DIR = path.join(process.cwd(), "uploads", "dev-runs");
const MAX_TRANSACTIONS = 300;
const MAX_PARSED_LINES = 2000;

type WarningGroupedItem = {
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

function mapWarningSeverity(severityRaw: string | undefined, reason: string) {
  if (!severityRaw) return severityFromReason(reason);
  const normalized = severityRaw.toLowerCase();
  if (normalized === "critical" || normalized === "high") return "high" as const;
  if (normalized === "warning" || normalized === "medium") return "medium" as const;
  return "low" as const;
}

function buildGroupedWarnings(rows: DevWarningRow[]) {
  const grouped: Record<"high" | "medium" | "low", WarningGroupedItem[]> = {
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

function resolveByHashOrLegacyId(fileHash: string, entries: Awaited<ReturnType<typeof readIndex>>) {
  return entries.find(
    (entry) => entry.contentHash === fileHash || `id:${entry.id}` === fileHash
  );
}

async function readLatestDevRun(fileHash: string) {
  const dir = path.join(DEV_RUNS_DIR, sanitizeDirSegment(fileHash));
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const sorted = entries.sort((a, b) => b.localeCompare(a));
  for (const runId of sorted) {
    const filePath = path.join(dir, runId, "rerun-output.json");
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return { runId, filePath, payload: parsed };
    } catch {
      // Skip malformed run output and continue.
    }
  }

  return null;
}

function normalizeRaw(rawLine?: string, fallbackLines?: string[]) {
  if (rawLine && rawLine.trim()) return rawLine;
  if (Array.isArray(fallbackLines) && fallbackLines.length > 0) {
    return fallbackLines.join("\n");
  }
  return "";
}

function normalizeDevRunTransactions(items: unknown[]) {
  return items.slice(0, MAX_TRANSACTIONS).map((item, idx) => {
    const tx = (item || {}) as Record<string, unknown>;
    const amount = Number(tx.amount || 0);
    const rawLines = Array.isArray(tx.rawLines)
      ? tx.rawLines.map((line) => String(line || ""))
      : [];
    const rawLine = normalizeRaw(
      typeof tx.rawLine === "string" ? tx.rawLine : undefined,
      rawLines
    );
    const sourceObj =
      typeof tx.source === "object" && tx.source !== null
        ? (tx.source as Record<string, unknown>)
        : {};
    const lineIndex =
      Number(sourceObj.lineIndex || sourceObj.rowIndex || 0) || undefined;

    return {
      tableIndex: idx + 1,
      id: tx.id ? String(tx.id) : undefined,
      date: String(tx.date || "").slice(0, 10),
      description: String(tx.description || tx.descriptionRaw || ""),
      debit:
        typeof tx.debit === "number"
          ? tx.debit
          : amount < 0
            ? Math.abs(amount)
            : undefined,
      credit:
        typeof tx.credit === "number"
          ? tx.credit
          : amount > 0
            ? Math.abs(amount)
            : undefined,
      balance:
        typeof tx.balance === "number" && Number.isFinite(tx.balance)
          ? (tx.balance as number)
          : undefined,
      amount,
      direction: amount >= 0 ? "credit" : "debit",
      confidence: typeof tx.confidence === "number" ? tx.confidence : undefined,
      source: {
        fileId: sourceObj.fileId ? String(sourceObj.fileId) : undefined,
        fileHash: sourceObj.fileHash ? String(sourceObj.fileHash) : undefined,
        rowIndex: lineIndex,
        lineIndex,
      },
      rawLine,
      rawLines: rawLines.length > 0 ? rawLines : rawLine ? rawLine.split("\n") : [],
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
      rawLines: rawLine ? rawLine.split("\n") : [],
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

function normalizeDevRunWarnings(items: unknown[], transactions: DevTxRow[]) {
  const rows = items.map((item, idx) => {
    const warning = (item || {}) as Record<string, unknown>;
    const reason = String(warning.reason || warning.code || "UNKNOWN_WARNING");
    const lineIndex = Number(warning.lineIndex || 0) || undefined;

    return {
      warningIndex: idx,
      reason,
      message: warning.message ? String(warning.message) : reason,
      severity: mapWarningSeverity(
        typeof warning.severity === "string" ? warning.severity : undefined,
        reason
      ),
      confidence:
        typeof warning.confidence === "number" ? warning.confidence : undefined,
      rawLine: typeof warning.rawLine === "string" ? warning.rawLine : undefined,
      lineIndex,
      txnIndex:
        typeof warning.txnIndex === "number" ? warning.txnIndex : undefined,
    } satisfies DevWarningRow;
  });

  return linkWarningsToTransactions(rows, transactions);
}

function normalizeMainStoreWarnings(
  warnings: Array<{ rawLine: string; reason: string; confidence: number }>,
  transactions: DevTxRow[]
) {
  const rows = warnings.map((warning, idx) => ({
    warningIndex: idx,
    reason: warning.reason,
    message: warning.reason,
    severity: severityFromReason(warning.reason),
    confidence: warning.confidence,
    rawLine: warning.rawLine,
    lineIndex: undefined,
  }));

  return linkWarningsToTransactions(rows, transactions);
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

    const normalizedFileHash = indexEntry.contentHash || `id:${indexEntry.id}`;
    const textPath = path.join(TEXT_CACHE_DIR, `${indexEntry.id}.txt`);
    const segmentPath = path.join(SEGMENT_CACHE_DIR, `${indexEntry.id}.json`);
    const parsedPath = path.join(PARSED_CACHE_DIR, `${indexEntry.id}.json`);

    const fullText = await fs.readFile(textPath, "utf8").catch(() => "");
    const textPreview = fullText.slice(0, 2000);
    const parsedLinesFromText = buildParsedLines(fullText);
    const sectionTextPreview = await readSegmentPreview(indexEntry.id);

    const latestDevRun = await readLatestDevRun(normalizedFileHash);
    if (latestDevRun) {
      const payload = latestDevRun.payload as Record<string, unknown>;
      const payloadTransactions = Array.isArray(payload.transactions)
        ? payload.transactions
        : Array.isArray(payload.sampleTransactions)
          ? payload.sampleTransactions
          : [];
      const transactions = normalizeDevRunTransactions(payloadTransactions);
      const payloadWarnings = Array.isArray(payload.warnings)
        ? payload.warnings
        : Array.isArray(payload.warningsSample)
          ? payload.warningsSample
          : [];
      const warnings = normalizeDevRunWarnings(payloadWarnings, transactions);

      const debugRaw =
        typeof payload.debug === "object" && payload.debug !== null
          ? (payload.debug as Record<string, unknown>)
          : {};
      const detectedRaw =
        typeof payload.detected === "object" && payload.detected !== null
          ? (payload.detected as Record<string, unknown>)
          : {};
      const rawArtifacts =
        typeof payload.rawArtifacts === "object" && payload.rawArtifacts !== null
          ? (payload.rawArtifacts as Record<string, unknown>)
          : {};

      const parsedLines = Array.isArray(rawArtifacts.parsedLines)
        ? rawArtifacts.parsedLines
            .slice(0, MAX_PARSED_LINES)
            .map((item) => ({
              lineIndex: Number((item as Record<string, unknown>).lineIndex || 0),
              text: String((item as Record<string, unknown>).text || ""),
            }))
        : parsedLinesFromText;

      return NextResponse.json({
        ok: true,
        source: "devRun",
        devRun: {
          runId: latestDevRun.runId,
          path: latestDevRun.filePath,
        },
        indexEntry: {
          ...indexEntry,
          fileHash: normalizedFileHash,
          bankId:
            String(detectedRaw.bankId || indexEntry.bankId || "unknown") || "unknown",
          accountId:
            String(payload.accountId || indexEntry.accountId || "default") || "default",
          templateId:
            String(detectedRaw.templateId || indexEntry.templateId || "unknown") ||
            "unknown",
          coverage:
            typeof payload.coverage === "object" && payload.coverage !== null
              ? payload.coverage
              : null,
        },
        debug: {
          ...debugRaw,
          templateType:
            String(
              debugRaw.templateType || detectedRaw.templateId || indexEntry.templateId || "unknown"
            ) || "unknown",
          bankId: String(debugRaw.bankId || detectedRaw.bankId || indexEntry.bankId || "unknown"),
          accountId: String(debugRaw.accountId || payload.accountId || indexEntry.accountId || "default"),
          mode: String(debugRaw.mode || detectedRaw.mode || "unknown"),
          confidence:
            typeof debugRaw.confidence === "number"
              ? debugRaw.confidence
              : Number(detectedRaw.confidence || 0),
          continuity: Number(debugRaw.continuity || 0),
          checked: Number(debugRaw.checked || 0),
          dedupedCount: Number(debugRaw.dedupedCount || 0),
          warningCount: warnings.length,
          needsReview: Boolean(debugRaw.needsReview),
          needsReviewReasons: Array.isArray(debugRaw.needsReviewReasons)
            ? debugRaw.needsReviewReasons
            : [],
          evidence: Array.isArray(detectedRaw.evidence) ? detectedRaw.evidence : [],
        },
        transactions,
        warnings,
        warningsGrouped: buildGroupedWarnings(warnings),
        warningsSample: warnings.slice(0, 50),
        artifacts: {
          hasText: await fileExists(textPath),
          hasSegment: await fileExists(segmentPath),
          hasParsed: await fileExists(parsedPath),
          hasDevRun: true,
        },
        rawArtifacts: {
          textPreview:
            typeof rawArtifacts.textPreview === "string"
              ? rawArtifacts.textPreview
              : textPreview,
          sectionTextPreview:
            typeof rawArtifacts.sectionTextPreview === "string"
              ? rawArtifacts.sectionTextPreview
              : sectionTextPreview,
          parsedLines,
        },
      });
    }

    const analysis = await loadCategorizedTransactionsForScope({
      fileId: indexEntry.id,
      scope: "file",
      accountId: indexEntry.accountId,
    });
    const transactions = normalizeMainStoreTransactions(
      analysis.transactions as Array<Record<string, unknown>>
    );
    const warnings = normalizeMainStoreWarnings(analysis.warnings, transactions);

    return NextResponse.json({
      ok: true,
      source: "mainStore",
      indexEntry: {
        ...indexEntry,
        fileHash: normalizedFileHash,
      },
      debug: {
        templateType: analysis.templateType,
        bankId: indexEntry.bankId || "cba",
        accountId: indexEntry.accountId || "default",
        continuity: analysis.quality.balanceContinuityPassRate,
        checked: analysis.quality.balanceContinuityChecked,
        dedupedCount: analysis.dedupedCount,
        warningCount: warnings.length,
        needsReview: analysis.needsReview,
        needsReviewReasons: analysis.quality.needsReviewReasons,
      },
      transactions,
      warnings,
      warningsGrouped: buildGroupedWarnings(warnings),
      warningsSample: warnings.slice(0, 50),
      artifacts: {
        hasText: await fileExists(textPath),
        hasSegment: await fileExists(segmentPath),
        hasParsed: await fileExists(parsedPath),
        hasDevRun: false,
      },
      rawArtifacts: {
        textPreview,
        sectionTextPreview,
        parsedLines: parsedLinesFromText,
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
