/**
 * Phase 2.3
 *
 * Rule-based parser for transaction lines. This is intentionally conservative:
 * - keep rawLine for traceability
 * - lower confidence for uncertain parses
 * - emit warnings instead of dropping problematic rows
 */

export type ParsedTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  currency?: string;
  rawLine: string;
  confidence: number;
};

export type ParseWarning = {
  rawLine: string;
  reason: string;
  confidence: number;
};

export type ParseTransactionsResult = {
  transactions: ParsedTransaction[];
  warnings: ParseWarning[];
};

type AmountParse = {
  amount: number;
  currency?: string;
  confidence: number;
};

const DATE_PREFIX_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.*)$/;
const AMOUNT_TAIL_RE =
  /((?:(?:[A-Z]{3}|[$£€])\s*)?(?:\(?-?\d{1,3}(?:,\d{3})*(?:\.\d{2})\)?(?:[Cc][Rr])?|-?\d+(?:\.\d{2})(?:[Cc][Rr])?))\s*$/;

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Supports DD/MM/YYYY and DD/MM/YY.
 * Two-digit years are normalized to 20xx (00-69) or 19xx (70-99).
 */
function toIsoDate(dateToken: string): string | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dateToken.trim());
  if (!m) return null;

  const day = Number(m[1]);
  const month = Number(m[2]);
  const rawYear = Number(m[3]);
  const year = m[3].length === 2 ? (rawYear >= 70 ? 1900 + rawYear : 2000 + rawYear) : rawYear;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  return dt.toISOString();
}

/**
 * Amount format support (minimum requested):
 * - -12.34
 * - 1,234.56
 * - (12.34)
 * - 12.34CR
 */
function parseAmountToken(token: string): AmountParse | null {
  let text = token.trim();
  if (!text) return null;

  const currencyMatch = /^([A-Z]{3}|[$£€])\s*/.exec(text);
  const currency = currencyMatch ? currencyMatch[1] : undefined;
  if (currencyMatch) text = text.slice(currencyMatch[0].length);

  const hasCR = /CR$/i.test(text);
  text = text.replace(/CR$/i, "");

  const hasParens = /^\(.*\)$/.test(text);
  if (hasParens) text = text.slice(1, -1);

  const hasMinus = text.startsWith("-");
  if (hasMinus) text = text.slice(1);

  text = text.replace(/,/g, "").trim();
  const value = Number(text);
  if (!Number.isFinite(value)) return null;

  let amount = value;
  let confidence = 0.7;

  if (hasCR) {
    amount = Math.abs(value);
    confidence = 0.9;
  } else if (hasParens || hasMinus) {
    amount = -Math.abs(value);
    confidence = 0.9;
  } else {
    // Conservative fallback for statement style: unsigned values are treated as expense.
    amount = -Math.abs(value);
  }

  return { amount, currency, confidence };
}

export function parseTransactionsV1(sectionText: string, fileId: string): ParseTransactionsResult {
  const lines = (sectionText || "").replace(/\r\n/g, "\n").split("\n");
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];

  let counter = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const dateMatch = DATE_PREFIX_RE.exec(line);

    // Continuation lines append to previous transaction description.
    if (!dateMatch) {
      if (transactions.length > 0) {
        const prev = transactions[transactions.length - 1];
        prev.description = `${prev.description} ${line}`.trim();
        prev.rawLine = `${prev.rawLine}\n${raw}`;
        prev.confidence = clamp01(prev.confidence - 0.05);
      } else {
        warnings.push({
          rawLine: raw,
          reason: "No date and no previous transaction to attach.",
          confidence: 0.2,
        });
      }
      continue;
    }

    const dateToken = dateMatch[1];
    const afterDate = dateMatch[2] || "";
    const isoDate = toIsoDate(dateToken);

    // Try parsing amount from line tail.
    const amountMatch = AMOUNT_TAIL_RE.exec(afterDate);
    if (!amountMatch) {
      counter += 1;
      const fallbackTx: ParsedTransaction = {
        id: `${fileId}-${counter}`,
        date: isoDate || "",
        description: afterDate.trim(),
        amount: 0,
        rawLine: raw,
        confidence: 0.3,
      };
      transactions.push(fallbackTx);
      warnings.push({
        rawLine: raw,
        reason: "Date found but amount not recognized.",
        confidence: 0.3,
      });
      continue;
    }

    const amountToken = amountMatch[1].trim();
    const amountParsed = parseAmountToken(amountToken);

    if (!amountParsed || !isoDate) {
      counter += 1;
      const fallbackTx: ParsedTransaction = {
        id: `${fileId}-${counter}`,
        date: isoDate || "",
        description: afterDate.trim(),
        amount: 0,
        rawLine: raw,
        confidence: 0.3,
      };
      transactions.push(fallbackTx);
      warnings.push({
        rawLine: raw,
        reason: !isoDate ? "Date format invalid." : "Amount parse failed.",
        confidence: 0.3,
      });
      continue;
    }

    const description = afterDate.slice(0, amountMatch.index).trim();

    counter += 1;
    transactions.push({
      id: `${fileId}-${counter}`,
      date: isoDate,
      description: description || "(no description)",
      amount: amountParsed.amount,
      currency: amountParsed.currency,
      rawLine: raw,
      confidence: amountParsed.confidence,
    });
  }

  return { transactions, warnings };
}
