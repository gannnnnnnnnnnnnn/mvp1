import { NormalizedTransaction } from "@/lib/analysis/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const HINT_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "TRANSFER", re: /\bTRANSFER\b/i },
  { code: "OSKO", re: /\bOSKO\b/i },
  { code: "NPP", re: /\bNPP\b/i },
  { code: "PAYMENT_TO", re: /\bPAYMENT TO\b/i },
  { code: "PAYMENT_FROM", re: /\bPAYMENT FROM\b/i },
  { code: "INTERNET_BANKING", re: /\bINTERNET BANKING\b/i },
  { code: "BPAY_TRANSFER", re: /\bBPAY TRANSFER\b/i },
];

const DENY_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "MERCHANT_LIKE_PAYROLL", re: /\bPAYROLL\b|\bSALARY\b|\bWAGES\b/i },
  { code: "MERCHANT_LIKE_SUPER", re: /\bSUPER\b/i },
  { code: "MERCHANT_LIKE_DIVIDEND", re: /\bDIVIDEND\b/i },
  { code: "MERCHANT_LIKE_INTEREST", re: /\bINTEREST EARNED\b/i },
  { code: "MERCHANT_LIKE_REFUND", re: /\bREFUND\b|\bCASHBACK\b/i },
  {
    code: "MERCHANT_CARD_PURCHASE",
    re: /\bVISA DEBIT PURCHASE\b|\bEFTPOS PURCHASE\b/i,
  },
];

const MERCHANT_LIKE_RE =
  /\bWATER\b|\bELECTRIC\b|\bGAS\b|\bTELSTRA\b|\bOPTUS\b|\bCOUNCIL\b|\bRATES\b|\bRENT\b|\bINSURANCE\b|\bUBER\b|\bWOOLWORTHS\b|\bCOLES\b/i;
const STRONG_TRANSFER_HINT_RE =
  /\bTRANSFER\b|\bOSKO\b|\bNPP\b|\bINTERNET BANKING\b|\bBPAY TRANSFER\b/i;

type Candidate = {
  tx: NormalizedTransaction;
  amountCents: number;
  dateMs: number;
  hints: string[];
  denies: string[];
};

export type TransferInspectorParams = {
  windowDays: number;
  minMatched: number;
  minUncertain: number;
};

export type TransferState = "matched" | "uncertain";

export type TransferInspectorRow = {
  matchId: string;
  state: TransferState;
  confidence: number;
  amountCents: number;
  dateA: string;
  dateB: string;
  dateDiffDays: number;
  a: {
    transactionId: string;
    bankId: string;
    accountId: string;
    date: string;
    description: string;
    amountSigned: number;
    balance?: number;
    source: { fileId?: string; fileHash?: string; lineIndex: number };
    merchantNorm?: string;
  };
  b: {
    transactionId: string;
    bankId: string;
    accountId: string;
    date: string;
    description: string;
    amountSigned: number;
    balance?: number;
    source: { fileId?: string; fileHash?: string; lineIndex: number };
    merchantNorm?: string;
  };
  explain: {
    amountCents: number;
    dateDiffDays: number;
    sameAccount: boolean;
    descHints: string[];
    penalties: string[];
    score: number;
  };
};

export type CollisionBucket = {
  amountCents: number;
  dates: string[];
  txIds: string[];
  suggested: Array<{
    debitId: string;
    creditId: string;
    bestScore: number;
    secondBestScore: number | null;
  }>;
};

type MatcherStats = {
  txCount: number;
  candidateCount: number;
  matchedPairs: number;
  uncertainPairs: number;
  excludedFromKpiCount: number;
  excludedFromKpiAmountAbs: number;
  topPenalties: Array<{ penalty: string; count: number }>;
  topHints: Array<{ hint: string; count: number }>;
  ambiguousBuckets: number;
};

export type TransferInspectorResult = {
  params: TransferInspectorParams;
  rows: TransferInspectorRow[];
  collisions: CollisionBucket[];
  stats: MatcherStats;
};

function toDayMs(dateIso: string) {
  return new Date(`${dateIso.slice(0, 10)}T00:00:00Z`).getTime();
}

function dayDiffMs(a: number, b: number) {
  return Math.round(Math.abs(a - b) / MS_PER_DAY);
}

function clamp01(value: number) {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function hasTransferHint(text: string) {
  return HINT_PATTERNS.some((pattern) => pattern.re.test(text));
}

function isMerchantLikeWithoutStrongTransferHint(text: string) {
  return MERCHANT_LIKE_RE.test(text) && !STRONG_TRANSFER_HINT_RE.test(text);
}

function detectHints(text: string) {
  return HINT_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.code);
}

function detectDenies(text: string) {
  return DENY_PATTERNS.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.code);
}

function isCandidate(tx: NormalizedTransaction) {
  const text = `${tx.descriptionRaw || ""} ${tx.merchantNorm || ""}`;
  const hasHint = hasTransferHint(text);
  const hasFlag = Boolean(tx.flags?.transferCandidate);
  if (!hasHint && !hasFlag) return false;
  // Allow explicit transfer-hint lines even if deny patterns are also present.
  return true;
}

function sortRows(rows: TransferInspectorRow[]) {
  return [...rows].sort((a, b) => {
    if (a.amountCents !== b.amountCents) return a.amountCents - b.amountCents;
    const dA = a.dateA.localeCompare(b.dateA);
    if (dA !== 0) return dA;
    const dB = a.dateB.localeCompare(b.dateB);
    if (dB !== 0) return dB;
    return a.matchId.localeCompare(b.matchId);
  });
}

export function matchTransfersV2(
  transactions: NormalizedTransaction[],
  params: TransferInspectorParams
): TransferInspectorResult {
  const candidates: Candidate[] = transactions
    .filter((tx) => Number.isFinite(tx.amount) && tx.amount !== 0)
    .filter((tx) => isCandidate(tx))
    .map((tx) => {
      const text = `${tx.descriptionRaw || ""} ${tx.merchantNorm || ""}`.toUpperCase();
      return {
        tx,
        amountCents: Math.round(Math.abs(tx.amount) * 100),
        dateMs: toDayMs(tx.date),
        hints: detectHints(text),
        denies: detectDenies(text),
      };
    });

  const debits = candidates
    .filter((item) => item.tx.amount < 0)
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.id.localeCompare(b.tx.id));
  const creditsByAmount = new Map<number, Candidate[]>();
  for (const credit of candidates) {
    if (credit.tx.amount <= 0) continue;
    const list = creditsByAmount.get(credit.amountCents) || [];
    list.push(credit);
    creditsByAmount.set(credit.amountCents, list);
  }
  for (const [amount, list] of creditsByAmount.entries()) {
    creditsByAmount.set(
      amount,
      [...list].sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.id.localeCompare(b.tx.id))
    );
  }

  const penaltyCounter = new Map<string, number>();
  const hintCounter = new Map<string, number>();
  const usedCredits = new Set<string>();
  const rows: TransferInspectorRow[] = [];
  const bucketCollision = new Map<
    number,
    {
      amountCents: number;
      dates: Set<string>;
      txIds: Set<string>;
      suggested: Array<{
        debitId: string;
        creditId: string;
        bestScore: number;
        secondBestScore: number | null;
      }>;
    }
  >();

  type Scored = {
    credit: Candidate;
    score: number;
    dateDiffDays: number;
    hints: string[];
    penalties: string[];
    sameAccount: boolean;
  };

  const debitCandidates = debits.map((debit) => {
    const pool = creditsByAmount.get(debit.amountCents) || [];
    const scored: Scored[] = [];

    for (const credit of pool) {
      if (credit.tx.id === debit.tx.id) continue;
      const dateDiffDays = dayDiffMs(debit.dateMs, credit.dateMs);
      if (dateDiffDays > params.windowDays) continue;

      const hints = unique([...debit.hints, ...credit.hints]);
      const penalties: string[] = [];
      let score = 0.5;

      const sameAccount = debit.tx.accountId === credit.tx.accountId;
      if (!sameAccount) score += 0.25;
      if (dateDiffDays === 0) score += 0.15;
      else if (dateDiffDays === 1) score += 0.08;

      if (debit.hints.length > 0 && credit.hints.length > 0) {
        score += 0.15;
      }

      const debitText = debit.tx.descriptionRaw.toUpperCase();
      const creditText = credit.tx.descriptionRaw.toUpperCase();
      const hasToFromPair =
        (/\bPAYMENT TO\b/.test(debitText) && /\bPAYMENT FROM\b/.test(creditText)) ||
        (/\bPAYMENT FROM\b/.test(debitText) && /\bPAYMENT TO\b/.test(creditText));
      if (hasToFromPair) score += 0.1;

      if (debit.denies.length > 0 || credit.denies.length > 0) {
        penalties.push("MERCHANT_LIKE_PAYROLL");
        score -= 0.25;
      }
      if (
        isMerchantLikeWithoutStrongTransferHint(debitText) ||
        isMerchantLikeWithoutStrongTransferHint(creditText)
      ) {
        penalties.push("MERCHANT_LIKE");
        score -= 0.45;
      }
      if (sameAccount && hints.length === 0) {
        penalties.push("SAME_ACCOUNT_NO_HINTS");
        score -= 0.15;
      }

      scored.push({
        credit,
        score: clamp01(score),
        dateDiffDays,
        hints,
        penalties,
        sameAccount,
      });
    }

    scored.sort((a, b) => b.score - a.score || a.dateDiffDays - b.dateDiffDays || a.credit.tx.id.localeCompare(b.credit.tx.id));
    if (scored.length > 1) {
      // Ambiguity penalty applies equally to competing candidates.
      for (const s of scored) {
        s.penalties = unique([...s.penalties, "AMBIGUOUS_MULTI_MATCH"]);
        s.score = clamp01(s.score - 0.2);
      }
      scored.sort((a, b) => b.score - a.score || a.dateDiffDays - b.dateDiffDays || a.credit.tx.id.localeCompare(b.credit.tx.id));
      const bucket = bucketCollision.get(debit.amountCents) || {
        amountCents: debit.amountCents,
        dates: new Set<string>(),
        txIds: new Set<string>(),
        suggested: [],
      };
      bucket.dates.add(debit.tx.date.slice(0, 10));
      bucket.txIds.add(debit.tx.id);
      for (const candidate of scored) {
        bucket.dates.add(candidate.credit.tx.date.slice(0, 10));
        bucket.txIds.add(candidate.credit.tx.id);
      }
      bucket.suggested.push({
        debitId: debit.tx.id,
        creditId: scored[0].credit.tx.id,
        bestScore: scored[0].score,
        secondBestScore: scored[1]?.score ?? null,
      });
      bucketCollision.set(debit.amountCents, bucket);
    }

    return { debit, scored };
  });

  debitCandidates.sort((a, b) => {
    const aBest = a.scored[0]?.score ?? -1;
    const bBest = b.scored[0]?.score ?? -1;
    if (aBest !== bBest) return bBest - aBest;
    return a.debit.tx.date.localeCompare(b.debit.tx.date) || a.debit.tx.id.localeCompare(b.debit.tx.id);
  });

  for (const item of debitCandidates) {
    const best = item.scored.find((scored) => !usedCredits.has(scored.credit.tx.id));
    if (!best) continue;

    const state: TransferState | null =
      best.score >= params.minMatched
        ? "matched"
        : best.score >= params.minUncertain
          ? "uncertain"
          : null;
    if (!state) continue;

    usedCredits.add(best.credit.tx.id);
    const matchId = `v2_${item.debit.tx.id.slice(0, 8)}_${best.credit.tx.id.slice(0, 8)}`;
    const descHints = unique(best.hints);
    const penalties = unique(best.penalties);

    for (const h of descHints) {
      hintCounter.set(h, (hintCounter.get(h) || 0) + 1);
    }
    for (const p of penalties) {
      penaltyCounter.set(p, (penaltyCounter.get(p) || 0) + 1);
    }

    rows.push({
      matchId,
      state,
      confidence: best.score,
      amountCents: item.debit.amountCents,
      dateA: item.debit.tx.date.slice(0, 10),
      dateB: best.credit.tx.date.slice(0, 10),
      dateDiffDays: best.dateDiffDays,
      a: {
        transactionId: item.debit.tx.id,
        bankId: item.debit.tx.bankId,
        accountId: item.debit.tx.accountId,
        date: item.debit.tx.date.slice(0, 10),
        description: item.debit.tx.descriptionRaw,
        amountSigned: item.debit.tx.amount,
        balance: item.debit.tx.balance,
        source: {
          fileId: item.debit.tx.source.fileId,
          fileHash: item.debit.tx.source.fileHash,
          lineIndex: item.debit.tx.source.lineIndex,
        },
        merchantNorm: item.debit.tx.merchantNorm,
      },
      b: {
        transactionId: best.credit.tx.id,
        bankId: best.credit.tx.bankId,
        accountId: best.credit.tx.accountId,
        date: best.credit.tx.date.slice(0, 10),
        description: best.credit.tx.descriptionRaw,
        amountSigned: best.credit.tx.amount,
        balance: best.credit.tx.balance,
        source: {
          fileId: best.credit.tx.source.fileId,
          fileHash: best.credit.tx.source.fileHash,
          lineIndex: best.credit.tx.source.lineIndex,
        },
        merchantNorm: best.credit.tx.merchantNorm,
      },
      explain: {
        amountCents: item.debit.amountCents,
        dateDiffDays: best.dateDiffDays,
        sameAccount: best.sameAccount,
        descHints,
        penalties,
        score: best.score,
      },
    });
  }

  const sortedRows = sortRows(rows);
  const matchedRows = sortedRows.filter((row) => row.state === "matched");
  const uncertainRows = sortedRows.filter((row) => row.state === "uncertain");

  const topPenalties = [...penaltyCounter.entries()]
    .map(([penalty, count]) => ({ penalty, count }))
    .sort((a, b) => b.count - a.count || a.penalty.localeCompare(b.penalty))
    .slice(0, 10);

  const topHints = [...hintCounter.entries()]
    .map(([hint, count]) => ({ hint, count }))
    .sort((a, b) => b.count - a.count || a.hint.localeCompare(b.hint))
    .slice(0, 10);

  const collisions: CollisionBucket[] = [...bucketCollision.values()]
    .map((bucket) => ({
      amountCents: bucket.amountCents,
      dates: [...bucket.dates].sort(),
      txIds: [...bucket.txIds].sort(),
      suggested: [...bucket.suggested].sort(
        (a, b) => b.bestScore - a.bestScore || a.debitId.localeCompare(b.debitId)
      ),
    }))
    .sort((a, b) => a.amountCents - b.amountCents);

  const excludedFromKpiCount = matchedRows.length * 2;
  const excludedFromKpiAmountAbs = matchedRows.reduce(
    (sum, row) => sum + Math.abs(row.amountCents / 100) * 2,
    0
  );

  return {
    params,
    rows: sortedRows,
    collisions,
    stats: {
      txCount: transactions.length,
      candidateCount: candidates.length,
      matchedPairs: matchedRows.length,
      uncertainPairs: uncertainRows.length,
      excludedFromKpiCount,
      excludedFromKpiAmountAbs,
      topPenalties,
      topHints,
      ambiguousBuckets: collisions.length,
    },
  };
}
