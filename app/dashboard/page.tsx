"use client";

import { useEffect, useMemo, useState } from "react";

type FileMeta = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

type ApiError = { code: string; message: string };

type OverviewResponse = {
  ok: true;
  fileId?: string;
  fileIds?: string[];
  filesIncludedCount?: number;
  txCountBeforeDedupe?: number;
  dedupedCount?: number;
  accountId?: string;
  granularity: "month" | "week";
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
    granularity?: "month" | "week";
    balanceScope?: "file" | "account" | "none";
  };
  totals: { income: number; spend: number; net: number };
  periods: Array<{
    period: string;
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
  }>;
  spendByCategory: Array<{
    category: string;
    amount: number;
    share: number;
    transactionIds: string[];
  }>;
  topMerchants: Array<{
    merchantNorm: string;
    amount: number;
    transactionIds: string[];
  }>;
  balanceSeries: Array<{ date: string; balance: number; transactionId: string }>;
  balanceSeriesDisabledReason?: string;
};

type CompareResponse = {
  ok: true;
  fileId?: string;
  fileIds?: string[];
  filesIncludedCount?: number;
  txCountBeforeDedupe?: number;
  dedupedCount?: number;
  accountId?: string;
  mode: "current_vs_previous";
  granularity: "month" | "quarter" | "year";
  appliedFilters?: Record<string, unknown>;
  current: {
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
    categories: Array<{ category: string; amount: number }>;
  };
  previous: {
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
    categories: Array<{ category: string; amount: number }>;
  };
  deltas: {
    income: { amount: number; percent: number };
    spend: { amount: number; percent: number };
    net: { amount: number; percent: number };
  };
  categoryDeltas: Array<{
    category: string;
    current: number;
    previous: number;
    delta: number;
    percent: number;
  }>;
  merchantDeltas?: Array<{
    merchantNorm: string;
    current: number;
    previous: number;
    delta: number;
    percent: number;
  }>;
};

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

const PERCENT = new Intl.NumberFormat("en-AU", {
  style: "percent",
  maximumFractionDigits: 1,
});

function templateLabel(templateType: string) {
  if (templateType === "commbank_manual_amount_balance") return "manual";
  if (templateType === "commbank_auto_debit_credit") return "auto";
  if (templateType === "mixed") return "mixed";
  return "unknown";
}

function deltaText(value: { amount: number; percent: number }) {
  const sign = value.amount >= 0 ? "+" : "-";
  return `${sign}${CURRENCY.format(Math.abs(value.amount))} (${sign}${PERCENT.format(
    Math.abs(value.percent)
  )})`;
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

function buildLinePath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x},${point.y}`)
    .join(" ");
}

function continuitySummary(quality?: OverviewResponse["quality"]) {
  if (!quality || typeof quality.balanceContinuityPassRate !== "number") return "-";
  const checked = quality.balanceContinuityChecked ?? 0;
  const total = quality.balanceContinuityTotalRows ?? checked;
  return `${(quality.balanceContinuityPassRate * 100).toFixed(1)}% (checked ${checked}/${total})`;
}

function skippedSummary(quality?: OverviewResponse["quality"]) {
  if (!quality) return "-";
  const skipped = quality.balanceContinuitySkipped ?? 0;
  const reasons = quality.balanceContinuitySkippedReasons || {};
  const reasonText = Object.entries(reasons)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(", ");
  return skipped > 0 ? `${skipped}${reasonText ? ` · ${reasonText}` : ""}` : "0";
}

export default function DashboardPage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<"all" | "selected">("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<"month" | "week">("month");
  const [compareGranularity, setCompareGranularity] = useState<"month" | "quarter" | "year">(
    "month"
  );
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

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

  const fetchAnalytics = async () => {
    if (scopeMode === "selected" && selectedFileIds.length === 0) return;
    setIsLoading(true);
    setError(null);

    const common = new URLSearchParams({
      granularity,
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    });
    if (scopeMode === "all") {
      common.set("scope", "all");
    } else {
      for (const fileId of selectedFileIds) {
        common.append("fileIds", fileId);
      }
    }

    try {
      const compareParams = new URLSearchParams({
        mode: "current_vs_previous",
        granularity: compareGranularity,
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
      });
      if (scopeMode === "all") {
        compareParams.set("scope", "all");
      } else {
        for (const fileId of selectedFileIds) {
          compareParams.append("fileIds", fileId);
        }
      }

      const [overviewRes, compareRes] = await Promise.all([
        fetch(`/api/analysis/overview?${common.toString()}`),
        fetch(`/api/analysis/compare?${compareParams.toString()}`),
      ]);

      const overviewData = (await overviewRes.json()) as
        | OverviewResponse
        | { ok: false; error: ApiError };
      const compareData = (await compareRes.json()) as
        | CompareResponse
        | { ok: false; error: ApiError };

      if (!overviewData.ok) {
        setError(overviewData.error);
        setOverview(null);
        setCompare(null);
        return;
      }

      if (!compareData.ok) {
        setError(compareData.error);
        setOverview(overviewData);
        setCompare(null);
        return;
      }

      setOverview(overviewData);
      setCompare(compareData);
    } catch {
      setError({ code: "FETCH_FAILED", message: "Failed to load analysis data." });
    } finally {
      setIsLoading(false);
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
    void fetchAnalytics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeMode, selectedFileIds, granularity, compareGranularity]);

  const maxPeriodTotal = useMemo(() => {
    if (!overview?.periods.length) return 0;
    return Math.max(
      ...overview.periods.map((item) => Math.max(item.income, item.spend, Math.abs(item.net)))
    );
  }, [overview]);

  const balancePath = useMemo(() => {
    const rows = overview?.balanceSeries || [];
    if (rows.length < 2) return "";

    const width = 720;
    const height = 200;
    const min = Math.min(...rows.map((r) => r.balance));
    const max = Math.max(...rows.map((r) => r.balance));
    const span = max - min || 1;

    const points = rows.map((row, index) => {
      const x = (index / (rows.length - 1)) * width;
      const y = height - ((row.balance - min) / span) * height;
      return { x, y };
    });

    return buildLinePath(points);
  }, [overview]);

  const donutStyle = useMemo(
    () => makeDonutStyle((overview?.spendByCategory || []).slice(0, 8)),
    [overview]
  );

  return (
    <main className="min-h-screen bg-slate-50 p-6 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Phase 3 Dashboard</h1>
          <p className="mt-1 text-sm text-slate-600">
            Category analytics and period comparisons for CommBank parsed transactions.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-5">
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
              Granularity
              <select
                value={granularity}
                onChange={(e) => setGranularity(e.target.value as "month" | "week")}
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              >
                <option value="month">Month</option>
                <option value="week">Week</option>
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Compare Basis
              <select
                value={compareGranularity}
                onChange={(e) =>
                  setCompareGranularity(e.target.value as "month" | "quarter" | "year")
                }
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              >
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Date From
              <input
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                type="date"
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              />
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600">
              Date To
              <input
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                type="date"
                className="w-full rounded-lg border border-slate-300 bg-white px-2 py-2 text-sm text-slate-900"
              />
            </label>

            <button
              type="button"
              onClick={() => {
                void fetchAnalytics();
              }}
              disabled={isLoading || (scopeMode === "selected" && selectedFileIds.length === 0)}
              className="self-end rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isLoading ? "Loading..." : "Refresh"}
            </button>
          </div>

          {overview && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <div>
                Template: <span className="font-medium">{templateLabel(overview.templateType)}</span> (
                {overview.templateType})
              </div>
              <div>
                Header: {overview.quality?.headerFound ? "found" : "not found"} | Continuity:{" "}
                {continuitySummary(overview.quality)}
              </div>
              <div>
                Continuity skipped: {skippedSummary(overview.quality)}
              </div>
              <div>
                Review: {overview.needsReview ? "yes" : "no"}
                {overview.needsReview && overview.quality?.needsReviewReasons?.length
                  ? ` (${overview.quality.needsReviewReasons.join(", ")})`
                  : ""}
              </div>
              <div>
                Scope: <span className="font-medium">{overview.appliedFilters?.scope || scopeMode}</span>
                {scopeMode === "selected" && selectedFileIds.length
                  ? ` · ${selectedFileIds.length} selected`
                  : ""}
              </div>
              <div>
                Files included: {overview.filesIncludedCount ?? 0}
                {selectedFileNames.length ? ` · ${selectedFileNames.join(", ")}` : ""}
              </div>
              <div>
                Tx before dedupe: {overview.txCountBeforeDedupe ?? 0} · deduped:{" "}
                {overview.dedupedCount ?? 0}
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
        </header>

        <section className="grid gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Income</div>
            <div className="mt-2 text-2xl font-semibold text-emerald-700">
              {CURRENCY.format(overview?.totals.income || 0)}
            </div>
            {compare && <div className="mt-2 text-xs text-slate-500">vs prev: {deltaText(compare.deltas.income)}</div>}
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Spend</div>
            <div className="mt-2 text-2xl font-semibold text-rose-700">
              {CURRENCY.format(overview?.totals.spend || 0)}
            </div>
            {compare && <div className="mt-2 text-xs text-slate-500">vs prev: {deltaText(compare.deltas.spend)}</div>}
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Net</div>
            <div
              className={`mt-2 text-2xl font-semibold ${(overview?.totals.net || 0) >= 0 ? "text-emerald-700" : "text-rose-700"}`}
            >
              {CURRENCY.format(overview?.totals.net || 0)}
            </div>
            {compare && <div className="mt-2 text-xs text-slate-500">vs prev: {deltaText(compare.deltas.net)}</div>}
          </article>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-900">Compare: Top Category Movers</h2>
            <div className="text-xs text-slate-500">Basis: {compareGranularity}</div>
          </div>
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {(compare?.categoryDeltas || []).slice(0, 5).map((row) => (
              <div key={row.category} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{row.category}</span>
                  <span className={row.delta >= 0 ? "text-rose-700" : "text-emerald-700"}>
                    {row.delta >= 0 ? "+" : "-"}
                    {CURRENCY.format(Math.abs(row.delta))}
                  </span>
                </div>
                <div className="mt-1 text-slate-500">
                  current {CURRENCY.format(row.current)} · previous {CURRENCY.format(row.previous)} ·{" "}
                  {row.percent >= 0 ? "+" : "-"}
                  {PERCENT.format(Math.abs(row.percent))}
                </div>
              </div>
            ))}
            {!compare?.categoryDeltas?.length && (
              <p className="text-sm text-slate-500">No comparison deltas in current range.</p>
            )}
          </div>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Income / Spend / Net by Period</h2>
            <div className="mt-4 space-y-3">
              {(overview?.periods || []).map((row) => (
                <div key={row.period}>
                  <div className="flex items-center justify-between text-xs text-slate-600">
                    <span className="font-medium text-slate-800">{row.period}</span>
                    <span title={row.transactionIds.join(", ")}>{row.transactionIds.length} tx</span>
                  </div>
                  <div className="mt-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-12 text-[11px] text-slate-500">Income</span>
                      <div className="h-2 flex-1 rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-emerald-500"
                          style={{
                            width:
                              maxPeriodTotal > 0
                                ? `${Math.max(2, (row.income / maxPeriodTotal) * 100)}%`
                                : "0%",
                          }}
                        />
                      </div>
                      <span className="w-24 text-right text-[11px] text-slate-600">{CURRENCY.format(row.income)}</span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="w-12 text-[11px] text-slate-500">Spend</span>
                      <div className="h-2 flex-1 rounded-full bg-slate-100">
                        <div
                          className="h-2 rounded-full bg-rose-500"
                          style={{
                            width:
                              maxPeriodTotal > 0
                                ? `${Math.max(2, (row.spend / maxPeriodTotal) * 100)}%`
                                : "0%",
                          }}
                        />
                      </div>
                      <span className="w-24 text-right text-[11px] text-slate-600">{CURRENCY.format(row.spend)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {!overview?.periods.length && <p className="text-sm text-slate-500">No period data yet.</p>}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Spend by Category</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-[200px_1fr]">
              <div
                className="mx-auto h-48 w-48 rounded-full border border-slate-200"
                style={donutStyle}
                aria-label="Spend by category donut"
              />
              <div className="space-y-2">
                {(overview?.spendByCategory || []).slice(0, 8).map((row) => (
                  <div key={row.category} className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">{row.category}</span>
                      <span className="text-slate-600">{CURRENCY.format(row.amount)}</span>
                    </div>
                    <div className="mt-1 text-slate-500">
                      {PERCENT.format(row.share)} · <span title={row.transactionIds.join(", ")}>{row.transactionIds.length} tx</span>
                    </div>
                  </div>
                ))}
                {!(overview?.spendByCategory.length) && (
                  <p className="text-sm text-slate-500">No spending rows in range.</p>
                )}
              </div>
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Balance Curve</h2>
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              {balancePath ? (
                <svg viewBox="0 0 720 220" className="h-56 w-full">
                  <path d={balancePath} fill="none" stroke="#2563eb" strokeWidth="2.5" />
                </svg>
              ) : (
                <p className="text-sm text-slate-500">
                  {overview?.balanceSeriesDisabledReason || "Not enough balance points to draw curve."}
                </p>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Each point maps to the latest transaction balance for that date.
            </p>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Top Merchants (Spend)</h2>
            <div className="mt-4 space-y-2">
              {(overview?.topMerchants || []).map((row, index, arr) => {
                const max = arr.length > 0 ? arr[0].amount : 1;
                return (
                  <div key={row.merchantNorm} className="rounded border border-slate-200 bg-slate-50 p-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-800">{index + 1}. {row.merchantNorm}</span>
                      <span className="text-slate-600">{CURRENCY.format(row.amount)}</span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-slate-200">
                      <div
                        className="h-2 rounded-full bg-indigo-500"
                        style={{ width: `${Math.max(4, (row.amount / max) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1 text-[11px] text-slate-500" title={row.transactionIds.join(", ")}>
                      {row.transactionIds.length} tx linked
                    </div>
                  </div>
                );
              })}
              {!overview?.topMerchants.length && <p className="text-sm text-slate-500">No merchants in range.</p>}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
