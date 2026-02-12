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
import { COMM_BANK_TEMPLATE_MAP } from "@/templates/commbank";
import { CommBankTemplateConfig } from "@/templates/commbank/types";

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
  /** Template id used for this segmentation run. */
  templateType?: CommBankTemplateType;
};

export type SegmentResult = {
  sectionText: string;
  debug: SegmentDebug;
};

/**
 * Compact to alphanumeric only so we can match regardless of spaces/punctuation,
 * e.g. "DateTransaction detailsAmountBalance" still matches the same anchor.
 */
function compactAlphaNum(line: string) {
  return line.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchesAnchor(line: string, anchor: string) {
  const lineLower = line.toLowerCase();
  const anchorLower = anchor.toLowerCase();
  if (lineLower.includes(anchorLower)) return true;
  return compactAlphaNum(line).includes(compactAlphaNum(anchor));
}

function findHeaderIndex(lines: string[], template: CommBankTemplateConfig) {
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const hit = template.headerAnchors.some((anchor) => matchesAnchor(line, anchor));
    if (hit) {
      headerIndex = i;
      break;
    }
  }
  return headerIndex;
}

function buildRemoveRegexList(patterns: string[]) {
  const list: RegExp[] = [];
  for (const pattern of patterns) {
    try {
      list.push(new RegExp(pattern, "i"));
    } catch {
      // Ignore malformed patterns so one bad rule does not break the endpoint.
    }
  }
  return list;
}

function segmentByTemplate(
  lines: string[],
  template: CommBankTemplateConfig,
  templateType: CommBankTemplateType
): SegmentResult {
  const headerIndex = findHeaderIndex(lines, template);
  const startIndex =
    headerIndex >= 0
      ? template.segment.startAfterHeader
        ? headerIndex + 1
        : headerIndex
      : 0;

  const removeRegexes = buildRemoveRegexList(template.segment.removeLinePatterns || []);
  const filteredLines: string[] = [];
  let endLine: number | undefined;
  let removedLines = 0;
  let stopReason: string | undefined;

  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const stopAnchor = template.segment.stopAnchors.find((anchor) =>
      matchesAnchor(line, anchor)
    );
    if (stopAnchor) {
      endLine = i + 1;
      stopReason = stopAnchor;
      break;
    }

    const shouldRemove = removeRegexes.some((re) => re.test(line));
    if (shouldRemove) {
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
      templateType,
    },
  };
}

export function segmentTransactionSection(
  text: string,
  templateType: CommBankTemplateType = "commbank_manual_amount_balance"
): SegmentResult {
  const normalizedText = (text || "").replace(/\r\n/g, "\n");
  const lines = normalizedText.split("\n");
  const template = COMM_BANK_TEMPLATE_MAP[templateType as keyof typeof COMM_BANK_TEMPLATE_MAP];
  if (!template) {
    return {
      sectionText: normalizedText.trim(),
      debug: {
        startLine: undefined,
        endLine: undefined,
        removedLines: 0,
        headerFound: false,
        stopReason: "TEMPLATE_NOT_FOUND",
        templateType,
      },
    };
  }
  return segmentByTemplate(lines, template, templateType);
}
