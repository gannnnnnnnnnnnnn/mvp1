import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import {
  TransferV3IgnoredReason,
  TransferV3Params,
  TransferV3Result,
  matchTransfersV3,
} from "@/lib/analysis/transfers/matchTransfersV3";
import { decideTransferEffect } from "@/lib/analysis/transfers/decideTransferEffect";
import { readBoundaryConfig } from "@/lib/boundary/store";

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseNumber(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseInspectorParams(searchParams: URLSearchParams): TransferV3Params {
  return {
    windowDays: Math.trunc(clamp(parseNumber(searchParams.get("windowDays"), 1), 0, 7)),
    minMatched: clamp(parseNumber(searchParams.get("minMatched"), 0.85), 0, 1),
    minUncertain: clamp(parseNumber(searchParams.get("minUncertain"), 0.6), 0, 1),
  };
}

function parseSameFileFilter(raw: string | null) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "yes" || value === "true" || value === "1") return "yes";
  if (value === "no" || value === "false" || value === "0") return "no";
  return "all";
}

function parseDecisionFilter(raw: string | null) {
  const value = String(raw || "").trim().toUpperCase();
  if (
    value === "INTERNAL_OFFSET" ||
    value === "BOUNDARY_FLOW" ||
    value === "UNCERTAIN_NO_OFFSET" ||
    value === "IGNORED"
  ) {
    return value;
  }
  return "all";
}

type TransferMatchRow = TransferV3Result["rows"][number];

export type DecoratedInspectorRow = Omit<TransferMatchRow, "state"> & {
  transferState: "matched" | "uncertain" | "ignored";
  state?: "matched" | "uncertain";
  decision: "INTERNAL_OFFSET" | "BOUNDARY_FLOW" | "UNCERTAIN_NO_OFFSET" | "IGNORED";
  kpiEffect: "EXCLUDED" | "INCLUDED";
  sameFile: boolean;
  whySentence: string;
  ignoredReason?: TransferV3IgnoredReason;
};

export type DecoratedInspectorResult = Omit<TransferV3Result, "rows"> & {
  rows: DecoratedInspectorRow[];
  decisionStats: {
    internalOffsetPairs: number;
    boundaryTransferPairs: number;
    uncertainPairs: number;
  };
  diagnostics: {
    scoredMatchedPairs: number;
    scoredUncertainPairs: number;
    missingIdentityClosurePairs: number;
  };
};

export async function runTransferInspector(searchParams: URLSearchParams) {
  const bankId = (searchParams.get("bankId") || "").trim() || undefined;
  const accountId = (searchParams.get("accountId") || "").trim() || undefined;
  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;
  const params = parseInspectorParams(searchParams);

  const loaded = await loadCategorizedTransactionsForScope({
    scope: "all",
    bankId,
    accountId: undefined,
    dateFrom,
    dateTo,
    showTransfers: "all",
  });

  const { config } = await readBoundaryConfig(loaded.accountIds || []);
  const source = loaded.allTransactions.map((tx) => ({ ...tx, transfer: null }));
  const result = matchTransfersV3({
    transactions: source,
    boundaryAccountIds: config.boundaryAccountIds,
    statementAccountMeta: loaded.statementAccountMeta || [],
    accountAliases: config.accountAliases || {},
    options: params,
  });

  const decoratedRows: DecoratedInspectorRow[] = result.rows.map((row) => {
    const effect = decideTransferEffect(row, config.boundaryAccountIds);
    return {
      ...row,
      transferState: row.state,
      state: row.state,
      decision: effect.decision,
      kpiEffect: effect.kpiEffect,
      sameFile: effect.sameFile,
      whySentence: effect.whySentence,
    };
  });

  const ignoredRows: DecoratedInspectorRow[] = result.ignoredRows.map((row) => {
    const sameFile =
      Boolean(row.a.source.fileHash) &&
      Boolean(row.b.source.fileHash) &&
      row.a.source.fileHash === row.b.source.fileHash;
    const reasonSentenceMap: Record<TransferV3IgnoredReason, string> = {
      SAME_ACCOUNT: "Ignored: both sides are the same account.",
      SAME_FILE: "Ignored: both sides come from the same source file.",
      DATE_OUT_OF_WINDOW: "Ignored: date gap is outside matching window.",
      REF_ID_MISMATCH: "Ignored: transfer reference id does not match.",
      CREDIT_ALREADY_MATCHED: "Ignored: candidate credit side already used by another pair.",
      LOW_CONFIDENCE: "Ignored: score is below uncertain threshold.",
      SELF_TX: "Ignored: same transaction id on both sides.",
      MISSING_SOURCE: "Ignored: missing source file identity for at least one side.",
    };
    return {
      ...row,
      matchId: row.ignoredId,
      transferState: "ignored",
      state: undefined,
      decision: "IGNORED",
      kpiEffect: "INCLUDED",
      sameFile,
      whySentence: reasonSentenceMap[row.ignoredReason] || `Ignored: ${row.ignoredReason}.`,
      ignoredReason: row.ignoredReason,
    };
  });

  const allRows = [...decoratedRows, ...ignoredRows];

  const rows = accountId
    ? allRows.filter(
        (row) => row.a.accountId === accountId || row.b.accountId === accountId
      )
    : allRows;

  const rowTxIds = new Set<string>();
  for (const row of rows) {
    rowTxIds.add(row.a.transactionId);
    rowTxIds.add(row.b.transactionId);
  }

  const collisions = accountId
    ? result.collisions.filter((bucket) => bucket.txIds.some((id) => rowTxIds.has(id)))
    : result.collisions;

  const internal = rows.filter((row) => row.decision === "INTERNAL_OFFSET");
  const boundaryTransfers = rows.filter((row) => row.decision === "BOUNDARY_FLOW");
  const uncertain = rows.filter((row) => row.decision === "UNCERTAIN_NO_OFFSET");
  const ignored = rows.filter((row) => row.decision === "IGNORED");
  const scoredMatchedPairs = rows.filter((row) => row.transferState === "matched").length;
  const scoredUncertainPairs = rows.filter((row) => row.transferState === "uncertain").length;
  const missingIdentityClosurePairs = rows.filter(
    (row) =>
      !row.explain.accountKeyMatchAtoB &&
      !row.explain.accountKeyMatchBtoA &&
      !row.explain.nameMatchAtoB &&
      !row.explain.nameMatchBtoA &&
      !row.explain.payIdMatch
  ).length;

  const penaltyCounter = new Map<string, number>();
  const hintCounter = new Map<string, number>();
  const ignoredReasonCounter = new Map<TransferV3IgnoredReason, number>();
  for (const row of rows) {
    for (const penalty of row.explain.penalties || []) {
      penaltyCounter.set(penalty, (penaltyCounter.get(penalty) || 0) + 1);
    }
    for (const hint of row.explain.descHints || []) {
      hintCounter.set(hint, (hintCounter.get(hint) || 0) + 1);
    }
    if (row.ignoredReason) {
      ignoredReasonCounter.set(
        row.ignoredReason,
        (ignoredReasonCounter.get(row.ignoredReason) || 0) + 1
      );
    }
  }

  const topPenalties = [...penaltyCounter.entries()]
    .map(([penalty, count]) => ({ penalty, count }))
    .sort((a, b) => b.count - a.count || a.penalty.localeCompare(b.penalty))
    .slice(0, 10);

  const topHints = [...hintCounter.entries()]
    .map(([hint, count]) => ({ hint, count }))
    .sort((a, b) => b.count - a.count || a.hint.localeCompare(b.hint))
    .slice(0, 10);

  const topIgnoredReasons = [...ignoredReasonCounter.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);

  const decoratedResult: DecoratedInspectorResult = {
    ...result,
    rows,
    collisions,
    stats: {
      ...result.stats,
      matchedPairs: internal.length,
      uncertainPairs: uncertain.length,
      ignoredPairsCount: ignored.length,
      excludedFromKpiCount: internal.length * 2,
      excludedFromKpiAmountAbs: internal.reduce(
        (sum, row) => sum + Math.abs(row.amountCents / 100) * 2,
        0
      ),
      topPenalties,
      topHints,
      topIgnoredReasons,
      ambiguousBuckets: collisions.length,
    },
    decisionStats: {
      internalOffsetPairs: internal.length,
      boundaryTransferPairs: boundaryTransfers.length,
      uncertainPairs: uncertain.length,
    },
    diagnostics: {
      scoredMatchedPairs,
      scoredUncertainPairs,
      missingIdentityClosurePairs,
    },
  };

  return {
    scope: { bankId, accountId, dateFrom, dateTo },
    params,
    boundary: {
      mode: config.mode,
      boundaryAccountIds: config.boundaryAccountIds,
      lastUpdatedAt: config.lastUpdatedAt,
    },
    loaded,
    result: decoratedResult,
  };
}

export function filterInspectorRows(
  result: DecoratedInspectorResult,
  searchParams: URLSearchParams
) {
  const state = (searchParams.get("state") || "all").trim();
  const q = (searchParams.get("q") || "").trim().toUpperCase();
  const amountRaw = (searchParams.get("amountCents") || "").trim();
  const amountCents = amountRaw ? Number(amountRaw) : NaN;
  const decision = parseDecisionFilter(searchParams.get("decision"));
  const sameFile = parseSameFileFilter(searchParams.get("sameFile"));
  const limit = Math.trunc(clamp(parseNumber(searchParams.get("limit"), 200), 1, 2000));

  const rows = result.rows.filter((row) => {
    if (
      (state === "matched" || state === "uncertain") &&
      row.transferState !== state
    ) {
      return false;
    }
    if (Number.isFinite(amountCents) && row.amountCents !== amountCents) {
      return false;
    }
    if (decision !== "all" && row.decision !== decision) {
      return false;
    }
    if (sameFile === "yes" && !row.sameFile) {
      return false;
    }
    if (sameFile === "no" && row.sameFile) {
      return false;
    }
    if (q) {
      const haystack = [
        row.matchId,
        row.a.description,
        row.b.description,
        row.a.transactionId,
        row.b.transactionId,
      ]
        .join(" ")
        .toUpperCase();
      if (!haystack.includes(q)) {
        return false;
      }
    }
    return true;
  });

  return rows.slice(0, limit);
}
