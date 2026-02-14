import {
  Category,
  CategoryOverrides,
  CategoryRule,
  NormalizedTransaction,
} from "@/lib/analysis/types";

const RULES: CategoryRule[] = [
  {
    id: "transfer-internal",
    category: "Transfers",
    descriptionPattern: /\bTRANSFER\s+(TO|FROM)\b|\bFAST\s+TRANSFER\b|\bDIRECT\s+DEBIT\b/i,
  },
  {
    id: "bank-fees-interest",
    category: "Fees/Interest/Bank",
    descriptionPattern: /\bFEE\b|\bINTEREST\s+CHARGED\b|\bOVERDRAW\b/i,
  },
  {
    id: "income-salary",
    category: "Income",
    descriptionPattern: /\bSALARY\b|\bPAYROLL\b|\bPAY\b|\bWAGE\b|\bCREDIT\s+INTEREST\b/i,
    amountSign: "positive",
  },
  {
    id: "groceries",
    category: "Groceries",
    merchantIncludes: ["WOOLWORTHS", "COLES", "ALDI", "IGA", "COSTCO"],
    amountSign: "negative",
  },
  {
    id: "food-delivery",
    category: "Food Delivery",
    merchantIncludes: [
      "HUNGRYPANDA",
      "EASI",
      "UBER EATS",
      "UBEREATS",
      "DOORDASH",
      "MENULOG",
      "DELIVEROO",
    ],
    amountSign: "negative",
  },
  {
    id: "dining",
    category: "Dining",
    merchantIncludes: ["MCDONALD", "KFC", "SUBWAY", "CAFE"],
    amountSign: "negative",
  },
  {
    id: "transport",
    category: "Transport",
    merchantIncludes: ["UBER", "DIDI", "MYKI", "METRO", "SHELL", "BP"],
    amountSign: "negative",
  },
  {
    id: "shopping",
    category: "Shopping",
    merchantIncludes: ["AMAZON", "EBAY", "KMART", "TARGET", "UNIQLO"],
    amountSign: "negative",
  },
  {
    id: "bills-utilities",
    category: "Bills&Utilities",
    merchantIncludes: ["TELSTRA", "OPTUS", "AGL", "ORIGIN", "WATER", "ENERGY"],
    amountSign: "negative",
  },
  {
    id: "rent-mortgage",
    category: "Rent/Mortgage",
    descriptionPattern: /\bRENT\b|\bRENTAL\b|\bMORTGAGE\b/i,
    amountSign: "negative",
  },
  {
    id: "health",
    category: "Health",
    merchantIncludes: ["CHEMIST", "PHARMACY", "MEDICAL", "HOSPITAL", "DENTAL"],
    amountSign: "negative",
  },
  {
    id: "pet",
    category: "Pet",
    merchantIncludes: [
      "VET",
      "VETERINARY",
      "PETSTOCK",
      "PET BARN",
      "PET CIRCLE",
      "PET FOOD",
      "GROOMING",
    ],
    amountSign: "negative",
  },
  {
    id: "entertainment",
    category: "Entertainment",
    merchantIncludes: ["NETFLIX", "SPOTIFY", "YOUTUBE", "CINEMA", "STEAM"],
    amountSign: "negative",
  },
  {
    id: "travel",
    category: "Travel",
    merchantIncludes: ["AIR", "HOTEL", "BOOKING", "QANTAS", "JETSTAR"],
    amountSign: "negative",
  },
];

function matchesRule(tx: NormalizedTransaction, rule: CategoryRule) {
  if (rule.amountSign === "positive" && tx.amount <= 0) return false;
  if (rule.amountSign === "negative" && tx.amount >= 0) return false;

  if (rule.merchantIncludes && rule.merchantIncludes.length > 0) {
    const hit = rule.merchantIncludes.some((term) => tx.merchantNorm.includes(term));
    if (hit) return true;
  }

  if (rule.descriptionPattern && rule.descriptionPattern.test(tx.descriptionNorm)) {
    return true;
  }

  return false;
}

function defaultCategory(tx: NormalizedTransaction): Category {
  if (tx.amount > 0) return "Income";
  if (tx.amount < 0) return "Other";
  return "Other";
}

export function assignCategory(
  tx: NormalizedTransaction,
  overrides: CategoryOverrides
): Pick<NormalizedTransaction, "category" | "categorySource" | "categoryRuleId"> {
  const txOverride = overrides.transactionMap[tx.id];
  if (txOverride) {
    return { category: txOverride, categorySource: "manual" };
  }

  const merchantOverride = overrides.merchantMap[tx.merchantNorm];
  if (merchantOverride) {
    return { category: merchantOverride, categorySource: "manual" };
  }

  for (const rule of RULES) {
    if (matchesRule(tx, rule)) {
      return {
        category: rule.category,
        categorySource: "rule",
        categoryRuleId: rule.id,
      };
    }
  }

  return {
    category: defaultCategory(tx),
    categorySource: "default",
  };
}

export const CATEGORY_RULES = RULES;
