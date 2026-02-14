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
  fileId: string;
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
  appliedFilters?: Record<string, unknown>;
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
  const [selectedFileId, setSelectedFileId] = useState("");

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
  const [page, setPage] = useState(1);

  const selectedFileName = useMemo(
    () => files.find((f) => f.id === selectedFileId)?.originalName || "",
    [files, selectedFileId]
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
    if (!selectedFileId && data.files.length > 0) {
      setSelectedFileId(data.files[0].id);
    }
  };

  const fetchTransactions = async (fileId: string) => {
    if (!fileId) return;
    setIsLoading(true);
    setError(null);
    setSaveStatus("");

    const params = new URLSearchParams({
      fileId,
      ...(q ? { q } : {}),
      ...(category ? { category } : {}),
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    });

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
      setPage(1);
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
      await fetchTransactions(selectedFileId);
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
    if (!selectedFileId) return;
    void fetchTransactions(selectedFileId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFileId]);

  const categoryList = result?.categories || [];
  const pageSize = 100;
  const totalRows = result?.transactions.length || 0;
  const pageCount = Math.max(1, Math.ceil(totalRows / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedTransactions = (result?.transactions || []).slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
  );

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-semibold text-slate-900">Transactions</h1>
          <p className="mt-2 text-sm text-slate-600">
            Search, filter, and assign categories. All analytics remain traceable to tx IDs.
          </p>

          <div className="mt-5 text-sm font-semibold text-slate-800">Filter Bar</div>
          <div className="mt-3 grid gap-4 lg:grid-cols-12">
            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-4">
              File
              <select
                value={selectedFileId}
                onChange={(e) => setSelectedFileId(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">Select a file</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.originalName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Search
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="merchant / description"
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              />
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Category
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">All</option>
                {categoryList.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Date From
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              />
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Date To
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => {
                if (selectedFileId) {
                  void fetchTransactions(selectedFileId);
                }
              }}
              disabled={isLoading || !selectedFileId}
              className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isLoading ? "Loading..." : "Apply Filters"}
            </button>
            <button
              onClick={() => {
                setQ("");
                setCategory("");
                setDateFrom("");
                setDateTo("");
                setPage(1);
                if (selectedFileId) {
                  void fetchTransactions(selectedFileId);
                }
              }}
              className="h-10 rounded-lg border border-slate-300 px-4 text-sm text-slate-700 hover:bg-slate-100"
            >
              Clear Filters
            </button>
          </div>

          {result && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
              <div className="mb-1 font-medium uppercase tracking-wide text-slate-500">Debug</div>
              <div>
                Template: <span className="text-slate-700">{templateLabel(result.templateType)}</span> (
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
                File: <span className="font-mono text-slate-700">{selectedFileId}</span>
                {selectedFileName ? ` · ${selectedFileName}` : ""}
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
          <div className="sticky top-0 z-10 mb-3 flex items-center justify-between rounded-lg border border-slate-200 bg-white/90 px-3 py-2 text-sm text-slate-600 backdrop-blur">
            <div>
              Rows: {totalRows}
              {pageCount > 1 ? ` · Page ${currentPage}/${pageCount}` : ""}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                disabled={currentPage <= 1}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
                disabled={currentPage >= pageCount}
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-[1200px] w-full text-left text-xs text-slate-700">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="w-[110px] px-3 py-2">Date</th>
                  <th className="w-[360px] px-3 py-2">Description</th>
                  <th className="w-[220px] px-3 py-2">Merchant</th>
                  <th className="w-[140px] px-3 py-2">Amount</th>
                  <th className="w-[140px] px-3 py-2">Balance</th>
                  <th className="w-[220px] px-3 py-2">Category</th>
                  <th className="px-3 py-2">Confidence</th>
                  <th className="px-3 py-2">Raw</th>
                </tr>
              </thead>
              <tbody>
                {pagedTransactions.map((tx, index) => (
                  <tr key={tx.id} className={`border-t align-top ${index % 2 === 0 ? "bg-white" : "bg-slate-50/40"}`}>
                    <td className="px-3 py-2">{tx.date.slice(0, 10)}</td>
                    <td className="max-w-[360px] px-3 py-2 whitespace-normal">
                      <span title={tx.descriptionRaw}>
                        {tx.descriptionRaw.length > 120
                          ? `${tx.descriptionRaw.slice(0, 120)}...`
                          : tx.descriptionRaw}
                      </span>
                    </td>
                    <td className="max-w-[220px] px-3 py-2 font-mono text-[11px]">
                      <span title={tx.merchantNorm}>
                        {tx.merchantNorm.length > 28
                          ? `${tx.merchantNorm.slice(0, 28)}...`
                          : tx.merchantNorm}
                      </span>
                    </td>
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

          {pagedTransactions.map((tx) =>
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
