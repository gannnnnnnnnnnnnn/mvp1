"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
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
  transfer?: {
    matchId: string;
    role: "out" | "in";
    counterpartyTransactionId: string;
    method: string;
    confidence: number;
  } | null;
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
  | "Insurance"
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
  "Insurance",
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
  { label: "Health, Insurance & Pet", options: ["Health", "Insurance", "Pet"] },
  { label: "Other / Uncategorized", options: ["Fees/Interest/Bank", "Other"] },
];

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

function readPeriodFromUrl(): { type: PeriodType; key: string; openInbox: boolean } {
  if (typeof window === "undefined") {
    return { type: "month" as PeriodType, key: "", openInbox: false };
  }

  const query = new URLSearchParams(window.location.search);
  const typeRaw = (query.get("type") || "").trim();
  const keyRaw = (query.get("key") || "").trim();
  const legacyMonth = (query.get("m") || "").trim();
  const openInbox = query.get("openInbox") === "1";

  const type: PeriodType =
    typeRaw === "quarter" || typeRaw === "year" ? typeRaw : "month";

  if (keyRaw) {
    return { type, key: keyRaw, openInbox };
  }

  if (legacyMonth) {
    return { type: "month", key: legacyMonth, openInbox };
  }

  return { type: "month", key: "", openInbox };
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

function clampIndex(nextIndex: number, length: number) {
  if (length <= 0) return 0;
  if (nextIndex < 0) return 0;
  if (nextIndex >= length) return length - 1;
  return nextIndex;
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
  const [selectedBankId, setSelectedBankId] = useState("");
  const [selectedAccountId, setSelectedAccountId] = useState("");

  const [periodType, setPeriodType] = useState<PeriodType>("month");
  const [periodKey, setPeriodKey] = useState("");
  const [excludeMatchedTransfers, setExcludeMatchedTransfers] = useState(true);

  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
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
  const [focusInboxOnLoad, setFocusInboxOnLoad] = useState(false);
  const [inboxPulse, setInboxPulse] = useState(false);
  const [rowCategoryDraft, setRowCategoryDraft] = useState<Record<string, CategoryOption>>({});
  const [rowSavingTxId, setRowSavingTxId] = useState<string | null>(null);
  const [rowSavingMerchantNorm, setRowSavingMerchantNorm] = useState<string | null>(null);
  const [rowStatus, setRowStatus] = useState("");
  const triageSectionRef = useRef<HTMLElement | null>(null);
  const hasExplicitPeriodFromUrlRef = useRef(false);
  const hasAppliedDefaultPeriodRef = useRef(false);

  const selectedFileNames = useMemo(
    () =>
      selectedFileIds
        .map((id) => files.find((f) => f.id === id)?.originalName)
        .filter(Boolean) as string[],
    [files, selectedFileIds]
  );
  const bankOptions = useMemo(() => overview?.bankIds || [], [overview?.bankIds]);
  const accountOptions = useMemo(() => overview?.accountIds || [], [overview?.accountIds]);

  const availablePeriodKeys = useMemo(
    () => availableKeysByType(overview, periodType),
    [overview, periodType]
  );
  const selectedPeriodIndex = useMemo(
    () => availablePeriodKeys.indexOf(periodKey),
    [availablePeriodKeys, periodKey]
  );
  const effectivePeriodIndex =
    selectedPeriodIndex >= 0 ? selectedPeriodIndex : Math.max(availablePeriodKeys.length - 1, 0);
  const timelineVisibleItems = useMemo(() => {
    if (availablePeriodKeys.length <= 16) {
      return availablePeriodKeys.map((key, idx) => ({ key, idx }));
    }
    const start = clampIndex(effectivePeriodIndex - 7, availablePeriodKeys.length);
    const end = clampIndex(start + 15, availablePeriodKeys.length);
    const windowStart = clampIndex(end - 15, availablePeriodKeys.length);
    return availablePeriodKeys
      .slice(windowStart, end + 1)
      .map((key, offset) => ({ key, idx: windowStart + offset }));
  }, [availablePeriodKeys, effectivePeriodIndex]);

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

  const spendRows = (overview?.spendByCategory || []).slice(0, 10);
  const maxCategoryAmount = useMemo(
    () => Math.max(0, ...spendRows.map((row) => row.amount)),
    [spendRows]
  );

  const selectedMerchantItem = useMemo(
    () => triageItems.find((item) => item.merchantNorm === selectedMerchant) || null,
    [triageItems, selectedMerchant]
  );

  const unknownOtherSpend = useMemo(
    () => triageItems.reduce((sum, item) => sum + item.totalSpend, 0),
    [triageItems]
  );

  const setTimelineIndex = useCallback(
    (nextIndex: number) => {
      if (!availablePeriodKeys.length) return;
      const clamped = clampIndex(nextIndex, availablePeriodKeys.length);
      const key = availablePeriodKeys[clamped];
      if (key) {
        setPeriodKey(key);
      }
    },
    [availablePeriodKeys]
  );

  const switchPeriodType = useCallback(
    (nextType: PeriodType) => {
      setPeriodType(nextType);
      const nextKeys = availableKeysByType(overview, nextType);
      setPeriodKey(nextKeys[nextKeys.length - 1] || "");
    },
    [overview]
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

  const fetchPeriodOverview = useCallback(
    async (
      nextScope: ScopeMode,
      nextIds: string[],
      nextType: PeriodType,
      nextKey: string,
      nextBankId: string,
      nextAccountId: string,
      nextShowTransfers: "excludeMatched" | "all"
    ) => {
      setIsLoading(true);
      setError(null);

      try {
        const params = buildScopeParams(nextScope, nextIds, {
          bankId: nextBankId || undefined,
          accountId: nextAccountId || undefined,
        });
        params.set("granularity", nextType === "month" ? "week" : "month");
        const range = periodRange(nextType, nextKey);
        if (range) {
          params.set("dateFrom", range.dateFrom);
          params.set("dateTo", range.dateTo);
        }
        params.set("showTransfers", nextShowTransfers);

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
    },
    []
  );

  const fetchCategoryDrilldown = useCallback(
    async (category: string) => {
      if (!category) return;
      setDrilldownLoading(true);
      setDrilldownError(null);

      try {
        const params = buildScopeParams(scopeMode, selectedFileIds, {
          bankId: selectedBankId || undefined,
          accountId: selectedAccountId || undefined,
        });
        const range = periodRange(periodType, periodKey);
        if (range) {
          params.set("dateFrom", range.dateFrom);
          params.set("dateTo", range.dateTo);
        }
        params.set("category", category);
        params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");

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
    [
      scopeMode,
      selectedFileIds,
      selectedBankId,
      selectedAccountId,
      periodType,
      periodKey,
      excludeMatchedTransfers,
    ]
  );

  const fetchTriage = useCallback(async () => {
    setTriageLoading(true);
    setTriageError(null);

    try {
      const params = buildScopeParams(scopeMode, selectedFileIds, {
        bankId: selectedBankId || undefined,
        accountId: selectedAccountId || undefined,
      });
      const range = periodRange(periodType, periodKey);
      if (range) {
        params.set("dateFrom", range.dateFrom);
        params.set("dateTo", range.dateTo);
      }
      params.set("showTransfers", excludeMatchedTransfers ? "excludeMatched" : "all");

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
  }, [
    scopeMode,
    selectedFileIds,
    selectedBankId,
    selectedAccountId,
    periodType,
    periodKey,
    excludeMatchedTransfers,
  ]);

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
        fetchPeriodOverview(
          scopeMode,
          selectedFileIds,
          periodType,
          periodKey,
          selectedBankId,
          selectedAccountId,
          excludeMatchedTransfers ? "excludeMatched" : "all"
        ),
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
    selectedBankId,
    selectedAccountId,
    excludeMatchedTransfers,
    fetchPeriodOverview,
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

        setRowStatus(`Saved: fixed this transaction to ${category}.`);
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

  const applyMerchantCategoryFromRow = useCallback(
    async (tx: DrilldownTx) => {
      const category = rowCategoryDraft[tx.id] || "Other";
      if (!tx.merchantNorm) {
        setRowStatus("Cannot save merchant rule: missing merchant.");
        return;
      }

      setRowSavingMerchantNorm(tx.merchantNorm);
      setRowStatus("");
      try {
        const res = await fetch("/api/analysis/category-override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchantNorm: tx.merchantNorm,
            category,
            applyToMerchant: true,
          }),
        });

        const data = (await res.json()) as { ok: true } | { ok: false; error: ApiError };
        if (!data.ok) {
          setRowStatus(`${data.error.code}: ${data.error.message}`);
          return;
        }

        setRowStatus(`Saved: learned rule ${tx.merchantNorm} → ${category}.`);
        if (selectedCategory) {
          await fetchCategoryDrilldown(selectedCategory);
        }
        await fetchTriage();
      } catch {
        setRowStatus("Failed to save merchant rule.");
      } finally {
        setRowSavingMerchantNorm(null);
      }
    },
    [rowCategoryDraft, selectedCategory, fetchCategoryDrilldown, fetchTriage]
  );

  useEffect(() => {
    const parsed = parseScopeFromWindow();
    const period = readPeriodFromUrl();
    hasExplicitPeriodFromUrlRef.current = Boolean(period.key);
    hasAppliedDefaultPeriodRef.current = false;
    setScopeMode(parsed.scopeMode);
    setSelectedFileIds(parsed.fileIds);
    setSelectedBankId(parsed.bankId || "");
    setSelectedAccountId(parsed.accountId || "");
    setPeriodType(period.type);
    setPeriodKey(period.key);
    setFocusInboxOnLoad(period.openInbox);

    void fetchFiles().catch(() => {
      setError({ code: "FILES_FAILED", message: "Failed to load file list." });
    });

    void fetchPeriodOverview(
      parsed.scopeMode,
      parsed.fileIds,
      period.type,
      period.key,
      parsed.bankId || "",
      parsed.accountId || "",
      "excludeMatched"
    );
  }, [fetchPeriodOverview]);

  useEffect(() => {
    const params = buildScopeParams(scopeMode, selectedFileIds, {
      bankId: selectedBankId || undefined,
      accountId: selectedAccountId || undefined,
    });
    params.set("type", periodType);
    if (periodKey) {
      params.set("key", periodKey);
    }
    window.history.replaceState(null, "", `/phase3/period?${params.toString()}`);
  }, [scopeMode, selectedFileIds, selectedBankId, selectedAccountId, periodType, periodKey]);

  useEffect(() => {
    if (availablePeriodKeys.length === 0) {
      return;
    }

    if (!periodKey && availablePeriodKeys.length > 0) {
      if (!hasExplicitPeriodFromUrlRef.current && !hasAppliedDefaultPeriodRef.current) {
        hasAppliedDefaultPeriodRef.current = true;
        setPeriodKey(availablePeriodKeys[availablePeriodKeys.length - 1]);
      }
      return;
    }

    if (periodKey && !availablePeriodKeys.includes(periodKey)) {
      if (hasExplicitPeriodFromUrlRef.current) {
        return;
      }
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
  }, [
    periodType,
    periodKey,
    scopeMode,
    selectedFileIds,
    selectedBankId,
    selectedAccountId,
    fetchTriage,
  ]);

  useEffect(() => {
    if (!focusInboxOnLoad || triageItems.length === 0) return;
    triageSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    setInboxPulse(true);
    const timer = window.setTimeout(() => setInboxPulse(false), 1200);
    setFocusInboxOnLoad(false);
    return () => window.clearTimeout(timer);
  }, [focusInboxOnLoad, triageItems.length]);

  useEffect(() => {
    if (!periodKey) return;
    void fetchPeriodOverview(
      scopeMode,
      selectedFileIds,
      periodType,
      periodKey,
      selectedBankId,
      selectedAccountId,
      excludeMatchedTransfers ? "excludeMatched" : "all"
    );
  }, [
    periodType,
    periodKey,
    scopeMode,
    selectedFileIds,
    selectedBankId,
    selectedAccountId,
    excludeMatchedTransfers,
    fetchPeriodOverview,
  ]);

  const timelineAriaLabel = `${periodType} timeline`;

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

            <label className="space-y-1 text-xs font-medium text-slate-600 lg:col-span-2">
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
                {accountOptions.map((accountId) => (
                  <option key={accountId} value={accountId}>
                    {accountId}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-end lg:col-span-2">
              <button
                type="button"
                onClick={() =>
                  void fetchPeriodOverview(
                    scopeMode,
                    selectedFileIds,
                    periodType,
                    periodKey,
                    selectedBankId,
                    selectedAccountId,
                    excludeMatchedTransfers ? "excludeMatched" : "all"
                  )
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

            <label className="flex items-center gap-2 text-xs font-medium text-slate-700 lg:col-span-2 lg:justify-end">
              <input
                type="checkbox"
                checked={excludeMatchedTransfers}
                onChange={(e) => setExcludeMatchedTransfers(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-blue-600"
              />
              Exclude matched transfers
            </label>
          </div>

          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Timeline
              </div>
              <button
                type="button"
                onClick={() => switchPeriodType("month")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  periodType === "month"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:border-blue-300"
                }`}
              >
                Month
              </button>
              <button
                type="button"
                onClick={() => switchPeriodType("quarter")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  periodType === "quarter"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:border-blue-300"
                }`}
              >
                Quarter
              </button>
              <button
                type="button"
                onClick={() => switchPeriodType("year")}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  periodType === "year"
                    ? "bg-blue-600 text-white"
                    : "border border-slate-300 bg-white text-slate-700 hover:border-blue-300"
                }`}
              >
                Year
              </button>
              <div className="ml-auto text-xs text-slate-600">
                Selected: <span className="font-semibold text-slate-900">{periodKey || "-"}</span>
              </div>
            </div>

            <div
              className="mt-3 rounded-lg border border-slate-200 bg-white p-3"
              role="group"
              aria-label={timelineAriaLabel}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  setTimelineIndex(effectivePeriodIndex - 1);
                }
                if (event.key === "ArrowRight") {
                  event.preventDefault();
                  setTimelineIndex(effectivePeriodIndex + 1);
                }
              }}
            >
              <input
                type="range"
                min={0}
                max={Math.max(availablePeriodKeys.length - 1, 0)}
                value={effectivePeriodIndex}
                onChange={(event) => setTimelineIndex(Number(event.target.value))}
                className="w-full accent-blue-600"
                disabled={availablePeriodKeys.length === 0}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                {timelineVisibleItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => setTimelineIndex(item.idx)}
                    className={`rounded-md border px-2 py-1 text-xs transition ${
                      periodKey === item.key
                        ? "border-blue-300 bg-blue-50 text-blue-700"
                        : "border-slate-300 bg-white text-slate-700 hover:border-blue-300 hover:bg-blue-50"
                    }`}
                  >
                    {item.key}
                  </button>
                ))}
                {timelineVisibleItems.length === 0 && (
                  <span className="text-xs text-slate-500">No period keys in this scope.</span>
                )}
              </div>
            </div>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
        </section>

        <section className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <article
            ref={triageSectionRef}
            className={`rounded-2xl border bg-white p-6 shadow-sm transition ${
              inboxPulse ? "border-amber-300 ring-2 ring-amber-100" : "border-slate-200"
            }`}
          >
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
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="text-xs uppercase tracking-wide text-slate-500">Transfers</div>
            <div className="mt-3 text-3xl font-semibold text-slate-900">
              {CURRENCY.format(overview?.transferStats?.matchedTransferTotal || 0)}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              matched: {overview?.transferStats?.matchedTransferCount || 0}
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
            <div className="mt-4 space-y-2">
              {spendRows.map((row) => {
                const widthPct =
                  maxCategoryAmount > 0
                    ? Math.max(3, (row.amount / maxCategoryAmount) * 100)
                    : 0;
                return (
                  <button
                    key={row.category}
                    type="button"
                    onClick={() => setSelectedCategory(row.category)}
                    className={`w-full rounded border px-3 py-2 text-left text-xs transition ${
                      selectedCategory === row.category
                        ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200"
                        : "border-slate-200 bg-slate-50 hover:border-blue-300 hover:bg-blue-50"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-slate-800">{row.category}</span>
                      <span className="text-slate-600">{CURRENCY.format(row.amount)}</span>
                    </div>
                    <div className="mt-1 text-slate-500">
                      {PERCENT.format(row.share)} · {row.transactionIds.length} tx
                    </div>
                    <div className="mt-2 h-2 w-full rounded bg-slate-200">
                      <div
                        className="h-2 rounded bg-blue-500"
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
              {!spendRows.length && (
                <p className="text-sm text-slate-500">
                  No spending categories in this period.
                </p>
              )}
            </div>
          </article>
        </section>

        <section className="grid gap-4 xl:grid-cols-2">
          <article className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-900">Category Drilldown</h2>
              <span className="text-xs text-slate-500">{selectedCategory || "overview"}</span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Wrong category? Pick the right one. We can fix this row or learn a rule for this merchant.
            </p>

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
                  <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-slate-500">
                    <span>{tx.merchantNorm} · {tx.categorySource} · conf {tx.quality.confidence.toFixed(2)}</span>
                    {(tx.categorySource === "default" || tx.category === "Other") && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-800">
                        Needs review: Uncategorized
                      </span>
                    )}
                    {tx.quality.confidence < 0.6 && (
                      <span className="rounded bg-rose-100 px-1.5 py-0.5 text-rose-800">
                        Needs review: low confidence {tx.quality.confidence.toFixed(2)}
                      </span>
                    )}
                    {tx.categorySource !== "default" && tx.category !== "Other" && tx.quality.confidence >= 0.6 && (
                      <span className="rounded bg-slate-200 px-1.5 py-0.5 text-slate-700">
                        In selected category
                      </span>
                    )}
                    {tx.transfer?.matchId && (
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 text-blue-800">
                        Transfer matched · {tx.transfer.role} · pair {tx.transfer.counterpartyTransactionId.slice(0, 8)}
                      </span>
                    )}
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
                      {rowSavingTxId === tx.id ? "Saving..." : "Fix this transaction"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void applyMerchantCategoryFromRow(tx)}
                      disabled={rowSavingMerchantNorm === tx.merchantNorm}
                      className="h-8 rounded border border-blue-300 bg-white px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {rowSavingMerchantNorm === tx.merchantNorm
                        ? "Saving..."
                        : "Fix all from this merchant"}
                    </button>
                  </div>
                </div>
              ))}

              {drilldownLoading && <p className="text-sm text-slate-500">Loading drilldown...</p>}
              {!drilldownLoading && !drilldownRows.length && (
                <p className="text-sm text-slate-500">
                  {selectedCategory
                    ? "No transactions for selected category in this period."
                    : "Select a category from the breakdown list to open drilldown."}
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
              bank: {selectedBankId || "all"} · account: {selectedAccountId || "all"}
            </div>
            <div>
              period: {periodType} · {periodKey || "-"}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
