/**
 * Phase 2.5.2 (CommBank-only)
 *
 * This parser is intentionally rule-based and bank-specific for now.
 * We prioritize:
 * 1) traceability (keep rawLine),
 * 2) deterministic behavior,
 * 3) conservative warnings for unclassified lines.
 */

export type ParsedTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  // Tracks how amount was decided for debugging/UX explainability.
  // Most rows are token-based; some auto-template rows may be inferred from
  // running balance delta when debit/credit tokens are missing.
  amountSource?: "parsed_token" | "balance_diff_inferred";
  debit?: number;
  credit?: number;
  balance?: number;
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

type ParsedMoney = {
  value: number;
  currency?: string;
};

type MoneyTokenMatch = {
  token: string;
  index: number;
};

type ParsedTail = {
  description: string;
  amount: ParsedMoney;
  balance: ParsedMoney;
};

type PendingTransaction = {
  dateIso: string;
  descriptionParts: string[];
  rawLines: string[];
};

const DATE_PREFIX_RE = /^(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})\s*(.*)$/;
const HEADER_ANCHOR = "datetransactiondetailsamountbalance";

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

// Supports: -$50.00, $2,000.00, (50.00), 12.34CR
const MONEY_TOKEN_RE =
  /(?:-?\$?\d+(?:,\d{3})*(?:\.\d{2})|\(\$?\d+(?:,\d{3})*(?:\.\d{2})\)|\$?\d+(?:,\d{3})*(?:\.\d{2})CR)/gi;

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function compactAlphaNum(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isHeaderLine(line: string) {
  return compactAlphaNum(line).includes(HEADER_ANCHOR);
}

function isNoiseLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // CommBank PDF page-break artifacts that should not become warnings.
  if (/^created\s+/i.test(trimmed)) return true;
  if (/^while this letter is accurate/i.test(trimmed)) return true;
  if (/^we['’]re not responsible/i.test(trimmed)) return true;
  if (/^transaction summary\b/i.test(trimmed)) return true;
  if (/^account number/i.test(trimmed)) return true;
  if (/^page\s*\d+\s*of\s*\d+/i.test(trimmed.replace(/\s+/g, ""))) return true;

  return isHeaderLine(trimmed);
}

function toIsoDate(dateToken: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/.exec(dateToken.trim());
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTH_INDEX[m[2].toLowerCase()];
  const year = Number(m[3]);

  if (!Number.isInteger(day) || month === undefined || !Number.isInteger(year)) return null;
  if (day < 1 || day > 31) return null;

  const dt = new Date(Date.UTC(year, month, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  return dt.toISOString();
}

function parseMoneyToken(token: string): ParsedMoney | null {
  const raw = token.trim();
  if (!raw) return null;

  const upper = raw.toUpperCase();
  const hasCR = upper.endsWith("CR");
  const hasParens = upper.startsWith("(") && upper.endsWith(")");
  const hasMinus = upper.includes("-");
  const currency = raw.includes("$") ? "AUD" : undefined;

  const numeric = upper
    .replace(/CR$/i, "")
    .replace(/[()$,\s]/g, "")
    .replace(/[-+]/g, "");

  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  // CommBank statements in this phase: explicit minus / parentheses are debits,
  // CR is explicit credit, unsigned token defaults to positive credit.
  const signed = hasParens || hasMinus ? -Math.abs(value) : Math.abs(value);
  const finalValue = hasCR ? Math.abs(value) : signed;

  return { value: finalValue, currency };
}

function extractMoneyMatches(text: string): MoneyTokenMatch[] {
  const re = new RegExp(MONEY_TOKEN_RE.source, "gi");
  const result: MoneyTokenMatch[] = [];

  for (const match of text.matchAll(re)) {
    if (match.index === undefined) continue;
    result.push({ token: match[0], index: match.index });
  }

  return result;
}

/**
 * Parse a line tail with amount + balance at the end.
 * We take the last two money tokens to avoid brittle assumptions about spaces.
 */
function parseTailWithAmountAndBalance(text: string): ParsedTail | null {
  const matches = extractMoneyMatches(text);
  if (matches.length < 2) return null;

  const amountToken = matches[matches.length - 2];
  const balanceToken = matches[matches.length - 1];

  const amount = parseMoneyToken(amountToken.token);
  const balance = parseMoneyToken(balanceToken.token);
  if (!amount || !balance) return null;

  const description = text.slice(0, amountToken.index).trim();
  return { description, amount, balance };
}

function pushWarning(
  warnings: ParseWarning[],
  rawLine: string,
  reason: string,
  confidence = 0.2
) {
  warnings.push({ rawLine, reason, confidence: clamp01(confidence) });
}

function normalizeDescription(parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function isLikelyReferenceLine(line: string) {
  const compact = line.replace(/\s+/g, "").trim();
  return /^\d{6,}$/.test(compact);
}

function appendToPreviousTransaction(
  transactions: ParsedTransaction[],
  raw: string,
  line: string
) {
  if (transactions.length === 0) return false;
  const prev = transactions[transactions.length - 1];
  prev.description = `${prev.description} ${line}`.replace(/\s+/g, " ").trim();
  prev.rawLine = `${prev.rawLine}\n${raw}`;
  prev.confidence = clamp01(prev.confidence - 0.08);
  return true;
}

export function parseTransactionsV1(sectionText: string, fileId: string): ParseTransactionsResult {
  const lines = (sectionText || "").replace(/\r\n/g, "\n").split("\n");
  const transactions: ParsedTransaction[] = [];
  const warnings: ParseWarning[] = [];

  let pending: PendingTransaction | null = null;
  let counter = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (isNoiseLine(line)) {
      continue;
    }

    const dateMatch = DATE_PREFIX_RE.exec(line);

    if (dateMatch) {
      if (pending) {
        pushWarning(
          warnings,
          pending.rawLines.join("\n"),
          "Pending transaction was not completed before next dated row.",
          0.25
        );
        pending = null;
      }

      const dateIso = toIsoDate(dateMatch[1]);
      if (!dateIso) {
        pushWarning(warnings, rawLine, "Invalid date format.", 0.25);
        continue;
      }

      const afterDate = (dateMatch[2] || "").trim();
      const inlineParsed = parseTailWithAmountAndBalance(afterDate);

      if (inlineParsed) {
        counter += 1;
        const description = inlineParsed.description || "(no description)";
        transactions.push({
          id: `${fileId}-${counter}`,
          date: dateIso,
          description,
          amount: inlineParsed.amount.value,
          balance: inlineParsed.balance.value,
          currency: inlineParsed.amount.currency || inlineParsed.balance.currency,
          rawLine,
          confidence: description === "(no description)" ? 0.75 : 0.95,
        });
        continue;
      }

      // CommBank Direct Credit pattern:
      // line 1 = date + text, next line(s) = reference, final line = amount+balance.
      pending = {
        dateIso,
        descriptionParts: [afterDate],
        rawLines: [rawLine],
      };
      continue;
    }

    // Non-dated line handling.
    if (pending) {
      pending.rawLines.push(rawLine);

      const parsedTail = parseTailWithAmountAndBalance(line);
      if (parsedTail) {
        pending.descriptionParts.push(parsedTail.description);

        counter += 1;
        transactions.push({
          id: `${fileId}-${counter}`,
          date: pending.dateIso,
          description: normalizeDescription(pending.descriptionParts) || "(no description)",
          amount: parsedTail.amount.value,
          balance: parsedTail.balance.value,
          currency: parsedTail.amount.currency || parsedTail.balance.currency,
          rawLine: pending.rawLines.join("\n"),
          confidence: 0.88,
        });

        pending = null;
        continue;
      }

      if (isLikelyReferenceLine(line)) {
        pending.descriptionParts.push(line);
      } else {
        // Keep unknown continuation lines for traceability. We do not warn yet,
        // because many CommBank rows span multiple lines before amount appears.
        pending.descriptionParts.push(line);
      }
      continue;
    }

    if (!appendToPreviousTransaction(transactions, rawLine, line)) {
      pushWarning(warnings, rawLine, "Unclassified line (no date and no pending row).", 0.2);
    }
  }

  if (pending) {
    pushWarning(
      warnings,
      pending.rawLines.join("\n"),
      "Pending transaction reached end without amount/balance line.",
      0.25
    );
  }

  return { transactions, warnings };
}
