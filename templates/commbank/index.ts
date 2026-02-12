import { commbankStatementDebitCreditTemplate } from "@/templates/commbank/commbank_statement_debit_credit";
import { commbankTransactionSummaryTemplate } from "@/templates/commbank/commbank_transaction_summary";
import { CommBankTemplateConfig, CommBankTemplateId } from "@/templates/commbank/types";

export const COMM_BANK_TEMPLATES: CommBankTemplateConfig[] = [
  commbankStatementDebitCreditTemplate,
  commbankTransactionSummaryTemplate,
];

export const COMM_BANK_TEMPLATE_MAP: Record<
  CommBankTemplateId,
  CommBankTemplateConfig
> = COMM_BANK_TEMPLATES.reduce(
  (acc, template) => {
    acc[template.id] = template;
    return acc;
  },
  {} as Record<CommBankTemplateId, CommBankTemplateConfig>
);

export function getCommBankTemplateById(id: string) {
  return COMM_BANK_TEMPLATES.find((tpl) => tpl.id === id);
}

