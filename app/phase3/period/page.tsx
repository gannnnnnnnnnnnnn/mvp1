"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
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

type PeriodType = "month" | "quarter" | "year";

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

const CATEGORY_GROUPS: Array<{ label: string; options: CategoryOption[] }> = [
  { label: "Income", options: ["Income"] },
  { label: "Transfers", options: ["Transfers"] },
  {
    label: "Essential Spend",
    options: ["Groceries", "Bills&Utilities", "Transport", "Rent/Mortgage"],
  },
  {
    label: "Lifestyle Spend",
    options: ["Dining", "Food Delivery", "Entertainment", "Shopping", "Travel"],
  },
  { label: "Health & Pet", options: ["Health", "Pet"] },
  { label: "Other / Uncategorized", options: ["Fees/Interest/Bank", "Other"] },
];

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

type CashflowPoint = {
  xLabel: string;
  fullLabel: string;
  income: number;
  spend: number;
  net: number;
  txCount: number;
};

function readScopeLabel(value: unknown, fallback: ScopeMode) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function toCategoryOption(value: string | undefined): CategoryOption {
  if (value && CATEGORY_OPTIONS.includes(value as CategoryOption)) {
    return value as CategoryOption;
  }
  return "Other";
}

function readPeriodFromUrl(): { type: PeriodType; key: string } {
  if (typeof window === "undefined") {
    return { type: "month" as PeriodType, key: "" };
  }

  const query = new URLSearchParams(window.location.search);
  const typeRaw = (query.get("type") || "").trim();
  const keyRaw = (query.get("key") || "").trim();
  const legacyMonth = (query.get("m") || "").trim();

  const type: PeriodType =
    typeRaw === "quarter" || typeRaw === "year" ? typeRaw : "month";

  if (keyRaw) {
    return { type, key: keyRaw };
  }

  if (legacyMonth) {
    return { type: "month", key: legacyMonth };
  }

  return { type: "month", key: "" };
}

function periodRange(type: PeriodType, key: string) {
  if (!key) return null;
  if (type === "quarter") return quarterRange(key);
  if (type === "year") return yearRange(key);
  return monthRange(key);
}

function availableKeysByType(overview: OverviewResponse | null, type: PeriodType) {
  if (!overview) return [] as string[];
  if (type === "quarter") return [...(overview.availableQuarters || [])].sort();
  if (type === "year") return [...(overview.availableYears || [])].sort();
  return [...(overview.availableMonths || [])].sort();
}

function clampPieTooltip(params: {
  chartX: number;
  chartY: number;
  containerWidth: number;
  containerHeight: number;
}) {
  const offset = 18;
  const tooltipWidth = 320;
  const tooltipHeight = 170;
  let x = params.chartX + offset;
  let y = params.chartY + offset;

  if (x + tooltipWidth > params.containerWidth - 8) {
    x = params.chartX - tooltipWidth - offset;
  }
  if (y + tooltipHeight > params.containerHeight - 8) {
    y = params.chartY - tooltipHeight - offset;
  }

  if (x < 8) x = 8;
  if (y < 8) y = 8;
  return { x, y };
}

function dayLabel(date: string) {
  return date.slice(8, 10);
}

function addDays(base: Date, delta: number) {
  const copy = new Date(base);
  copy.setUTCDate(copy.getUTCDate() + delta);
  return copy;
}

function monthKeyFromDate(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function CategoryTooltipCard(props: { row: PieRow }) {
  const row = props.row;
  if (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    (window as { __PIE_TOOLTIP_DEBUG__?: boolean }).__PIE_TOOLTIP_DEBUG__
  ) {
    console.debug("[pie-tooltip]", row.category, row.amount, row.share);
  }

  return (
    <div className="max-w-[320px] rounded-xl border border-slate-200 bg-white p-2 text-xs text-slate-700 shadow-lg">
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

function GroupedCategorySelect(props: {
  value: CategoryOption;
  onChange: (next: CategoryOption) => void;
  className?: string;
}) {
  return (
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as CategoryOption)}
      className={props.className}
    >
      {CATEGORY_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.options.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function Phase3PeriodPage() {
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [scopeMode, setScopeMode] = useState<ScopeMode>("all");
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);

  const [periodType, setPeriodType] = useState<PeriodType>("month");
  const [periodKey, setPeriodKey] = useState("");

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [pieTooltip, setPieTooltip] = useState<{
    row: PieRow | null;
    x: number;
    y: number;
    visible: boolean;
  }>({ row: null, x: 0, y: 0, visible: false });
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
  const [rowCategoryDraft, setRowCategoryDraft] = useState<Record<string, CategoryOption>>({});
  const [rowSavingTxId, setRowSavingTxId] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState("");
  const pieCardRef = useRef<HTMLDivElement | null>(null);

  const selectedFileNames = useMemo(
    () =>
      selectedFileIds
        .map((id) => files.find((f) => f.id === id)?.originalName)
        .filter(Boolean) as string[],
    [files, selectedFileIds]
  );

  const availablePeriodKeys = useMemo(
    () => availableKeysByType(overview, periodType),
    [overview, periodType]
  );

  const dailySeries = useMemo(
    () => overview?.monthDailySeries || [],
    [overview?.monthDailySeries]
  );

  const cashflowSeries = useMemo<CashflowPoint[]>(() => {
    if (!periodKey) return [];
    const range = periodRange(periodType, periodKey);
    if (!range) return [];

    if (periodType === "month") {
      const start = new Date(`${range.dateFrom}T00:00:00Z`);
      const end = new Date(`${range.dateTo}T00:00:00Z`);
      const map = new Map(
        dailySeries.map((row) => [row.date, row] as const)
      );
      const points: CashflowPoint[] = [];
      for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
        const key = cursor.toISOString().slice(0, 10);
        const existing = map.get(key);
        const income = existing?.income || 0;
        const spend = existing?.spend || 0;
        points.push({
          xLabel: dayLabel(key),
          fullLabel: key,
          income,
          spend,
          net: income - spend,
          txCount: existing?.transactionIds.length || 0,
        });
      }
      return points;
    }

    const monthSeries = overview?.datasetMonthlySeries || [];
    const monthMap = new Map(monthSeries.map((row) => [row.month, row] as const));
    const start = new Date(`${range.dateFrom}T00:00:00Z`);
    const end = new Date(`${range.dateTo}T00:00:00Z`);
    const points: CashflowPoint[] = [];

    for (
      let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
      cursor <= end;
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
    ) {
      const monthKey = monthKeyFromDate(cursor);
      const existing = monthMap.get(monthKey);
      points.push({
        xLabel: monthKey,
        fullLabel: monthKey,
        income: existing?.income || 0,
        spend: existing?.spend || 0,
        net: existing?.net || 0,
        txCount: existing?.transactionIds.length || 0,
      });
    }

    return points;
  }, [periodKey, periodType, dailySeries, overview?.datasetMonthlySeries]);

  const xTickInterval = useMemo(() => {
    if (cashflowSeries.length <= 12) return 0;
    return Math.ceil(cashflowSeries.length / 8);
  }, [cashflowSeries.length]);

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

  const handlePieMouseMove = useCallback((state: unknown) => {
    const event = state as {
      chartX?: number;
      chartY?: number;
      activePayload?: Array<{ payload?: PieRow }>;
    };

    const row = event.activePayload?.[0]?.payload;
    const chartX = event.chartX;
    const chartY = event.chartY;
    const container = pieCardRef.current;

    if (!row || typeof chartX !== "number" || typeof chartY !== "number" || !container) {
      setPieTooltip((prev) =>
        prev.visible ? { ...prev, visible: false, row: null } : prev
      );
      return;
    }

    const next = clampPieTooltip({
      chartX,
      chartY,
      containerWidth: container.clientWidth,
      containerHeight: container.clientHeight,
    });

    setPieTooltip({
      row,
      x: next.x,
      y: next.y,
      visible: true,
    });
  }, []);

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

  async function fetchPeriodOverview(nextScope: ScopeMode, nextIds: string[], nextType: PeriodType, nextKey: string) {
    setIsLoading(true);
    setError(null);

    try {
      const params = buildScopeParams(nextScope, nextIds);
      params.set("granularity", nextType === "month" ? "week" : "month");
      const range = periodRange(nextType, nextKey);
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
      const nextAvailableKeys = availableKeysByType(data, nextType);
      if (!nextKey && nextAvailableKeys.length > 0) {
        setPeriodKey(nextAvailableKeys[nextAvailableKeys.length - 1]);
      }
    } catch {
      setOverview(null);
      setError({ code: "FETCH_FAILED", message: "Failed to load specific period data." });
    } finally {
      setIsLoading(false);
    }
  }

  const fetchCategoryDrilldown = useCallback(
    async (category: string) => {
      if (!category) return;
      setDrilldownLoading(true);
      setDrilldownError(null);

      try {
        const params = buildScopeParams(scopeMode, selectedFileIds);
        const range = periodRange(periodType, periodKey);
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
    },
    [scopeMode, selectedFileIds, periodType, periodKey]
  );

  const fetchTriage = useCallback(async () => {
    setTriageLoading(true);
    setTriageError(null);

    try {
      const params = buildScopeParams(scopeMode, selectedFileIds);
      const range = periodRange(periodType, periodKey);
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
  }, [scopeMode, selectedFileIds, periodType, periodKey]);

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
        fetchPeriodOverview(scopeMode, selectedFileIds, periodType, periodKey),
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
    periodType,
    periodKey,
    fetchTriage,
    selectedCategory,
    fetchCategoryDrilldown,
  ]);

  const applyTransactionCategory = useCallback(
    async (transactionId: string) => {
      if (!transactionId) return;
      const category = rowCategoryDraft[transactionId] || "Other";
      setRowSavingTxId(transactionId);
      setRowStatus("");

      try {
        const res = await fetch("/api/analysis/category-override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactionId,
            category,
            applyToMerchant: false,
          }),
        });

        const data = (await res.json()) as { ok: true } | { ok: false; error: ApiError };
        if (!data.ok) {
          setRowStatus(`${data.error.code}: ${data.error.message}`);
          return;
        }

        setRowStatus(`Updated transaction category to ${category}.`);
        if (selectedCategory) {
          await fetchCategoryDrilldown(selectedCategory);
        }
        await fetchTriage();
      } catch {
        setRowStatus("Failed to update transaction category.");
      } finally {
        setRowSavingTxId(null);
      }
    },
    [rowCategoryDraft, selectedCategory, fetchCategoryDrilldown, fetchTriage]
  );

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    const period = readPeriodFromUrl();
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);
    setPeriodType(period.type);
    setPeriodKey(period.key);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load file list." });
    });

    void fetchPeriodOverview(parsed.scopeMode, parsed.fileIds, period.type, period.key);
  }, []);

  useEffect(() => {
    const params = buildScopeParams(scopeMode, selectedFileIds);
    params.set("type", periodType);
    if (periodKey) {
      params.set("key", periodKey);
    }
    window.history.replaceState(null, "", `/phase3/period?${params.toString()}`);
  }, [scopeMode, selectedFileIds, periodType, periodKey]);

  useEffect(() => {
    if (!periodKey && availablePeriodKeys.length > 0) {
      setPeriodKey(availablePeriodKeys[availablePeriodKeys.length - 1]);
      return;
    }

    if (periodKey && !availablePeriodKeys.includes(periodKey)) {
      setPeriodKey(availablePeriodKeys[availablePeriodKeys.length - 1] || "");
    }
  }, [periodKey, availablePeriodKeys]);

  useEffect(() => {
    if (!selectedCategory) return;
    if (!spendRows.some((row) => row.category === selectedCategory)) {
      setSelectedCategory(null);
      setDrilldownRows([]);
    }
  }, [selectedCategory, spendRows]);

  useEffect(() => {
    if (!selectedCategory) {
      setDrilldownRows([]);
      return;
    }
    void fetchCategoryDrilldown(selectedCategory);
  }, [selectedCategory, fetchCategoryDrilldown]);

  useEffect(() => {
    if (drilldownRows.length === 0) {
      setRowCategoryDraft({});
      return;
    }

    setRowCategoryDraft((prev) => {
      const next = { ...prev };
      for (const row of drilldownRows) {
        if (!next[row.id]) {
          next[row.id] = toCategoryOption(row.category);
        }
      }
      return next;
    });
  }, [drilldownRows]);

  useEffect(() => {
    if (!periodKey) return;
    void fetchTriage();
  }, [periodType, periodKey, scopeMode, selectedFileIds, fetchTriage]);

  useEffect(() => {
    if (!periodKey) return;
    void fetchPeriodOverview(scopeMode, selectedFileIds, periodType, periodKey);
  }, [periodType, periodKey, scopeMode, selectedFileIds]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Specific Period View</h1>
          <p className="mt-1 text-sm text-slate-600">
            Focused analysis for one selected period. Category drilldown and labeling stay embedded.
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
              Period Type
              <select
                value={periodType}
                onChange={(e) => setPeriodType(e.target.value as PeriodType)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                <option value="month">Month</option>
                <option value="quarter">Quarter</option>
                <option value="year">Year</option>
              </select>
            </label>

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-3">
              Period
              <select
                value={periodKey}
                onChange={(e) => setPeriodKey(e.target.value)}
                className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
              >
                {availablePeriodKeys.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end lg:col-span-2">
              <button
                type="button"
                onClick={() =>
                  void fetchPeriodOverview(scopeMode, selectedFileIds, periodType, periodKey)
                }
                disabled={
                  isLoading ||
                  (scopeMode === "selected" && selectedFileIds.length === 0) ||
                  !periodKey
                }
                className="h-10 w-full rounded-lg bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {isLoading ? "Loading..." : "Refresh"}
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

        <section className="grid items-stretch gap-4 xl:grid-cols-2">
          <article className="h-full min-h-[360px] rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Period Cashflow Trend</h2>
            <p className="mt-1 text-sm text-slate-600">
              Compact chart: income/spend bars with net line.
            </p>
            <div className="mt-4 h-64 w-full">
              {cashflowSeries.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={cashflowSeries}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis
                      dataKey="xLabel"
                      interval={xTickInterval}
                      tick={{ fontSize: 11, fill: "#64748b" }}
                    />
                    <YAxis tick={{ fontSize: 11, fill: "#64748b" }} />
                    <RechartsTooltip
                      contentStyle={{
                        borderRadius: 10,
                        borderColor: "#e2e8f0",
                        boxShadow: "0 8px 24px rgba(15, 23, 42, 0.08)",
                      }}
                      formatter={(value, name) => {
                        const numeric =
                          typeof value === "number" ? value : Number(value || 0);
                        return [
                          CURRENCY.format(numeric),
                          name === "income"
                            ? "Income"
                            : name === "spend"
                              ? "Spend"
                              : "Net",
                        ];
                      }}
                      labelFormatter={(label) => {
                        const found = cashflowSeries.find((row) => row.xLabel === label);
                        return found?.fullLabel || String(label);
                      }}
                    />
                    <Legend />
                    <Bar
                      dataKey="income"
                      fill="#10b981"
                      radius={[4, 4, 0, 0]}
                      barSize={periodType === "month" ? 8 : 16}
                    />
                    <Bar
                      dataKey="spend"
                      fill="#f43f5e"
                      radius={[4, 4, 0, 0]}
                      barSize={periodType === "month" ? 8 : 16}
                    />
                    <Line
                      dataKey="net"
                      stroke="#2563eb"
                      strokeWidth={2}
                      dot={false}
                      type="monotone"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-slate-500">No trend points available.</p>
              )}
            </div>
          </article>

          <article className="h-full min-h-[360px] overflow-visible rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Spend by Category</h2>
            <p className="mt-1 text-sm text-slate-600">Hover for details. Click to open embedded drilldown.</p>
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setSelectedCategory(null)}
                disabled={!selectedCategory}
                className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Clear selection
              </button>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-[240px_1fr]">
              <div
                ref={pieCardRef}
                className="relative mx-auto h-56 w-56 overflow-visible"
              >
                <PieChart
                  width={224}
                  height={224}
                  onMouseMove={handlePieMouseMove}
                  onMouseLeave={() =>
                    setPieTooltip((prev) =>
                      prev.visible ? { ...prev, visible: false, row: null } : prev
                    )
                  }
                >
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
                    animationDuration={180}
                    stroke="#ffffff"
                    strokeWidth={1}
                  >
                    {selectedPieData.map((row) => (
                      <Cell key={`${row.category}-active`} fill={row.fill} />
                    ))}
                  </Pie>
                </PieChart>
                {pieTooltip.visible && pieTooltip.row && (
                  <div
                    className="pointer-events-none absolute z-50 transition-opacity duration-100"
                    style={{ left: pieTooltip.x, top: pieTooltip.y }}
                  >
                    <CategoryTooltipCard row={pieTooltip.row} />
                  </div>
                )}
              </div>
              <div className="space-y-2">
                {spendRows.map((row) => (
                  <button
                    key={row.category}
                    type="button"
                    onClick={() => setSelectedCategory(row.category)}
                    className={`w-full rounded border px-3 py-2 text-left text-xs transition-all duration-200 ${selectedCategory === row.category ? "scale-[1.01] border-blue-300 bg-blue-50 shadow-sm ring-1 ring-blue-200" : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50"}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">{row.category}</span>
                      <span className="text-slate-600">{CURRENCY.format(row.amount)}</span>
                    </div>
                    <div className="mt-1 text-slate-500">
                      {PERCENT.format(row.share)} · {row.transactionIds.length} tx
                    </div>
                  </button>
                ))}
                {!spendRows.length && <p className="text-sm text-slate-500">No spending categories in this period.</p>}
              </div>
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Category Drilldown</h2>
              <span className="text-xs text-slate-500">{selectedCategory || "overview"}</span>
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
                  <div className="mt-2 flex items-center gap-2">
                    <GroupedCategorySelect
                      value={rowCategoryDraft[tx.id] || toCategoryOption(tx.category)}
                      onChange={(next) =>
                        setRowCategoryDraft((prev) => ({ ...prev, [tx.id]: next }))
                      }
                      className="h-8 flex-1 rounded border border-slate-300 bg-white px-2 text-xs text-slate-900"
                    />
                    <button
                      type="button"
                      onClick={() => void applyTransactionCategory(tx.id)}
                      disabled={rowSavingTxId === tx.id}
                      className="h-8 rounded bg-blue-600 px-2 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                    >
                      {rowSavingTxId === tx.id ? "Saving..." : "Apply"}
                    </button>
                  </div>
                </div>
              ))}

              {drilldownLoading && <p className="text-sm text-slate-500">Loading drilldown...</p>}
              {!drilldownLoading && !drilldownRows.length && (
                <p className="text-sm text-slate-500">
                  {selectedCategory
                    ? "No transactions for selected category in this period."
                    : "Select a category from the chart or list to open drilldown."}
                </p>
              )}
              {rowStatus && <p className="text-xs text-slate-600">{rowStatus}</p>}
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Other Inbox (Specific Period)</h2>
            <p className="mt-1 text-sm text-slate-600">
              Label unknown merchants quickly and remove them from `Other/default`.
            </p>
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
              Unknown merchants: <span className="font-medium text-slate-900">{triageItems.length}</span> ·
              Other/default spend: <span className="font-medium text-slate-900">{CURRENCY.format(unknownOtherSpend)}</span>
            </div>

            {triageError && (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
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
                  <p className="text-sm text-slate-500">No unknown merchants in this period. Good signal quality.</p>
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
                  <GroupedCategorySelect
                    value={triageCategory}
                    onChange={(next) => setTriageCategory(next)}
                    className="h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                  />
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
            <div>
              period: {periodType} · {periodKey || "-"}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
