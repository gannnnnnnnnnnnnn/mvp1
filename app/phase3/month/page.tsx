"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Cell,
  Pie,
  PieChart,
  Tooltip,
} from "recharts";
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

type UnknownMerchantItem = {
  merchantNorm: string;
  displayName: string;
  txCount: number;
  totalSpend: number;
  lastDate: string;
  sampleTransactions: Array<{
    id: string;
    date: string;
    amount: number;
    descriptionRaw: string;
    fileId: string;
  }>;
};

type CategoryOption =
  | "Groceries"
  | "Dining"
  | "Food Delivery"
  | "Transport"
  | "Shopping"
  | "Bills&Utilities"
  | "Rent/Mortgage"
  | "Health"
  | "Pet"
  | "Entertainment"
  | "Travel"
  | "Income"
  | "Transfers"
  | "Fees/Interest/Bank"
  | "Other";

const CATEGORY_OPTIONS: CategoryOption[] = [
  "Groceries",
  "Dining",
  "Food Delivery",
  "Transport",
  "Shopping",
  "Bills&Utilities",
  "Rent/Mortgage",
  "Health",
  "Pet",
  "Entertainment",
  "Travel",
  "Income",
  "Transfers",
  "Fees/Interest/Bank",
  "Other",
];

function readMonthFromUrl() {
  if (typeof window === "undefined") return "";
  const query = new URLSearchParams(window.location.search);
  return (query.get("m") || "").trim();
}

function readOpenInboxFlag() {
  if (typeof window === "undefined") return false;
  const query = new URLSearchParams(window.location.search);
  return query.get("openInbox") === "1";
}

function readScopeLabel(value: unknown, fallback: ScopeMode) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

const PIE_COLORS = [
  "#0f766e",
  "#0369a1",
  "#2563eb",
  "#7c3aed",
  "#be185d",
  "#dc2626",
  "#ca8a04",
  "#059669",
];

type PieRow = {
  category: string;
  amount: number;
  share: number;
  transactionIds: string[];
  topMerchants?: Array<{ merchantNorm: string; amount: number }>;
  recentTransactions?: Array<{
    id: string;
    date: string;
    merchantNorm: string;
    amount: number;
    descriptionRaw: string;
  }>;
  fill: string;
};

function CategoryPieTooltip(props: {
  active?: boolean;
  payload?: Array<{ payload?: PieRow }>;
}) {
  if (!props.active || !props.payload || props.payload.length === 0) {
    return null;
  }

  const row = props.payload[0]?.payload;
  if (!row) return null;

  if (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    (window as { __PIE_TOOLTIP_DEBUG__?: boolean }).__PIE_TOOLTIP_DEBUG__
  ) {
    console.debug("[pie-tooltip]", row.category, row.amount, row.share);
  }

  return (
    <div className="w-[320px] rounded-lg border border-slate-300 bg-white p-2 text-[11px] text-slate-700 shadow-xl">
      <div className="font-semibold text-slate-900">{row.category}</div>
      <div className="mt-1">
        total {CURRENCY.format(row.amount)} · {row.transactionIds.length} tx · {PERCENT.format(row.share)}
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
  );
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
  const [drilldownEntered, setDrilldownEntered] = useState(false);
  const [drilldownRows, setDrilldownRows] = useState<DrilldownTx[]>([]);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState<ApiError | null>(null);
  const [triageItems, setTriageItems] = useState<UnknownMerchantItem[]>([]);
  const [triageLoading, setTriageLoading] = useState(false);
  const [triageError, setTriageError] = useState<ApiError | null>(null);
  const [selectedMerchant, setSelectedMerchant] = useState("");
  const [triageCategory, setTriageCategory] = useState<CategoryOption>("Other");
  const [triageSaving, setTriageSaving] = useState(false);
  const [triageStatus, setTriageStatus] = useState("");
  const [inboxOpen, setInboxOpen] = useState(false);
  const [openInboxRequested, setOpenInboxRequested] = useState(false);
  const inboxRef = useRef<HTMLElement | null>(null);

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
  const pieData = useMemo<PieRow[]>(
    () =>
      spendRows.map((row, index) => ({
        ...row,
        fill: PIE_COLORS[index % PIE_COLORS.length],
      })),
    [spendRows]
  );
  const selectedPieData = useMemo(
    () => pieData.filter((row) => row.category === selectedCategory),
    [pieData, selectedCategory]
  );
  const selectedMerchantItem = useMemo(
    () => triageItems.find((item) => item.merchantNorm === selectedMerchant) || null,
    [triageItems, selectedMerchant]
  );
  const unknownOtherSpend = useMemo(
    () => triageItems.reduce((sum, item) => sum + item.totalSpend, 0),
    [triageItems]
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

  const fetchTriage = useCallback(async () => {
    setTriageLoading(true);
    setTriageError(null);
    try {
      const params = buildScopeParams(scopeMode, selectedFileIds);
      const range = monthRange(month);
      if (range) {
        params.set("dateFrom", range.dateFrom);
        params.set("dateTo", range.dateTo);
      }
      const res = await fetch(`/api/analysis/triage/unknown-merchants?${params.toString()}`);
      const data = (await res.json()) as
        | { ok: true; unknownMerchants: UnknownMerchantItem[] }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setTriageItems([]);
        setTriageError(data.error);
        return;
      }
      setTriageItems(data.unknownMerchants);
      if (data.unknownMerchants.length > 0) {
        setSelectedMerchant((prev) =>
          prev && data.unknownMerchants.some((item) => item.merchantNorm === prev)
            ? prev
            : data.unknownMerchants[0].merchantNorm
        );
      } else {
        setSelectedMerchant("");
      }
    } catch {
      setTriageItems([]);
      setTriageError({ code: "FETCH_FAILED", message: "Failed to load Other Inbox data." });
    } finally {
      setTriageLoading(false);
    }
  }, [scopeMode, selectedFileIds, month]);

  const applyMerchantCategory = useCallback(async () => {
    if (!selectedMerchant) return;
    setTriageSaving(true);
    setTriageStatus("");
    try {
      const res = await fetch("/api/analysis/category-override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          merchantNorm: selectedMerchant,
          category: triageCategory,
          applyToMerchant: true,
        }),
      });
      const data = (await res.json()) as { ok: true } | { ok: false; error: ApiError };
      if (!data.ok) {
        setTriageStatus(`${data.error.code}: ${data.error.message}`);
        return;
      }

      setTriageStatus(`Applied ${triageCategory} to ${selectedMerchant}.`);
      await Promise.all([
        fetchMonthOverview(scopeMode, selectedFileIds, month),
        fetchTriage(),
      ]);
      if (selectedCategory) {
        await fetchCategoryDrilldown(selectedCategory);
      }
    } catch {
      setTriageStatus("Failed to apply merchant override.");
    } finally {
      setTriageSaving(false);
    }
  }, [
    selectedMerchant,
    triageCategory,
    scopeMode,
    selectedFileIds,
    month,
    fetchTriage,
    selectedCategory,
    fetchCategoryDrilldown,
  ]);

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    const initialMonth = readMonthFromUrl();
    const openInbox = readOpenInboxFlag();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);
    setMonth(initialMonth);
    setOpenInboxRequested(openInbox);
    setInboxOpen(openInbox);

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

  useEffect(() => {
    if (!selectedCategory) {
      setDrilldownEntered(false);
      return;
    }
    setDrilldownEntered(false);
    const timer = window.setTimeout(() => {
      setDrilldownEntered(true);
    }, 16);
    return () => window.clearTimeout(timer);
  }, [selectedCategory]);

  useEffect(() => {
    if (!month) return;
    void fetchTriage();
  }, [month, scopeMode, selectedFileIds, fetchTriage]);

  useEffect(() => {
    if (triageLoading || triageItems.length === 0) return;
    if (typeof window === "undefined") return;

    const sessionKey = "phase3_inbox_auto_opened";
    const alreadyOpened = window.sessionStorage.getItem(sessionKey) === "1";

    if (openInboxRequested || !alreadyOpened) {
      setInboxOpen(true);
      if (!alreadyOpened) {
        window.sessionStorage.setItem(sessionKey, "1");
      }
      if (openInboxRequested) {
        inboxRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
        setOpenInboxRequested(false);
      }
    }
  }, [triageItems.length, triageLoading, openInboxRequested]);

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

          <article className="overflow-visible rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Spend by Category</h2>
            <p className="mt-1 text-sm text-slate-600">Hover for details. Click to open embedded drilldown.</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-[240px_1fr]">
              <div className="relative mx-auto h-56 w-56 overflow-visible">
                <PieChart width={224} height={224}>
                  <Pie
                    data={pieData}
                    dataKey="amount"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={88}
                    isAnimationActive
                    animationDuration={200}
                    onClick={(_, index) => {
                      const next = pieData[index];
                      if (next) setSelectedCategory(next.category);
                    }}
                  >
                    {pieData.map((row) => (
                      <Cell key={row.category} fill={row.fill} />
                    ))}
                  </Pie>
                  <Pie
                    data={selectedPieData}
                    dataKey="amount"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={96}
                    isAnimationActive
                    animationDuration={200}
                    stroke="#ffffff"
                    strokeWidth={1}
                  >
                    {selectedPieData.map((row) => (
                      <Cell key={`${row.category}-active`} fill={row.fill} />
                    ))}
                  </Pie>
                  <Tooltip
                    content={<CategoryPieTooltip />}
                    wrapperStyle={{ zIndex: 70, pointerEvents: "none" }}
                  />
                </PieChart>
              </div>
              <div className="space-y-2">
                {spendRows.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    onClick={() => setSelectedCategory(row.category)}
                    aria-pressed={selectedCategory === row.category}
                    className={`group relative w-full rounded border px-3 py-2 text-left text-xs transition-all duration-200 ${selectedCategory === row.category ? "scale-[1.01] border-blue-300 bg-blue-50 shadow-sm ring-1 ring-blue-200" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50"}`}
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
          <article
            className={`rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition-all duration-200 ${
              drilldownEntered
                ? "translate-y-0 opacity-100"
                : "translate-y-1 opacity-90"
            }`}
          >
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

          <article ref={inboxRef} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Other Inbox (Month)</h2>
              <button
                type="button"
                onClick={() => setInboxOpen((prev) => !prev)}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
              >
                {inboxOpen ? "Collapse" : "Open"}
              </button>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Label unknown merchants quickly and remove them from `Other/default`.
            </p>
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Unknown merchants: <span className="font-medium text-slate-900">{triageItems.length}</span> ·
              Other/default spend: <span className="font-medium text-slate-900">{CURRENCY.format(unknownOtherSpend)}</span>
            </div>

            <div
              className={`overflow-hidden transition-all duration-200 ${
                inboxOpen ? "mt-3 max-h-[1400px] opacity-100" : "max-h-0 opacity-0"
              }`}
            >
              {triageError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {triageError.code}: {triageError.message}
                </div>
              )}

              <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_1fr]">
                <div className="space-y-2">
                  {triageItems.map((item) => (
                    <button
                      key={item.merchantNorm}
                      type="button"
                      onClick={() => setSelectedMerchant(item.merchantNorm)}
                      className={`w-full rounded border px-3 py-2 text-left text-xs ${selectedMerchant === item.merchantNorm ? "border-blue-300 bg-blue-50" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50"}`}
                    >
                      <div className="font-medium text-slate-800">{item.displayName}</div>
                      <div className="mt-1 text-slate-500">
                        {item.txCount} tx · {CURRENCY.format(item.totalSpend)} · last {item.lastDate}
                      </div>
                    </button>
                  ))}
                  {triageLoading && <p className="text-sm text-slate-500">Loading inbox...</p>}
                  {!triageLoading && triageItems.length === 0 && (
                    <p className="text-sm text-slate-500">No unknown merchants in this month. Good signal quality.</p>
                  )}
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                  <div className="text-xs font-medium text-slate-700">
                    Selected: {selectedMerchantItem?.displayName || "-"}
                  </div>
                  <div className="mt-2 text-xs text-slate-500">Sample transactions</div>
                  <div className="mt-1 space-y-1 text-xs text-slate-600">
                    {(selectedMerchantItem?.sampleTransactions || []).slice(0, 5).map((tx) => (
                      <div key={tx.id} className="rounded border border-slate-200 bg-white px-2 py-1">
                        <div className="flex items-center justify-between">
                          <span>{tx.date}</span>
                          <span className={tx.amount >= 0 ? "text-emerald-700" : "text-rose-700"}>
                            {CURRENCY.format(tx.amount)}
                          </span>
                        </div>
                        <div className="truncate text-[11px] text-slate-500">{tx.descriptionRaw}</div>
                      </div>
                    ))}
                    {!(selectedMerchantItem?.sampleTransactions || []).length && <div>-</div>}
                  </div>

                  <label className="mt-3 block space-y-1 text-xs font-medium text-slate-600">
                    Category
                    <select
                      value={triageCategory}
                      onChange={(e) => setTriageCategory(e.target.value as CategoryOption)}
                      className="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                    >
                      {CATEGORY_OPTIONS.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </label>

                  <button
                    type="button"
                    onClick={() => void applyMerchantCategory()}
                    disabled={!selectedMerchant || triageSaving}
                    className="mt-3 h-9 w-full rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                  >
                    {triageSaving ? "Applying..." : "Apply to merchant"}
                  </button>

                  {triageStatus && <div className="mt-2 text-xs text-slate-600">{triageStatus}</div>}
                </div>
              </div>
            </div>
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
