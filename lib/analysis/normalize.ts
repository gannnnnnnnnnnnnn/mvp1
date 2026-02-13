import { createHash } from "crypto";
import { normalizeMerchantFromRaw } from "@/lib/analysis/merchant";
import { ParsedTransaction, ParseWarning } from "@/lib/parseTransactionsV1";
import { NormalizedTransaction } from "@/lib/analysis/types";

function stableTxId(params: {
  fileId: string;
  accountId: string;
  index: number;
  date: string;
  descriptionNorm: string;
  amount: number;
  balance?: number;
}) {
  const payload = [
    params.fileId,
    params.accountId,
    String(params.index),
    params.date,
    params.descriptionNorm,
    params.amount.toFixed(2),
    typeof params.balance === "number" ? params.balance.toFixed(2) : "",
  ].join("|");

  return createHash("sha1").update(payload).digest("hex").slice(0, 16);
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
  transactions: ParsedTransaction[];
  warnings: ParseWarning[];
}) {
  const { fileId, accountId, transactions, warnings } = params;

  const normalized: NormalizedTransaction[] = transactions.map((tx, index) => {
    const { descriptionNorm, merchantNorm } = normalizeMerchantFromRaw(tx.description || "");

    const id = stableTxId({
      fileId,
      accountId,
      index,
      date: tx.date,
      descriptionNorm,
      amount: tx.amount,
      balance: tx.balance,
    });

    return {
      id,
      accountId,
      date: tx.date,
      descriptionRaw: tx.description,
      descriptionNorm,
      merchantNorm,
      amount: tx.amount,
      balance: tx.balance,
      currency: "AUD",
      source: {
        accountId,
        fileId,
        lineIndex: index + 1,
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
    };
  });

  return normalized;
}
