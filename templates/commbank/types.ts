export type CommBankTemplateId =
  | "commbank_manual_amount_balance"
  | "commbank_auto_debit_credit";

export type AmountBalanceStrategy =
  | "amount_balance"
  | "debit_credit_balance"
  | "infer_from_last_numbers";

export type YearInferenceMode = "none" | "from_period";

export type CommBankTemplateConfig = {
  id: CommBankTemplateId;
  bank: "commbank";
  name: string;
  headerAnchors: string[];
  segment: {
    startAfterHeader: boolean;
    stopAnchors: string[];
    removeLinePatterns: string[];
  };
  parse: {
    datePattern: string;
    hasDebitCreditColumns: boolean;
    amountBalanceStrategy: AmountBalanceStrategy;
    yearInference: YearInferenceMode;
    multilineBlock: boolean;
  };
  quality: {
    enableContinuityGate: boolean;
    continuityThreshold: number;
    minContinuityChecked: number;
  };
};
