export const CATEGORY_TAXONOMY = [
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
] as const;

export type Category = (typeof CATEGORY_TAXONOMY)[number];

export type CategorySource = "rule" | "manual" | "default";
export type TransferState = "matched" | "uncertain";
export type TransferDecision =
  | "INTERNAL_OFFSET"
  | "BOUNDARY_FLOW"
  | "UNCERTAIN_NO_OFFSET";
export type TransferKpiEffect = "EXCLUDED" | "INCLUDED";

export type NormalizedTransaction = {
  id: string;
  // Cross-file dedupe key. Keep id unique per source, dedupeKey stable by business fields.
  dedupeKey: string;
  bankId: string;
  accountId: string;
  templateId: string;
  date: string;
  descriptionRaw: string;
  descriptionNorm: string;
  merchantNorm: string;
  amount: number;
  balance?: number;
  currency: "AUD";
  source: {
    bankId: string;
    accountId: string;
    templateId: string;
    fileId: string;
    fileHash?: string;
    page?: number;
    lineIndex: number;
    rowIndex?: number;
    parserVersion?: string;
  };
  quality: {
    warnings: string[];
    confidence: number;
    rawLine: string;
    rawText: string;
  };
  category: Category;
  categorySource: CategorySource;
  categoryRuleId?: string;
  flags?: {
    transferCandidate?: boolean;
  };
  transfer?: {
    matchId: string;
    state?: TransferState;
    role: "out" | "in";
    counterpartyTransactionId: string;
    method: "amount_time_window_v1" | "amount_time_window_v2";
    confidence: number;
    decision?: TransferDecision;
    kpiEffect?: TransferKpiEffect;
    whySentence?: string;
    sameFile?: boolean;
    explain?: {
      amountCents: number;
      dateDiffDays: number;
      sameAccount: boolean;
      descHints: string[];
      penalties: string[];
      score: number;
      refId?: string;
      accountKeyMatchAtoB?: boolean;
      accountKeyMatchBtoA?: boolean;
      nameMatchAtoB?: boolean;
      nameMatchBtoA?: boolean;
      payIdMatch?: boolean;
      evidenceA?: {
        transferType?: string;
        refId?: string;
        counterpartyAccountKey?: string;
        counterpartyName?: string;
        payId?: string;
        hints?: string[];
      };
      evidenceB?: {
        transferType?: string;
        refId?: string;
        counterpartyAccountKey?: string;
        counterpartyName?: string;
        payId?: string;
        hints?: string[];
      };
      accountMetaA?: {
        accountName?: string;
        accountKey?: string;
      };
      accountMetaB?: {
        accountName?: string;
        accountKey?: string;
      };
      decision?: TransferDecision;
      kpiEffect?: TransferKpiEffect;
      whySentence?: string;
      sameFile?: boolean;
    };
  } | null;
};

export type CategoryRule = {
  id: string;
  category: Category;
  merchantIncludes?: string[];
  descriptionPattern?: RegExp;
  amountSign?: "positive" | "negative";
};

export const DEFAULT_OVERRIDE_SCOPE = "global" as const;
export type OverrideScopeKey = string;
export type ScopedCategoryMap = Record<OverrideScopeKey, Record<string, Category>>;

export type CategoryOverrides = {
  merchantMap: ScopedCategoryMap;
  transactionMap: ScopedCategoryMap;
  updatedAt?: string;
};
