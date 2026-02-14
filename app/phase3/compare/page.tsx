"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  CompareResponse,
  FileMeta,
  OverviewResponse,
} from "@/app/phase3/_lib/types";
import {
  buildScopeParams,
  monthRange,
  parseScopeFromWindow,
  quarterRange,
  ScopeMode,
  yearRange,
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

type CompareMode =
  | "month_prev"
  | "month_last_year"
  | "quarter_prev"
  | "year_prev"
  | "custom_month";

function periodFromMode(
  mode: CompareMode,
  overview: OverviewResponse,
  customA: string,
  customB: string
) {
  const months = overview.availableMonths || [];
  const quarters = overview.availableQuarters || [];
  const years = overview.availableYears || [];
  const latestMonth = months[months.length - 1] || "";
  const latestQuarter = quarters[quarters.length - 1] || "";
  const latestYear = years[years.length - 1] || "";

  if (mode === "custom_month") {
    const a = monthRange(customA || latestMonth);
    const b = monthRange(customB || latestMonth);
    return a && b ? { a, b, label: `Custom ${customA} vs ${customB}` } : null;
  }

  if (mode === "month_last_year") {
    const a = monthRange(latestMonth);
    if (!a || !latestMonth) return null;
    const [yearText, monthText] = latestMonth.split("-");
    const b = monthRange(`${Number(yearText) - 1}-${monthText}`);
    return b ? { a, b, label: "This month vs same month last year" } : null;
  }

  if (mode === "quarter_prev") {
    const a = quarterRange(latestQuarter);
    if (!a || !latestQuarter) return null;
    const match = /^(\d{4})-Q([1-4])$/.exec(latestQuarter);
    if (!match) return null;
    const year = Number(match[1]);
    const quarter = Number(match[2]);
    const prevQuarter = quarter === 1 ? `${year - 1}-Q4` : `${year}-Q${quarter - 1}`;
    const b = quarterRange(prevQuarter);
    return b ? { a, b, label: "This quarter vs last quarter" } : null;
  }

  if (mode === "year_prev") {
    const a = yearRange(latestYear);
    const b = yearRange(String(Number(latestYear || "0") - 1));
    return a && b ? { a, b, label: "This year vs last year" } : null;
  }

  const a = monthRange(latestMonth);
  if (!a) return null;
  const d = new Date(`${a.dateFrom}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  const prevMonth = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  const b = monthRange(prevMonth);
  return b ? { a, b, label: "This month vs last month" } : null;
}

function deltaLabel(value: { amount: number; percent: number }) {
  const sign = value.amount >= 0 ? "+" : "-";
  return `${sign}${CURRENCY.format(Math.abs(value.amount))} (${sign}${PERCENT.format(
    Math.abs(value.percent)
  )})`;
}

export default function Phase3ComparePage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

  const [compareMode, setCompareMode] = useState<CompareMode>("month_prev");
  const [customMonthA, setCustomMonthA] = useState("");
  const [customMonthB, setCustomMonthB] = useState("");

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

  async function fetchFiles() {
    const res = await fetch("/api/files");
    const data = (await res.json()) as
      | { ok: true; files: FileMeta[] }
      | { ok: false; error: ApiError };
    if (!data.ok) throw new Error(`${data.error.code}: ${data.error.message}`);
    setFiles(data.files);
  }

  const fetchCompare = useCallback(async (nextScope: ScopeMode, nextIds: string[]) => {
    setIsLoading(true);
    setError(null);

    try {
      const overviewParams = buildScopeParams(nextScope, nextIds);
      overviewParams.set("granularity", "month");
      const overviewRes = await fetch(`/api/analysis/overview?${overviewParams.toString()}`);
      const overviewData = (await overviewRes.json()) as
        | OverviewResponse
        | { ok: false; error: ApiError };

      if (!overviewData.ok) {
        setOverview(null);
        setCompare(null);
        setError(overviewData.error);
        return;
      }

      setOverview(overviewData);
      const periods = periodFromMode(compareMode, overviewData, customMonthA, customMonthB);
      if (!periods) {
        setCompare(null);
        setError({
          code: "COMPARE_RANGE_UNAVAILABLE",
          message: "Could not derive comparison periods from current settings.",
        });
        return;
      }

      const compareParams = buildScopeParams(nextScope, nextIds);
      compareParams.set("periodAStart", periods.a.dateFrom);
      compareParams.set("periodAEnd", periods.a.dateTo);
      compareParams.set("periodBStart", periods.b.dateFrom);
      compareParams.set("periodBEnd", periods.b.dateTo);

      const compareRes = await fetch(`/api/analysis/compare?${compareParams.toString()}`);
      const compareData = (await compareRes.json()) as CompareResponse | { ok: false; error: ApiError };

      if (!compareData.ok) {
        setCompare(null);
        setError(compareData.error);
        return;
      }

      setCompare(compareData);
    } catch {
      setCompare(null);
      setError({ code: "FETCH_FAILED", message: "Failed to load comparison." });
    } finally {
      setIsLoading(false);
    }
  }, [compareMode, customMonthA, customMonthB]);

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });
    void fetchCompare(parsed.scopeMode, parsed.fileIds);
  }, [fetchCompare]);

  useEffect(() => {
    if (scopeMode === "selected" && selectedFileIds.length === 0) return;
    void fetchCompare(scopeMode, selectedFileIds);
  }, [scopeMode, selectedFileIds, fetchCompare]);

  useEffect(() => {
    const params = buildScopeParams(scopeMode, selectedFileIds);
    window.history.replaceState(null, "", `/phase3/compare?${params.toString()}`);
  }, [scopeMode, selectedFileIds]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Compare View</h1>
          <p className="mt-1 text-sm text-slate-600">
            Period A vs Period B comparison driven by your selected dataset scope.
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
              Compare Mode
              <select
                value={compareMode}
                onChange={(e) => setCompareMode(e.target.value as CompareMode)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="month_prev">This month vs last month</option>
                <option value="month_last_year">This month vs same month last year</option>
                <option value="quarter_prev">This quarter vs last quarter</option>
                <option value="year_prev">This year vs last year</option>
                <option value="custom_month">Custom (month vs month)</option>
              </select>
            </label>

            <div className="flex items-end lg:col-span-3">
              <button
                type="button"
                onClick={() => void fetchCompare(scopeMode, selectedFileIds)}
                disabled={isLoading || (scopeMode === "selected" && selectedFileIds.length === 0)}
                className="h-10 w-full rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isLoading ? "Loading..." : "Refresh Compare"}
              </button>
            </div>

            {compareMode === "custom_month" && (
              <>
                <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
                  Month A
                  <select
                    value={customMonthA}
                    onChange={(e) => setCustomMonthA(e.target.value)}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    {(overview?.availableMonths || []).map((month) => (
                      <option key={month} value={month}>
                        {month}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
                  Month B
                  <select
                    value={customMonthB}
                    onChange={(e) => setCustomMonthB(e.target.value)}
                    className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  >
                    {(overview?.availableMonths || []).map((month) => (
                      <option key={month} value={month}>
                        {month}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </div>

          {overview && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Dataset covers: {overview.datasetDateMin || "-"} → {overview.datasetDateMax || "-"} · Months:{" "}
              {overview.availableMonths?.length || 0} · Files: {overview.filesIncludedCount || 0}
              <br />
              selected files: {selectedFileNames.length ? selectedFileNames.join(", ") : "All files"}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Income delta</div>
            <div className="mt-3 text-xl font-semibold text-slate-900">
              {compare ? deltaLabel(compare.delta.income) : "-"}
            </div>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Spend delta</div>
            <div className="mt-3 text-xl font-semibold text-slate-900">
              {compare ? deltaLabel(compare.delta.spend) : "-"}
            </div>
          </article>
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Net delta</div>
            <div className="mt-3 text-xl font-semibold text-slate-900">
              {compare ? deltaLabel(compare.delta.net) : "-"}
            </div>
          </article>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Category Movers</h2>
          <div className="mt-4 grid gap-2 md:grid-cols-2">
            {(compare?.categoryDeltas || []).slice(0, 10).map((row) => (
              <div key={row.category} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-800">{row.category}</span>
                  <span className={row.delta >= 0 ? "text-rose-700" : "text-emerald-700"}>
                    {row.delta >= 0 ? "+" : "-"}
                    {CURRENCY.format(Math.abs(row.delta))}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-600">
                  A {CURRENCY.format(row.current)} · B {CURRENCY.format(row.previous)} ·
                  {row.percent >= 0 ? " +" : " -"}
                  {PERCENT.format(Math.abs(row.percent))}
                </div>
              </div>
            ))}
            {!compare?.categoryDeltas?.length && (
              <p className="text-sm text-slate-500">No category deltas in selected periods.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
          <div className="mb-1 font-medium uppercase tracking-wide text-slate-500">Debug</div>
          <div>templateType: {overview?.templateType || "-"}</div>
          <div>needsReview: {String(overview?.needsReview || false)}</div>
          <div>
            continuity: {(overview?.quality?.balanceContinuityPassRate || 0).toFixed(3)} · checked: {overview?.quality?.balanceContinuityChecked || 0}
          </div>
          <div>
            periods A/B: {compare ? `${compare.periodA.start}→${compare.periodA.end} vs ${compare.periodB.start}→${compare.periodB.end}` : "-"}
          </div>
        </section>
      </div>
    </main>
  );
}
