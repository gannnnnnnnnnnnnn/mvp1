"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  FileMeta,
  OverviewResponse,
} from "@/app/phase3/_lib/types";
import {
  buildScopeParams,
  monthRange,
  parseScopeFromWindow,
  ScopeMode,
} from "@/app/phase3/_lib/timeNav";

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const PERCENT = new Intl.NumberFormat("en-AU", {
  style: "percent",
  maximumFractionDigits: 1,
});

type DrilldownTx = {
  id: string;
  date: string;
  merchantNorm: string;
  descriptionRaw: string;
  amount: number;
  category: string;
  categorySource: "rule" | "manual" | "default";
  quality: { confidence: number; warnings: string[] };
  source: { fileId: string };
};

function readMonthFromUrl() {
  if (typeof window === "undefined") return "";
  const query = new URLSearchParams(window.location.search);
  return (query.get("m") || "").trim();
}

function readScopeLabel(value: unknown, fallback: ScopeMode) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function makeDonutStyle(items: Array<{ share: number }>) {
  if (items.length === 0) {
    return { background: "conic-gradient(#e2e8f0 0deg 360deg)" } as const;
  }

  const palette = [
    "#0f766e",
    "#0369a1",
    "#2563eb",
    "#7c3aed",
    "#be185d",
    "#dc2626",
    "#ca8a04",
    "#059669",
  ];

  let cursor = 0;
  const pieces = items.map((item, index) => {
    const start = cursor;
    const end = cursor + item.share * 360;
    cursor = end;
    return `${palette[index % palette.length]} ${start}deg ${end}deg`;
  });

  if (cursor < 360) {
    pieces.push(`#e2e8f0 ${cursor}deg 360deg`);
  }

  return { background: `conic-gradient(${pieces.join(", ")})` } as const;
}

export default function Phase3MonthPage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [month, setMonth] = useState("");

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [selectedCategory, setSelectedCategory] = useState("");
  const [drilldownRows, setDrilldownRows] = useState<DrilldownTx[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<ApiError | null>(null);

  const selectedFileNames = useMemo(
    () =>
      selectedFileIds
        .map((id) => files.find((f) => f.id === id)?.originalName)
        .filter(Boolean) as string[],
    [files, selectedFileIds]
  );

  const dailySeries = useMemo(
    () => overview?.monthDailySeries || [],
    [overview?.monthDailySeries]
  );
  const maxPeriod = useMemo(
    () => Math.max(0, ...dailySeries.map((row) => Math.max(row.income, row.spend))),
    [dailySeries]
  );

  const spendRows = (overview?.spendByCategory || []).slice(0, 8);
  const donutStyle = useMemo(() => makeDonutStyle(spendRows), [spendRows]);

  async function fetchFiles() {
    const res = await fetch("/api/files");
    const data = (await res.json()) as
      | { ok: true; files: FileMeta[] }
      | { ok: false; error: ApiError };
    if (!data.ok) {
      throw new Error(`${data.error.code}: ${data.error.message}`);
    }
    setFiles(data.files);
  }

  async function fetchMonthOverview(nextScope: ScopeMode, nextIds: string[], nextMonth: string) {
    setIsLoading(true);
    setError(null);
    try {
      const params = buildScopeParams(nextScope, nextIds);
      params.set("granularity", "week");
      const range = monthRange(nextMonth);
      if (range) {
        params.set("dateFrom", range.dateFrom);
        params.set("dateTo", range.dateTo);
      }

      const res = await fetch(`/api/analysis/overview?${params.toString()}`);
      const data = (await res.json()) as OverviewResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setOverview(null);
        setError(data.error);
        return;
      }
      setOverview(data);
      if (!nextMonth && data.availableMonths?.length) {
        setMonth(data.availableMonths[data.availableMonths.length - 1]);
      }
    } catch {
      setOverview(null);
      setError({ code: "FETCH_FAILED", message: "Failed to load month view data." });
    } finally {
      setIsLoading(false);
    }
  }

  const fetchCategoryDrilldown = useCallback(async (category: string) => {
    if (!category) return;
    setDrilldownLoading(true);
    setDrilldownError(null);

    try {
      const params = buildScopeParams(scopeMode, selectedFileIds);
      const range = monthRange(month);
      if (range) {
        params.set("dateFrom", range.dateFrom);
        params.set("dateTo", range.dateTo);
      }
      params.set("category", category);
      const res = await fetch(`/api/analysis/transactions?${params.toString()}`);
      const data = (await res.json()) as
        | { ok: true; transactions: DrilldownTx[] }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setDrilldownRows([]);
        setDrilldownError(data.error);
        return;
      }
      setDrilldownRows(data.transactions);
    } catch {
      setDrilldownRows([]);
      setDrilldownError({ code: "FETCH_FAILED", message: "Failed to load category drilldown." });
    } finally {
      setDrilldownLoading(false);
    }
  }, [scopeMode, selectedFileIds, month]);

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    const initialMonth = readMonthFromUrl();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);
    setMonth(initialMonth);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load file list." });
    });

    void fetchMonthOverview(parsed.scopeMode, parsed.fileIds, initialMonth);
  }, []);

  useEffect(() => {
    if (!month) return;
    const params = buildScopeParams(scopeMode, selectedFileIds);
    params.set("m", month);
    window.history.replaceState(null, "", `/phase3/month?${params.toString()}`);
  }, [scopeMode, selectedFileIds, month]);

  useEffect(() => {
    if (!selectedCategory && spendRows.length > 0) {
      setSelectedCategory(spendRows[0].category);
      return;
    }
    if (selectedCategory && !spendRows.some((row) => row.category === selectedCategory)) {
      setSelectedCategory(spendRows[0]?.category || "");
    }
  }, [selectedCategory, spendRows]);

  useEffect(() => {
    if (!selectedCategory) return;
    void fetchCategoryDrilldown(selectedCategory);
  }, [selectedCategory, fetchCategoryDrilldown]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Month View</h1>
          <p className="mt-1 text-sm text-slate-600">
            Focused monthly analysis for selected dataset scope. Category drilldown and labeling are embedded
            here.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Scope
              <select
                value={scopeMode}
                onChange={(e) => setScopeMode(e.target.value as ScopeMode)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="all">All files</option>
                <option value="selected">Selected files</option>
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-4">
              Files
              <select
                multiple
                value={selectedFileIds}
                disabled={scopeMode !== "selected"}
                onChange={(e) => {
                  const values = Array.from(e.currentTarget.selectedOptions).map((opt) => opt.value);
                  setSelectedFileIds(values);
                }}
                className="h-[92px] w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 disabled:bg-slate-100"
              >
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.originalName}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
              Month
              <select
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                {(overview?.availableMonths || []).map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end lg:col-span-3">
              <button
                type="button"
                onClick={() => void fetchMonthOverview(scopeMode, selectedFileIds, month)}
                disabled={isLoading || (scopeMode === "selected" && selectedFileIds.length === 0)}
                className="h-10 w-full rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isLoading ? "Loading..." : "Refresh Month"}
              </button>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Income</div>
            <div className="mt-3 text-3xl font-semibold text-emerald-700">
              {CURRENCY.format(overview?.totals.income || 0)}
            </div>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Spend</div>
            <div className="mt-3 text-3xl font-semibold text-rose-700">
              {CURRENCY.format(overview?.totals.spend || 0)}
            </div>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Net</div>
            <div
              className={`mt-3 text-3xl font-semibold ${(overview?.totals.net || 0) >= 0 ? "text-emerald-700" : "text-rose-700"}`}
            >
              {CURRENCY.format(overview?.totals.net || 0)}
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Daily Cashflow Trend</h2>
            <p className="mt-1 text-sm text-slate-600">Daily income and spend buckets inside selected month.</p>
            <div className="mt-4 space-y-3">
              {dailySeries.map((row) => (
                <div key={row.date}>
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="font-medium text-slate-800">{row.date}</span>
                    <span>{row.transactionIds.length} tx</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-100">
                      <div
                        className="h-2 rounded-full bg-emerald-500"
                        style={{
                          width: maxPeriod > 0 ? `${Math.max(2, (row.income / maxPeriod) * 100)}%` : "0%",
                        }}
                      />
                    </div>
                    <span className="w-20 text-right text-[11px] text-slate-600">{CURRENCY.format(row.income)}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2">
                    <div className="h-2 flex-1 rounded-full bg-slate-100">
                      <div
                        className="h-2 rounded-full bg-rose-500"
                        style={{
                          width: maxPeriod > 0 ? `${Math.max(2, (row.spend / maxPeriod) * 100)}%` : "0%",
                        }}
                      />
                    </div>
                    <span className="w-20 text-right text-[11px] text-slate-600">{CURRENCY.format(row.spend)}</span>
                  </div>
                </div>
              ))}
              {!dailySeries.length && <p className="text-sm text-slate-500">No trend points available.</p>}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Spend by Category</h2>
            <p className="mt-1 text-sm text-slate-600">Hover for details. Click to open embedded drilldown.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-[200px_1fr]">
              <div
                className="mx-auto h-48 w-48 rounded-full border border-slate-200"
                style={donutStyle}
                aria-label="Spend by category donut"
              />
              <div className="space-y-2">
                {spendRows.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    onClick={() => setSelectedCategory(row.category)}
                    className={`group relative w-full rounded border px-3 py-2 text-left text-xs ${selectedCategory === row.category ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">{row.category}</span>
                      <span className="text-slate-600">{CURRENCY.format(row.amount)}</span>
                    </div>
                    <div className="mt-1 text-slate-500">
                      {PERCENT.format(row.share)} · {row.transactionIds.length} tx
                    </div>

                    <div className="pointer-events-none absolute left-0 top-full z-20 mt-1 hidden w-[320px] rounded-lg border border-slate-300 bg-white p-2 text-[11px] text-slate-700 shadow-xl group-hover:block">
                      <div className="font-semibold text-slate-900">{row.category}</div>
                      <div className="mt-1">
                        total {CURRENCY.format(row.amount)} · {row.transactionIds.length} tx
                      </div>
                      <div className="mt-2 text-slate-500">Top merchants</div>
                      <div>
                        {(row.topMerchants || []).slice(0, 3).map((item) => (
                          <div key={item.merchantNorm}>
                            {item.merchantNorm}: {CURRENCY.format(item.amount)}
                          </div>
                        ))}
                        {!(row.topMerchants || []).length && <div>-</div>}
                      </div>
                      <div className="mt-2 text-slate-500">Recent transactions</div>
                      <div>
                        {(row.recentTransactions || []).slice(0, 5).map((item) => (
                          <div key={item.id} className="truncate">
                            {item.date} · {item.merchantNorm} · {CURRENCY.format(item.amount)}
                          </div>
                        ))}
                        {!(row.recentTransactions || []).length && <div>-</div>}
                      </div>
                    </div>
                  </button>
                ))}
                {!spendRows.length && <p className="text-sm text-slate-500">No spending categories in this month.</p>}
              </div>
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Category Drilldown</h2>
              <span className="text-xs text-slate-500">{selectedCategory || "-"}</span>
            </div>

            {drilldownError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                {drilldownError.code}: {drilldownError.message}
              </div>
            )}

            <div className="mt-3 space-y-2">
              {drilldownRows.slice(0, 30).map((tx) => (
                <div key={tx.id} className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-800">{tx.date.slice(0, 10)}</span>
                    <span className={tx.amount >= 0 ? "text-emerald-700" : "text-rose-700"}>
                      {CURRENCY.format(tx.amount)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-slate-700">{tx.descriptionRaw}</div>
                  <div className="mt-1 text-[11px] text-slate-500">
                    {tx.merchantNorm} · {tx.categorySource} · conf {tx.quality.confidence.toFixed(2)}
                  </div>
                </div>
              ))}

              {drilldownLoading && <p className="text-sm text-slate-500">Loading drilldown...</p>}
              {!drilldownLoading && !drilldownRows.length && (
                <p className="text-sm text-slate-500">No transactions for selected category in this month.</p>
              )}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Other Inbox (Month)</h2>
            <p className="mt-2 text-sm text-slate-600">
              Unknown merchants (`Other/default`) are listed in the next milestone with inline label actions.
            </p>
          </article>
        </section>

        {overview && (
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
            <div className="mb-1 font-medium uppercase tracking-wide text-slate-500">Debug</div>
            <div>templateType: {overview.templateType}</div>
            <div>needsReview: {String(overview.needsReview)}</div>
            <div>
              continuity: {(overview.quality?.balanceContinuityPassRate || 0).toFixed(3)} · checked: {overview.quality?.balanceContinuityChecked || 0}
            </div>
            <div>
              scope: {readScopeLabel(overview.appliedFilters?.scope, scopeMode)} · files: {overview.filesIncludedCount || 0}
            </div>
            <div>selected files: {selectedFileNames.length ? selectedFileNames.join(", ") : "All files"}</div>
          </section>
        )}
      </div>
    </main>
  );
}
