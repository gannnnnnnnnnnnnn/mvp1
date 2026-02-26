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
import {
  AccountDisplayOption,
  FileMeta,
  OverviewResponse,
  ApiError,
} from "@/app/phase3/_lib/types";
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

type BoundaryConfig = {
  version: 1;
  mode: "customAccounts";
  boundaryAccountIds: string[];
  accountAliases: Record<string, string>;
  lastUpdatedAt: string;
};

type KnownAccount = {
  bankId: string;
  accountId: string;
  accountName?: string;
  accountKey?: string;
  bsb?: string;
  accountNumber?: string;
  fileCount: number;
  dateRange?: { from: string; to: string };
};

type BoundaryResponse = {
  ok: true;
  config: BoundaryConfig;
  knownAccounts: KnownAccount[];
  needsSetup: boolean;
};

function formatAccountOptionLabel(option: AccountDisplayOption) {
  const head = option.accountName
    ? `${option.bankId.toUpperCase()} · ${option.accountName}`
    : `${option.bankId.toUpperCase()} · ${option.accountId}`;
  const tail = option.accountKey || option.accountId;
  return `${head} (${tail})`;
}

export default function Phase3DatasetHomePage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [boundary, setBoundary] = useState<BoundaryResponse | null>(null);
  const [boundaryModalOpen, setBoundaryModalOpen] = useState(false);
  const [boundaryDraft, setBoundaryDraft] = useState<string[]>([]);
  const [boundaryAliasDraft, setBoundaryAliasDraft] = useState<Record<string, string>>({});
  const [boundarySaving, setBoundarySaving] = useState(false);
  const [boundaryStatus, setBoundaryStatus] = useState("");
  const [showOnboardingBanner, setShowOnboardingBanner] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);

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
  const hasDatasetData = (overview?.availableMonths?.length || 0) > 0;

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

  async function fetchBoundary() {
    try {
      const res = await fetch("/api/analysis/boundary", { cache: "no-store" });
      const data = (await res.json()) as BoundaryResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setBoundary(data);
      setBoundaryDraft(data.config.boundaryAccountIds);
      setBoundaryAliasDraft(data.config.accountAliases || {});
    } catch {
      setError({ code: "BOUNDARY_FAILED", message: "Failed to load boundary config." });
    }
  }

  async function fetchOverview(
    nextScopeMode: ScopeMode,
    nextSelectedFileIds: string[],
    nextBankId: string,
    nextAccountId: string
  ) {
    setIsLoading(true);
    setError(null);

    try {
      const params = buildScopeParams(nextScopeMode, nextSelectedFileIds, {
        bankId: nextBankId || undefined,
        accountId: nextAccountId || undefined,
      });
      params.set("granularity", "month");
      const res = await fetch(`/api/analysis/overview?${params.toString()}`);
      const data = (await res.json()) as OverviewResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setOverview(null);
        setError(data.error);
        setInboxCount(0);
        return;
      }
      setOverview(data);
      const inboxParams = buildScopeParams(nextScopeMode, nextSelectedFileIds, {
        bankId: nextBankId || undefined,
        accountId: nextAccountId || undefined,
      });
      void fetch(`/api/analysis/inbox?${inboxParams.toString()}`, {
        cache: "no-store",
      })
        .then(async (res) => {
          const inboxData = (await res.json()) as
            | { ok: true; totals?: { unresolved?: number } }
            | { ok: false; error: ApiError };
          if (!inboxData.ok) {
            setInboxCount(0);
            return;
          }
          setInboxCount(Number(inboxData.totals?.unresolved || 0));
        })
        .catch(() => {
          setInboxCount(0);
        });
    } catch {
      setOverview(null);
      setError({ code: "FETCH_FAILED", message: "Failed to load dataset home data." });
      setInboxCount(0);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    const openBoundary =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("openBoundary") === "1";
    const fromOnboarding =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("onboarding") === "1";
    const parsed = parseScopeFromWindow();
    const normalizedIds =
      parsed.scopeMode === "selected" ? parsed.fileIds.slice(0, 1) : parsed.fileIds;
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(normalizedIds);
    setSelectedBankId(parsed.bankId || "");
    setSelectedAccountId(parsed.accountId || "");

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });

    void fetchOverview(
      parsed.scopeMode,
      normalizedIds,
      parsed.bankId || "",
      parsed.accountId || ""
    );
    void fetchBoundary();
    setShowOnboardingBanner(fromOnboarding);
    if (openBoundary) {
      setBoundaryModalOpen(true);
    }
  }, []);

  useEffect(() => {
    pushScopeIntoUrl(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
  }, [scopeMode, selectedFileIds, selectedBankId, selectedAccountId]);

  const latestMonth = useMemo(
    () => [...(overview?.availableMonths || [])].sort().at(-1) || "",
    [overview?.availableMonths]
  );
  const sortedFiles = useMemo(
    () => [...files].sort((a, b) => a.originalName.localeCompare(b.originalName)),
    [files]
  );
  const selectedFileId = selectedFileIds[0] || "";
  const latestYear = useMemo(() => {
    const years = [...(overview?.availableYears || [])].sort();
    if (years.length > 0) return years[years.length - 1];
    const datasetMax = overview?.datasetDateMax || "";
    const parsedYear = datasetMax.slice(0, 4);
    if (/^\d{4}$/.test(parsedYear)) return parsedYear;
    return new Date().getUTCFullYear().toString();
  }, [overview?.availableYears, overview?.datasetDateMax]);

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
  const boundaryNeedsSetup = Boolean(
    boundary && (boundary.needsSetup || boundary.config.boundaryAccountIds.length === 0)
  );

  function toggleBoundaryAccount(accountId: string) {
    setBoundaryDraft((prev) => {
      if (prev.includes(accountId)) {
        return prev.filter((id) => id !== accountId);
      }
      return [...prev, accountId].sort();
    });
  }

  async function saveBoundaryConfig() {
    setBoundarySaving(true);
    setBoundaryStatus("");
    try {
      const res = await fetch("/api/analysis/boundary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boundaryAccountIds: boundaryDraft,
          accountAliases: boundaryAliasDraft,
        }),
      });
      const data = (await res.json()) as BoundaryResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setBoundaryStatus(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setBoundary(data);
      setBoundaryDraft(data.config.boundaryAccountIds);
      setBoundaryAliasDraft(data.config.accountAliases || {});
      setBoundaryStatus("Saved.");
      setBoundaryModalOpen(false);
    } catch {
      setBoundaryStatus("Failed to save boundary config.");
    } finally {
      setBoundarySaving(false);
    }
  }

  function applyScopeAndFetch(
    nextScopeMode: ScopeMode,
    nextFileIds: string[],
    nextBankId = selectedBankId,
    nextAccountId = selectedAccountId
  ) {
    setScopeMode(nextScopeMode);
    setSelectedFileIds(nextFileIds);
    setSelectedBankId(nextBankId);
    setSelectedAccountId(nextAccountId);
    void fetchOverview(nextScopeMode, nextFileIds, nextBankId, nextAccountId);
  }

  const navigateToMonth = (month: string) => {
    const params = buildScopeParams(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
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
            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
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
              <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
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

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
              Bank
              <select
                value={selectedBankId}
                onChange={(e) => {
                  const nextBankId = e.target.value;
                  applyScopeAndFetch(scopeMode, selectedFileIds, nextBankId, selectedAccountId);
                }}
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
                onChange={(e) => {
                  const nextAccountId = e.target.value;
                  applyScopeAndFetch(scopeMode, selectedFileIds, selectedBankId, nextAccountId);
                }}
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

            <div className="flex items-end lg:col-span-2">
              <button
                type="button"
                onClick={() =>
                  void fetchOverview(
                    scopeMode,
                    selectedFileIds,
                    selectedBankId,
                    selectedAccountId
                  )
                }
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

        {showOnboardingBanner && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">
                  Uncertain transfers are never offset automatically. Review them in Inbox.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="/inbox"
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  Open Inbox
                </a>
                <button
                  type="button"
                  onClick={() => setShowOnboardingBanner(false)}
                  className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </section>
        )}

        {boundaryNeedsSetup && (
          <section className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">Select boundary accounts</div>
                <div className="text-xs text-blue-800">
                  Used to offset internal transfers. Accounts inside boundary can offset each other.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setBoundaryModalOpen(true)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                Configure
              </button>
            </div>
          </section>
        )}

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
              {selectedBankId ? ` · bank ${selectedBankId}` : ""}
              {selectedAccountId ? ` · account ${selectedAccountId}` : ""}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
              {latestMonth && (
                <a
                  href={`/phase3/period?${(() => {
                    const params = buildScopeParams(scopeMode, selectedFileIds, {
                      bankId: selectedBankId || undefined,
                      accountId: selectedAccountId || undefined,
                    });
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
                href={`/phase3/compare?${buildScopeParams(scopeMode, selectedFileIds, {
                  bankId: selectedBankId || undefined,
                  accountId: selectedAccountId || undefined,
                }).toString()}`}
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
              <details className="relative">
                <summary className="list-none cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
                  Export
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-lg border border-slate-200 bg-white p-2 text-xs shadow-sm">
                  <a
                    href={`/api/analysis/export?${(() => {
                      const params = buildScopeParams(scopeMode, selectedFileIds, {
                        bankId: selectedBankId || undefined,
                        accountId: selectedAccountId || undefined,
                      });
                      params.set("type", "transactions");
                      params.set("format", "csv");
                      params.set("showTransfers", "excludeMatched");
                      return params.toString();
                    })()}`}
                    className="block rounded px-2 py-1.5 text-slate-700 hover:bg-slate-100"
                  >
                    Transactions CSV
                  </a>
                  <a
                    href={`/api/analysis/export?${(() => {
                      const params = buildScopeParams(scopeMode, selectedFileIds, {
                        bankId: selectedBankId || undefined,
                        accountId: selectedAccountId || undefined,
                      });
                      params.set("type", "annual");
                      params.set("format", "csv");
                      params.set("year", latestYear);
                      params.set("showTransfers", "excludeMatched");
                      return params.toString();
                    })()}`}
                    className="block rounded px-2 py-1.5 text-slate-700 hover:bg-slate-100"
                  >
                    Annual summary CSV ({latestYear})
                  </a>
                </div>
              </details>
              <a
                href={`/inbox?${buildScopeParams(scopeMode, selectedFileIds, {
                  bankId: selectedBankId || undefined,
                  accountId: selectedAccountId || undefined,
                }).toString()}`}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Inbox
                <span className="rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-600">
                  {inboxCount}
                </span>
              </a>
            </div>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Monthly Cashflow Trend</h2>
          <p className="mt-1 text-sm text-slate-600">
            Tip: Click a month bar to open detailed Period analysis.
          </p>
          <div className="mt-4 h-64 w-full rounded-xl border border-slate-100 bg-slate-50/50 p-2">
            {chartSeries.length > 0 ? (
              <div className="group relative h-full w-full cursor-pointer">
                <div className="pointer-events-none absolute right-3 top-3 z-10 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-medium text-blue-700 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                  Open period →
                </div>
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
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-sm text-slate-500">Upload PDFs first to see trend data here.</p>
                <a
                  href="/onboarding"
                  className="inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
                >
                  Go to Onboarding
                </a>
              </div>
            )}
          </div>
        </section>

        {!hasDatasetData && (
          <section className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-medium">No report data yet</div>
                <div className="text-xs text-blue-800">
                  Upload PDFs first, then return to Report for analysis.
                </div>
              </div>
              <a
                href="/onboarding"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                Start Onboarding
              </a>
            </div>
          </section>
        )}

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

        {boundaryModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
            <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-900">Boundary Accounts</h2>
                <button
                  type="button"
                  onClick={() => setBoundaryModalOpen(false)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
              <p className="mt-1 text-sm text-slate-600">
                Select account IDs inside your reporting boundary.
              </p>

              <div className="mt-3 max-h-72 space-y-2 overflow-y-auto rounded border border-slate-200 bg-slate-50 p-3">
                {(boundary?.knownAccounts || []).map((account) => {
                  const checked = boundaryDraft.includes(account.accountId);
                  return (
                    <label
                      key={`${account.bankId}:${account.accountId}`}
                      className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 bg-white px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-slate-300"
                        checked={checked}
                        onChange={() => toggleBoundaryAccount(account.accountId)}
                      />
                      <span className="text-xs text-slate-700">
                        <span className="font-medium text-slate-900">
                          {account.bankId.toUpperCase()} ·{" "}
                          {account.accountName || account.accountId}
                        </span>
                        {account.accountKey ? (
                          <span className="ml-2 text-slate-500">
                            ({account.accountKey})
                          </span>
                        ) : null}
                        <span className="ml-2 text-slate-500">
                          files: {account.fileCount}
                          {account.dateRange
                            ? ` · ${account.dateRange.from} → ${account.dateRange.to}`
                            : ""}
                        </span>
                        <span className="mt-1 block">
                          <input
                            type="text"
                            value={boundaryAliasDraft[account.accountId] || ""}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setBoundaryAliasDraft((prev) => ({
                                ...prev,
                                [account.accountId]: e.target.value,
                              }))
                            }
                            placeholder="Alias (optional, used for transfer name matching)"
                            className="mt-1 h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-700"
                          />
                        </span>
                      </span>
                    </label>
                  );
                })}
                {boundary && boundary.knownAccounts.length === 0 && (
                  <p className="text-xs text-slate-500">No known accounts yet. Upload and parse files first.</p>
                )}
              </div>

              {boundaryStatus && (
                <p className="mt-2 text-xs text-slate-600">{boundaryStatus}</p>
              )}

              <div className="mt-4 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setBoundaryModalOpen(false)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void saveBoundaryConfig()}
                  disabled={boundarySaving}
                  className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                >
                  {boundarySaving ? "Saving..." : "Save"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
