import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import {
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
    value === "UNCERTAIN_NO_OFFSET"
  ) {
    return value;
  }
  return "all";
}

export type DecoratedInspectorRow = TransferV3Result["rows"][number] & {
  decision: "INTERNAL_OFFSET" | "BOUNDARY_FLOW" | "UNCERTAIN_NO_OFFSET";
  kpiEffect: "EXCLUDED" | "INCLUDED";
  sameFile: boolean;
  whySentence: string;
};

export type DecoratedInspectorResult = Omit<TransferV3Result, "rows"> & {
  rows: DecoratedInspectorRow[];
  decisionStats: {
    internalOffsetPairs: number;
    boundaryTransferPairs: number;
    uncertainPairs: number;
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
      decision: effect.decision,
      kpiEffect: effect.kpiEffect,
      sameFile: effect.sameFile,
      whySentence: effect.whySentence,
    };
  });

  const rows = accountId
    ? decoratedRows.filter(
        (row) => row.a.accountId === accountId || row.b.accountId === accountId
      )
    : decoratedRows;

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

  const penaltyCounter = new Map<string, number>();
  const hintCounter = new Map<string, number>();
  for (const row of rows) {
    for (const penalty of row.explain.penalties || []) {
      penaltyCounter.set(penalty, (penaltyCounter.get(penalty) || 0) + 1);
    }
    for (const hint of row.explain.descHints || []) {
      hintCounter.set(hint, (hintCounter.get(hint) || 0) + 1);
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

  const decoratedResult: DecoratedInspectorResult = {
    ...result,
    rows,
    collisions,
    stats: {
      ...result.stats,
      matchedPairs: internal.length,
      uncertainPairs: uncertain.length,
      excludedFromKpiCount: internal.length * 2,
      excludedFromKpiAmountAbs: internal.reduce(
        (sum, row) => sum + Math.abs(row.amountCents / 100) * 2,
        0
      ),
      topPenalties,
      topHints,
      ambiguousBuckets: collisions.length,
    },
    decisionStats: {
      internalOffsetPairs: internal.length,
      boundaryTransferPairs: boundaryTransfers.length,
      uncertainPairs: uncertain.length,
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
    if ((state === "matched" || state === "uncertain") && row.state !== state) {
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
