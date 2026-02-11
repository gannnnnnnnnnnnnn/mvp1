/**
 * CommBank template detection (Phase: multi-template support within same bank).
 *
 * Keep detection intentionally small and deterministic:
 * - transaction summary template: Date Transaction details Amount Balance
 * - debit/credit statement template: Date Transaction Debit Credit Balance
 */

export type CommBankTemplateType =
  | "commbank_transaction_summary"
  | "commbank_statement_debit_credit"
  | "unknown";

function compactAlphaNum(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function detectCommBankTemplate(text: string): CommBankTemplateType {
  const compact = compactAlphaNum(text || "");

  if (compact.includes("datetransactiondebitcreditbalance")) {
    return "commbank_statement_debit_credit";
  }
  if (compact.includes("datetransactiondetailsamountbalance")) {
    return "commbank_transaction_summary";
  }

  return "unknown";
}

