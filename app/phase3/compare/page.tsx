"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccountDisplayOption,
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

type DateRange = { dateFrom: string; dateTo: string };

function formatAccountOptionLabel(option: AccountDisplayOption) {
  const head = option.accountName
    ? `${option.bankId.toUpperCase()} · ${option.accountName}`
    : `${option.bankId.toUpperCase()} · ${option.accountId}`;
  const tail = option.accountKey || option.accountId;
  return `${head} (${tail})`;
}

function previousAvailable(values: string[], current: string) {
  const sorted = [...values].sort();
  const idx = sorted.indexOf(current);
  if (idx <= 0) return null;
  return sorted[idx - 1];
}

function previousYearMonth(values: string[], current: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(current);
  if (!match) return null;
  const target = `${Number(match[1]) - 1}-${match[2]}`;
  return values.includes(target) ? target : null;
}

function derivePeriods(params: {
  mode: CompareMode;
  overview: OverviewResponse;
  customA: string;
  customB: string;
}): { a: DateRange; b: DateRange; label: string } | null {
  const months = [...(params.overview.availableMonths || [])].sort();
  const quarters = [...(params.overview.availableQuarters || [])].sort();
  const years = [...(params.overview.availableYears || [])].sort();

  const latestMonth = months[months.length - 1] || "";
  const latestQuarter = quarters[quarters.length - 1] || "";
  const latestYear = years[years.length - 1] || "";

  if (params.mode === "custom_month") {
    const monthA = params.customA || latestMonth;
    const monthB =
      params.customB || previousAvailable(months, monthA) || latestMonth;
    const a = monthRange(monthA);
    const b = monthRange(monthB);
    return a && b ? { a, b, label: `Custom ${monthA} vs ${monthB}` } : null;
  }

  if (params.mode === "month_last_year") {
    const a = monthRange(latestMonth);
    const monthB = previousYearMonth(months, latestMonth);
    const b = monthB ? monthRange(monthB) : null;
    return a && b
      ? { a, b, label: "Latest month vs same month last year" }
      : null;
  }

  if (params.mode === "quarter_prev") {
    const prevQuarter = previousAvailable(quarters, latestQuarter);
    const a = quarterRange(latestQuarter);
    const b = prevQuarter ? quarterRange(prevQuarter) : null;
    return a && b
      ? { a, b, label: "Latest quarter vs previous available quarter" }
      : null;
  }

  if (params.mode === "year_prev") {
    const prevYear = previousAvailable(years, latestYear);
    const a = yearRange(latestYear);
    const b = prevYear ? yearRange(prevYear) : null;
    return a && b
      ? { a, b, label: "Latest year vs previous available year" }
      : null;
  }

  const prevMonth = previousAvailable(months, latestMonth);
  const a = monthRange(latestMonth);
  const b = prevMonth ? monthRange(prevMonth) : null;
  return a && b
    ? { a, b, label: "Latest available month vs previous available month" }
    : null;
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
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [compareMode, setCompareMode] = useState<CompareMode>("month_prev");
  const [customMonthA, setCustomMonthA] = useState("");
  const [customMonthB, setCustomMonthB] = useState("");

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [compare, setCompare] = useState<CompareResponse | null>(null);
  const [compareLabel, setCompareLabel] = useState("Period A vs Period B");
  const [friendlyNote, setFriendlyNote] = useState("");
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

  const fetchCompare = useCallback(
    async (
      nextScope: ScopeMode,
      nextIds: string[],
      nextBankId: string,
      nextAccountId: string
    ) => {
    setIsLoading(true);
    setError(null);
    setFriendlyNote("");

    try {
      const overviewParams = buildScopeParams(nextScope, nextIds, {
        bankId: nextBankId || undefined,
        accountId: nextAccountId || undefined,
      });
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
      const periods = derivePeriods({
        mode: compareMode,
        overview: overviewData,
        customA: customMonthA,
        customB: customMonthB,
      });

      if (!periods) {
        setCompare(null);
        setCompareLabel("Period A vs Period B");
        if (compareMode !== "custom_month") {
          const months = [...(overviewData.availableMonths || [])].sort();
          const latestMonth = months[months.length - 1] || "";
          const previousMonth = previousAvailable(months, latestMonth) || latestMonth;
          setCustomMonthA(latestMonth);
          setCustomMonthB(previousMonth);
          setCompareMode("custom_month");
          setFriendlyNote(
            "No valid range for this mode in current dataset. Switched to custom month comparison."
          );
        } else {
          setFriendlyNote("Please pick two available months to compare.");
        }
        return;
      }

      setCompareLabel(periods.label);
      const compareParams = buildScopeParams(nextScope, nextIds, {
        bankId: nextBankId || undefined,
        accountId: nextAccountId || undefined,
      });
      compareParams.set("periodAStart", periods.a.dateFrom);
      compareParams.set("periodAEnd", periods.a.dateTo);
      compareParams.set("periodBStart", periods.b.dateFrom);
      compareParams.set("periodBEnd", periods.b.dateTo);

      const compareRes = await fetch(`/api/analysis/compare?${compareParams.toString()}`);
      const compareData = (await compareRes.json()) as
        | CompareResponse
        | { ok: false; error: ApiError };

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
  const bankOptions = useMemo(() => overview?.bankIds || [], [overview?.bankIds]);
  const accountOptions = useMemo(
    () =>
      overview?.accountDisplayOptions ||
      (overview?.accountIds || []).map((accountId) => ({
        bankId: selectedBankId || "cba",
        accountId,
      })),
    [overview?.accountDisplayOptions, overview?.accountIds, selectedBankId]
  );

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);
    setSelectedBankId(parsed.bankId || "");
    setSelectedAccountId(parsed.accountId || "");

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });
    void fetchCompare(
      parsed.scopeMode,
      parsed.fileIds,
      parsed.bankId || "",
      parsed.accountId || ""
    );
  }, [fetchCompare]);

  useEffect(() => {
    if (scopeMode === "selected" && selectedFileIds.length === 0) return;
    void fetchCompare(scopeMode, selectedFileIds, selectedBankId, selectedAccountId);
  }, [scopeMode, selectedFileIds, selectedBankId, selectedAccountId, fetchCompare]);

  useEffect(() => {
    const params = buildScopeParams(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
    window.history.replaceState(null, "", `/phase3/compare?${params.toString()}`);
  }, [scopeMode, selectedFileIds, selectedBankId, selectedAccountId]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Compare View</h1>
          <p className="mt-1 text-sm text-slate-600">
            Period A vs Period B comparison driven by available periods in your dataset.
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

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
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

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Bank
              <select
                value={selectedBankId}
                onChange={(e) => setSelectedBankId(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">All banks</option>
                {bankOptions.map((bankId) => (
                  <option key={bankId} value={bankId}>
                    {bankId}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Account
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">All accounts</option>
                {accountOptions.map((option) => (
                  <option
                    key={`${option.bankId}:${option.accountId}`}
                    value={option.accountId}
                  >
                    {formatAccountOptionLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Compare Mode
              <select
                value={compareMode}
                onChange={(e) => setCompareMode(e.target.value as CompareMode)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="month_prev">Latest month vs previous available month</option>
                <option value="month_last_year">Latest month vs same month last year</option>
                <option value="quarter_prev">Latest quarter vs previous available quarter</option>
                <option value="year_prev">Latest year vs previous available year</option>
                <option value="custom_month">Custom (month vs month)</option>
              </select>
            </label>

            <div className="flex items-end lg:col-span-1">
              <button
                type="button"
                onClick={() =>
                  void fetchCompare(
                    scopeMode,
                    selectedFileIds,
                    selectedBankId,
                    selectedAccountId
                  )
                }
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
              {selectedBankId ? ` · bank ${selectedBankId}` : ""}
              {selectedAccountId ? ` · account ${selectedAccountId}` : ""}
            </div>
          )}

          {friendlyNote && !error && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {friendlyNote}
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
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Category Movers</h2>
            <span className="text-xs text-slate-500">{compareLabel}</span>
          </div>

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
