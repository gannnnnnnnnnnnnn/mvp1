import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import {
  TransferInspectorParams,
  matchTransfersV2,
  TransferInspectorResult,
} from "@/lib/analysis/transfers/matchTransfersV2";

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseNumber(raw: string | null, fallback: number) {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseInspectorParams(searchParams: URLSearchParams): TransferInspectorParams {
  return {
    windowDays: Math.trunc(clamp(parseNumber(searchParams.get("windowDays"), 1), 0, 7)),
    minMatched: clamp(parseNumber(searchParams.get("minMatched"), 0.85), 0, 1),
    minUncertain: clamp(parseNumber(searchParams.get("minUncertain"), 0.6), 0, 1),
  };
}

export async function runTransferInspector(searchParams: URLSearchParams) {
  const bankId = (searchParams.get("bankId") || "").trim() || undefined;
  const accountId = (searchParams.get("accountId") || "").trim() || undefined;
  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;
  const params = parseInspectorParams(searchParams);

  const loaded = await loadCategorizedTransactionsForScope({
    scope: "all",
    bankId,
    accountId,
    dateFrom,
    dateTo,
    showTransfers: "all",
  });

  const source = loaded.allTransactions.map((tx) => ({ ...tx, transfer: null }));
  const result = matchTransfersV2(source, params);

  return {
    scope: { bankId, accountId, dateFrom, dateTo },
    params,
    loaded,
    result,
  };
}

export function filterInspectorRows(
  result: TransferInspectorResult,
  searchParams: URLSearchParams
) {
  const state = (searchParams.get("state") || "all").trim();
  const q = (searchParams.get("q") || "").trim().toUpperCase();
  const amountRaw = (searchParams.get("amountCents") || "").trim();
  const amountCents = amountRaw ? Number(amountRaw) : NaN;
  const limit = Math.trunc(clamp(parseNumber(searchParams.get("limit"), 200), 1, 2000));

  const rows = result.rows.filter((row) => {
    if ((state === "matched" || state === "uncertain") && row.state !== state) {
      return false;
    }
    if (Number.isFinite(amountCents) && row.amountCents !== amountCents) {
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
