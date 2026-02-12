/**
 * CommBank template detection (Phase: multi-template support within same bank).
 *
 * Detection is driven by template configs under templates/commbank.
 */
import { COMM_BANK_TEMPLATES } from "@/templates/commbank";
import { CommBankTemplateId } from "@/templates/commbank/types";

export type CommBankTemplateType = CommBankTemplateId | "unknown";

function compactAlphaNum(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function detectCommBankTemplate(text: string): CommBankTemplateType {
  const raw = text || "";
  const compact = compactAlphaNum(raw);
  const lowered = raw.toLowerCase();
  let bestId: CommBankTemplateId | null = null;
  let bestScore = 0;

  for (const tpl of COMM_BANK_TEMPLATES) {
    let score = 0;
    for (const anchor of tpl.headerAnchors) {
      const a = anchor.toLowerCase();
      const aCompact = compactAlphaNum(anchor);
      if (!aCompact) continue;

      if (compact.includes(aCompact) || lowered.includes(a)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestId = tpl.id;
    }
  }

  if (!bestId || bestScore <= 0) {
    return "unknown";
  }
  return bestId;
}
