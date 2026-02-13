import { assignCategory } from "@/lib/analysis/categories";
import { normalizeParsedTransactions } from "@/lib/analysis/normalize";
import { readCategoryOverrides } from "@/lib/analysis/overridesStore";
import { Category, NormalizedTransaction } from "@/lib/analysis/types";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";
import { findById } from "@/lib/fileStore";

export type Granularity = "month" | "week";

export type AnalysisOptions = {
  // Optional: routes can still pass fileId only for current behavior.
  fileId?: string;
  // Future-ready account scope. Current fallback is fileId when metadata has no accountId.
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
};

export type AppliedFilters = {
  scope: "file" | "service";
  fileId?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
  // Balance chart stays scoped (file/account) for now; no household merged balance yet.
  balanceScope: "file" | "account" | "none";
};

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, delta: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

function periodKey(dateIso: string, granularity: Granularity) {
  const d = new Date(dateIso);
  if (granularity === "month") {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  // ISO-like week bucket for lightweight analysis.
  const day = d.getUTCDay() || 7;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - day + 1);
  return `${monday.getUTCFullYear()}-W${String(Math.ceil(monday.getUTCDate() / 7)).padStart(2, "0")}`;
}

function between(dateIso: string, dateFrom?: string, dateTo?: string) {
  const value = new Date(dateIso).getTime();
  if (dateFrom) {
    const from = new Date(dateFrom).getTime();
    if (value < from) return false;
  }
  if (dateTo) {
    const to = new Date(dateTo).getTime();
    if (value > to) return false;
  }
  return true;
}

function resolveBalanceScope(
  transactions: NormalizedTransaction[],
  filters: Pick<AppliedFilters, "fileId" | "accountId">
): AppliedFilters["balanceScope"] {
  if (filters.fileId) return "file";
  if (filters.accountId) return "account";

  const accountIds = new Set(transactions.map((tx) => tx.accountId));
  if (accountIds.size === 1) return "account";
  return "none";
}

/**
 * Service-level core: apply filters over any normalized transaction list.
 * This is future-proof for multi-file / multi-account aggregation.
 */
export function runAnalysisCore(params: {
  transactions: NormalizedTransaction[];
  options: AnalysisOptions;
}) {
  const { transactions, options } = params;

  const uniqueFileIds = [...new Set(transactions.map((tx) => tx.source.fileId))];
  const uniqueAccountIds = [...new Set(transactions.map((tx) => tx.accountId))];

  const resolvedFileId = options.fileId || (uniqueFileIds.length === 1 ? uniqueFileIds[0] : undefined);
  const resolvedAccountId =
    options.accountId || (uniqueAccountIds.length === 1 ? uniqueAccountIds[0] : undefined);

  const filtered = transactions.filter((tx) => {
    if (options.fileId && tx.source.fileId !== options.fileId) return false;
    if (options.accountId && tx.accountId !== options.accountId) return false;
    if (!between(tx.date, options.dateFrom, options.dateTo)) return false;
    if (options.category && tx.category !== options.category) return false;

    if (options.q) {
      const q = options.q.toUpperCase();
      const hit =
        tx.descriptionRaw.toUpperCase().includes(q) ||
        tx.merchantNorm.toUpperCase().includes(q) ||
        tx.category.toUpperCase().includes(q);
      if (!hit) return false;
    }

    return true;
  });

  const appliedFilters: AppliedFilters = {
    scope: options.fileId ? "file" : "service",
    fileId: resolvedFileId,
    accountId: resolvedAccountId,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    q: options.q,
    category: options.category,
    granularity: options.granularity,
    balanceScope: resolveBalanceScope(filtered, {
      fileId: resolvedFileId,
      accountId: resolvedAccountId,
    }),
  };

  return {
    transactions: filtered,
    appliedFilters,
  };
}

export async function loadCategorizedTransactions(params: {
  fileId: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
}) {
  const parsed = await loadParsedTransactions(params.fileId);
  const overrides = await readCategoryOverrides();

  const fileMeta = await findById(params.fileId);
  const resolvedAccountId = params.accountId || fileMeta?.accountId || params.fileId;

  const normalized = normalizeParsedTransactions({
    fileId: params.fileId,
    accountId: resolvedAccountId,
    transactions: parsed.transactions,
    warnings: parsed.warnings,
  }).map((tx) => {
    const categoryInfo = assignCategory(tx, overrides);
    return { ...tx, ...categoryInfo };
  });

  const core = runAnalysisCore({
    transactions: normalized,
    options: {
      fileId: params.fileId,
      accountId: resolvedAccountId,
      dateFrom: params.dateFrom,
      dateTo: params.dateTo,
      q: params.q,
      category: params.category,
      granularity: params.granularity,
    },
  });

  return {
    ...parsed,
    accountId: resolvedAccountId,
    transactions: core.transactions,
    allTransactions: normalized,
    appliedFilters: core.appliedFilters,
  };
}

export function buildOverview(params: {
  transactions: NormalizedTransaction[];
  granularity: Granularity;
  appliedFilters?: AppliedFilters;
}) {
  const { transactions, granularity, appliedFilters } = params;
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  const byPeriod = new Map<
    string,
    {
      income: number;
      spend: number;
      net: number;
      transactionIds: string[];
    }
  >();

  const byCategory = new Map<string, { amount: number; transactionIds: string[] }>();
  const byMerchant = new Map<string, { amount: number; transactionIds: string[] }>();

  for (const tx of sorted) {
    const key = periodKey(tx.date, granularity);
    const current = byPeriod.get(key) || {
      income: 0,
      spend: 0,
      net: 0,
      transactionIds: [],
    };

    if (tx.amount > 0) current.income += tx.amount;
    if (tx.amount < 0) current.spend += Math.abs(tx.amount);
    current.net += tx.amount;
    current.transactionIds.push(tx.id);
    byPeriod.set(key, current);

    if (tx.amount < 0) {
      const cat = byCategory.get(tx.category) || { amount: 0, transactionIds: [] };
      cat.amount += Math.abs(tx.amount);
      cat.transactionIds.push(tx.id);
      byCategory.set(tx.category, cat);

      const merchant = byMerchant.get(tx.merchantNorm) || { amount: 0, transactionIds: [] };
      merchant.amount += Math.abs(tx.amount);
      merchant.transactionIds.push(tx.id);
      byMerchant.set(tx.merchantNorm, merchant);
    }
  }

  const totals = {
    income: sorted.filter((tx) => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0),
    spend: sorted
      .filter((tx) => tx.amount < 0)
      .reduce((sum, tx) => sum + Math.abs(tx.amount), 0),
    net: sorted.reduce((sum, tx) => sum + tx.amount, 0),
  };

  const periods = [...byPeriod.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([period, value]) => ({ period, ...value }));

  const spendByCategory = [...byCategory.entries()]
    .map(([category, value]) => ({
      category,
      amount: value.amount,
      share: totals.spend > 0 ? value.amount / totals.spend : 0,
      transactionIds: value.transactionIds,
    }))
    .sort((a, b) => b.amount - a.amount);

  const topMerchants = [...byMerchant.entries()]
    .map(([merchantNorm, value]) => ({
      merchantNorm,
      amount: value.amount,
      transactionIds: value.transactionIds,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10);

  // Keep balance series explicitly scoped. Do not merge cross-account balances.
  let balanceInput = sorted;
  if (appliedFilters?.balanceScope === "file" && appliedFilters.fileId) {
    balanceInput = sorted.filter((tx) => tx.source.fileId === appliedFilters.fileId);
  } else if (appliedFilters?.balanceScope === "account" && appliedFilters.accountId) {
    balanceInput = sorted.filter((tx) => tx.accountId === appliedFilters.accountId);
  } else if ((appliedFilters?.balanceScope || "none") === "none") {
    balanceInput = [];
  }

  const byDate = new Map<
    string,
    { date: string; balance: number; transactionId: string; accountId: string; fileId: string }
  >();
  for (const tx of balanceInput) {
    if (typeof tx.balance !== "number") continue;
    const dateKey = tx.date.slice(0, 10);
    byDate.set(dateKey, {
      date: dateKey,
      balance: tx.balance,
      transactionId: tx.id,
      accountId: tx.accountId,
      fileId: tx.source.fileId,
    });
  }

  const balanceSeries = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    totals,
    periods,
    spendByCategory,
    topMerchants,
    balanceSeries,
  };
}

function summarizePeriod(transactions: NormalizedTransaction[]) {
  const income = transactions.filter((tx) => tx.amount > 0).reduce((s, tx) => s + tx.amount, 0);
  const spend = transactions
    .filter((tx) => tx.amount < 0)
    .reduce((s, tx) => s + Math.abs(tx.amount), 0);
  const net = transactions.reduce((s, tx) => s + tx.amount, 0);

  const byCategory = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.amount >= 0) continue;
    byCategory.set(tx.category, (byCategory.get(tx.category) || 0) + Math.abs(tx.amount));
  }

  return {
    income,
    spend,
    net,
    transactionIds: transactions.map((tx) => tx.id),
    categories: [...byCategory.entries()].map(([category, amount]) => ({ category, amount })),
  };
}

export function buildMonthComparison(transactions: NormalizedTransaction[]) {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length === 0) {
    return {
      current: summarizePeriod([]),
      previous: summarizePeriod([]),
      deltas: {
        income: { amount: 0, percent: 0 },
        spend: { amount: 0, percent: 0 },
        net: { amount: 0, percent: 0 },
      },
      categoryDeltas: [],
    };
  }

  const lastDate = new Date(sorted[sorted.length - 1].date);
  const currentStart = startOfMonth(lastDate);
  const currentEnd = addMonths(currentStart, 1);
  const previousStart = addMonths(currentStart, -1);

  const currentPeriod = sorted.filter((tx) => {
    const t = new Date(tx.date).getTime();
    return t >= currentStart.getTime() && t < currentEnd.getTime();
  });
  const previousPeriod = sorted.filter((tx) => {
    const t = new Date(tx.date).getTime();
    return t >= previousStart.getTime() && t < currentStart.getTime();
  });

  const current = summarizePeriod(currentPeriod);
  const previous = summarizePeriod(previousPeriod);

  const delta = (cur: number, prev: number) => ({
    amount: cur - prev,
    percent: prev === 0 ? 0 : (cur - prev) / prev,
  });

  const byCategoryCurrent = new Map(current.categories.map((row) => [row.category, row.amount]));
  const byCategoryPrevious = new Map(previous.categories.map((row) => [row.category, row.amount]));
  const allCategories = new Set([...byCategoryCurrent.keys(), ...byCategoryPrevious.keys()]);

  const categoryDeltas = [...allCategories].map((category) => {
    const currentAmount = byCategoryCurrent.get(category) || 0;
    const previousAmount = byCategoryPrevious.get(category) || 0;
    return {
      category,
      current: currentAmount,
      previous: previousAmount,
      delta: currentAmount - previousAmount,
      percent: previousAmount === 0 ? 0 : (currentAmount - previousAmount) / previousAmount,
    };
  });

  return {
    current,
    previous,
    deltas: {
      income: delta(current.income, previous.income),
      spend: delta(current.spend, previous.spend),
      net: delta(current.net, previous.net),
    },
    categoryDeltas,
  };
}
