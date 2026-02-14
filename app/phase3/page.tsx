"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
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
  const chartSeries = useMemo(
    () =>
      datasetSeries.map((row) => ({
        ...row,
        txCount: row.transactionIds.length,
      })),
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
    const normalizedIds =
      parsed.scopeMode === "selected" ? parsed.fileIds.slice(0, 1) : parsed.fileIds;
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(normalizedIds);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });

    void fetchOverview(parsed.scopeMode, normalizedIds);
  }, []);

  useEffect(() => {
    pushScopeIntoUrl(scopeMode, selectedFileIds);
  }, [scopeMode, selectedFileIds]);

  const latestMonth = useMemo(
    () => [...(overview?.availableMonths || [])].sort().at(-1) || "",
    [overview?.availableMonths]
  );
  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.originalName.localeCompare(b.originalName)),
    [files]
  );
  const selectedFileId = selectedFileIds[0] || "";

  function applyScopeAndFetch(nextScopeMode: ScopeMode, nextFileIds: string[]) {
    setScopeMode(nextScopeMode);
    setSelectedFileIds(nextFileIds);
    void fetchOverview(nextScopeMode, nextFileIds);
  }

  const navigateToMonth = (month: string) => {
    const params = buildScopeParams(scopeMode, selectedFileIds);
    params.set("type", "month");
    params.set("key", month);
    window.location.href = `/phase3/period?${params.toString()}`;
  };

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-semibold text-slate-900">Phase3 Dataset Home</h1>
          <p className="mt-2 text-sm text-slate-600">
            Dataset-first navigation for CommBank statements. Default mode uses all files.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-12">
            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-4">
              Dataset scope
              <select
                value={scopeMode}
                onChange={(e) => {
                  const nextScope = e.target.value as ScopeMode;
                  if (nextScope === "all") {
                    applyScopeAndFetch("all", []);
                    return;
                  }
                  const fallbackId = selectedFileId || sortedFiles[0]?.id || "";
                  applyScopeAndFetch("selected", fallbackId ? [fallbackId] : []);
                }}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="all">All files</option>
                <option value="selected">Specific file</option>
              </select>
            </label>

            {scopeMode === "selected" && (
              <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-6">
                File
                <select
                  value={selectedFileId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    applyScopeAndFetch("selected", nextId ? [nextId] : []);
                  }}
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {sortedFiles.length === 0 ? (
                    <option value="">No files available</option>
                  ) : (
                    sortedFiles.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.originalName}
                      </option>
                    ))
                  )}
                </select>
              </label>
            )}

            <div className="flex items-end lg:col-span-2">
              <button
                type="button"
                onClick={() => void fetchOverview(scopeMode, selectedFileIds)}
                disabled={isLoading || (scopeMode === "selected" && !selectedFileId)}
                className="h-9 w-full rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
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

        <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          Note: Transfers are currently included in totals. Transfer offset matching will be added in the next milestone.
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Dataset Coverage</h2>
              <p className="mt-1 text-sm text-slate-600">
                {overview?.datasetDateMin || "-"} → {overview?.datasetDateMax || "-"} ·{" "}
                {overview?.availableMonths?.length || 0} months ·{" "}
                {overview?.filesIncludedCount || 0} files
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Scope: {scopeMode === "all" ? "All files" : selectedFileNames.join(", ") || "Selected files"}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {latestMonth && (
                <a
                  href={`/phase3/period?${(() => {
                    const params = buildScopeParams(scopeMode, selectedFileIds);
                    params.set("type", "month");
                    params.set("key", latestMonth);
                    return params.toString();
                  })()}`}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                >
                  Explore latest period
                </a>
              )}
              <a
                href={`/phase3/compare?${buildScopeParams(scopeMode, selectedFileIds).toString()}`}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Compare
              </a>
              <a
                href="/transactions"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Workspace
              </a>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Monthly Cashflow Trend</h2>
          <p className="mt-1 text-sm text-slate-600">
            Hover for details. Click a month to open Period view.
          </p>
          <div className="mt-4 h-64 w-full">
            {chartSeries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={chartSeries}
                  onClick={(state) => {
                    const month = (state as { activeLabel?: string })?.activeLabel;
                    if (month) {
                      navigateToMonth(month);
                    }
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                  <RechartsTooltip
                    contentStyle={{
                      borderRadius: 10,
                      borderColor: "#e2e8f0",
                      boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
                    }}
                    formatter={(value, name) => {
                      if (name === "txCount") {
                        return [String(value), "Tx count"];
                      }
                      const numeric =
                        typeof value === "number" ? value : Number(value || 0);
                      const label =
                        name === "income"
                          ? "Income"
                          : name === "spend"
                            ? "Spend"
                            : "Net";
                      return [CURRENCY.format(numeric), label];
                    }}
                    labelFormatter={(label, payload) => {
                      const txCount =
                        payload?.[0] &&
                        "payload" in payload[0] &&
                        typeof payload[0].payload?.txCount === "number"
                          ? payload[0].payload.txCount
                          : 0;
                      return `${label} · ${txCount} tx`;
                    }}
                  />
                  <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} barSize={12} />
                  <Bar dataKey="spend" fill="#f43f5e" radius={[4, 4, 0, 0]} barSize={12} />
                  <Line dataKey="net" stroke="#2563eb" strokeWidth={2} dot={false} type="monotone" />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <p className="text-sm text-slate-500">No monthly cashflow points available.</p>
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
