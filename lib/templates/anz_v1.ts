import {
  DevTemplate,
  DevTemplateDetection,
  DevTemplateParseInput,
  DevTemplateParseOutput,
  DevTemplateWarning,
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

const LONG_MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
] as const;

const AS_AT_RE =
  /AS AT\s+(\d{1,2}\s+(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4})/i;

function parseLongDateToIso(raw: string) {
  const match = /^\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*$/.exec(raw);
  if (!match) return null;
  const day = Number(match[1]);
  const monthName = match[2].toUpperCase();
  const year = Number(match[3]);
  const monthIndex = LONG_MONTHS.indexOf(monthName as (typeof LONG_MONTHS)[number]);
  if (monthIndex < 0) return null;
  const d = new Date(Date.UTC(year, monthIndex, day));
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function digitsOnly(value: string) {
  return (value || "").replace(/\D/g, "");
}

function extractHeaderMeta(text: string, mode: DevTemplateDetection["mode"]) {
  const warnings: DevTemplateWarning[] = [];
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");

  let bsb = "";
  let accountNumber = "";

  const bsbInline = /BRANCH NUMBER \(BSB\)\s*[:\-]?\s*([0-9 ]{6,})/i.exec(text);
  if (bsbInline) bsb = digitsOnly(bsbInline[1]).slice(0, 6);

  const accountInline = /ACCOUNT NUMBER\s*[:\-]?\s*([0-9 ]{6,})/i.exec(text);
  if (accountInline) accountNumber = digitsOnly(accountInline[1]);

  // Fallback: values may be on the next line in some PDF text outputs.
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!bsb && /BRANCH NUMBER \(BSB\)|BRANCH NUMBER/i.test(line)) {
      const candidate = digitsOnly(line);
      const nextCandidate = digitsOnly(lines[i + 1] || "");
      bsb = (candidate.length >= 6 ? candidate : nextCandidate).slice(0, 6);
    }
    if (!accountNumber && /ACCOUNT NUMBER/i.test(line)) {
      const candidate = digitsOnly(line);
      const nextCandidate = digitsOnly(lines[i + 1] || "");
      accountNumber = candidate.length >= 6 ? candidate : nextCandidate;
    }
  }

  if (!bsb || !accountNumber) {
    warnings.push({
      code: "ANZ_HEADER_ACCOUNT_MISSING",
      message: "Could not extract BSB and Account Number from statement header.",
      severity: "warning",
      confidence: 0.4,
    });
  }

  const accountId = bsb && accountNumber ? `${bsb}-${accountNumber}` : "unknown";

  let startDate: string | undefined;
  let endDate: string | undefined;

  const range = MONTHLY_RANGE_RE.exec(text);
  if (range) {
    startDate = parseLongDateToIso(range[1]) || undefined;
    endDate = parseLongDateToIso(range[2]) || undefined;
  }

  if (!endDate) {
    const asAtMatch = AS_AT_RE.exec(text.toUpperCase());
    if (asAtMatch) {
      endDate = parseLongDateToIso(asAtMatch[1]) || undefined;
    }
  }

  if (mode === "incremental" && !endDate) {
    const fallback = new Date().toISOString().slice(0, 10);
    endDate = fallback;
    warnings.push({
      code: "ANZ_INCREMENTAL_YEAR_FALLBACK",
      message:
        "Incremental statement end date not found. Falling back to current year/date in dev run.",
      severity: "warning",
      confidence: 0.2,
    });
  }

  return {
    accountId,
    coverage: {
      startDate,
      endDate,
    },
    warnings,
  };
}

function parseAnzV1(input: DevTemplateParseInput): DevTemplateParseOutput {
  const detection = detectAnzV1(input.text);
  const header = extractHeaderMeta(input.text, detection.mode);

  return {
    bankId: "anz",
    templateId: "anz_v1",
    mode: detection.mode,
    accountId: header.accountId,
    coverage: header.coverage,
    transactions: [],
    warnings: [
      ...header.warnings,
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
