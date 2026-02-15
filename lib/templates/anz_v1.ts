import { createHash } from "crypto";
import {
  DevTemplate,
  DevTemplateDetection,
  DevTemplateParseInput,
  DevTemplateParseOutput,
  DevTemplateWarning,
} from "@/lib/templates/types";

const MONTHLY_RANGE_RE =
  /(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})\s*-\s*(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4})/i;

const AS_AT_RE =
  /AS AT\s+(\d{1,2}\s+(?:JANUARY|FEBRUARY|MARCH|APRIL|MAY|JUNE|JULY|AUGUST|SEPTEMBER|OCTOBER|NOVEMBER|DECEMBER)\s+\d{4})/i;

const TABLE_HEADER_RE =
  /DATE\s*DESCRIPTION\s*(?:CREDIT|DEPOSITS?)\s*(?:DEBIT|WITHDRAWALS?)\s*BALANCE/i;

const TABLE_STOP_MARKERS: RegExp[] = [
  /^Opening Balance\b/i,
  /^Please check your statement\b/i,
  /^If you notice any errors\b/i,
  /^For information about your account\b/i,
  /^Account Statement\b/i,
  /^Australia and New Zealand Banking Group\b/i,
  /^\s*AFSL\b/i,
  /^\s*ABN\b/i,
  /^\s*Page\s+\d+\s+of\s+\d+/i,
  /^Closing Balance\b/i,
  /^Total Debits\b/i,
  /^Total Credits\b/i,
  /^Important Information\b/i,
  /^Transaction Summary\b/i,
];

const SHORT_MONTHS: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};

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

const TRANSACTION_ROW_RE =
  /^\s*(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(.*)$/i;
const DATE_RANGE_HEADER_LINE_RE =
  /^\s*\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*-\s*\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\s*$/i;

const MONEY_TOKEN_RE = /\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?/g;

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

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

function parseMoneyToken(token: string) {
  const raw = token.trim();
  const hasParens = raw.startsWith("(") && raw.endsWith(")");
  const normalized = raw.replace(/[()$,]/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  if (hasParens || value < 0) return -Math.abs(value);
  return Math.abs(value);
}

function extractMoneyTokens(text: string) {
  const out: Array<{ token: string; value: number }> = [];
  for (const match of text.matchAll(MONEY_TOKEN_RE)) {
    const token = match[0];
    const value = parseMoneyToken(token);
    if (typeof value === "number" && Number.isFinite(value)) {
      out.push({ token, value });
    }
  }
  return out;
}

function stripMoneyTokens(text: string) {
  return text
    .replace(MONEY_TOKEN_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function extractHeaderMeta(text: string, mode: DevTemplateDetection["mode"]) {
  const warnings: DevTemplateWarning[] = [];
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");

  let bsb = "";
  let accountNumber = "";

  const combinedRow = /(\d{3}\s?\d{3})\s*([0-9 ]{6,}?)(?=\$)/.exec(text);
  if (combinedRow) {
    bsb = digitsOnly(combinedRow[1]).slice(0, 6);
    accountNumber = digitsOnly(combinedRow[2]);
  }

  const bsbInline = /BRANCH NUMBER \(BSB\)\s*[:\-]?\s*([0-9 ]{6,})/i.exec(text);
  if (bsbInline && !bsb) bsb = digitsOnly(bsbInline[1]).slice(0, 6);

  const accountInline = /ACCOUNT NUMBER\s*[:\-]?\s*([0-9 ]{6,})/i.exec(text);
  if (accountInline && !accountNumber) accountNumber = digitsOnly(accountInline[1]);

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

type TxBlock = {
  day: number;
  monthShort: string;
  firstRemainder: string;
  lines: string[];
  startLine: number;
};

type ParsedBlock = {
  block: TxBlock;
  descriptionRaw: string;
  balance: number;
  amountAbs?: number;
  moneyTokens: string[];
};

function inferTransactionDateIso(params: {
  day: number;
  monthShort: string;
  coverageStart?: string;
  coverageEnd?: string;
  previousDate?: string;
}) {
  const monthIdx = SHORT_MONTHS[params.monthShort.toUpperCase()];
  if (typeof monthIdx !== "number") return null;

  const candidates = new Set<number>();
  const coverageStart = params.coverageStart ? new Date(params.coverageStart) : null;
  const coverageEnd = params.coverageEnd ? new Date(params.coverageEnd) : null;

  if (coverageStart) {
    candidates.add(coverageStart.getUTCFullYear() - 1);
    candidates.add(coverageStart.getUTCFullYear());
    candidates.add(coverageStart.getUTCFullYear() + 1);
  }
  if (coverageEnd) {
    candidates.add(coverageEnd.getUTCFullYear() - 1);
    candidates.add(coverageEnd.getUTCFullYear());
    candidates.add(coverageEnd.getUTCFullYear() + 1);
  }
  if (candidates.size === 0) {
    candidates.add(new Date().getUTCFullYear());
  }

  const previousTs = params.previousDate ? new Date(params.previousDate).getTime() : null;
  const scored: Array<{ iso: string; score: number }> = [];

  for (const year of candidates) {
    const date = new Date(Date.UTC(year, monthIdx, params.day));
    if (Number.isNaN(date.getTime())) continue;

    let score = 0;
    if (coverageStart && coverageEnd) {
      const ts = date.getTime();
      const inRange = ts >= coverageStart.getTime() && ts <= coverageEnd.getTime();
      if (inRange) score += 100;
    }

    if (previousTs !== null) {
      const diffDays = Math.abs(date.getTime() - previousTs) / (24 * 3600 * 1000);
      score += Math.max(0, 50 - diffDays);
      if (date.getTime() >= previousTs - 40 * 24 * 3600 * 1000) {
        score += 10;
      }
    }

    scored.push({ iso: date.toISOString().slice(0, 10), score });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0].iso;
}

function normalizeDescription(lines: string[], firstRemainder: string) {
  const merged = [firstRemainder, ...lines.slice(1)]
    .map((line) => line.trim())
    .map((line) => {
      const effective = /^Effective Date\b/i.exec(line);
      return effective ? `| ${line}` : line;
    })
    .filter(Boolean)
    .join(" ");

  return stripMoneyTokens(merged)
    .replace(/\s+/g, " ")
    .replace(/\s+\$/g, "")
    .trim();
}

function isStopMarkerLine(line: string) {
  return TABLE_STOP_MARKERS.some((regex) => regex.test(line));
}

function extractOpeningBalance(line: string) {
  const tokens = extractMoneyTokens(line);
  if (tokens.length === 0) return undefined;
  const last = tokens[tokens.length - 1].value;
  if (!Number.isFinite(last)) return undefined;
  return round2(last);
}

function getTransactionRowMatch(line: string) {
  if (DATE_RANGE_HEADER_LINE_RE.test(line)) return null;
  return TRANSACTION_ROW_RE.exec(line);
}

function parseAnzTransactions(params: {
  input: DevTemplateParseInput;
  accountId: string;
  coverage: { startDate?: string; endDate?: string };
  mode: DevTemplateDetection["mode"];
}) {
  const warnings: DevTemplateWarning[] = [];
  const lines = (params.input.text || "").replace(/\r\n/g, "\n").split("\n");

  let headerLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (TABLE_HEADER_RE.test(lines[i])) {
      headerLine = i;
      break;
    }
  }

  if (headerLine < 0) {
    warnings.push({
      code: "ANZ_TABLE_HEADER_MISSING",
      message: "Could not find ANZ transactions table header.",
      severity: "critical",
      confidence: 0.2,
    });
    return { transactions: [], warnings, continuityRatio: 0, checkedCount: 0 };
  }

  const blocks: TxBlock[] = [];
  let current: TxBlock | null = null;
  let openingBalance: number | undefined;

  for (let i = headerLine + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (!raw) continue;

    if (/^Opening Balance\b/i.test(raw)) {
      openingBalance = extractOpeningBalance(raw);
      if (current) {
        blocks.push(current);
        current = null;
      }
      // Opening Balance defines the lower boundary; do not parse below it.
      break;
    }

    if (isStopMarkerLine(raw)) {
      if (current) {
        blocks.push(current);
        current = null;
      }
      const hasAnotherHeaderAhead = lines
        .slice(i + 1)
        .some((line) => TABLE_HEADER_RE.test(line));
      if (hasAnotherHeaderAhead) {
        continue;
      }
      break;
    }

    if (TABLE_HEADER_RE.test(raw)) {
      // Repeated header from another page.
      continue;
    }

    const dateMatch = getTransactionRowMatch(raw);
    if (dateMatch) {
      if (current) blocks.push(current);
      current = {
        day: Number(dateMatch[1]),
        monthShort: dateMatch[2],
        firstRemainder: dateMatch[3].trim(),
        lines: [raw],
        startLine: i + 1,
      };
      continue;
    }

    if (current) {
      // Continuation lines (including Effective Date ...) belong to previous transaction.
      current.lines.push(raw);
    }
  }

  if (current) blocks.push(current);

  const parsedBlocks: ParsedBlock[] = [];
  for (const block of blocks) {
    const firstLineMoney = extractMoneyTokens(block.lines[0]);
    const blockMoney =
      firstLineMoney.length >= 2
        ? firstLineMoney
        : extractMoneyTokens(block.lines.join(" "));

    if (blockMoney.length < 1) {
      warnings.push({
        code: "ANZ_AMOUNT_OR_BALANCE_MISSING",
        message: "Could not find money tokens in ANZ transaction row.",
        severity: "warning",
        rawLine: block.lines[0],
        lineIndex: block.startLine,
        confidence: 0.35,
      });
      continue;
    }

    const balanceValue = blockMoney[blockMoney.length - 1].value;
    if (!Number.isFinite(balanceValue)) {
      warnings.push({
        code: "ANZ_BALANCE_NOT_VALID",
        message: "ANZ balance token was not a valid number.",
        severity: "warning",
        rawLine: block.lines[0],
        lineIndex: block.startLine,
        confidence: 0.3,
      });
      continue;
    }

    let amountAbs: number | undefined;
    if (blockMoney.length >= 2) {
      const amountCandidate = Math.abs(blockMoney[blockMoney.length - 2].value);
      if (Number.isFinite(amountCandidate) && amountCandidate > 0) {
        amountAbs = amountCandidate;
      }
    }

    const descriptionRaw =
      normalizeDescription(block.lines, block.firstRemainder) || "(no description)";

    if (/^EFFECTIVE\s+DATE\b/i.test(descriptionRaw) && block.lines.length === 1) {
      warnings.push({
        code: "ANZ_EFFECTIVE_DATE_STANDALONE_SKIPPED",
        message: "Skipped standalone Effective Date row.",
        severity: "warning",
        rawLine: block.lines[0],
        lineIndex: block.startLine,
        confidence: 0.4,
      });
      continue;
    }

    parsedBlocks.push({
      block,
      descriptionRaw,
      balance: round2(balanceValue),
      amountAbs,
      moneyTokens: blockMoney.map((entry) => entry.token),
    });
  }

  // ANZ table rows are newest -> oldest. Reverse into chronological order for continuity checks.
  const chronoBlocks = [...parsedBlocks].reverse();
  const transactions: DevTemplateParseOutput["transactions"] = [];

  for (const entry of chronoBlocks) {
    const previousBalance =
      transactions.length > 0
        ? transactions[transactions.length - 1].balance
        : openingBalance;
    const hasPreviousBalance = typeof previousBalance === "number";
    const balance = entry.balance;
    const deltaFromPrev =
      hasPreviousBalance
        ? round2(balance - previousBalance)
        : undefined;

    const dateIso = inferTransactionDateIso({
      day: entry.block.day,
      monthShort: entry.block.monthShort,
      coverageStart: params.coverage.startDate,
      coverageEnd: params.coverage.endDate,
      previousDate: transactions[transactions.length - 1]?.date,
    });

    if (!dateIso) {
      warnings.push({
        code: "ANZ_DATE_INFERENCE_FAILED",
        message: "Failed to infer ANZ transaction year from statement context.",
        severity: "warning",
        rawLine: entry.block.lines[0],
        lineIndex: entry.block.startLine,
        confidence: 0.25,
      });
      continue;
    }

    let amountSigned: number | null = null;

    if (typeof entry.amountAbs === "number" && typeof deltaFromPrev === "number") {
      if (Math.abs(Math.abs(deltaFromPrev) - entry.amountAbs) <= 0.01 && Math.abs(deltaFromPrev) > 0) {
        amountSigned = deltaFromPrev;
      } else {
        const plusHit = Math.abs(round2(previousBalance! + entry.amountAbs) - balance) <= 0.01;
        const minusHit = Math.abs(round2(previousBalance! - entry.amountAbs) - balance) <= 0.01;
        if (plusHit && !minusHit) amountSigned = entry.amountAbs;
        if (minusHit && !plusHit) amountSigned = -entry.amountAbs;
      }
    }

    if (amountSigned === null && typeof entry.amountAbs === "number") {
      const blockText = entry.block.lines.join(" ");
      if (/(CREDIT|DEPOSIT|TRANSFER\s+FROM|REFUND|INTEREST\s+PAID|SALARY)/i.test(blockText)) {
        amountSigned = entry.amountAbs;
      } else if (
        /(DEBIT|TRANSFER\s+TO|WITHDRAWAL|PURCHASE|FEE|PAYMENT\s+TO|CARD|BPAY)/i.test(
          blockText
        )
      ) {
        amountSigned = -entry.amountAbs;
      }
    }

    if (amountSigned === null && typeof deltaFromPrev === "number") {
      amountSigned = deltaFromPrev;
      warnings.push({
        code: "ANZ_AMOUNT_INFERRED_FROM_BALANCE_DELTA",
        message: `Amount inferred from balance delta (${deltaFromPrev.toFixed(2)}), tokens: ${
          entry.moneyTokens.join(", ") || "none"
        }.`,
        severity: "warning",
        rawLine: entry.block.lines[0],
        lineIndex: entry.block.startLine,
        confidence: 0.7,
      });
    }

    if (amountSigned === null && typeof entry.amountAbs === "number") {
      amountSigned = -entry.amountAbs;
      // Only warn when no opening/previous balance baseline exists.
      if (!hasPreviousBalance) {
        warnings.push({
          code: "ANZ_AMOUNT_SIGN_UNCERTAIN",
          message: `Amount sign uncertain; no opening/previous balance baseline (tokens: ${
            entry.moneyTokens.join(", ") || "none"
          }).`,
          severity: "warning",
          rawLine: entry.block.lines[0],
          lineIndex: entry.block.startLine,
          confidence: 0.35,
        });
      }
    }

    if (amountSigned === null) {
      const warningCode =
        typeof entry.amountAbs === "number"
          ? "ANZ_AMOUNT_NOT_VALID"
          : "ANZ_AMOUNT_OR_BALANCE_MISSING";
      warnings.push({
        code: warningCode,
        message: `ANZ amount could not be resolved (tokens: ${
          entry.moneyTokens.join(", ") || "none"
        }).`,
        severity: "warning",
        rawLine: entry.block.lines[0],
        lineIndex: entry.block.startLine,
        confidence: 0.3,
      });
      continue;
    }

    const direction = amountSigned >= 0 ? "credit" : "debit";
    const debit = amountSigned < 0 ? Math.abs(amountSigned) : undefined;
    const credit = amountSigned >= 0 ? Math.abs(amountSigned) : undefined;

    const id = createHash("sha1")
      .update(
        `${params.input.fileHash || params.input.fileId}|${entry.block.startLine}|${dateIso}|${round2(
          amountSigned
        ).toFixed(2)}|${entry.descriptionRaw}`
      )
      .digest("hex")
      .slice(0, 16);

    transactions.push({
      id,
      date: dateIso,
      descriptionRaw: entry.descriptionRaw,
      amount: round2(amountSigned),
      direction,
      debit,
      credit,
      balance,
      bankId: "anz",
      accountId: params.accountId,
      templateId: "anz_v1",
      confidence:
        typeof entry.amountAbs === "number"
          ? entry.block.lines.length > 1
            ? 0.88
            : 0.95
          : 0.8,
      rawLine: entry.block.lines[0],
      rawLines: entry.block.lines,
      source: {
        fileId: params.input.fileId,
        fileHash: params.input.fileHash,
        rowIndex: entry.block.startLine,
        parserVersion: `anz_v1_${params.mode}`,
      },
    });
  }

  let checkedCount = 0;
  let continuityPass = 0;
  for (let i = 1; i < transactions.length; i += 1) {
    const prev = transactions[i - 1];
    const curr = transactions[i];
    if (typeof prev.balance !== "number" || typeof curr.balance !== "number") continue;
    checkedCount += 1;
    if (Math.abs(round2(prev.balance + curr.amount) - round2(curr.balance)) <= 0.01) {
      continuityPass += 1;
    }
  }
  const continuityRatio = checkedCount > 0 ? continuityPass / checkedCount : 1;

  if (checkedCount >= 5 && continuityRatio < 0.995) {
    warnings.push({
      code: "ANZ_BALANCE_CONTINUITY_LOW",
      message: "ANZ balance continuity below threshold; review statement parsing.",
      severity: "critical",
      confidence: continuityRatio,
    });
  }

  return {
    transactions,
    warnings,
    continuityRatio,
    checkedCount,
  };
}

function parseAnzV1(input: DevTemplateParseInput): DevTemplateParseOutput {
  const detection = detectAnzV1(input.text);
  const header = extractHeaderMeta(input.text, detection.mode);
  const table = parseAnzTransactions({
    input,
    accountId: header.accountId,
    coverage: header.coverage,
    mode: detection.mode,
  });

  return {
    bankId: "anz",
    templateId: "anz_v1",
    mode: detection.mode,
    accountId: header.accountId,
    coverage: header.coverage,
    transactions: table.transactions,
    warnings: [...header.warnings, ...table.warnings],
    debug: {
      continuityRatio: table.continuityRatio,
      checkedCount: table.checkedCount,
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
