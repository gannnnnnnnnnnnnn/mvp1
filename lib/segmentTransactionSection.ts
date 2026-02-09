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
};

export type SegmentResult = {
  sectionText: string;
  debug: SegmentDebug;
};

// CommBank anchor requested in Milestone 2.5.1:
// "Date Transaction details Amount Balance"
// PDF extraction may remove spaces, so we compare with a compacted form.
const COMMBANK_HEADER_ANCHOR = "datetransactiondetailsamountbalance";
const COMMBANK_END_ANCHOR = "anypendingtransactionshaventbeenincluded";

/**
 * Compact to alphanumeric only so we can match regardless of spaces/punctuation,
 * e.g. "DateTransaction detailsAmountBalance" still matches the same anchor.
 */
function compactAlphaNum(line: string) {
  return line.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isCommbankHeaderLine(line: string) {
  return compactAlphaNum(line).includes(COMMBANK_HEADER_ANCHOR);
}

function isCommbankEndingLine(line: string) {
  return compactAlphaNum(line).includes(COMMBANK_END_ANCHOR);
}

export function segmentTransactionSection(text: string): SegmentResult {
  const normalizedText = (text || "").replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");

  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (isCommbankHeaderLine(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  // If header exists, start from the row after it; otherwise fallback to full text.
  const startIndex = headerIndex >= 0 ? headerIndex + 1 : 0;
  const filteredLines: string[] = [];
  let endLine: number | undefined;
  let removedLines = 0;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];

    // Stop at known CommBank ending disclaimer to keep only transaction area.
    if (isCommbankEndingLine(line)) {
      endLine = i + 1;
      break;
    }

    // Remove repeated header rows caused by page breaks.
    if (isCommbankHeaderLine(line)) {
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
    },
  };
}
