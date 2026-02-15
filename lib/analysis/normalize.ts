import { createHash } from "crypto";
import { normalizeMerchantFromRaw } from "@/lib/analysis/merchant";
import { ParsedTransaction, ParseWarning } from "@/lib/parseTransactionsV1";
import { NormalizedTransaction } from "@/lib/analysis/types";

type ParsedTransactionWithMeta = ParsedTransaction & {
  bankId?: string;
  accountId?: string;
  templateId?: string;
  source?: {
    fileId?: string;
    fileHash?: string;
    rowIndex?: number;
    lineIndex?: number;
    parserVersion?: string;
  };
};

function stableTxId(params: {
  fileId: string;
  bankId: string;
  accountId: string;
  templateId: string;
  index: number;
  date: string;
  descriptionNorm: string;
  amount: number;
  balance?: number;
}) {
  const payload = [
    params.fileId,
    params.bankId,
    params.accountId,
    params.templateId,
    String(params.index),
    params.date,
    params.descriptionNorm,
    params.amount.toFixed(2),
    typeof params.balance === "number" ? params.balance.toFixed(2) : "",
  ].join("|");

  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
}

function stableDedupeKey(params: {
  bankId: string;
  accountId: string;
  templateId: string;
  date: string;
  merchantNorm: string;
  amount: number;
  descriptionNorm: string;
}) {
  const payload = [
    params.bankId,
    params.accountId,
    params.templateId,
    params.date.slice(0, 10),
    params.merchantNorm,
    params.amount.toFixed(2),
    params.descriptionNorm,
  ].join("|");
  return createHash("sha1").update(payload).digest("hex").slice(0, 20);
}

function warningReasonsForTx(tx: ParsedTransaction, warnings: ParseWarning[]) {
  const lineHead = tx.rawLine.split("\n")[0] || tx.rawLine;
  return warnings
    .filter(
      (warning) =>
        warning.rawLine === tx.rawLine ||
        warning.rawLine.includes(lineHead) ||
        tx.rawLine.includes(warning.rawLine)
    )
    .map((warning) => warning.reason);
}

export function normalizeParsedTransactions(params: {
  fileId: string;
  accountId: string;
  bankId: string;
  templateId: string;
  fileHash?: string;
  transactions: ParsedTransactionWithMeta[];
  warnings: ParseWarning[];
}) {
  const { fileId, accountId, bankId, templateId, fileHash, transactions, warnings } = params;

  const normalized: NormalizedTransaction[] = transactions.map((tx, index) => {
    const { descriptionNorm, merchantNorm } = normalizeMerchantFromRaw(tx.description || "");
    const txBankId = tx.bankId || bankId || "cba";
    const txAccountId = tx.accountId || accountId || "default";
    const txTemplateId = tx.templateId || templateId || "cba_v1";
    const sourceLineIndex =
      tx.source?.lineIndex || tx.source?.rowIndex || index + 1;
    const transferCandidate = /TRANSFER|OSKO|NPP|PAYMENT TO|PAYMENT FROM/i.test(
      tx.description || ""
    );

    const id = stableTxId({
      fileId,
      bankId: txBankId,
      accountId: txAccountId,
      templateId: txTemplateId,
      index,
      date: tx.date,
      descriptionNorm,
      amount: tx.amount,
      balance: tx.balance,
    });

    return {
      id,
      dedupeKey: stableDedupeKey({
        bankId: txBankId,
        accountId: txAccountId,
        templateId: txTemplateId,
        date: tx.date,
        merchantNorm,
        amount: tx.amount,
        descriptionNorm,
      }),
      bankId: txBankId,
      accountId: txAccountId,
      templateId: txTemplateId,
      date: tx.date,
      descriptionRaw: tx.description,
      descriptionNorm,
      merchantNorm,
      amount: tx.amount,
      balance: tx.balance,
      currency: "AUD",
      source: {
        bankId: txBankId,
        accountId: txAccountId,
        templateId: txTemplateId,
        fileId,
        fileHash: tx.source?.fileHash || fileHash,
        lineIndex: sourceLineIndex,
        rowIndex: tx.source?.rowIndex || sourceLineIndex,
        parserVersion: tx.source?.parserVersion,
      },
      quality: {
        warnings: warningReasonsForTx(tx, warnings),
        confidence: tx.confidence,
        rawLine: tx.rawLine,
        rawText: tx.rawLine,
      },
      // Category fields are attached in category assignment step.
      category: "Other",
      categorySource: "default",
      flags: { transferCandidate },
      transfer: null,
    };
  });

  return normalized;
}
