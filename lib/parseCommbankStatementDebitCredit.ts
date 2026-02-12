import {
  ParsedTransaction,
  ParseTransactionsResult,
  ParseWarning,
} from "@/lib/parseTransactionsV1";

type StatementPeriod = {
  start?: Date;
  end?: Date;
};

type MoneyParsed = {
  value: number;
  absValue: number;
  suffix: "CR" | "DR" | null;
  hasMinus: boolean;
  hasParens: boolean;
};

type AmountResolution = {
  amount: number;
  debit?: number;
  credit?: number;
  confidencePenalty: number;
};

type MoneyTokenWithLine = {
  token: string;
  line: string;
};

const DATE_LINE_RE =
  /^(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*(\d{4}))?(.*)$/i;
const PERIOD_RE =
  /Period\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s*-\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;

// Strict money candidates:
// - must include two decimal places
// - allows optional $ / commas / parentheses
// - allows optional CR/DR suffix
// - forbids partial matches inside longer numeric fragments (e.g. 1363.10645)
const MONEY_TOKEN_RE =
  /(?<![\d.])(?:\(\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)|-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?:\s?(?:CR|DR))?(?![\d.])/gi;
const MAX_MONEY_ABS = 1_000_000;

const CREDIT_HINTS = [
  "CREDIT TO ACCOUNT",
  "FAST TRANSFER FROM",
  "TRANSFER FROM",
  "PAYMENT RECEIVED",
  "INTEREST",
  "REFUND",
];
const DEBIT_HINTS = [
  "TRANSFER TO",
  "OVERDRAW FEE",
  "FEE",
  "DEBIT",
  "CARD",
  "EFTPOS",
  "PURCHASE",
  "WITHDRAWAL",
  "PAYMENT TO",
];

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function parseDayMonYearToken(token: string): Date | null {
  const m = /^(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})$/i.exec(
    token.trim()
  );
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTH_INDEX[m[2].toLowerCase()];
  const year = Number(m[3]);
  if (month === undefined || day < 1 || day > 31) return null;

  const d = new Date(Date.UTC(year, month, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

function parseStatementPeriod(fullText: string): StatementPeriod {
  const match = PERIOD_RE.exec(fullText || "");
  if (!match) return {};

  const start = parseDayMonYearToken(match[1]);
  const end = parseDayMonYearToken(match[2]);
  return { start: start || undefined, end: end || undefined };
}

function inferDateIso(
  dayText: string,
  monthText: string,
  yearText: string | undefined,
  period: StatementPeriod
): string | null {
  const day = Number(dayText);
  const month = MONTH_INDEX[monthText.toLowerCase()];
  if (month === undefined || day < 1 || day > 31) return null;

  const explicitYear = yearText ? Number(yearText.trim()) : undefined;
  if (explicitYear) {
    const dt = new Date(Date.UTC(explicitYear, month, day));
    return dt.toISOString();
  }

  const candidateYears: number[] = [];
  if (period.start) candidateYears.push(period.start.getUTCFullYear());
  if (period.end) candidateYears.push(period.end.getUTCFullYear());
  const uniqueYears = [...new Set(candidateYears)];

  for (const year of uniqueYears) {
    const dt = new Date(Date.UTC(year, month, day));
    if (period.start && period.end) {
      if (dt >= period.start && dt <= period.end) {
        return dt.toISOString();
      }
    }
  }

  if (period.end) {
    const fallback = new Date(Date.UTC(period.end.getUTCFullYear(), month, day));
    return fallback.toISOString();
  }

  return null;
}

function parseMoneyToken(token: string): MoneyParsed | null {
  const raw = token.trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const condensed = upper.replace(/\s+/g, "");
  const hasParens = condensed.startsWith("(") && condensed.endsWith(")");
  const hasMinus = condensed.includes("-");
  const suffix: "CR" | "DR" | null = condensed.endsWith("CR")
    ? "CR"
    : condensed.endsWith("DR")
      ? "DR"
      : null;

  const numeric = condensed
    .replace(/CR$|DR$/i, "")
    .replace(/[()$,]/g, "");
  const parsed = Number(numeric);
  if (!Number.isFinite(parsed)) return null;

  const absValue = Math.abs(parsed);
  const signedByToken =
    hasParens || hasMinus || suffix === "DR" ? -absValue : absValue;

  return {
    value: suffix === "CR" ? absValue : signedByToken,
    absValue,
    suffix,
    hasMinus,
    hasParens,
  };
}

function isMoneyCandidateSane(m: MoneyParsed) {
  return m.absValue <= MAX_MONEY_ABS;
}

function extractMoneyTokens(lines: string[]): MoneyTokenWithLine[] {
  const tokens: MoneyTokenWithLine[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (isReferenceOnlyLine(trimmed)) {
      continue;
    }

    // Value Date lines may glue year+money (e.g. ".../202519.56...").
    const normalized = line.replace(
      /(Value Date:\s*\d{2}\/\d{2}\/\d{4})(?=\d)/gi,
      "$1 "
    );
    for (const match of normalized.matchAll(MONEY_TOKEN_RE)) {
      tokens.push({ token: match[0], line: normalized });
    }
  }
  return tokens;
}

function isFinancialLine(line: string) {
  const upper = line.toUpperCase();
  return (
    upper.includes("$") ||
    upper.includes("CR") ||
    upper.includes("DR") ||
    upper.includes("VALUE DATE") ||
    upper.includes("CREDIT TO ACCOUNT") ||
    upper.includes("TRANSFER")
  );
}

function hasAnyHint(blockUpper: string, hints: string[]) {
  return hints.some((hint) => blockUpper.includes(hint));
}

function isReferenceOnlyLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Reference-like rows in auto statements are often pure numbers/symbols.
  // If a row has no money markers and no 2-decimal currency pattern,
  // we keep it as description metadata but exclude it from money candidates.
  if (trimmed.includes("$")) return false;
  if (/,/.test(trimmed)) return false;
  if (/\b(?:CR|DR)\b/i.test(trimmed)) return false;
  if (/[()]/.test(trimmed)) return false;
  if (/\d+\.\d{2}/.test(trimmed)) return false;

  const compact = trimmed.replace(/\s+/g, "");
  return /^[0-9\-/.]+$/.test(compact);
}

function isNonTransactionBlock(firstLine: string) {
  const normalized = firstLine.toLowerCase();
  return (
    normalized.includes("opening balance") ||
    normalized.includes("closing balance")
  );
}

function buildDescription(lines: string[], firstRemainder: string) {
  const parts: string[] = [];
  if (firstRemainder.trim()) parts.push(firstRemainder.trim());

  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (isReferenceOnlyLine(line)) {
      parts.push(`REF: ${line}`);
      continue;
    }
    parts.push(line);
  }

  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

function pushWarning(
  warnings: ParseWarning[],
  rawLine: string,
  reason: string,
  confidence = 0.3
) {
  warnings.push({ rawLine, reason, confidence: clamp01(confidence) });
}

function resolveAmount(params: {
  blockUpper: string;
  amountCandidates: MoneyParsed[];
  rawBlock: string;
  warnings: ParseWarning[];
}): AmountResolution | null {
  const { blockUpper, amountCandidates, rawBlock, warnings } = params;
  if (amountCandidates.length === 0) return null;

  const hasExplicitDebit = amountCandidates.some(
    (c) => c.hasMinus || c.hasParens || c.suffix === "DR"
  );
  const hasExplicitCredit = amountCandidates.some((c) => c.suffix === "CR");
  const bothPresent = hasExplicitDebit && hasExplicitCredit;
  if (bothPresent) {
    pushWarning(warnings, rawBlock, "DEBIT_CREDIT_BOTH_PRESENT", 0.35);
  }

  const candidate = amountCandidates[amountCandidates.length - 1];
  const hasCreditHint = hasAnyHint(blockUpper, CREDIT_HINTS);
  const hasDebitHint = hasAnyHint(blockUpper, DEBIT_HINTS);

  let side: "debit" | "credit" | "unknown" = "unknown";
  if (candidate.hasMinus || candidate.hasParens || candidate.suffix === "DR") {
    side = "debit";
  } else if (candidate.suffix === "CR") {
    side = "credit";
  } else if (hasCreditHint && !hasDebitHint) {
    side = "credit";
  } else if (hasDebitHint && !hasCreditHint) {
    side = "debit";
  }

  // Fallback for column-misaligned extract text:
  // keep parser deterministic and expose ambiguity with warning + lower confidence.
  let confidencePenalty = 0;
  if (side === "unknown") {
    side = "debit";
    confidencePenalty += 0.22;
    pushWarning(warnings, rawBlock, "AUTO_AMOUNT_SIDE_AMBIGUOUS", 0.45);
  }

  if (side === "debit") {
    const debit = candidate.absValue;
    const credit = undefined;
    return {
      amount: (credit ?? 0) - debit,
      debit,
      credit,
      confidencePenalty,
    };
  }

  const credit = candidate.absValue;
  const debit = undefined;
  return {
    amount: credit - (debit ?? 0),
    debit,
    credit,
    confidencePenalty,
  };
}

function finalizeBlock(params: {
  fileId: string;
  counter: number;
  rawLines: string[];
  dayText: string;
  monthText: string;
  yearText?: string;
  firstRemainder: string;
  period: StatementPeriod;
  warnings: ParseWarning[];
}): ParsedTransaction | null {
  const {
    fileId,
    counter,
    rawLines,
    dayText,
    monthText,
    yearText,
    firstRemainder,
    period,
    warnings,
  } = params;

  if (rawLines.length === 0) return null;
  if (isNonTransactionBlock(rawLines[0])) return null;

  const rawBlock = rawLines.join("\n");
  const dateIso = inferDateIso(dayText, monthText, yearText, period);
  if (!dateIso) {
    pushWarning(warnings, rawBlock, "Unable to infer transaction date.", 0.3);
    return null;
  }

  const moneyTokens = extractMoneyTokens(rawLines);
  const preferredTokens = moneyTokens.filter((item) => isFinancialLine(item.line));
  const tokensToParse =
    preferredTokens.length >= 2 ? preferredTokens : moneyTokens;
  const parsedTokens = tokensToParse
    .map((item) => parseMoneyToken(item.token))
    .filter(Boolean) as MoneyParsed[];
  const saneTokens: MoneyParsed[] = [];
  for (const token of parsedTokens) {
    if (!isMoneyCandidateSane(token)) {
      pushWarning(
        warnings,
        rawBlock,
        `AMOUNT_OUTLIER: value exceeds ${MAX_MONEY_ABS}`,
        0.3
      );
      continue;
    }
    saneTokens.push(token);
  }

  const balanceRaw =
    saneTokens.length > 0 ? saneTokens[saneTokens.length - 1] : undefined;
  const amountCandidates = saneTokens.slice(0, -1);
  const amountResolved = resolveAmount({
    blockUpper: rawBlock.toUpperCase(),
    amountCandidates,
    rawBlock,
    warnings,
  });

  if (!balanceRaw) {
    pushWarning(warnings, rawBlock, "AUTO_BALANCE_NOT_FOUND", 0.35);
  }
  if (!amountResolved) {
    pushWarning(warnings, rawBlock, "AUTO_AMOUNT_NOT_FOUND", 0.35);
  }

  let confidence = rawLines.length === 1 ? 0.95 : 0.88;
  if (!balanceRaw || !amountResolved) {
    confidence = 0.42;
  } else {
    confidence = clamp01(confidence - amountResolved.confidencePenalty);
  }

  // Statement balance may carry "CR" suffix in source text.
  // For this phase we treat suffix as marker only and store numeric value.
  const balance = balanceRaw ? Math.abs(balanceRaw.absValue) : undefined;
  const amount = amountResolved?.amount ?? 0;
  const debit = amountResolved?.debit;
  const credit = amountResolved?.credit;

  return {
    id: `${fileId}-${counter}`,
    date: dateIso,
    description: buildDescription(rawLines, firstRemainder) || "(no description)",
    amount,
    debit,
    credit,
    balance,
    rawLine: rawBlock,
    confidence,
  };
}

export function parseCommbankStatementDebitCredit(
  sectionText: string,
  fileId: string,
  fullText: string
): ParseTransactionsResult {
  const lines = (sectionText || "").replace(/\r\n/g, "\n").split("\n");
  const warnings: ParseWarning[] = [];
  const transactions: ParsedTransaction[] = [];
  const period = parseStatementPeriod(fullText);

  let currentBlock: string[] = [];
  let currentDay = "";
  let currentMonth = "";
  let currentYear: string | undefined;
  let firstRemainder = "";
  let counter = 0;

  const flush = () => {
    if (currentBlock.length === 0) return;
    counter += 1;
    const parsed = finalizeBlock({
      fileId,
      counter,
      rawLines: currentBlock,
      dayText: currentDay,
      monthText: currentMonth,
      yearText: currentYear,
      firstRemainder,
      period,
      warnings,
    });
    if (parsed) {
      transactions.push(parsed);
    } else {
      counter -= 1;
    }
    currentBlock = [];
    currentDay = "";
    currentMonth = "";
    currentYear = undefined;
    firstRemainder = "";
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const dateMatch = DATE_LINE_RE.exec(line);
    if (dateMatch) {
      flush();
      currentDay = dateMatch[1];
      currentMonth = dateMatch[2];
      currentYear = dateMatch[3] ? dateMatch[3].trim() : undefined;
      firstRemainder = (dateMatch[4] || "").trim();
      currentBlock.push(raw);
      continue;
    }

    if (currentBlock.length > 0) {
      currentBlock.push(raw);
      continue;
    }

    // Ignore pre-table residual lines without active block.
  }

  flush();

  return { transactions, warnings };
}
