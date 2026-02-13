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
  lineIndex: number;
  tokenIndex: number;
  parsed?: MoneyParsed;
};

const DATE_LINE_RE =
  /^(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*(\d{4}))?(.*)$/i;
const PERIOD_RE =
  /Period\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s*-\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;

// CommBank amount tokens are expected to have exactly 2 decimals.
// Boundaries prevent grabbing partial values from long numeric references.
const MONEY_TOKEN_RE =
  /(?<![\d.])(?:\(\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)|-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?:\s?(?:CR|DR))?(?![\d.])/gi;
const MONEY_SANITY_MAX_ABS = 1_000_000;
const MONEY_EQ_TOLERANCE = 0.01;

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

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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
    if (period.start && period.end && dt >= period.start && dt <= period.end) {
      return dt.toISOString();
    }
  }

  if (period.end) {
    return new Date(Date.UTC(period.end.getUTCFullYear(), month, day)).toISOString();
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
  return m.absValue <= MONEY_SANITY_MAX_ABS;
}

function hasStrictMoneyPattern(text: string) {
  return new RegExp(MONEY_TOKEN_RE.source, "i").test(text);
}

function isReferenceOnlyLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;

  // Only mark as reference if it contains a long digit chain and no valid
  // two-decimal money token. This avoids dropping lines that are real amounts.
  if (hasStrictMoneyPattern(trimmed)) return false;
  const digitsOnly = trimmed.replace(/\D/g, "");
  return digitsOnly.length >= 12;
}

function extractMoneyTokens(lines: string[]): MoneyTokenWithLine[] {
  const tokens: MoneyTokenWithLine[] = [];
  let tokenIndex = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const originalLine = lines[lineIndex];
    const trimmed = originalLine.trim();
    if (isReferenceOnlyLine(trimmed)) {
      continue;
    }

    // Value Date lines may glue date+amount text; split to keep tokenization stable.
    const normalized = originalLine.replace(
      /(Value Date:\s*\d{2}\/\d{2}\/\d{4})(?=\d)/gi,
      "$1 "
    );
    const re = new RegExp(MONEY_TOKEN_RE.source, "gi");
    for (const match of normalized.matchAll(re)) {
      tokens.push({
        token: match[0],
        line: normalized,
        lineIndex,
        tokenIndex,
      });
      tokenIndex += 1;
    }
  }

  return tokens;
}

function hasAnyHint(blockUpper: string, hints: string[]) {
  return hints.some((hint) => blockUpper.includes(hint));
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

function pickBalanceCandidateIndex(tokens: MoneyTokenWithLine[]) {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const parsed = tokens[i].parsed;
    if (parsed?.suffix === "CR" || parsed?.suffix === "DR") {
      return i;
    }
  }
  return tokens.length - 1;
}

function resolveAmount(params: {
  blockUpper: string;
  amountCandidates: MoneyTokenWithLine[];
  rawBlock: string;
  warnings: ParseWarning[];
  prevBalance?: number;
  currBalance?: number;
}): AmountResolution | null {
  const {
    blockUpper,
    amountCandidates,
    rawBlock,
    warnings,
    prevBalance,
    currBalance,
  } = params;
  if (amountCandidates.length === 0) return null;

  const parsedCandidates = amountCandidates.filter((c) => c.parsed);
  if (parsedCandidates.length === 0) return null;

  const hasExplicitDebit = parsedCandidates.some(
    (c) => c.parsed!.hasMinus || c.parsed!.hasParens || c.parsed!.suffix === "DR"
  );
  const hasExplicitCredit = parsedCandidates.some((c) => c.parsed!.suffix === "CR");
  if (hasExplicitDebit && hasExplicitCredit) {
    pushWarning(warnings, rawBlock, "DEBIT_CREDIT_BOTH_PRESENT", 0.35);
  }

  const hasContinuityInputs =
    typeof prevBalance === "number" && typeof currBalance === "number";

  // If we can reconcile against running balances, this is the most reliable sign source.
  if (hasContinuityInputs) {
    for (let i = parsedCandidates.length - 1; i >= 0; i -= 1) {
      const candidate = parsedCandidates[i];
      const v = candidate.parsed!.absValue;
      const creditFits =
        Math.abs(round2((prevBalance as number) + v) - round2(currBalance as number)) <=
        MONEY_EQ_TOLERANCE;
      const debitFits =
        Math.abs(round2((prevBalance as number) - v) - round2(currBalance as number)) <=
        MONEY_EQ_TOLERANCE;

      if (creditFits && !debitFits) {
        return { amount: v, credit: v, confidencePenalty: 0 };
      }
      if (debitFits && !creditFits) {
        return { amount: -v, debit: v, confidencePenalty: 0 };
      }
    }

    pushWarning(warnings, rawBlock, "AMOUNT_SIGN_UNCERTAIN", 0.35);
    return null;
  }

  const candidate = parsedCandidates[parsedCandidates.length - 1];
  const hasCreditHint = hasAnyHint(blockUpper, CREDIT_HINTS);
  const hasDebitHint = hasAnyHint(blockUpper, DEBIT_HINTS);

  let side: "debit" | "credit" | "unknown" = "unknown";
  if (candidate.parsed!.hasMinus || candidate.parsed!.hasParens || candidate.parsed!.suffix === "DR") {
    side = "debit";
  } else if (candidate.parsed!.suffix === "CR") {
    side = "credit";
  } else if (hasCreditHint && !hasDebitHint) {
    side = "credit";
  } else if (hasDebitHint && !hasCreditHint) {
    side = "debit";
  }

  if (side === "unknown") {
    pushWarning(warnings, rawBlock, "AMOUNT_SIGN_UNCERTAIN", 0.4);
    return null;
  }

  const v = candidate.parsed!.absValue;
  if (side === "debit") {
    return { amount: -v, debit: v, confidencePenalty: 0.1 };
  }
  return { amount: v, credit: v, confidencePenalty: 0.1 };
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
  prevBalance?: number;
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
    prevBalance,
  } = params;

  if (rawLines.length === 0) return null;
  if (isNonTransactionBlock(rawLines[0])) return null;

  const rawBlock = rawLines.join("\n");
  const warningCountBefore = warnings.length;
  const dateIso = inferDateIso(dayText, monthText, yearText, period);
  if (!dateIso) {
    pushWarning(warnings, rawBlock, "Unable to infer transaction date.", 0.3);
    return null;
  }

  const moneyTokens = extractMoneyTokens(rawLines);
  const parsedTokens: MoneyTokenWithLine[] = [];
  for (const candidate of moneyTokens) {
    const parsed = parseMoneyToken(candidate.token);
    if (!parsed) continue;

    if (!isMoneyCandidateSane(parsed)) {
      pushWarning(warnings, rawBlock, "AMOUNT_OUTLIER", 0.3);
      continue;
    }

    parsedTokens.push({ ...candidate, parsed });
  }

  let balance: number | undefined;
  let amountResolved: AmountResolution | null = null;

  if (parsedTokens.length > 0) {
    const balanceIndex = pickBalanceCandidateIndex(parsedTokens);
    const balanceCandidate = parsedTokens[balanceIndex];
    balance = Math.abs(balanceCandidate.parsed!.absValue);

    // Amount candidates are constrained to balance neighborhood (same/prev/next line)
    // to reduce pollution from unrelated reference lines in the same block.
    const amountCandidates = parsedTokens.filter((c, idx) => {
      if (idx === balanceIndex) return false;
      return Math.abs(c.lineIndex - balanceCandidate.lineIndex) <= 1;
    });

    amountResolved = resolveAmount({
      blockUpper: rawBlock.toUpperCase(),
      amountCandidates,
      rawBlock,
      warnings,
      prevBalance,
      currBalance: balance,
    });
  }

  if (typeof balance !== "number") {
    pushWarning(warnings, rawBlock, "AUTO_BALANCE_NOT_FOUND", 0.35);
  }
  if (!amountResolved) {
    pushWarning(warnings, rawBlock, "AUTO_AMOUNT_NOT_FOUND", 0.35);
  }

  const amount = amountResolved?.amount ?? 0;
  const debit = amountResolved?.debit;
  const credit = amountResolved?.credit;
  const hasAmountSide =
    (typeof debit === "number" && typeof credit !== "number") ||
    (typeof debit !== "number" && typeof credit === "number");
  const hasCoreFields = typeof balance === "number" && hasAmountSide;
  const warningCountAdded = warnings.length - warningCountBefore;

  let confidence = 0.42;
  if (hasCoreFields && warningCountAdded === 0) {
    confidence = 0.95;
  } else if (hasCoreFields) {
    const fallbackPenalty = amountResolved?.confidencePenalty ?? 0;
    const warningPenalty = Math.min(0.25, warningCountAdded * 0.08);
    confidence = clamp01(0.88 - fallbackPenalty - warningPenalty);
  } else {
    const warningPenalty = Math.min(0.3, warningCountAdded * 0.06);
    confidence = clamp01(0.5 - warningPenalty);
  }

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

    const prevBalance =
      transactions.length > 0 ? transactions[transactions.length - 1].balance : undefined;

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
      prevBalance,
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

    // Ignore residual lines before first dated transaction row.
  }

  flush();

  return { transactions, warnings };
}
