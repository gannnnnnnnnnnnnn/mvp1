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

function hasTermsNearEachOther(
  lines: string[],
  terms: string[],
  windowSize = 6
) {
  const loweredTerms = terms.map((t) => t.toLowerCase());
  for (let i = 0; i < lines.length; i += 1) {
    const windowText = lines
      .slice(i, Math.min(lines.length, i + windowSize))
      .join(" ")
      .toLowerCase();
    const hitAll = loweredTerms.every((term) => windowText.includes(term));
    if (hitAll) return true;
  }
  return false;
}

export function detectCommBankTemplate(text: string): CommBankTemplateType {
  const safeText = text || "";
  const compact = compactAlphaNum(safeText);
  const lines = safeText.replace(/\r\n/g, "\n").split("\n");

  // Auto template: Debit/Credit + Balance around same header area.
  const autoByAnchor = compact.includes("transactiondebitcreditbalance");
  const autoByTerms = hasTermsNearEachOther(lines, [
    "transaction",
    "debit",
    "credit",
    "balance",
  ]);
  if (autoByAnchor || autoByTerms) return "commbank_auto_debit_credit";

  // Manual export template: Transaction details + Amount + Balance.
  const manualByAnchor = compact.includes("transactiondetailsamountbalance");
  const manualByTerms = hasTermsNearEachOther(lines, [
    "transaction details",
    "amount",
    "balance",
  ]);
  if (manualByAnchor || manualByTerms) return "commbank_manual_amount_balance";

  return "unknown";
}
