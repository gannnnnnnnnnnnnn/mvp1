import { assignCategory } from "@/lib/analysis/categories";
import { normalizeParsedTransactions } from "@/lib/analysis/normalize";
import { readCategoryOverrides } from "@/lib/analysis/overridesStore";
import { Category, NormalizedTransaction } from "@/lib/analysis/types";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";
import { matchTransfersV3 } from "@/lib/analysis/transfers/matchTransfersV3";
import { decideTransferEffect } from "@/lib/analysis/transfers/decideTransferEffect";
import { readBoundaryConfig } from "@/lib/boundary/store";
import { findById, readIndex } from "@/lib/fileStore";
import { normalizeAccountMeta, StatementAccountMeta } from "@/lib/parsing/accountMeta";

export type Granularity = "month" | "week";
export type CompareGranularity = "month" | "quarter" | "year";
export type AnalysisScope = "file" | "selected" | "all" | "service";

export type AnalysisOptions = {
  // Existing single-file behavior remains supported.
  fileId?: string;
  // New multi-file support. When provided, analysis loads/filters these files.
  fileIds?: string[];
  // scope=all loads all files in uploads/index.json.
  scope?: AnalysisScope;
  bankId?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
  showTransfers?: "all" | "excludeMatched" | "onlyMatched";
};

export type AppliedFilters = {
  scope: AnalysisScope;
  fileId?: string;
  fileIds?: string[];
  bankId?: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
  showTransfers?: "all" | "excludeMatched" | "onlyMatched";
  // Balance chart stays scoped (file/account) for now; no mixed-file household balance yet.
  balanceScope: "file" | "account" | "none";
};

const DEFAULT_TRANSFER_V3_PARAMS = {
  windowDays: 1,
  minMatched: 0.9,
  minUncertain: 0.65,
} as const;

type TransferV3Row = ReturnType<typeof matchTransfersV3>["rows"][number];

function transferFromV3Row(
  row: TransferV3Row,
  side: "a" | "b",
  boundaryAccountIds: string[]
): NonNullable<NormalizedTransaction["transfer"]> {
  const isOut = side === "a";
  const other = isOut ? row.b : row.a;
  const effect = decideTransferEffect(row, boundaryAccountIds);

  return {
    matchId: row.matchId,
    state: row.state,
    role: isOut ? "out" : "in",
    counterpartyTransactionId: other.transactionId,
    method: "amount_time_window_v2",
    confidence: row.confidence,
    decision: effect.decision,
    kpiEffect: effect.kpiEffect,
    whySentence: effect.whySentence,
    sameFile: effect.sameFile,
    explain: {
      amountCents: row.explain.amountCents,
      dateDiffDays: row.explain.dateDiffDays,
      sameAccount: row.explain.sameAccount,
      descHints: row.explain.descHints,
      penalties: row.explain.penalties,
      score: row.explain.score,
      refId: row.explain.refId,
      accountKeyMatchAtoB: row.explain.accountKeyMatchAtoB,
      accountKeyMatchBtoA: row.explain.accountKeyMatchBtoA,
      nameMatchAtoB: row.explain.nameMatchAtoB,
      nameMatchBtoA: row.explain.nameMatchBtoA,
      payIdMatch: row.explain.payIdMatch,
      evidenceA: row.explain.evidenceA,
      evidenceB: row.explain.evidenceB,
      accountMetaA: row.explain.accountMetaA,
      accountMetaB: row.explain.accountMetaB,
      decision: effect.decision,
      kpiEffect: effect.kpiEffect,
      whySentence: effect.whySentence,
      sameFile: effect.sameFile,
    },
  };
}

function normalizeLegacyTransfer(existing: NormalizedTransaction["transfer"] | null | undefined) {
  if (!existing) return null;
  const normalized = { ...existing };
  if (!normalized.state && normalized.matchId) {
    normalized.state = "matched";
  }
  if (!normalized.decision) {
    normalized.decision = "UNCERTAIN_NO_OFFSET";
  }
  if (!normalized.kpiEffect) {
    normalized.kpiEffect = "INCLUDED";
  }
  if (!normalized.whySentence) {
    normalized.whySentence = "Legacy transfer metadata retained; no boundary offset applied.";
  }
  return normalized;
}

function mergeTransferMetadata(
  existing: NormalizedTransaction["transfer"] | null | undefined,
  candidate: NormalizedTransaction["transfer"] | null | undefined
) {
  const normalizedExisting = normalizeLegacyTransfer(existing);
  if (!normalizedExisting && !candidate) return null;
  if (!normalizedExisting) return candidate || null;
  if (!candidate) return normalizedExisting;

  if (normalizedExisting.method === "amount_time_window_v1") {
    // Backward-compatible deterministic policy:
    // keep v1 transfer unless v2 provides an equal/higher-confidence matched state.
    const shouldUpgrade =
      candidate.state === "matched" && candidate.confidence >= normalizedExisting.confidence;
    return shouldUpgrade ? candidate : normalizedExisting;
  }

  if (candidate.state === "matched" && normalizedExisting.state !== "matched") {
    return candidate;
  }

  return candidate.confidence >= normalizedExisting.confidence ? candidate : normalizedExisting;
}

function annotateTransfersWithV3(
  transactions: NormalizedTransaction[],
  boundaryAccountIds: string[],
  statementAccountMeta: StatementAccountMeta[]
) {
  const v3 = matchTransfersV3({
    transactions,
    boundaryAccountIds,
    statementAccountMeta,
    options: DEFAULT_TRANSFER_V3_PARAMS,
  });
  const candidates = new Map<string, NonNullable<NormalizedTransaction["transfer"]>>();

  for (const row of v3.rows) {
    candidates.set(row.a.transactionId, transferFromV3Row(row, "a", boundaryAccountIds));
    candidates.set(row.b.transactionId, transferFromV3Row(row, "b", boundaryAccountIds));
  }

  return transactions.map((tx) => {
    const candidate = candidates.get(tx.id) || null;
    const transfer = mergeTransferMetadata(tx.transfer, candidate);
    return { ...tx, transfer };
  });
}

function startOfMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonths(date: Date, delta: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta, 1));
}

function startOfQuarter(date: Date) {
  const quarterMonth = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), quarterMonth, 1));
}

function addQuarters(date: Date, delta: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + delta * 3, 1));
}

function startOfYear(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
}

function addYears(date: Date, delta: number) {
  return new Date(Date.UTC(date.getUTCFullYear() + delta, 0, 1));
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

function resolveBalanceScope(params: {
  transactions: NormalizedTransaction[];
  fileId?: string;
  accountId?: string;
  selectedFileCount: number;
  scope: AnalysisScope;
}): AppliedFilters["balanceScope"] {
  if (params.fileId) return "file";
  if (params.selectedFileCount > 1) return "none";
  if (params.scope === "all") return "none";
  if (params.accountId) return "account";

  const accountIds = new Set(params.transactions.map((tx) => tx.accountId));
  if (accountIds.size === 1 && params.selectedFileCount <= 1) return "account";
  return "none";
}

function uniqueStrings(values: Array<string | undefined | null>) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function monthKeyFromDate(dateIso: string) {
  const d = new Date(dateIso);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function quarterKeyFromDate(dateIso: string) {
  const d = new Date(dateIso);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

function buildDatasetCoverage(transactions: NormalizedTransaction[]) {
  if (transactions.length === 0) {
    return {
      datasetDateMin: "",
      datasetDateMax: "",
      availableMonths: [] as string[],
      availableQuarters: [] as string[],
      availableYears: [] as string[],
      bankIds: [] as string[],
      accountIds: [] as string[],
    };
  }

  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const availableMonths = [...new Set(sorted.map((tx) => monthKeyFromDate(tx.date)))].sort();
  const availableQuarters = [...new Set(sorted.map((tx) => quarterKeyFromDate(tx.date)))].sort();
  const availableYears = [...new Set(sorted.map((tx) => tx.date.slice(0, 4)))].sort();
  const bankIds = [...new Set(sorted.map((tx) => tx.bankId))].sort();
  const accountIds = [...new Set(sorted.map((tx) => tx.accountId))].sort();

  return {
    datasetDateMin: sorted[0].date.slice(0, 10),
    datasetDateMax: sorted[sorted.length - 1].date.slice(0, 10),
    availableMonths,
    availableQuarters,
    availableYears,
    bankIds,
    accountIds,
  };
}

function buildAccountDisplayOptions(params: {
  transactions: NormalizedTransaction[];
  statementAccountMeta: StatementAccountMeta[];
}) {
  const byKey = new Map<
    string,
    {
      bankId: string;
      accountId: string;
      accountName?: string;
      accountKey?: string;
    }
  >();

  for (const tx of params.transactions) {
    const key = `${tx.bankId}|${tx.accountId}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        bankId: tx.bankId,
        accountId: tx.accountId,
      });
    }
  }

  for (const meta of params.statementAccountMeta) {
    const key = `${meta.bankId}|${meta.accountId}`;
    const existing = byKey.get(key) || {
      bankId: meta.bankId,
      accountId: meta.accountId,
    };
    byKey.set(key, {
      ...existing,
      accountName: existing.accountName || meta.accountName,
      accountKey: existing.accountKey || meta.accountKey,
    });
  }

  return [...byKey.values()].sort((a, b) => {
    const bankDiff = a.bankId.localeCompare(b.bankId);
    if (bankDiff !== 0) return bankDiff;
    const keyA = `${a.accountName || ""}|${a.accountId}`;
    const keyB = `${b.accountName || ""}|${b.accountId}`;
    return keyA.localeCompare(keyB);
  });
}

function dedupeTransactions(transactions: NormalizedTransaction[]) {
  const dedupedByKey = new Map<string, NormalizedTransaction>();
  for (const tx of transactions) {
    const key = tx.dedupeKey || [tx.accountId, tx.date.slice(0, 10), tx.amount.toFixed(2), tx.descriptionNorm].join("|");
    if (!dedupedByKey.has(key)) {
      dedupedByKey.set(key, tx);
    }
  }
  return [...dedupedByKey.values()];
}

async function resolveTargetFileIds(options: AnalysisOptions) {
  if (options.fileId) return [options.fileId];

  const selected = uniqueStrings(options.fileIds || []);
  if (selected.length > 0) return selected;

  if (options.scope === "all") {
    const all = await readIndex();
    return uniqueStrings(all.map((row) => row.id));
  }

  return [];
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

  const targetFileIds = uniqueStrings([...(options.fileIds || []), options.fileId]);
  const uniqueFileIds = [...new Set(transactions.map((tx) => tx.source.fileId))];
  const uniqueBankIds = [...new Set(transactions.map((tx) => tx.bankId))];
  const uniqueAccountIds = [...new Set(transactions.map((tx) => tx.accountId))];

  const resolvedFileId = options.fileId || (uniqueFileIds.length === 1 ? uniqueFileIds[0] : undefined);
  const resolvedBankId = options.bankId || (uniqueBankIds.length === 1 ? uniqueBankIds[0] : undefined);
  const resolvedAccountId =
    options.accountId || (uniqueAccountIds.length === 1 ? uniqueAccountIds[0] : undefined);

  const showTransfers = params.options.showTransfers || "excludeMatched";
  const filtered = transactions.filter((tx) => {
    if (options.fileId && tx.source.fileId !== options.fileId) return false;
    if (targetFileIds.length > 0 && !targetFileIds.includes(tx.source.fileId)) return false;
    if (options.bankId && tx.bankId !== options.bankId) return false;
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

  const internalOffsetTransfers = filtered.filter(
    (tx) =>
      tx.transfer?.state === "matched" &&
      tx.transfer.role === "out" &&
      tx.transfer.explain?.kpiEffect === "EXCLUDED"
  );
  const boundaryTransfers = filtered.filter(
    (tx) =>
      tx.transfer?.state === "matched" &&
      tx.transfer.role === "out" &&
      tx.transfer.decision === "BOUNDARY_FLOW"
  );
  const uncertainTransfers = filtered.filter(
    (tx) =>
      tx.transfer?.role === "out" &&
      (tx.transfer?.state === "uncertain" ||
        tx.transfer?.decision === "UNCERTAIN_NO_OFFSET")
  );
  const internalOffsetPairsCount = new Set(
    internalOffsetTransfers.map((tx) => tx.transfer?.matchId).filter(Boolean)
  ).size;
  const internalOffsetAbs = internalOffsetTransfers.reduce(
    (sum, tx) => sum + Math.abs(tx.amount),
    0
  );
  const boundaryFlowPairsCount = new Set(
    boundaryTransfers.map((tx) => tx.transfer?.matchId).filter(Boolean)
  ).size;
  const boundaryFlowAbs = boundaryTransfers.reduce(
    (sum, tx) => sum + Math.abs(tx.amount),
    0
  );
  const uncertainPairsCount = new Set(
    uncertainTransfers.map((tx) => tx.transfer?.matchId).filter(Boolean)
  ).size;
  const uncertainAbs = uncertainTransfers.reduce(
    (sum, tx) => sum + Math.abs(tx.amount),
    0
  );

  const transferFiltered = filtered.filter((tx) => {
    if (showTransfers === "all") return true;
    const excluded = tx.transfer?.kpiEffect === "EXCLUDED";
    if (showTransfers === "onlyMatched") return excluded;
    return !excluded;
  });

  const scope: AnalysisScope =
    options.scope || (options.fileId ? "file" : targetFileIds.length > 0 ? "selected" : "service");

  const appliedFilters: AppliedFilters = {
    scope,
    fileId: resolvedFileId,
    fileIds: targetFileIds.length > 0 ? targetFileIds : undefined,
    bankId: resolvedBankId,
    accountId: resolvedAccountId,
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    q: options.q,
    category: options.category,
    granularity: options.granularity,
    showTransfers,
    balanceScope: resolveBalanceScope({
      transactions: transferFiltered,
      fileId: resolvedFileId,
      accountId: resolvedAccountId,
      selectedFileCount: targetFileIds.length,
      scope,
    }),
  };

  return {
    transactions: transferFiltered,
    transferStats: {
      internalOffsetPairsCount,
      internalOffsetAbs,
      boundaryFlowPairsCount,
      boundaryFlowAbs,
      uncertainPairsCount,
      uncertainAbs,
    },
    appliedFilters,
  };
}

export async function loadCategorizedTransactionsForScope(params: AnalysisOptions) {
  const targetFileIds = await resolveTargetFileIds(params);
  if (targetFileIds.length === 0) {
    throw new Error("NO_FILES_SELECTED");
  }

  const overrides = await readCategoryOverrides();
  const allNormalized: NormalizedTransaction[] = [];
  const statementAccountMetaByKey = new Map<string, StatementAccountMeta>();

  const allWarnings: Array<{ rawLine: string; reason: string; confidence: number }> = [];
  const reviewReasonSet = new Set<string>();
  const nonBlockingSet = new Set<string>();
  let headerFoundAll = true;
  let continuityChecked = 0;
  let continuityPassRows = 0;
  let continuityTotalRows = 0;
  let continuitySkipped = 0;
  const continuitySkippedReasons: Record<string, number> = {};

  for (const fileId of targetFileIds) {
    const parsed = await loadParsedTransactions(fileId);
    allWarnings.push(...parsed.warnings);

    for (const reason of parsed.quality.needsReviewReasons || []) reviewReasonSet.add(reason);
    for (const code of parsed.quality.nonBlockingWarnings || []) nonBlockingSet.add(code);

    headerFoundAll = headerFoundAll && parsed.quality.headerFound;
    continuityChecked += parsed.quality.balanceContinuityChecked || 0;
    continuityPassRows +=
      (parsed.quality.balanceContinuityPassRate || 0) *
      (parsed.quality.balanceContinuityChecked || 0);
    continuityTotalRows += parsed.quality.balanceContinuityTotalRows || 0;
    continuitySkipped += parsed.quality.balanceContinuitySkipped || 0;

    for (const [reason, count] of Object.entries(
      parsed.quality.balanceContinuitySkippedReasons || {}
    )) {
      continuitySkippedReasons[reason] = (continuitySkippedReasons[reason] || 0) + count;
    }

    const fileMeta = await findById(fileId);
    const resolvedAccountId = params.accountId || fileMeta?.accountId || parsed.accountId || "default";
    const resolvedBankId = fileMeta?.bankId || parsed.bankId || "cba";
    const resolvedTemplateId =
      fileMeta?.templateId || parsed.templateId || parsed.templateType || "cba_v1";
    const resolvedAccountMeta = normalizeAccountMeta({
      bankId: resolvedBankId,
      accountId: resolvedAccountId,
      templateId: resolvedTemplateId,
      ...(fileMeta?.accountMeta || parsed.accountMeta || {}),
    });
    statementAccountMetaByKey.set(
      `${resolvedAccountMeta.bankId}::${resolvedAccountMeta.accountId}`,
      resolvedAccountMeta
    );

    const normalized = normalizeParsedTransactions({
      fileId,
      accountId: resolvedAccountId,
      bankId: resolvedBankId,
      templateId: resolvedTemplateId,
      fileHash: fileMeta?.contentHash,
      transactions: parsed.transactions,
      warnings: parsed.warnings,
    }).map((tx) => {
      const categoryInfo = assignCategory(tx, overrides);
      return { ...tx, ...categoryInfo };
    });

    allNormalized.push(...normalized);
  }

  const txCountBeforeDedupe = allNormalized.length;
  const dedupedTransactions = dedupeTransactions(allNormalized);
  const knownAccountIds = [...new Set(dedupedTransactions.map((tx) => tx.accountId))];
  const boundary = await readBoundaryConfig(knownAccountIds);
  const annotatedTransactions = annotateTransfersWithV3(
    dedupedTransactions,
    boundary.config.boundaryAccountIds,
    [...statementAccountMetaByKey.values()]
  );
  const dedupedCount = txCountBeforeDedupe - dedupedTransactions.length;
  const datasetCoverage = buildDatasetCoverage(annotatedTransactions);
  const accountDisplayOptions = buildAccountDisplayOptions({
    transactions: annotatedTransactions,
    statementAccountMeta: [...statementAccountMetaByKey.values()],
  });

  const core = runAnalysisCore({
    transactions: annotatedTransactions,
    options: {
      ...params,
      fileIds: targetFileIds,
      // If caller passed one explicit fileId, keep single-file scope semantics.
      scope: params.fileId ? "file" : params.scope || (targetFileIds.length > 1 ? "selected" : "file"),
    },
  });

  const uniqueAccountIds = [...new Set(annotatedTransactions.map((tx) => tx.accountId))];
  const scopedTemplateTypes = new Set(core.transactions.map((tx) => tx.templateId));
  const fallbackTemplateTypes = new Set(annotatedTransactions.map((tx) => tx.templateId));

  return {
    fileId: params.fileId,
    fileIds: targetFileIds,
    filesIncludedCount: targetFileIds.length,
    txCountBeforeDedupe,
    dedupedCount,
    ...datasetCoverage,
    bankId:
      params.bankId ||
      (datasetCoverage.bankIds.length === 1 ? datasetCoverage.bankIds[0] : undefined),
    accountId: params.accountId || (uniqueAccountIds.length === 1 ? uniqueAccountIds[0] : undefined),
    templateType:
      (scopedTemplateTypes.size > 0 ? scopedTemplateTypes.size : fallbackTemplateTypes.size) === 1
        ? [...(scopedTemplateTypes.size > 0 ? scopedTemplateTypes : fallbackTemplateTypes)][0]
        : "mixed",
    warnings: allWarnings,
    quality: {
      headerFound: headerFoundAll,
      balanceContinuityPassRate: continuityChecked > 0 ? continuityPassRows / continuityChecked : 0,
      balanceContinuityChecked: continuityChecked,
      balanceContinuityTotalRows: continuityTotalRows,
      balanceContinuitySkipped: continuitySkipped,
      balanceContinuitySkippedReasons: continuitySkippedReasons,
      needsReviewReasons: [...reviewReasonSet],
      nonBlockingWarnings: [...nonBlockingSet],
    },
    needsReview: reviewReasonSet.size > 0,
    transactions: core.transactions,
    allTransactions: annotatedTransactions,
    statementAccountMeta: [...statementAccountMetaByKey.values()],
    accountDisplayOptions,
    transferStats: core.transferStats,
    appliedFilters: core.appliedFilters,
  };
}

// Backward-compatible single-file entry used by existing routes.
export async function loadCategorizedTransactions(params: {
  fileId: string;
  accountId?: string;
  dateFrom?: string;
  dateTo?: string;
  q?: string;
  category?: Category;
  granularity?: Granularity;
}) {
  return loadCategorizedTransactionsForScope({
    fileId: params.fileId,
    accountId: params.accountId,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    q: params.q,
    category: params.category,
    granularity: params.granularity,
    scope: "file",
  });
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
  const byCategoryMerchant = new Map<string, Map<string, number>>();
  const byCategoryRecent = new Map<
    string,
    Array<{ id: string; date: string; merchantNorm: string; amount: number; descriptionRaw: string }>
  >();
  const byCategoryMonth = new Map<
    string,
    Map<string, { amount: number; transactionIds: string[] }>
  >();
  const byMerchant = new Map<string, { amount: number; transactionIds: string[] }>();
  const byMonthSeries = new Map<
    string,
    { income: number; spend: number; net: number; transactionIds: string[] }
  >();
  const byDaySeries = new Map<
    string,
    { income: number; spend: number; net: number; transactionIds: string[] }
  >();

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

    const monthKey = tx.date.slice(0, 7);
    const monthBucket = byMonthSeries.get(monthKey) || {
      income: 0,
      spend: 0,
      net: 0,
      transactionIds: [],
    };
    if (tx.amount > 0) monthBucket.income += tx.amount;
    if (tx.amount < 0) monthBucket.spend += Math.abs(tx.amount);
    monthBucket.net += tx.amount;
    monthBucket.transactionIds.push(tx.id);
    byMonthSeries.set(monthKey, monthBucket);

    const dayKey = tx.date.slice(0, 10);
    const dayBucket = byDaySeries.get(dayKey) || {
      income: 0,
      spend: 0,
      net: 0,
      transactionIds: [],
    };
    if (tx.amount > 0) dayBucket.income += tx.amount;
    if (tx.amount < 0) dayBucket.spend += Math.abs(tx.amount);
    dayBucket.net += tx.amount;
    dayBucket.transactionIds.push(tx.id);
    byDaySeries.set(dayKey, dayBucket);

    if (tx.amount < 0) {
      const cat = byCategory.get(tx.category) || { amount: 0, transactionIds: [] };
      cat.amount += Math.abs(tx.amount);
      cat.transactionIds.push(tx.id);
      byCategory.set(tx.category, cat);

      const byMerchantForCategory = byCategoryMerchant.get(tx.category) || new Map<string, number>();
      byMerchantForCategory.set(
        tx.merchantNorm,
        (byMerchantForCategory.get(tx.merchantNorm) || 0) + Math.abs(tx.amount)
      );
      byCategoryMerchant.set(tx.category, byMerchantForCategory);

      const recents = byCategoryRecent.get(tx.category) || [];
      recents.push({
        id: tx.id,
        date: tx.date.slice(0, 10),
        merchantNorm: tx.merchantNorm,
        amount: Math.abs(tx.amount),
        descriptionRaw: tx.descriptionRaw,
      });
      byCategoryRecent.set(tx.category, recents);

      const monthKey = tx.date.slice(0, 7);
      const byMonth = byCategoryMonth.get(tx.category) || new Map<
        string,
        { amount: number; transactionIds: string[] }
      >();
      const monthBucket = byMonth.get(monthKey) || { amount: 0, transactionIds: [] };
      monthBucket.amount += Math.abs(tx.amount);
      monthBucket.transactionIds.push(tx.id);
      byMonth.set(monthKey, monthBucket);
      byCategoryMonth.set(tx.category, byMonth);

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
  const datasetMonthlySeries = [...byMonthSeries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, value]) => ({ month, ...value }));
  const monthDailySeries = [...byDaySeries.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, ...value }));

  const spendByCategory = [...byCategory.entries()]
    .map(([category, value]) => {
      const merchantMap = byCategoryMerchant.get(category) || new Map<string, number>();
      const topMerchants = [...merchantMap.entries()]
        .map(([merchantNorm, amount]) => ({ merchantNorm, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 3);
      const recentTransactions = [...(byCategoryRecent.get(category) || [])]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5);
      return {
        category,
        amount: value.amount,
        share: totals.spend > 0 ? value.amount / totals.spend : 0,
        transactionIds: value.transactionIds,
        topMerchants,
        recentTransactions,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const categoryTrendMonthly = [...byCategoryMonth.entries()]
    .map(([category, monthMap]) => ({
      category,
      points: [...monthMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([period, value]) => ({
          period,
          amount: value.amount,
          transactionIds: value.transactionIds,
        })),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));

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
    datasetMonthlySeries,
    monthDailySeries,
    spendByCategory,
    categoryTrendMonthly,
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
  const byMerchant = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.amount < 0) {
      byCategory.set(tx.category, (byCategory.get(tx.category) || 0) + Math.abs(tx.amount));
      byMerchant.set(tx.merchantNorm, (byMerchant.get(tx.merchantNorm) || 0) + Math.abs(tx.amount));
    }
  }

  return {
    income,
    spend,
    net,
    transactionIds: transactions.map((tx) => tx.id),
    categories: [...byCategory.entries()].map(([category, amount]) => ({ category, amount })),
    merchants: [...byMerchant.entries()].map(([merchantNorm, amount]) => ({ merchantNorm, amount })),
  };
}

function buildDeltaRows(current: ReturnType<typeof summarizePeriod>, previous: ReturnType<typeof summarizePeriod>) {
  const byCategoryCurrent = new Map(current.categories.map((row) => [row.category, row.amount]));
  const byCategoryPrevious = new Map(previous.categories.map((row) => [row.category, row.amount]));
  const allCategories = new Set([...byCategoryCurrent.keys(), ...byCategoryPrevious.keys()]);

  const categoryDeltas = [...allCategories]
    .map((category) => {
      const currentAmount = byCategoryCurrent.get(category) || 0;
      const previousAmount = byCategoryPrevious.get(category) || 0;
      return {
        category,
        current: currentAmount,
        previous: previousAmount,
        delta: currentAmount - previousAmount,
        percent: previousAmount === 0 ? 0 : (currentAmount - previousAmount) / previousAmount,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const byMerchantCurrent = new Map(current.merchants.map((row) => [row.merchantNorm, row.amount]));
  const byMerchantPrevious = new Map(previous.merchants.map((row) => [row.merchantNorm, row.amount]));
  const allMerchants = new Set([...byMerchantCurrent.keys(), ...byMerchantPrevious.keys()]);

  const merchantDeltas = [...allMerchants]
    .map((merchantNorm) => {
      const currentAmount = byMerchantCurrent.get(merchantNorm) || 0;
      const previousAmount = byMerchantPrevious.get(merchantNorm) || 0;
      return {
        merchantNorm,
        current: currentAmount,
        previous: previousAmount,
        delta: currentAmount - previousAmount,
        percent: previousAmount === 0 ? 0 : (currentAmount - previousAmount) / previousAmount,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  return { categoryDeltas, merchantDeltas };
}

export function buildExplicitPeriodComparison(params: {
  transactions: NormalizedTransaction[];
  periodAStart: string;
  periodAEnd: string;
  periodBStart: string;
  periodBEnd: string;
}) {
  const { transactions, periodAStart, periodAEnd, periodBStart, periodBEnd } = params;
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));

  const periodA = sorted.filter((tx) => between(tx.date, periodAStart, periodAEnd));
  const periodB = sorted.filter((tx) => between(tx.date, periodBStart, periodBEnd));

  const totalsA = summarizePeriod(periodA);
  const totalsB = summarizePeriod(periodB);

  const delta = (a: number, b: number) => ({
    amount: a - b,
    percent: b === 0 ? 0 : (a - b) / b,
  });

  const { categoryDeltas, merchantDeltas } = buildDeltaRows(totalsA, totalsB);

  return {
    periodA: { start: periodAStart, end: periodAEnd },
    periodB: { start: periodBStart, end: periodBEnd },
    totalsA: totalsA,
    totalsB: totalsB,
    delta: {
      income: delta(totalsA.income, totalsB.income),
      spend: delta(totalsA.spend, totalsB.spend),
      net: delta(totalsA.net, totalsB.net),
    },
    categoryBreakdownA: totalsA.categories,
    categoryBreakdownB: totalsB.categories,
    categoryDeltas,
    merchantDeltas,
  };
}

function resolvePeriodWindow(lastDate: Date, granularity: CompareGranularity) {
  if (granularity === "year") {
    const currentStart = startOfYear(lastDate);
    const currentEnd = addYears(currentStart, 1);
    const previousStart = addYears(currentStart, -1);
    return { currentStart, currentEnd, previousStart };
  }

  if (granularity === "quarter") {
    const currentStart = startOfQuarter(lastDate);
    const currentEnd = addQuarters(currentStart, 1);
    const previousStart = addQuarters(currentStart, -1);
    return { currentStart, currentEnd, previousStart };
  }

  const currentStart = startOfMonth(lastDate);
  const currentEnd = addMonths(currentStart, 1);
  const previousStart = addMonths(currentStart, -1);
  return { currentStart, currentEnd, previousStart };
}

export function buildPeriodComparison(params: {
  transactions: NormalizedTransaction[];
  granularity: CompareGranularity;
}) {
  const { transactions, granularity } = params;
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
      merchantDeltas: [],
    };
  }

  const lastDate = new Date(sorted[sorted.length - 1].date);
  const { currentStart, currentEnd, previousStart } = resolvePeriodWindow(lastDate, granularity);

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
  const { categoryDeltas, merchantDeltas } = buildDeltaRows(current, previous);

  const delta = (cur: number, prev: number) => ({
    amount: cur - prev,
    percent: prev === 0 ? 0 : (cur - prev) / prev,
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
    merchantDeltas,
  };
}

// Backward compatibility export name for callers still importing old helper.
export function buildMonthComparison(transactions: NormalizedTransaction[]) {
  return buildPeriodComparison({ transactions, granularity: "month" });
}
