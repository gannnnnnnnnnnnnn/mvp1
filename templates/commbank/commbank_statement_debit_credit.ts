import { CommBankTemplateConfig } from "@/templates/commbank/types";

export const commbankStatementDebitCreditTemplate: CommBankTemplateConfig = {
  id: "commbank_statement_debit_credit",
  bank: "commbank",
  name: "CommBank Statement Debit/Credit/Balance",
  headerAnchors: [
    "Date Transaction Debit Credit Balance",
    "TransactionDebitCreditBalance",
  ],
  segment: {
    startAfterHeader: true,
    stopAnchors: ["CLOSING BALANCE", "Transaction Summary during"],
    removeLinePatterns: [
      "^\\s*Date\\s*$",
      "Transaction\\s*Debit\\s*Credit\\s*Balance",
      "^\\s*Statement\\s+\\d+",
      "^\\s*Account Number",
      "^\\s*\\d{2}(?:\\s+\\d{2,6}){1,}\\s*$",
    ],
  },
  parse: {
    datePattern: "^\\d{2}\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\\s+\\d{4})?",
    hasDebitCreditColumns: true,
    amountBalanceStrategy: "infer_from_last_numbers",
    yearInference: "from_period",
    multilineBlock: true,
  },
  quality: {
    enableContinuityGate: true,
    continuityThreshold: 0.85,
    minContinuityChecked: 5,
  },
};
