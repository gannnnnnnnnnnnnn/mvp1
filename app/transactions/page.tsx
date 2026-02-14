"use client";

import { useEffect, useMemo, useState } from "react";

type FileMeta = {
  id: string;
  originalName: string;
};

type ApiError = { code: string; message: string };

type Category =
  | "Groceries"
  | "Dining"
  | "Transport"
  | "Shopping"
  | "Bills&Utilities"
  | "Rent/Mortgage"
  | "Health"
  | "Entertainment"
  | "Travel"
  | "Income"
  | "Transfers"
  | "Fees/Interest/Bank"
  | "Other";

type TxRow = {
  id: string;
  accountId: string;
  date: string;
  descriptionRaw: string;
  descriptionNorm: string;
  merchantNorm: string;
  amount: number;
  balance?: number;
  category: Category;
  categorySource: "rule" | "manual" | "default";
  categoryRuleId?: string;
  quality: {
    confidence: number;
    warnings: string[];
    rawLine: string;
  };
  source: {
    lineIndex: number;
    fileId: string;
  };
};

type TransactionsResponse = {
  ok: true;
  fileId?: string;
  fileIds?: string[];
  filesIncludedCount?: number;
  txCountBeforeDedupe?: number;
  dedupedCount?: number;
  accountId?: string;
  templateType: string;
  needsReview: boolean;
  quality?: {
    headerFound: boolean;
    balanceContinuityPassRate: number;
    balanceContinuityChecked: number;
    balanceContinuityTotalRows?: number;
    balanceContinuitySkipped?: number;
    balanceContinuitySkippedReasons?: Record<string, number>;
    needsReviewReasons: string[];
  };
  appliedFilters?: {
    scope?: string;
    fileId?: string;
    fileIds?: string[];
    accountId?: string;
    dateFrom?: string;
    dateTo?: string;
    q?: string;
    category?: string;
    balanceScope?: "file" | "account" | "none";
  };
  transactions: TxRow[];
  categories: Category[];
};

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

function templateLabel(templateType: string) {
  if (templateType === "commbank_manual_amount_balance") return "manual";
  if (templateType === "commbank_auto_debit_credit") return "auto";
  if (templateType === "mixed") return "mixed";
  return "unknown";
}

function continuitySummary(quality?: TransactionsResponse["quality"]) {
  if (!quality || typeof quality.balanceContinuityPassRate !== "number") return "-";
  const checked = quality.balanceContinuityChecked ?? 0;
  const total = quality.balanceContinuityTotalRows ?? checked;
  return `${(quality.balanceContinuityPassRate * 100).toFixed(1)}% (checked ${checked}/${total})`;
}

function skippedSummary(quality?: TransactionsResponse["quality"]) {
  if (!quality) return "-";
  const skipped = quality.balanceContinuitySkipped ?? 0;
  const reasons = quality.balanceContinuitySkippedReasons || {};
  const reasonText = Object.entries(reasons)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ");
  return skipped > 0 ? `${skipped}${reasonText ? ` · ${reasonText}` : ""}` : "0";
}

export default function TransactionsPage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<"all" | "selected">("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [result, setResult] = useState<TransactionsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saveStatus, setSaveStatus] = useState<string>("");
  const [savingId, setSavingId] = useState<string>("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [pendingCategories, setPendingCategories] = useState<Record<string, Category>>({});

  const selectedFileNames = useMemo(
    () =>
      selectedFileIds
        .map((id) => files.find((f) => f.id === id)?.originalName)
        .filter(Boolean) as string[],
    [files, selectedFileIds]
  );

  const fetchFiles = async () => {
    const res = await fetch("/api/files");
    const data = (await res.json()) as
      | { ok: true; files: FileMeta[] }
      | { ok: false; error: ApiError };

    if (!data.ok) {
      throw new Error(`${data.error.code}: ${data.error.message}`);
    }

    setFiles(data.files);
    if (selectedFileIds.length === 0 && data.files.length > 0) {
      setSelectedFileIds([data.files[0].id]);
    }
  };

  const fetchTransactions = async () => {
    if (scopeMode === "selected" && selectedFileIds.length === 0) return;
    setIsLoading(true);
    setError(null);
    setSaveStatus("");

    const params = new URLSearchParams({
      ...(q ? { q } : {}),
      ...(category ? { category } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    });
    if (scopeMode === "all") {
      params.set("scope", "all");
    } else {
      for (const id of selectedFileIds) {
        params.append("fileIds", id);
      }
    }

    try {
      const res = await fetch(`/api/analysis/transactions?${params.toString()}`);
      const data = (await res.json()) as
        | TransactionsResponse
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setError(data.error);
        setResult(null);
        setPendingCategories({});
        return;
      }

      setResult(data);
      setPendingCategories(
        data.transactions.reduce<Record<string, Category>>((acc, tx) => {
          acc[tx.id] = tx.category;
          return acc;
        }, {})
      );
    } catch {
      setError({ code: "FETCH_FAILED", message: "Failed to load transactions." });
      setResult(null);
      setPendingCategories({});
    } finally {
      setIsLoading(false);
    }
  };

  const saveCategory = async (tx: TxRow, nextCategory: string, applyToMerchant: boolean) => {
    setSavingId(tx.id);
    setSaveStatus("");

    try {
      const res = await fetch("/api/analysis/category-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          applyToMerchant
            ? {
                category: nextCategory,
                merchantNorm: tx.merchantNorm,
                applyToMerchant: true,
              }
            : {
                category: nextCategory,
                transactionId: tx.id,
              }
        ),
      });

      const data = (await res.json()) as { ok: true } | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(data.error);
        return;
      }

      setSaveStatus(
        applyToMerchant
          ? `Updated merchant mapping: ${tx.merchantNorm}`
          : `Updated category for tx ${tx.id}`
      );
      await fetchTransactions();
    } catch {
      setError({ code: "SAVE_FAILED", message: "Failed to save category override." });
    } finally {
      setSavingId("");
    }
  };

  useEffect(() => {
    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scopeMode === "selected" && selectedFileIds.length === 0) return;
    void fetchTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeMode, selectedFileIds]);

  const categoryList = result?.categories || [];

  return (
    <main className="min-h-screen bg-slate-50 p-6 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Transactions</h1>
          <p className="mt-1 text-sm text-slate-600">
            Search, filter, and assign categories. All analytics remain traceable to tx IDs.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-6">
            <label className="space-y-1 text-xs font-medium text-slate-600">
              Scope
              <select
                value={scopeMode}
                onChange={(e) => setScopeMode(e.target.value as "all" | "selected")}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              >
                <option value="all">All files</option>
                <option value="selected">Selected files</option>
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 md:col-span-2">
              Files (multi-select)
              <select
                multiple
                value={selectedFileIds}
                onChange={(e) => {
                  const values = Array.from(e.currentTarget.selectedOptions).map((opt) => opt.value);
                  setSelectedFileIds(values);
                }}
                disabled={scopeMode !== "selected"}
                className="h-[88px] w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900 disabled:bg-slate-100"
              >
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.originalName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Search
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="merchant / description"
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              />
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              >
                <option value="">All</option>
                {categoryList.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Date From
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              />
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Date To
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              />
            </label>
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => {
                void fetchTransactions();
              }}
              disabled={isLoading || (scopeMode === "selected" && selectedFileIds.length === 0)}
              className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isLoading ? "Loading..." : "Apply Filters"}
            </button>
            <button
              onClick={() => {
                setQ("");
                setCategory("");
                setDateFrom("");
                setDateTo("");
                void fetchTransactions();
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              Clear Filters
            </button>
          </div>

          {result && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <div>
                Template: <span className="font-medium">{templateLabel(result.templateType)}</span> (
                {result.templateType})
              </div>
              <div>
                Header: {result.quality?.headerFound ? "found" : "not found"} | Continuity:{" "}
                {continuitySummary(result.quality)}
              </div>
              <div>
                Continuity skipped: {skippedSummary(result.quality)}
              </div>
              <div>
                Review: {result.needsReview ? "yes" : "no"}
                {result.needsReview && result.quality?.needsReviewReasons?.length
                  ? ` (${result.quality.needsReviewReasons.join(", ")})`
                  : ""}
              </div>
              <div>
                Scope: <span className="font-medium">{result.appliedFilters?.scope || scopeMode}</span>
                {scopeMode === "selected" && selectedFileIds.length
                  ? ` · ${selectedFileIds.length} selected`
                  : ""}
              </div>
              <div>
                Files included: {result.filesIncludedCount ?? 0}
                {selectedFileNames.length ? ` · ${selectedFileNames.join(", ")}` : ""}
              </div>
              <div>
                Tx before dedupe: {result.txCountBeforeDedupe ?? 0} · deduped:{" "}
                {result.dedupedCount ?? 0}
              </div>
            </div>
          )}

          {saveStatus && (
            <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {saveStatus}
            </div>
          )}
          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 text-sm text-slate-600">
            Rows: {result?.transactions.length || 0}
            {(result?.dedupedCount || 0) > 0 ? ` · Deduped ${result?.dedupedCount}` : ""}
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-[1200px] w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2">Date</th>
                  <th className="px-3 py-2">Description</th>
                  <th className="px-3 py-2">Merchant</th>
                  <th className="px-3 py-2">Amount</th>
                  <th className="px-3 py-2">Balance</th>
                  <th className="px-3 py-2">Category</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Raw</th>
                </tr>
              </thead>
              <tbody>
                {(result?.transactions || []).map((tx) => (
                  <tr key={tx.id} className="border-t align-top">
                    <td className="px-3 py-2">{tx.date.slice(0, 10)}</td>
                    <td className="px-3 py-2 max-w-[280px] whitespace-normal">{tx.descriptionRaw}</td>
                    <td className="px-3 py-2 font-mono text-[11px]">{tx.merchantNorm}</td>
                    <td className={`px-3 py-2 ${tx.amount >= 0 ? "text-emerald-700" : "text-rose-700"}`}>
                      {CURRENCY.format(tx.amount)}
                    </td>
                    <td className="px-3 py-2">
                      {typeof tx.balance === "number" ? CURRENCY.format(tx.balance) : "-"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="space-y-1">
                        <select
                          value={pendingCategories[tx.id] ?? tx.category}
                          onChange={(e) => {
                            const value = e.target.value as Category;
                            setPendingCategories((prev) => ({ ...prev, [tx.id]: value }));
                          }}
                          disabled={savingId === tx.id}
                          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-xs"
                        >
                          {categoryList.map((item) => (
                            <option key={item} value={item}>
                              {item}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            void saveCategory(
                              tx,
                              pendingCategories[tx.id] ?? tx.category,
                              false
                            );
                          }}
                          disabled={savingId === tx.id}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          Save this row
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void saveCategory(
                              tx,
                              pendingCategories[tx.id] ?? tx.category,
                              true
                            );
                          }}
                          disabled={savingId === tx.id}
                          className="w-full rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700 hover:bg-slate-100"
                        >
                          Apply to merchant
                        </button>
                        <div className="text-[10px] text-slate-500">
                          {tx.categorySource}
                          {tx.categoryRuleId ? ` · ${tx.categoryRuleId}` : ""}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2">{tx.quality.confidence.toFixed(2)}</td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() =>
                          setExpanded((prev) => ({
                            ...prev,
                            [tx.id]: !prev[tx.id],
                          }))
                        }
                        className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
                      >
                        {expanded[tx.id] ? "Hide" : "Show"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(result?.transactions || []).map((tx) =>
            expanded[tx.id] ? (
              <div key={`${tx.id}-raw`} className="mt-2 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
                <div className="font-mono text-[11px] text-slate-600">txId: {tx.id}</div>
                <div className="font-mono text-[11px] text-slate-600">
                  source: fileId={tx.source.fileId}, line={tx.source.lineIndex}
                </div>
                {tx.quality.warnings.length > 0 && (
                  <div className="text-amber-700">warnings: {tx.quality.warnings.join(", ")}</div>
                )}
                <pre className="mt-1 whitespace-pre-wrap text-[11px] text-slate-700">{tx.quality.rawLine}</pre>
              </div>
            ) : null
          )}
        </section>
      </div>
    </main>
  );
}
