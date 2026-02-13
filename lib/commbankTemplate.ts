/**
 * CommBank template detection (Phase: multi-template support within same bank).
 *
 * Detection is driven by template configs under templates/commbank.
 */
import { CommBankTemplateId } from "@/templates/commbank/types";

export type CommBankTemplateType = CommBankTemplateId | "unknown";

function compactAlphaNum(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function buildHeaderWindows(lines: string[]) {
  const windows: string[] = [];
  const candidateIndexes: number[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const lower = (lines[i] || "").toLowerCase();
    if (lower.includes("date")) {
      candidateIndexes.push(i);
    }
  }

  // Fallback: if no explicit Date row, inspect early document area only.
  if (candidateIndexes.length === 0) {
    candidateIndexes.push(0);
  }

  for (const index of candidateIndexes) {
    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length, index + 6);
    const text = lines.slice(start, end).join(" ");
    windows.push(compactAlphaNum(text));
  }

  return windows;
}

function windowHasTerms(compactedWindow: string, terms: string[]) {
  return terms.every((term) => compactedWindow.includes(compactAlphaNum(term)));
}

export function detectCommBankTemplate(text: string): CommBankTemplateType {
  const safeText = text || "";
  const lines = safeText.replace(/\r\n/g, "\n").split("\n");
  const windows = buildHeaderWindows(lines);

  // Priority 1: manual header evidence.
  const manualHit = windows.some((window) =>
    windowHasTerms(window, ["Transaction details", "Amount", "Balance"])
  );
  if (manualHit) return "commbank_manual_amount_balance";

  // Priority 2: auto header evidence.
  const autoHit = windows.some((window) =>
    windowHasTerms(window, ["Transaction", "Debit", "Credit", "Balance"])
  );
  if (autoHit) return "commbank_auto_debit_credit";

  return "unknown";
}
