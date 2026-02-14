export type FileMeta = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

export type ApiError = { code: string; message: string };

export type OverviewResponse = {
  ok: true;
  fileId?: string;
  fileIds?: string[];
  filesIncludedCount?: number;
  txCountBeforeDedupe?: number;
  dedupedCount?: number;
  datasetDateMin?: string;
  datasetDateMax?: string;
  availableMonths?: string[];
  availableQuarters?: string[];
  availableYears?: string[];
  accountIds?: string[];
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
  appliedFilters?: Record<string, unknown>;
  totals: { income: number; spend: number; net: number };
  periods: Array<{
    period: string;
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
  }>;
  datasetMonthlySeries?: Array<{
    month: string;
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
  }>;
  monthDailySeries?: Array<{
    date: string;
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
    topMerchants?: Array<{ merchantNorm: string; amount: number }>;
    recentTransactions?: Array<{
      id: string;
      date: string;
      merchantNorm: string;
      amount: number;
      descriptionRaw: string;
    }>;
  }>;
  topMerchants: Array<{
    merchantNorm: string;
    amount: number;
    transactionIds: string[];
  }>;
  balanceSeries: Array<{ date: string; balance: number; transactionId: string }>;
  balanceSeriesDisabledReason?: string;
};

export type CompareResponse = {
  ok: true;
  totalsA: {
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
    categories: Array<{ category: string; amount: number }>;
  };
  totalsB: {
    income: number;
    spend: number;
    net: number;
    transactionIds: string[];
    categories: Array<{ category: string; amount: number }>;
  };
  delta: {
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
  periodA: { start: string; end: string };
  periodB: { start: string; end: string };
  appliedFilters?: Record<string, unknown>;
  availableMonths?: string[];
  availableQuarters?: string[];
  availableYears?: string[];
};
