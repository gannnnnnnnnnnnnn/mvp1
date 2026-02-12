import { CommBankTemplateConfig } from "@/templates/commbank/types";

export const commbankTransactionSummaryTemplate: CommBankTemplateConfig = {
  id: "commbank_transaction_summary",
  bank: "commbank",
  name: "CommBank Transaction Summary",
  headerAnchors: ["Date Transaction details Amount Balance"],
  segment: {
    startAfterHeader: true,
    stopAnchors: ["Any pending transactions haven’t been included"],
    removeLinePatterns: [
      "^\\s*Date\\s*$",
      "Transaction\\s*details\\s*Amount\\s*Balance",
    ],
  },
  parse: {
    datePattern:
      "^(\\d{1,2}\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{4})",
    hasDebitCreditColumns: false,
    amountBalanceStrategy: "amount_balance",
    yearInference: "none",
    multilineBlock: true,
  },
  quality: {
    enableContinuityGate: true,
    continuityThreshold: 0.85,
    minContinuityChecked: 5,
  },
};

