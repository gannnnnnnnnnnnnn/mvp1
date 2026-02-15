import {
  DevTemplate,
  DevTemplateDetection,
  DevTemplateParseInput,
  DevTemplateParseOutput,
} from "@/lib/templates/types";

const MONTHLY_RANGE_RE =
  /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s*-\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i;

function detectAnzV1(text: string): DevTemplateDetection {
  const upper = (text || "").toUpperCase();
  const evidence: string[] = [];
  let score = 0;

  if (upper.includes("ACCOUNT STATEMENT")) {
    score += 0.35;
    evidence.push("ACCOUNT_STATEMENT");
  }
  if (upper.includes("ANZ PLUS") || upper.includes("AUSTRALIA AND NEW ZEALAND")) {
    score += 0.2;
    evidence.push("ANZ_BRAND");
  }
  if (upper.includes("BRANCH NUMBER (BSB)") || upper.includes("BRANCH NUMBER")) {
    score += 0.2;
    evidence.push("BSB_LABEL");
  }
  if (upper.includes("ACCOUNT NUMBER")) {
    score += 0.1;
    evidence.push("ACCOUNT_NUMBER_LABEL");
  }
  if (
    upper.includes("DATE DESCRIPTION CREDIT DEBIT BALANCE") ||
    (upper.includes("DATE") &&
      upper.includes("DESCRIPTION") &&
      upper.includes("CREDIT") &&
      upper.includes("DEBIT") &&
      upper.includes("BALANCE"))
  ) {
    score += 0.25;
    evidence.push("TABLE_HEADER");
  }

  const mode =
    /TRANSACTIONS MADE SINCE YOUR LAST STATEMENT/i.test(text)
      ? "incremental"
      : MONTHLY_RANGE_RE.test(text)
        ? "monthly"
        : "unknown";

  if (mode === "incremental") evidence.push("MODE_INCREMENTAL");
  if (mode === "monthly") evidence.push("MODE_MONTHLY_RANGE");

  const confidence = Math.min(1, Number(score.toFixed(2)));
  const matched = confidence >= 0.6;

  return {
    matched,
    confidence,
    bankId: "anz",
    templateId: "anz_v1",
    mode,
    evidence,
  };
}

function parseAnzV1(input: DevTemplateParseInput): DevTemplateParseOutput {
  const detection = detectAnzV1(input.text);
  return {
    bankId: "anz",
    templateId: "anz_v1",
    mode: detection.mode,
    accountId: "unknown",
    coverage: {},
    transactions: [],
    warnings: [
      {
        code: "ANZ_TEMPLATE_NOT_IMPLEMENTED",
        message: "ANZ parser is scaffolded but not implemented yet.",
        severity: "warning",
        confidence: 0,
      },
    ],
    debug: {
      continuityRatio: 0,
      checkedCount: 0,
      detection,
    },
  };
}

export const anzTemplateV1: DevTemplate = {
  id: "anz_v1",
  bankId: "anz",
  detect: detectAnzV1,
  parse: parseAnzV1,
};
