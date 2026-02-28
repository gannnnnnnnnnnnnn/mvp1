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
} from "@/app/phase3/_lib/timeNav";
import {
  formatAccountLabel,
  formatAccountSupportText,
  isUnknownAccountIdentity,
} from "@/lib/boundary/accountLabels";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Modal,
  MotionCard,
  SectionHeader,
  StatTile,
  Toast,
} from "@/components/ui";

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
  sampleFileName?: string;
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
  const head = `${option.bankId.toUpperCase()} · ${formatAccountLabel(option)}`;
  const tail = formatAccountSupportText(option);
  return tail ? `${head} (${tail})` : head;
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
  const [excludeMatchedTransfers, setExcludeMatchedTransfers] = useState(true);
  const [offsetModalOpen, setOffsetModalOpen] = useState(false);

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
    nextAccountId: string,
    nextShowTransfers = excludeMatchedTransfers ? "excludeMatched" : "all"
  ) {
    setIsLoading(true);
    setError(null);

    try {
      const params = buildScopeParams(nextScopeMode, nextSelectedFileIds, {
        bankId: nextBankId || undefined,
        accountId: nextAccountId || undefined,
      });
      params.set("granularity", "month");
      params.set("showTransfers", nextShowTransfers);
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
    const search = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const showTransfers = search?.get("showTransfers") === "all" ? "all" : "excludeMatched";
    const normalizedIds =
      parsed.scopeMode === "selected" ? parsed.fileIds.slice(0, 1) : parsed.fileIds;
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(normalizedIds);
    setSelectedBankId(parsed.bankId || "");
    setSelectedAccountId(parsed.accountId || "");
    setExcludeMatchedTransfers(showTransfers !== "all");

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load files list." });
    });

    void fetchOverview(
      parsed.scopeMode,
      normalizedIds,
      parsed.bankId || "",
      parsed.accountId || "",
      showTransfers
    );
    void fetchBoundary();
    setShowOnboardingBanner(fromOnboarding);
    if (openBoundary) {
      setBoundaryModalOpen(true);
    }
  }, []);

  useEffect(() => {
    const params = buildScopeParams(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
    params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
    const base = window.location.pathname;
    const next = params.toString();
    const url = next ? `${base}?${next}` : base;
    window.history.replaceState(null, "", url);
  }, [scopeMode, selectedFileIds, selectedBankId, selectedAccountId, excludeMatchedTransfers]);

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
  const uncertainCount = overview?.transferStats?.uncertainPairsCount || 0;
  const offsetStatus = excludeMatchedTransfers
    ? uncertainCount > 0
      ? {
          tone: "border-amber-200 bg-amber-50 text-amber-900",
          message: "Some transfers are uncertain and are included for safety. Review them in Inbox.",
        }
      : {
          tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
          message: "Matched internal transfers are excluded.",
        }
    : {
        tone: "border-slate-200 bg-slate-50 text-slate-800",
        message: "Showing raw cashflow including internal transfers.",
      };

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
    void fetchOverview(
      nextScopeMode,
      nextFileIds,
      nextBankId,
      nextAccountId,
      excludeMatchedTransfers ? "excludeMatched" : "all"
    );
  }

  function applyTransferMode(nextExcludeMatchedTransfers: boolean) {
    setExcludeMatchedTransfers(nextExcludeMatchedTransfers);
    setOffsetModalOpen(false);
    void fetchOverview(
      scopeMode,
      selectedFileIds,
      selectedBankId,
      selectedAccountId,
      nextExcludeMatchedTransfers ? "excludeMatched" : "all"
    );
  }

  const navigateToMonth = (month: string) => {
    const params = buildScopeParams(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
    params.set("type", "month");
    params.set("key", month);
    params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
    window.location.href = `/phase3/period?${params.toString()}`;
  };

  return (
    <main className="px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <MotionCard>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-1 text-xs font-medium">
                <a href="/phase3" className="rounded-full bg-slate-900 px-4 py-2 text-white">
                  Overview
                </a>
                <a
                  href={`/phase3/period?${(() => {
                    const params = buildScopeParams(scopeMode, selectedFileIds, {
                      bankId: selectedBankId || undefined,
                      accountId: selectedAccountId || undefined,
                    });
                    if (latestMonth) {
                      params.set("type", "month");
                      params.set("key", latestMonth);
                    }
                    params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
                    return params.toString();
                  })()}`}
                  className="rounded-full px-4 py-2 text-slate-600 transition hover:text-slate-900"
                >
                  Period
                </a>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {latestMonth ? (
                <ButtonLink
                  href={`/phase3/period?${(() => {
                    const params = buildScopeParams(scopeMode, selectedFileIds, {
                      bankId: selectedBankId || undefined,
                      accountId: selectedAccountId || undefined,
                    });
                    params.set("type", "month");
                    params.set("key", latestMonth);
                    params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
                    return params.toString();
                  })()}`}
                  size="sm"
                >
                  Open latest month
                </ButtonLink>
              ) : null}
              <ButtonLink
                href={`/phase3/period?${(() => {
                  const params = buildScopeParams(scopeMode, selectedFileIds, {
                    bankId: selectedBankId || undefined,
                    accountId: selectedAccountId || undefined,
                  });
                  if (latestMonth) {
                    params.set("type", "month");
                    params.set("key", latestMonth);
                  }
                  params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
                  return params.toString();
                })()}`}
                variant="secondary"
                size="sm"
              >
                Pick a period
              </ButtonLink>
            </div>
          </div>

          <SectionHeader
            eyebrow="Report"
            title="Your cashflow dashboard"
            description="A calm overview across uploaded statements, with clear next actions when something still needs review."
          />

          <div className="mt-6 grid gap-4 lg:grid-cols-12">
            <label className="space-y-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 lg:col-span-3">
              Scope
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
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
              >
                <option value="all">All files</option>
                <option value="selected">Specific file</option>
              </select>
            </label>

            {scopeMode === "selected" && (
              <label className="space-y-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 lg:col-span-3">
                File
                <select
                  value={selectedFileId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    applyScopeAndFetch("selected", nextId ? [nextId] : []);
                  }}
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
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

            <label className="space-y-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 lg:col-span-2">
              Bank
              <select
                value={selectedBankId}
                onChange={(e) => {
                  const nextBankId = e.target.value;
                  applyScopeAndFetch(scopeMode, selectedFileIds, nextBankId, selectedAccountId);
                }}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">All banks</option>
                {bankOptions.map((bankId) => (
                  <option key={bankId} value={bankId}>
                    {bankId}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-2 text-xs font-medium uppercase tracking-[0.18em] text-slate-400 lg:col-span-2">
              Account
              <select
                value={selectedAccountId}
                onChange={(e) => {
                  const nextAccountId = e.target.value;
                  applyScopeAndFetch(scopeMode, selectedFileIds, selectedBankId, nextAccountId);
                }}
                className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
              >
                <option value="">All accounts</option>
                {accountOptions.map((option) => (
                  <option key={`${option.bankId}:${option.accountId}`} value={option.accountId}>
                    {formatAccountOptionLabel(option)}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end lg:col-span-2">
              <Button
                type="button"
                className="w-full"
                onClick={() =>
                  void fetchOverview(
                    scopeMode,
                    selectedFileIds,
                    selectedBankId,
                    selectedAccountId
                  )
                }
                disabled={isLoading || (scopeMode === "selected" && !selectedFileId)}
              >
                {isLoading ? "Loading..." : "Refresh"}
              </Button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-2 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-3">
            <Badge tone="neutral">Uploads {files.length}</Badge>
            <Badge tone="blue">Inbox {inboxCount}</Badge>
            <Badge tone="neutral">
              Mode {excludeMatchedTransfers ? "Conservative" : "Raw"}
            </Badge>
            <Badge tone="neutral">
              {scopeMode === "all" ? "All files" : selectedFileNames.join(", ") || "Selected file"}
            </Badge>
            {selectedBankId ? <Badge tone="neutral">Bank {selectedBankId}</Badge> : null}
            {selectedAccountId ? <Badge tone="neutral">Account {selectedAccountId}</Badge> : null}
            <div className="ml-auto flex flex-wrap gap-2">
              <details className="relative">
                <summary className="list-none">
                  <Button variant="secondary" size="sm">Export</Button>
                </summary>
                <div className="absolute right-0 z-20 mt-2 w-56 rounded-[20px] border border-slate-200 bg-white p-2 shadow-lg">
                  <a
                    href={`/api/analysis/export?${(() => {
                      const params = buildScopeParams(scopeMode, selectedFileIds, {
                        bankId: selectedBankId || undefined,
                        accountId: selectedAccountId || undefined,
                      });
                      params.set("type", "transactions");
                      params.set("format", "csv");
                      params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
                      return params.toString();
                    })()}`}
                    className="block rounded-2xl px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
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
                      params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");
                      return params.toString();
                    })()}`}
                    className="block rounded-2xl px-3 py-2 text-sm text-slate-700 transition hover:bg-slate-50"
                  >
                    Annual summary CSV ({latestYear})
                  </a>
                </div>
              </details>
              <ButtonLink
                href={`/inbox?${buildScopeParams(scopeMode, selectedFileIds, {
                  bankId: selectedBankId || undefined,
                  accountId: selectedAccountId || undefined,
                }).toString()}`}
                variant="secondary"
                size="sm"
              >
                Open Inbox
              </ButtonLink>
            </div>
          </div>
        </MotionCard>

        <Toast
          message={error ? `${error.code}: ${error.message}` : boundaryStatus}
          tone={error ? "error" : boundaryStatus ? "success" : "neutral"}
        />

        {showOnboardingBanner ? (
          <Card className="border-amber-200 bg-amber-50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-sm text-amber-900">
                Uncertain transfers are never offset automatically. Review them in Inbox.
              </div>
              <div className="flex gap-2">
                <ButtonLink href="/inbox" variant="secondary" size="sm">
                  Open Inbox
                </ButtonLink>
                <Button variant="ghost" size="sm" onClick={() => setShowOnboardingBanner(false)}>
                  Dismiss
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {boundaryNeedsSetup ? (
          <Card className="border-blue-200 bg-blue-50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-blue-900">Boundary needs attention</div>
                <div className="mt-1 text-sm text-blue-800">
                  Choose which accounts sit inside your world so internal transfers can offset correctly.
                </div>
              </div>
              <Button size="sm" onClick={() => setBoundaryModalOpen(true)}>
                Configure boundary
              </Button>
            </div>
          </Card>
        ) : null}

        <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StatTile label="Spending" value={CURRENCY.format(overview?.totals.spend || 0)} tone="red" />
          <StatTile label="Income" value={CURRENCY.format(overview?.totals.income || 0)} tone="green" />
          <StatTile
            label="Net"
            value={CURRENCY.format(overview?.totals.net || 0)}
            tone={(overview?.totals.net || 0) >= 0 ? "green" : "red"}
          />
        </section>

        <Card>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <Badge tone="neutral">
                Mode {excludeMatchedTransfers ? "Conservative (Recommended)" : "Raw (Show all)"}
              </Badge>
              <Badge tone="green">
                Matched excluded {overview?.transferStats?.internalOffsetPairsCount || 0}
              </Badge>
              <ButtonLink
                href={`/inbox?${buildScopeParams(scopeMode, selectedFileIds, {
                  bankId: selectedBankId || undefined,
                  accountId: selectedAccountId || undefined,
                }).toString()}`}
                variant="secondary"
                size="sm"
              >
                Uncertain {overview?.transferStats?.uncertainPairsCount || 0}
              </ButtonLink>
            </div>
            <Button variant="secondary" size="sm" onClick={() => setOffsetModalOpen(true)}>
              Change...
            </Button>
          </div>
          <div className={`mt-4 rounded-[24px] border px-4 py-3 text-sm ${offsetStatus.tone}`}>
            {offsetStatus.message}
          </div>
        </Card>

        <MotionCard>
          <SectionHeader
            eyebrow="Coverage"
            title="Dataset coverage"
            description={`${overview?.datasetDateMin || "-"} → ${overview?.datasetDateMax || "-"} · ${overview?.availableMonths?.length || 0} months · ${overview?.filesIncludedCount || 0} files`}
          />
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              {scopeMode === "all" ? "All files" : selectedFileNames.join(", ") || "Selected files"}
            </Badge>
            {selectedBankId ? <Badge tone="neutral">Bank {selectedBankId}</Badge> : null}
            {selectedAccountId ? <Badge tone="neutral">Account {selectedAccountId}</Badge> : null}
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs text-slate-600">
              Open a month from the chart below, or switch to Period view.
            </span>
          </div>
        </MotionCard>

        <MotionCard>
          <SectionHeader
            eyebrow="Trend"
            title="Monthly cashflow"
            description="Click any month to open the detailed period view."
          />
          <div className="mt-5 h-72 rounded-[28px] border border-slate-200 bg-slate-50 p-3">
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
                      if (month) navigateToMonth(month);
                    }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#64748b" }} />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <RechartsTooltip
                      contentStyle={{
                        borderRadius: 16,
                        borderColor: "#e2e8f0",
                        boxShadow: "0 16px 40px rgba(15, 23, 42, 0.08)",
                      }}
                      formatter={(value, name) => {
                        if (name === "txCount") return [String(value), "Transactions"];
                        const numeric = typeof value === "number" ? value : Number(value || 0);
                        const label = name === "income" ? "Income" : name === "spend" ? "Spending" : "Net";
                        return [CURRENCY.format(numeric), label];
                      }}
                      labelFormatter={(label, payload) => {
                        const txCount =
                          payload?.[0] &&
                          "payload" in payload[0] &&
                          typeof payload[0].payload?.txCount === "number"
                            ? payload[0].payload.txCount
                            : 0;
                        return `${label} · ${txCount} transactions`;
                      }}
                    />
                    <Bar dataKey="income" fill="#10b981" radius={[6, 6, 0, 0]} barSize={12} />
                    <Bar dataKey="spend" fill="#f43f5e" radius={[6, 6, 0, 0]} barSize={12} />
                    <Line dataKey="net" stroke="#2563eb" strokeWidth={2} dot={false} type="monotone" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <EmptyState
                title="No report data yet"
                body="Upload PDFs first, then return here to see your monthly trend and category breakdown."
                action={<ButtonLink href="/onboarding">Start onboarding</ButtonLink>}
              />
            )}
          </div>
        </MotionCard>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <MotionCard>
            <SectionHeader
              eyebrow="Categories"
              title="Spending by category"
              description="Your biggest categories across the current selection."
            />
            <div className="mt-5 space-y-3">
              {(overview?.spendByCategory || []).slice(0, 8).map((category) => (
                <div key={category.category} className="rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{category.category}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {(category.share * 100).toFixed(1)}% of spending
                      </div>
                    </div>
                    <div className="text-sm font-medium text-slate-900">{CURRENCY.format(category.amount)}</div>
                  </div>
                </div>
              ))}
              {(overview?.spendByCategory || []).length === 0 ? (
                <div className="text-sm text-slate-500">No category data yet.</div>
              ) : null}
            </div>
          </MotionCard>

          <MotionCard>
            <SectionHeader
              eyebrow="Help"
              title="A few useful reminders"
              description="Short explanations for the choices that most affect totals."
            />
            <div className="mt-5 space-y-3">
              <Card className="rounded-[24px] bg-slate-50 p-4 shadow-none">
                <div className="text-sm font-semibold text-slate-900">What is Boundary?</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Boundary defines which accounts are inside your own money world. Transfers within that boundary can offset each other.
                </p>
              </Card>
              <Card className="rounded-[24px] bg-slate-50 p-4 shadow-none">
                <div className="text-sm font-semibold text-slate-900">Why uncertain transfers stay in totals</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  If a transfer match is not clear enough, it stays counted so the report never hides real spending or income by mistake.
                </p>
              </Card>
              <Card className="rounded-[24px] bg-slate-50 p-4 shadow-none">
                <div className="text-sm font-semibold text-slate-900">Where to review issues</div>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Open Inbox to review merchants, transfer notes, and parsing issues that still need a decision.
                </p>
              </Card>
            </div>
          </MotionCard>
        </section>

        {overview ? (
          <Card className="bg-slate-50">
            <details>
              <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">
                Details
              </summary>
              <div className="mt-3 grid gap-2 text-sm text-slate-500 sm:grid-cols-2">
                <div>Template: {overview.templateType}</div>
                <div>Review needed: {String(overview.needsReview)}</div>
                <div>
                  Continuity: {(overview.quality?.balanceContinuityPassRate || 0).toFixed(3)}
                </div>
                <div>Checked rows: {overview.quality?.balanceContinuityChecked || 0}</div>
                <div>Duplicates removed: {overview.dedupedCount || 0}</div>
              </div>
            </details>
          </Card>
        ) : null}
      </div>

      <Modal
        open={offsetModalOpen}
        onClose={() => setOffsetModalOpen(false)}
        title="Offset mode"
        subtitle="Choose whether Report hides matched internal transfers or shows raw cashflow."
      >
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => applyTransferMode(true)}
            className={`w-full rounded-2xl border p-4 text-left transition ${
              excludeMatchedTransfers
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-slate-50 text-slate-900 hover:border-slate-300 hover:bg-white"
            }`}
          >
            <div className="text-sm font-semibold">Conservative (Recommended)</div>
            <div className={`mt-1 text-sm ${excludeMatchedTransfers ? "text-slate-200" : "text-slate-600"}`}>
              Exclude matched internal transfers. Uncertain transfers stay included for safety.
            </div>
          </button>
          <button
            type="button"
            onClick={() => applyTransferMode(false)}
            className={`w-full rounded-2xl border p-4 text-left transition ${
              !excludeMatchedTransfers
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-slate-50 text-slate-900 hover:border-slate-300 hover:bg-white"
            }`}
          >
            <div className="text-sm font-semibold">Raw (Show all)</div>
            <div className={`mt-1 text-sm ${!excludeMatchedTransfers ? "text-slate-200" : "text-slate-600"}`}>
              Keep matched internal transfers inside the totals so you can inspect the raw movement.
            </div>
          </button>
        </div>
      </Modal>

      <Modal
        open={boundaryModalOpen}
        onClose={() => setBoundaryModalOpen(false)}
        title="Boundary accounts"
        subtitle="Select the accounts that belong inside your reporting boundary."
        footer={
          <>
            <Button variant="secondary" onClick={() => setBoundaryModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void saveBoundaryConfig()} disabled={boundarySaving}>
              {boundarySaving ? "Saving..." : "Save"}
            </Button>
          </>
        }
      >
        <div className="max-h-72 space-y-3 overflow-y-auto">
          {(boundary?.knownAccounts || []).map((account) => {
            const checked = boundaryDraft.includes(account.accountId);
            return (
              <label
                key={`${account.bankId}:${account.accountId}`}
                className="flex cursor-pointer items-start gap-3 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4"
              >
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-slate-300"
                  checked={checked}
                  onChange={() => toggleBoundaryAccount(account.accountId)}
                />
                <div className="min-w-0 flex-1 text-sm text-slate-700">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">
                      {account.bankId.toUpperCase()} ·{" "}
                      {formatAccountLabel({
                        ...account,
                        alias: boundaryAliasDraft[account.accountId],
                      })}
                    </span>
                    {isUnknownAccountIdentity(account) ? (
                      <Badge tone="amber">Account details incomplete</Badge>
                    ) : null}
                  </div>
                  <div className="mt-1 text-slate-500">
                    {formatAccountSupportText({
                      ...account,
                      alias: boundaryAliasDraft[account.accountId],
                    })}
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    {account.fileCount} files
                    {account.dateRange ? ` · ${account.dateRange.from} → ${account.dateRange.to}` : ""}
                  </div>
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
                    placeholder="Rename account (optional)"
                    className="mt-3 h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
                  />
                </div>
              </label>
            );
          })}
          {boundary && boundary.knownAccounts.length === 0 ? (
            <div className="text-sm text-slate-500">No account details found yet. Upload and parse files first.</div>
          ) : null}
        </div>
      </Modal>
    </main>
  );
}
