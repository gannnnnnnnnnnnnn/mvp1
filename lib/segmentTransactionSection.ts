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
   * 1-based line number where we found the header line.
   * Undefined means we failed to detect a header and returned full text.
   */
  startLine?: number;
  /** Number of repeated noisy lines removed from the returned section. */
  removedLines: number;
};

export type SegmentResult = {
  sectionText: string;
  debug: SegmentDebug;
};

const HEADER_HINTS = ["date", "description", "amount", "transaction", "transactions"];

function normalizeLine(line: string) {
  return line.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * We keep this heuristic simple (minimum viable):
 * - if a line contains at least two table keywords, treat it as transaction header.
 */
function looksLikeTransactionHeader(line: string) {
  const normalized = normalizeLine(line);
  if (!normalized) return false;

  let hit = 0;
  for (const hint of HEADER_HINTS) {
    if (normalized.includes(hint)) hit += 1;
  }
  return hit >= 2;
}

/**
 * Repeated short lines are usually page headers/footers in PDF extraction output.
 * We remove those only when frequency is high enough to avoid over-cleaning.
 */
function shouldRemoveByFrequency(normalized: string, count: number) {
  if (!normalized) return false;
  if (count < 3) return false;
  if (normalized.length > 120) return false;
  return true;
}

export function segmentTransactionSection(text: string): SegmentResult {
  const normalizedText = (text || "").replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");

  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (looksLikeTransactionHeader(lines[i])) {
      headerIndex = i;
      break;
    }
  }

  // If header exists, return lines after header; otherwise fallback to full text.
  const candidateLines = headerIndex >= 0 ? lines.slice(headerIndex + 1) : lines.slice();

  const freq = new Map<string, number>();
  for (const line of candidateLines) {
    const key = normalizeLine(line);
    if (!key) continue;
    freq.set(key, (freq.get(key) || 0) + 1);
  }

  let removedLines = 0;
  const filteredLines = candidateLines.filter((line) => {
    const key = normalizeLine(line);
    const count = freq.get(key) || 0;
    const remove = shouldRemoveByFrequency(key, count);
    if (remove) removedLines += 1;
    return !remove;
  });

  return {
    sectionText: filteredLines.join("\n").trim(),
    debug: {
      startLine: headerIndex >= 0 ? headerIndex + 1 : undefined,
      removedLines,
    },
  };
}
