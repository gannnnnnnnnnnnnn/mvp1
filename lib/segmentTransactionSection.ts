/**
 * Phase 2.2
 *
 * This module intentionally exports a pure function:
 * - no file system reads
 * - no external state
 * - deterministic result for same input text
 *
 * Goal: locate likely transaction area in bank-style PDF text and remove
 * noisy repeated header/footer lines while preserving raw line structure.
 */

import { CommBankTemplateType } from "@/lib/commbankTemplate";

export type SegmentDebug = {
  /**
   * 1-based line number where we found the transaction header anchor.
   * Undefined means anchor was not found and we used full text fallback.
   */
  startLine?: number;
  /**
   * 1-based line number where we detected a known CommBank ending hint.
   * Undefined means no explicit ending hint was found.
   */
  endLine?: number;
  /** Number of repeated header rows removed from the final segment. */
  removedLines: number;
  /** Whether the required CommBank header anchor was detected. */
  headerFound: boolean;
  /** Optional end trigger reason (for debugging failed/early stops). */
  stopReason?: string;
};

export type SegmentResult = {
  sectionText: string;
  debug: SegmentDebug;
};

// CommBank anchor requested in Milestone 2.5.1:
// "Date Transaction details Amount Balance"
// PDF extraction may remove spaces, so we compare with a compacted form.
const SUMMARY_HEADER_ANCHOR = "datetransactiondetailsamountbalance";
const SUMMARY_END_ANCHOR = "anypendingtransactionshaventbeenincluded";

// CommBank traditional statement template:
// "Date Transaction Debit Credit Balance" (often split across lines in PDF text).
const STATEMENT_HEADER_ANCHOR = "transactiondebitcreditbalance";
const STATEMENT_STOP_CLOSING_BALANCE = "closingbalance";
const STATEMENT_STOP_SUMMARY = "transactionsummaryduring";

/**
 * Compact to alphanumeric only so we can match regardless of spaces/punctuation,
 * e.g. "DateTransaction detailsAmountBalance" still matches the same anchor.
 */
function compactAlphaNum(line: string) {
  return line.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSummaryHeaderLine(line: string) {
  return compactAlphaNum(line).includes(SUMMARY_HEADER_ANCHOR);
}

function isSummaryEndingLine(line: string) {
  return compactAlphaNum(line).includes(SUMMARY_END_ANCHOR);
}

function segmentSummaryTemplate(lines: string[]): SegmentResult {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isSummaryHeaderLine(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const filteredLines: string[] = [];
  let endLine: number | undefined;
  let removedLines = 0;
  let stopReason: string | undefined;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];

    if (isSummaryEndingLine(line)) {
      endLine = i + 1;
      stopReason = "PENDING_TRANSACTIONS_NOTE";
      break;
    }

    if (isSummaryHeaderLine(line)) {
      removedLines += 1;
      continue;
    }

    filteredLines.push(line);
  }

  return {
    sectionText: filteredLines.join("\n").trim(),
    debug: {
      startLine: headerIndex >= 0 ? headerIndex + 1 : undefined,
      endLine,
      removedLines,
      headerFound: headerIndex >= 0,
      stopReason,
    },
  };
}

function isStatementHeaderLine(line: string) {
  const compact = compactAlphaNum(line);
  return compact.includes(STATEMENT_HEADER_ANCHOR);
}

function isStatementDateOnlyHeader(line: string) {
  return line.trim().toLowerCase() === "date";
}

function isStatementPageNoise(line: string) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^statement\s+\d+/i.test(trimmed)) return true;
  if (/^account number/i.test(trimmed)) return true;
  // Account number line variants such as "06 3408 11101463"
  if (/^\d{2}(?:\s+\d{2,6}){1,}$/i.test(trimmed)) return true;
  return false;
}

function segmentStatementTemplate(lines: string[]): SegmentResult {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isStatementHeaderLine(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const filteredLines: string[] = [];
  let endLine: number | undefined;
  let removedLines = 0;
  let stopReason: string | undefined;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const compact = compactAlphaNum(line);

    if (compact.includes(STATEMENT_STOP_CLOSING_BALANCE)) {
      endLine = i + 1;
      stopReason = "CLOSING_BALANCE";
      break;
    }
    if (compact.includes(STATEMENT_STOP_SUMMARY)) {
      endLine = i + 1;
      stopReason = "TRANSACTION_SUMMARY_DURING";
      break;
    }

    if (isStatementHeaderLine(line) || isStatementDateOnlyHeader(line)) {
      removedLines += 1;
      continue;
    }
    if (isStatementPageNoise(line)) {
      removedLines += 1;
      continue;
    }

    filteredLines.push(line);
  }

  return {
    sectionText: filteredLines.join("\n").trim(),
    debug: {
      startLine: headerIndex >= 0 ? headerIndex + 1 : undefined,
      endLine,
      removedLines,
      headerFound: headerIndex >= 0,
      stopReason,
    },
  };
}

export function segmentTransactionSection(
  text: string,
  templateType: CommBankTemplateType = "commbank_transaction_summary"
): SegmentResult {
  const normalizedText = (text || "").replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");

  if (templateType === "commbank_statement_debit_credit") {
    return segmentStatementTemplate(lines);
  }
  return segmentSummaryTemplate(lines);
}
