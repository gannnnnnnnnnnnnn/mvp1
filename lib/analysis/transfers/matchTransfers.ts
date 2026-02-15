import { NormalizedTransaction } from "@/lib/analysis/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRANSFER_HINT_RE = /TRANSFER|OSKO|NPP|PAYMENT TO|PAYMENT FROM|NETBANK TRANSFER/i;

function toDateOnly(dateIso: string) {
  return new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
}

function dayDiff(a: string, b: string) {
  return Math.round(
    Math.abs(toDateOnly(a).getTime() - toDateOnly(b).getTime()) / MS_PER_DAY
  );
}

function moneyKey(amount: number) {
  return Math.round(Math.abs(amount) * 100);
}

function looksTransferCandidate(tx: NormalizedTransaction) {
  if (tx.flags?.transferCandidate) return true;
  return TRANSFER_HINT_RE.test(tx.descriptionRaw || "");
}

export type TransferMatch = {
  matchId: string;
  aId: string;
  bId: string;
  amount: number;
  dateA: string;
  dateB: string;
  confidence: number;
};

export function matchTransfers(
  transactions: NormalizedTransaction[]
): {
  annotatedTransactions: NormalizedTransaction[];
  matches: TransferMatch[];
} {
  if (transactions.length === 0) {
    return { annotatedTransactions: transactions, matches: [] };
  }

  const annotated = transactions.map((tx) => ({ ...tx, transfer: tx.transfer || null }));
  const byId = new Map(annotated.map((tx) => [tx.id, tx]));
  const used = new Set<string>();
  const creditBuckets = new Map<number, NormalizedTransaction[]>();
  const matches: TransferMatch[] = [];

  for (const tx of annotated) {
    if (!looksTransferCandidate(tx)) continue;
    if (tx.amount <= 0) continue;
    const key = moneyKey(tx.amount);
    const bucket = creditBuckets.get(key) || [];
    bucket.push(tx);
    creditBuckets.set(key, bucket);
  }

  for (const debit of annotated) {
    if (!looksTransferCandidate(debit)) continue;
    if (debit.amount >= 0) continue;
    if (used.has(debit.id)) continue;

    const key = moneyKey(debit.amount);
    const credits = creditBuckets.get(key) || [];
    if (credits.length === 0) continue;

    let best: NormalizedTransaction | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const credit of credits) {
      if (used.has(credit.id)) continue;
      const distance = dayDiff(debit.date, credit.date);
      if (distance > 1) continue;

      const sameAccountPenalty = debit.accountId === credit.accountId ? 1 : 0;
      const sameBankPenalty = debit.bankId === credit.bankId ? 0 : -0.25;
      const score = distance + sameAccountPenalty + sameBankPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = credit;
      }
    }

    if (!best) continue;

    used.add(debit.id);
    used.add(best.id);
    const matchId = `tr_${debit.id.slice(0, 8)}_${best.id.slice(0, 8)}`;
    const confidence = bestScore <= 0.25 ? 0.95 : bestScore <= 1 ? 0.88 : 0.8;

    const debitTx = byId.get(debit.id);
    const creditTx = byId.get(best.id);
    if (debitTx) {
      debitTx.transfer = {
        matchId,
        role: "out",
        counterpartyTransactionId: best.id,
        method: "amount_time_window_v1",
        confidence,
      };
    }
    if (creditTx) {
      creditTx.transfer = {
        matchId,
        role: "in",
        counterpartyTransactionId: debit.id,
        method: "amount_time_window_v1",
        confidence,
      };
    }

    matches.push({
      matchId,
      aId: debit.id,
      bId: best.id,
      amount: Math.abs(debit.amount),
      dateA: debit.date,
      dateB: best.date,
      confidence,
    });
  }

  return {
    annotatedTransactions: annotated,
    matches,
  };
}
