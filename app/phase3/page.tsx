"use client";

import { useEffect, useMemo, useState } from "react";
import { FileMeta, OverviewResponse, ApiError } from "@/app/phase3/_lib/types";
import {
  ScopeMode,
  buildScopeParams,
  parseScopeFromWindow,
  pushScopeIntoUrl,
} from "@/app/phase3/_lib/timeNav";

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

export default function Phase3DatasetHomePage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const selectedFileNames = useMemo(
    () =>
      selectedFileIds
        .map((id) => files.find((f) => f.id === id)?.originalName)
        .filter(Boolean) as string[],
    [files, selectedFileIds]
  );
  const datasetSeries = useMemo(
    () => overview?.datasetMonthlySeries || [],
    [overview?.datasetMonthlySeries]
  );
  const maxDatasetBar = useMemo(
    () =>
      Math.max(
        0,
        ...datasetSeries.map((row) => Math.max(row.income, row.spend, Math.abs(row.net)))
      ),
    [datasetSeries]
  );

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

  async function fetchOverview(nextScopeMode: ScopeMode, nextSelectedFileIds: string[]) {
    setIsLoading(true);
    setError(null);

    try {
      const params = buildScopeParams(nextScopeMode, nextSelectedFileIds);
      params.set("granularity", "month");
      const res = await fetch(`/api/analysis/overview?${params.toString()}`);
      const data = (await res.json()) as OverviewResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setOverview(null);
        setError(data.error);
        return;
      }
      setOverview(data);
    } catch {
      setOverview(null);
      setError({ code: "FETCH_FAILED", message: "Failed to load dataset home data." });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });

    void fetchOverview(parsed.scopeMode, parsed.fileIds);
  }, []);

  useEffect(() => {
    pushScopeIntoUrl(scopeMode, selectedFileIds);
  }, [scopeMode, selectedFileIds]);

  const monthChips = [...(overview?.availableMonths || [])].sort((a, b) => b.localeCompare(a));

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-semibold text-slate-900">Phase3 Dataset Home</h1>
          <p className="mt-2 text-sm text-slate-600">
            Dataset-first navigation for CommBank statements. Default mode uses all files.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
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

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-6">
              Files (secondary)
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

            <div className="flex items-end lg:col-span-3">
              <button
                type="button"
                onClick={() => void fetchOverview(scopeMode, selectedFileIds)}
                disabled={isLoading || (scopeMode === "selected" && selectedFileIds.length === 0)}
                className="h-10 w-full rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isLoading ? "Loading..." : "Refresh Dataset"}
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

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Dataset Coverage</h2>
          <p className="mt-2 text-sm text-slate-600">
            {overview?.datasetDateMin || "-"} → {overview?.datasetDateMax || "-"} · Months: {overview?.availableMonths?.length || 0} · Files: {overview?.filesIncludedCount || 0}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Selected file names: {selectedFileNames.length ? selectedFileNames.join(", ") : "All files"}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href={`/phase3/compare?${buildScopeParams(scopeMode, selectedFileIds).toString()}`}
              className="rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
            >
              Open Compare View
            </a>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Monthly Cashflow Trend</h2>
          <p className="mt-1 text-sm text-slate-600">
            Income / spend / net across the full selected dataset.
          </p>
          <div className="mt-4 space-y-3">
            {datasetSeries.map((row) => (
              <div key={row.month}>
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span className="font-medium text-slate-800">{row.month}</span>
                  <span>{row.transactionIds.length} tx</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-slate-100">
                    <div
                      className="h-2 rounded-full bg-emerald-500"
                      style={{
                        width:
                          maxDatasetBar > 0
                            ? `${Math.max(2, (row.income / maxDatasetBar) * 100)}%`
                            : "0%",
                      }}
                    />
                  </div>
                  <span className="w-20 text-right text-[11px] text-slate-600">
                    {CURRENCY.format(row.income)}
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 rounded-full bg-slate-100">
                    <div
                      className="h-2 rounded-full bg-rose-500"
                      style={{
                        width:
                          maxDatasetBar > 0
                            ? `${Math.max(2, (row.spend / maxDatasetBar) * 100)}%`
                            : "0%",
                      }}
                    />
                  </div>
                  <span className="w-20 text-right text-[11px] text-slate-600">
                    {CURRENCY.format(row.spend)}
                  </span>
                </div>
              </div>
            ))}
            {!datasetSeries.length && (
              <p className="text-sm text-slate-500">No monthly cashflow points available.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Period Navigation</h2>
          <p className="mt-1 text-sm text-slate-600">Click a month to open Specific Period View.</p>
          <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
            {monthChips.map((month) => {
              const params = buildScopeParams(scopeMode, selectedFileIds);
              params.set("type", "month");
              params.set("key", month);
              return (
                <a
                  key={month}
                  href={`/phase3/period?${params.toString()}`}
                  className="rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-center text-sm font-medium text-slate-800 hover:border-blue-300 hover:bg-blue-50"
                >
                  {month}
                </a>
              );
            })}
            {monthChips.length === 0 && (
              <div className="col-span-full rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-500">
                No month data available in current dataset scope.
              </div>
            )}
          </div>
        </section>

        {overview && (
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-500">
            <div className="mb-1 font-medium uppercase tracking-wide text-slate-500">Debug</div>
            <div>templateType: {overview.templateType}</div>
            <div>needsReview: {String(overview.needsReview)}</div>
            <div>
              continuity: {(overview.quality?.balanceContinuityPassRate || 0).toFixed(3)} · checked: {overview.quality?.balanceContinuityChecked || 0}
            </div>
            <div>dedupedCount: {overview.dedupedCount || 0}</div>
          </section>
        )}
      </div>
    </main>
  );
}
