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
  suffix: "CR" | "DR" | null;
};

const DATE_LINE_RE =
  /^(\d{2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*(\d{4}))?(.*)$/i;
const PERIOD_RE =
  /Period\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})\s*-\s*(\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4})/i;
const MONEY_TOKEN_RE =
  /(?<!\d)(?:-?\$?\d{1,3}(?:,\d{3})*|-?\$?\d+)\.\d{2}(?:CR|DR)?/gi;

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
  const suffix: "CR" | "DR" | null = upper.endsWith("CR")
    ? "CR"
    : upper.endsWith("DR")
      ? "DR"
      : null;

  const numeric = upper
    .replace(/CR$|DR$/i, "")
    .replace(/[$,\s]/g, "");
  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  return { value, suffix };
}

function extractMoneyTokens(lines: string[]): string[] {
  const tokens: string[] = [];
  for (const line of lines) {
    // Value Date lines often glue year and amount: ".../202519.56$$108.66CR".
    const normalized = line.replace(
      /(Value Date:\s*\d{2}\/\d{2}\/\d{4})(?=\d)/gi,
      "$1 "
    );
    for (const match of normalized.matchAll(MONEY_TOKEN_RE)) {
      tokens.push(match[0]);
    }
  }
  return tokens;
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
    parts.push(line);
  }

  return parts.join(" | ").replace(/\s+/g, " ").trim();
}

function detectAmountSign(blockTextUpper: string, amount: MoneyParsed) {
  if (
    blockTextUpper.includes("CREDIT TO ACCOUNT") ||
    blockTextUpper.includes("FAST TRANSFER FROM")
  ) {
    return 1;
  }
  if (
    blockTextUpper.includes("TRANSFER TO") ||
    blockTextUpper.includes("OVERDRAW FEE") ||
    blockTextUpper.includes("DEBIT") ||
    blockTextUpper.includes("CARD XX")
  ) {
    return -1;
  }
  if (amount.suffix === "CR") return 1;
  if (amount.suffix === "DR") return -1;
  return -1;
}

function pushWarning(
  warnings: ParseWarning[],
  rawLine: string,
  reason: string,
  confidence = 0.3
) {
  warnings.push({ rawLine, reason, confidence: clamp01(confidence) });
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

  const dateIso = inferDateIso(dayText, monthText, yearText, period);
  if (!dateIso) {
    pushWarning(warnings, rawLines.join("\n"), "Unable to infer transaction date.", 0.3);
    return null;
  }

  const moneyTokens = extractMoneyTokens(rawLines);
  if (moneyTokens.length < 2) {
    pushWarning(
      warnings,
      rawLines.join("\n"),
      "Amount/balance not found for statement block.",
      0.35
    );
    return {
      id: `${fileId}-${counter}`,
      date: dateIso,
      description: buildDescription(rawLines, firstRemainder) || "(no description)",
      amount: 0,
      balance: undefined,
      rawLine: rawLines.join("\n"),
      confidence: 0.4,
    };
  }

  const amountRaw = parseMoneyToken(moneyTokens[moneyTokens.length - 2]);
  const balanceRaw = parseMoneyToken(moneyTokens[moneyTokens.length - 1]);
  if (!amountRaw || !balanceRaw) {
    pushWarning(
      warnings,
      rawLines.join("\n"),
      "Failed to parse amount/balance tokens.",
      0.35
    );
    return {
      id: `${fileId}-${counter}`,
      date: dateIso,
      description: buildDescription(rawLines, firstRemainder) || "(no description)",
      amount: 0,
      balance: undefined,
      rawLine: rawLines.join("\n"),
      confidence: 0.4,
    };
  }

  const blockUpper = rawLines.join("\n").toUpperCase();
  const sign = detectAmountSign(blockUpper, amountRaw);
  const amount = sign * Math.abs(amountRaw.value);

  let balance = Math.abs(balanceRaw.value);
  if (balanceRaw.suffix === "DR") balance = -Math.abs(balanceRaw.value);
  if (balanceRaw.suffix === "CR") balance = Math.abs(balanceRaw.value);

  return {
    id: `${fileId}-${counter}`,
    date: dateIso,
    description: buildDescription(rawLines, firstRemainder) || "(no description)",
    amount,
    balance,
    rawLine: rawLines.join("\n"),
    confidence: rawLines.length === 1 ? 0.95 : 0.88,
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

