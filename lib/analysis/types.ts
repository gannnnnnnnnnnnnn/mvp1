export const CATEGORY_TAXONOMY = [
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
] as const;

export type Category = (typeof CATEGORY_TAXONOMY)[number];

export type CategorySource = "rule" | "manual" | "default";

export type NormalizedTransaction = {
  id: string;
  // Cross-file dedupe key. Keep id unique per source, dedupeKey stable by business fields.
  dedupeKey: string;
  accountId: string;
  date: string;
  descriptionRaw: string;
  descriptionNorm: string;
  merchantNorm: string;
  amount: number;
  balance?: number;
  currency: "AUD";
  source: {
    accountId: string;
    fileId: string;
    page?: number;
    lineIndex: number;
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
