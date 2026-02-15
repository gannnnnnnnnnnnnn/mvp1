export type DevTemplateMode = "monthly" | "incremental" | "unknown";

export type DevTemplateSeverity = "info" | "warning" | "critical";

export type DevTemplateWarning = {
  code: string;
  message: string;
  severity: DevTemplateSeverity;
  rawLine?: string;
  confidence?: number;
};

export type DevTemplateDetection = {
  matched: boolean;
  confidence: number;
  bankId: string;
  templateId: string;
  mode: DevTemplateMode;
  evidence: string[];
};

export type DevTemplateCoverage = {
  startDate?: string;
  endDate?: string;
};

export type DevTemplateTransaction = {
  id: string;
  date: string;
  descriptionRaw: string;
  amount: number;
  direction: "debit" | "credit";
  debit?: number;
  credit?: number;
  balance?: number;
  bankId: string;
  accountId: string;
  templateId: string;
  confidence: number;
  rawLine: string;
  rawLines?: string[];
  source: {
    fileId: string;
    fileHash?: string;
    rowIndex?: number;
    parserVersion: string;
  };
};

export type DevTemplateParseInput = {
  fileId: string;
  fileHash?: string;
  fileName?: string;
  text: string;
};

export type DevTemplateParseOutput = {
  bankId: string;
  templateId: string;
  mode: DevTemplateMode;
  accountId: string;
  coverage: DevTemplateCoverage;
  transactions: DevTemplateTransaction[];
  warnings: DevTemplateWarning[];
  debug: {
    continuityRatio: number;
    checkedCount: number;
    detection: DevTemplateDetection;
  };
};

export type DevTemplate = {
  id: string;
  bankId: string;
  detect: (text: string) => DevTemplateDetection;
  parse: (input: DevTemplateParseInput) => DevTemplateParseOutput;
};
