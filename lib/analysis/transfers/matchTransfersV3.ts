import { StatementAccountMeta } from "@/lib/parsing/accountMeta";
import { NormalizedTransaction } from "@/lib/analysis/types";
import { extractTransferEvidence, TransferEvidence } from "@/lib/analysis/transfers/extractTransferEvidence";
import { nameMatchStrong } from "@/lib/analysis/transfers/nameFingerprint";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXTERNAL_MERCHANT_RE =
  /\bWATER\b|\bELECTRIC\b|\bGAS\b|\bTELSTRA\b|\bOPTUS\b|\bCOUNCIL\b|\bRATES\b|\bRENT\b|\bINSURANCE\b|\bUBER\b|\bWOOLWORTHS\b|\bCOLES\b/i;

export type TransferV3Params = {
  windowDays: number;
  minMatched: number;
  minUncertain: number;
};

export type TransferV3State = "matched" | "uncertain";

export type TransferV3IgnoredReason =
  | "SAME_ACCOUNT"
  | "SAME_FILE"
  | "DATE_OUT_OF_WINDOW"
  | "REF_ID_MISMATCH"
  | "CREDIT_ALREADY_MATCHED"
  | "LOW_CONFIDENCE"
  | "SELF_TX"
  | "MISSING_SOURCE";

export type TransferV3Row = {
  matchId: string;
  state: TransferV3State;
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
    refId?: string;
    accountKeyMatchAtoB: boolean;
    accountKeyMatchBtoA: boolean;
    nameMatchAtoB: boolean;
    nameMatchBtoA: boolean;
    payIdMatch: boolean;
    evidenceA: TransferEvidence;
    evidenceB: TransferEvidence;
    accountMetaA?: Pick<StatementAccountMeta, "accountName" | "accountKey">;
    accountMetaB?: Pick<StatementAccountMeta, "accountName" | "accountKey">;
  };
};

export type TransferV3IgnoredRow = {
  ignoredId: string;
  transferState: "ignored";
  ignoredReason: TransferV3IgnoredReason;
  confidence: number;
  amountCents: number;
  dateA: string;
  dateB: string;
  dateDiffDays: number;
  a: TransferV3Row["a"];
  b: TransferV3Row["b"];
  explain: TransferV3Row["explain"];
};

export type TransferV3CollisionBucket = {
  amountCents: number;
  dates: string[];
  txIds: string[];
  suggested: Array<{
    debitId: string;
    creditId: string;
    bestScore: number;
    secondBestScore: number | null;
    strongClosureCount: number;
  }>;
};

type TransferV3Stats = {
  txCount: number;
  candidateCount: number;
  matchedPairs: number;
  uncertainPairs: number;
  ignoredPairsCount: number;
  excludedFromKpiCount: number;
  excludedFromKpiAmountAbs: number;
  topPenalties: Array<{ penalty: string; count: number }>;
  topHints: Array<{ hint: string; count: number }>;
  topIgnoredReasons: Array<{ reason: TransferV3IgnoredReason; count: number }>;
  ambiguousBuckets: number;
};

export type TransferV3Result = {
  params: TransferV3Params;
  rows: TransferV3Row[];
  ignoredRows: TransferV3IgnoredRow[];
  collisions: TransferV3CollisionBucket[];
  stats: TransferV3Stats;
};

type Candidate = {
  tx: NormalizedTransaction;
  amountCents: number;
  dateMs: number;
  sourceKey: string;
  evidence: TransferEvidence;
  accountMeta?: StatementAccountMeta;
};

type Scored = {
  credit: Candidate;
  score: number;
  dateDiffDays: number;
  hints: string[];
  penalties: string[];
  sameAccount: boolean;
  strongClosureCount: number;
  accountKeyMatchAtoB: boolean;
  accountKeyMatchBtoA: boolean;
  nameMatchAtoB: boolean;
  nameMatchBtoA: boolean;
  payIdMatch: boolean;
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

function keyForAccountMeta(bankId: string, accountId: string) {
  return `${bankId}::${accountId}`;
}

function hasTransferHints(evidence: TransferEvidence) {
  if (!evidence) return false;
  if (
    evidence.transferType === "TRANSFER_TO" ||
    evidence.transferType === "TRANSFER_FROM" ||
    evidence.transferType === "PAYMENT_TO" ||
    evidence.transferType === "PAYMENT_FROM"
  ) {
    return true;
  }
  return evidence.hints.some((hint) =>
    ["TRANSFER", "OSKO", "NPP", "PAYID"].includes(hint)
  );
}

function resolveSourceKey(source: { fileId?: string; fileHash?: string }) {
  return String(source.fileHash || source.fileId || "").trim();
}

function toComplementaryDirection(type?: string) {
  if (type === "TRANSFER_TO") return "TRANSFER_FROM";
  if (type === "TRANSFER_FROM") return "TRANSFER_TO";
  if (type === "PAYMENT_TO") return "PAYMENT_FROM";
  if (type === "PAYMENT_FROM") return "PAYMENT_TO";
  return "";
}

function sortRows(rows: TransferV3Row[]) {
  return [...rows].sort((a, b) => {
    if (a.amountCents !== b.amountCents) return a.amountCents - b.amountCents;
    const dA = a.dateA.localeCompare(b.dateA);
    if (dA !== 0) return dA;
    const dB = a.dateB.localeCompare(b.dateB);
    if (dB !== 0) return dB;
    return a.matchId.localeCompare(b.matchId);
  });
}

function mapCandidateSide(candidate: Candidate): TransferV3Row["a"] {
  return {
    transactionId: candidate.tx.id,
    bankId: candidate.tx.bankId,
    accountId: candidate.tx.accountId,
    date: candidate.tx.date.slice(0, 10),
    description: candidate.tx.descriptionRaw,
    amountSigned: candidate.tx.amount,
    balance: candidate.tx.balance,
    source: {
      fileId: candidate.tx.source.fileId,
      fileHash: candidate.tx.source.fileHash,
      lineIndex: candidate.tx.source.lineIndex,
    },
    merchantNorm: candidate.tx.merchantNorm,
  };
}

function sortIgnoredRows(rows: TransferV3IgnoredRow[]) {
  return [...rows].sort((a, b) => {
    if (a.amountCents !== b.amountCents) return a.amountCents - b.amountCents;
    const dA = a.dateA.localeCompare(b.dateA);
    if (dA !== 0) return dA;
    const dB = a.dateB.localeCompare(b.dateB);
    if (dB !== 0) return dB;
    return a.ignoredId.localeCompare(b.ignoredId);
  });
}

export function matchTransfersV3(params: {
  transactions: NormalizedTransaction[];
  boundaryAccountIds: string[];
  statementAccountMeta: StatementAccountMeta[];
  accountAliases?: Record<string, string>;
  options?: Partial<TransferV3Params>;
}): TransferV3Result {
  const matcherParams: TransferV3Params = {
    windowDays: params.options?.windowDays ?? 1,
    minMatched: params.options?.minMatched ?? 0.9,
    minUncertain: params.options?.minUncertain ?? 0.65,
  };

  const boundarySet = new Set(
    params.boundaryAccountIds.map((id) => String(id || "").trim()).filter(Boolean)
  );
  const metaMap = new Map<string, StatementAccountMeta>();
  for (const item of params.statementAccountMeta || []) {
    if (!item?.bankId || !item?.accountId) continue;
    metaMap.set(keyForAccountMeta(item.bankId, item.accountId), item);
  }

  const baseCandidates: Candidate[] = params.transactions
    .filter((tx) => Number.isFinite(tx.amount) && tx.amount !== 0)
    .map((tx) => ({
      tx,
      amountCents: Math.round(Math.abs(tx.amount) * 100),
      dateMs: toDayMs(tx.date),
      sourceKey: resolveSourceKey(tx.source),
      evidence: extractTransferEvidence(tx.descriptionRaw, tx.merchantNorm),
      accountMeta: metaMap.get(keyForAccountMeta(tx.bankId, tx.accountId)),
    }))
    .filter((candidate) => boundarySet.size === 0 || boundarySet.has(candidate.tx.accountId))
    .filter((candidate) => hasTransferHints(candidate.evidence));

  const debits = baseCandidates
    .filter((item) => item.tx.amount < 0)
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.tx.id.localeCompare(b.tx.id));

  const creditsByAmount = new Map<number, Candidate[]>();
  for (const credit of baseCandidates) {
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
  const ignoredReasonCounter = new Map<TransferV3IgnoredReason, number>();
  const usedCredits = new Set<string>();
  const rows: TransferV3Row[] = [];
  const ignoredRows: TransferV3IgnoredRow[] = [];
  const maxIgnoredRows = 200;
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
        strongClosureCount: number;
      }>;
    }
  >();

  function addIgnoredRow(input: {
    debit: Candidate;
    credit: Candidate;
    reason: TransferV3IgnoredReason;
    confidence?: number;
    score?: number;
    hints?: string[];
    penalties?: string[];
    dateDiffDays?: number;
    refId?: string;
    accountKeyMatchAtoB?: boolean;
    accountKeyMatchBtoA?: boolean;
    nameMatchAtoB?: boolean;
    nameMatchBtoA?: boolean;
    payIdMatch?: boolean;
  }) {
    ignoredReasonCounter.set(input.reason, (ignoredReasonCounter.get(input.reason) || 0) + 1);
    if (ignoredRows.length >= maxIgnoredRows) return;
    const dateDiffDays =
      typeof input.dateDiffDays === "number"
        ? input.dateDiffDays
        : dayDiffMs(input.debit.dateMs, input.credit.dateMs);
    const hints = unique(input.hints || []);
    const penalties = unique(input.penalties || []);
    ignoredRows.push({
      ignoredId: `ignored_${input.debit.tx.id.slice(0, 8)}_${input.credit.tx.id.slice(0, 8)}_${input.reason}`,
      transferState: "ignored",
      ignoredReason: input.reason,
      confidence:
        typeof input.confidence === "number"
          ? input.confidence
          : clamp01(typeof input.score === "number" ? input.score : 0),
      amountCents: input.debit.amountCents,
      dateA: input.debit.tx.date.slice(0, 10),
      dateB: input.credit.tx.date.slice(0, 10),
      dateDiffDays,
      a: mapCandidateSide(input.debit),
      b: mapCandidateSide(input.credit),
      explain: {
        amountCents: input.debit.amountCents,
        dateDiffDays,
        sameAccount: input.debit.tx.accountId === input.credit.tx.accountId,
        descHints: hints,
        penalties,
        score: typeof input.score === "number" ? clamp01(input.score) : 0,
        refId: input.refId || input.debit.evidence.refId || input.credit.evidence.refId,
        accountKeyMatchAtoB: Boolean(input.accountKeyMatchAtoB),
        accountKeyMatchBtoA: Boolean(input.accountKeyMatchBtoA),
        nameMatchAtoB: Boolean(input.nameMatchAtoB),
        nameMatchBtoA: Boolean(input.nameMatchBtoA),
        payIdMatch: Boolean(input.payIdMatch),
        evidenceA: input.debit.evidence,
        evidenceB: input.credit.evidence,
        accountMetaA: input.debit.accountMeta
          ? {
              accountName: input.debit.accountMeta.accountName,
              accountKey: input.debit.accountMeta.accountKey,
            }
          : undefined,
        accountMetaB: input.credit.accountMeta
          ? {
              accountName: input.credit.accountMeta.accountName,
              accountKey: input.credit.accountMeta.accountKey,
            }
          : undefined,
      },
    });
  }

  const debitCandidates = debits.map((debit) => {
    const amountBucket = creditsByAmount.get(debit.amountCents) || [];
    const rawPool: Candidate[] = [];
    for (const credit of amountBucket) {
      if (credit.tx.id === debit.tx.id) {
        addIgnoredRow({ debit, credit, reason: "SELF_TX" });
        continue;
      }
      if (debit.tx.accountId === credit.tx.accountId) {
        addIgnoredRow({ debit, credit, reason: "SAME_ACCOUNT" });
        continue;
      }
      if (!debit.sourceKey || !credit.sourceKey) {
        addIgnoredRow({ debit, credit, reason: "MISSING_SOURCE" });
        continue;
      }
      if (debit.sourceKey === credit.sourceKey) {
        addIgnoredRow({ debit, credit, reason: "SAME_FILE" });
        continue;
      }
      const dateDiffDays = dayDiffMs(debit.dateMs, credit.dateMs);
      if (dateDiffDays > matcherParams.windowDays) {
        addIgnoredRow({ debit, credit, reason: "DATE_OUT_OF_WINDOW", dateDiffDays });
        continue;
      }
      rawPool.push(credit);
    }
    // REF_ID is a strong join key only when both sides expose a ref id.
    // Missing counterpart ref id must not hard-reject cross-bank candidates.
    const pool = rawPool;
    const scored: Scored[] = [];

    for (const credit of pool) {
      const dateDiffDays = dayDiffMs(debit.dateMs, credit.dateMs);
      const hints = unique([...debit.evidence.hints, ...credit.evidence.hints]);
      const penalties: string[] = [];
      let score = 0.5;

      const sameAccount = debit.tx.accountId === credit.tx.accountId;
      const accountKeyMatchAtoB =
        Boolean(debit.evidence.counterpartyAccountKey) &&
        Boolean(credit.accountMeta?.accountKey) &&
        debit.evidence.counterpartyAccountKey === credit.accountMeta?.accountKey;
      const accountKeyMatchBtoA =
        Boolean(credit.evidence.counterpartyAccountKey) &&
        Boolean(debit.accountMeta?.accountKey) &&
        credit.evidence.counterpartyAccountKey === debit.accountMeta?.accountKey;
      const payIdMatch =
        Boolean(debit.evidence.payId) &&
        Boolean(credit.evidence.payId) &&
        debit.evidence.payId === credit.evidence.payId;
      const nameMatchAtoB = nameMatchStrong(
        debit.evidence.counterpartyName,
        credit.accountMeta?.accountName
      ) ||
        nameMatchStrong(
          debit.evidence.counterpartyName,
          params.accountAliases?.[credit.tx.accountId]
        );
      const nameMatchBtoA = nameMatchStrong(
        credit.evidence.counterpartyName,
        debit.accountMeta?.accountName
      ) ||
        nameMatchStrong(
          credit.evidence.counterpartyName,
          params.accountAliases?.[debit.tx.accountId]
        );
      const bidirectionalNameClosure = nameMatchAtoB && nameMatchBtoA;
      const debitRefId = debit.evidence.refId;
      const creditRefId = credit.evidence.refId;
      const bothHaveRefId = Boolean(debitRefId && creditRefId);
      const sameBankTemplate =
        debit.tx.bankId === credit.tx.bankId &&
        String(debit.tx.templateId || "") === String(credit.tx.templateId || "");

      let strongClosureCount = 0;
      if (accountKeyMatchAtoB) {
        score += 0.55;
        strongClosureCount += 1;
      }
      if (accountKeyMatchBtoA) {
        score += 0.55;
        strongClosureCount += 1;
      }
      if (payIdMatch) {
        score += 0.4;
        strongClosureCount += 1;
      }
      if (bothHaveRefId && debitRefId === creditRefId) {
        hints.push("REF_ID_MATCH");
        score += 0.25;
        strongClosureCount += 1;
      } else if (bothHaveRefId && debitRefId !== creditRefId) {
        penalties.push("REF_ID_MISMATCH");
        score -= sameBankTemplate ? 0.4 : 0.1;
      } else if (debitRefId && !creditRefId) {
        penalties.push("REF_ID_COUNTERPARTY_MISSING");
        // Keep this as a debug note; never a hard reject.
        if (sameBankTemplate) {
          score -= 0.04;
        }
      }

      if (nameMatchAtoB) score += 0.3;
      if (nameMatchBtoA) score += 0.3;
      if (bidirectionalNameClosure) {
        strongClosureCount += 1;
      }

      const complement = toComplementaryDirection(debit.evidence.transferType);
      if (complement && credit.evidence.transferType === complement) {
        score += 0.12;
      }

      if (hasTransferHints(debit.evidence) && hasTransferHints(credit.evidence)) {
        score += 0.1;
      }

      if (dateDiffDays === 0) score += 0.1;
      else if (dateDiffDays === 1) score += 0.05;

      const debitText = debit.tx.descriptionRaw.toUpperCase();
      const creditText = credit.tx.descriptionRaw.toUpperCase();
      const debitHasHint = hasTransferHints(debit.evidence);
      const creditHasHint = hasTransferHints(credit.evidence);

      if (
        (EXTERNAL_MERCHANT_RE.test(debitText) || EXTERNAL_MERCHANT_RE.test(creditText)) &&
        !debitHasHint &&
        !creditHasHint
      ) {
        penalties.push("MERCHANT_LIKE");
        score -= 0.3;
      }

      if (!debitHasHint && !creditHasHint) {
        penalties.push("NO_TRANSFER_HINTS");
        score -= 0.2;
      }

      scored.push({
        credit,
        score: clamp01(score),
        dateDiffDays,
        hints,
        penalties,
        sameAccount,
        strongClosureCount,
        accountKeyMatchAtoB,
        accountKeyMatchBtoA,
        nameMatchAtoB,
        nameMatchBtoA,
        payIdMatch,
      });
    }

    scored.sort(
      (a, b) =>
        b.strongClosureCount - a.strongClosureCount ||
        b.score - a.score ||
        a.dateDiffDays - b.dateDiffDays ||
        a.credit.tx.id.localeCompare(b.credit.tx.id)
    );

    if (scored.length > 1) {
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
        strongClosureCount: scored[0].strongClosureCount,
      });
      bucketCollision.set(debit.amountCents, bucket);
    }

    return { debit, scored };
  });

  debitCandidates.sort((a, b) => {
    const aBest = a.scored[0];
    const bBest = b.scored[0];
    const aStrong = aBest?.strongClosureCount ?? -1;
    const bStrong = bBest?.strongClosureCount ?? -1;
    if (aStrong !== bStrong) return bStrong - aStrong;
    const aScore = aBest?.score ?? -1;
    const bScore = bBest?.score ?? -1;
    if (aScore !== bScore) return bScore - aScore;
    return a.debit.tx.date.localeCompare(b.debit.tx.date) || a.debit.tx.id.localeCompare(b.debit.tx.id);
  });

  for (const item of debitCandidates) {
    const available = item.scored.filter((candidate) => !usedCredits.has(candidate.credit.tx.id));
    if (available.length === 0) {
      if (item.scored.length > 0) {
        addIgnoredRow({
          debit: item.debit,
          credit: item.scored[0].credit,
          reason: "CREDIT_ALREADY_MATCHED",
          score: item.scored[0].score,
          hints: item.scored[0].hints,
          penalties: item.scored[0].penalties,
          dateDiffDays: item.scored[0].dateDiffDays,
          accountKeyMatchAtoB: item.scored[0].accountKeyMatchAtoB,
          accountKeyMatchBtoA: item.scored[0].accountKeyMatchBtoA,
          nameMatchAtoB: item.scored[0].nameMatchAtoB,
          nameMatchBtoA: item.scored[0].nameMatchBtoA,
          payIdMatch: item.scored[0].payIdMatch,
        });
      }
      continue;
    }

    const strong = available.filter((candidate) => candidate.strongClosureCount > 0);
    let best: Scored | undefined;
    let forceUncertain = false;

    if (strong.length === 1) {
      best = strong[0];
    } else if (strong.length > 1) {
      best = strong[0];
      const bestBidirectionalName = best.nameMatchAtoB && best.nameMatchBtoA;
      const competingBidirectional = strong
        .slice(1)
        .some((candidate) => candidate.nameMatchAtoB && candidate.nameMatchBtoA);
      if (!(bestBidirectionalName && !competingBidirectional)) {
        forceUncertain = true;
        best.penalties = unique([...best.penalties, "AMBIGUOUS_MULTI_MATCH"]);
        best.score = clamp01(best.score - 0.25);
      }
    } else {
      best = available[0];
      const second = available[1];
      if (second && Math.abs(best.score - second.score) <= 0.05) {
        best.penalties = unique([...best.penalties, "AMBIGUOUS_MULTI_MATCH"]);
        best.score = clamp01(best.score - 0.25);
      }
    }

    if (!best) continue;

    const hasStrongClosure = best.strongClosureCount > 0;
    const hasBidirectionalNameClosure = best.nameMatchAtoB && best.nameMatchBtoA;
    const hasOneDirectionNameClosure =
      (best.nameMatchAtoB || best.nameMatchBtoA) && !hasBidirectionalNameClosure;
    const hasStrongHints =
      hasTransferHints(item.debit.evidence) && hasTransferHints(best.credit.evidence);
    const hasMerchantLikePenalty = best.penalties.includes("MERCHANT_LIKE");
    const second = available[1];
    const uniqueEnough = !second || Math.abs(best.score - second.score) > 0.05;
    const state: TransferV3State | null = forceUncertain
      ? best.score >= matcherParams.minUncertain
        ? "uncertain"
        : null
      : hasStrongClosure
        ? "matched"
        : hasBidirectionalNameClosure
          ? best.score >= matcherParams.minMatched && uniqueEnough && hasStrongHints && !hasMerchantLikePenalty
            ? "matched"
            : best.score >= matcherParams.minUncertain
              ? "uncertain"
              : null
        : hasOneDirectionNameClosure
          ? best.score >= matcherParams.minMatched && uniqueEnough && hasStrongHints && !hasMerchantLikePenalty
            ? "matched"
            : best.score >= matcherParams.minUncertain
              ? "uncertain"
              : null
        : best.score >= matcherParams.minMatched
          ? "matched"
          : best.score >= matcherParams.minUncertain
            ? "uncertain"
            : null;
    if (!state) {
      addIgnoredRow({
        debit: item.debit,
        credit: best.credit,
        reason: "LOW_CONFIDENCE",
        score: best.score,
        hints: best.hints,
        penalties: best.penalties,
        dateDiffDays: best.dateDiffDays,
        accountKeyMatchAtoB: best.accountKeyMatchAtoB,
        accountKeyMatchBtoA: best.accountKeyMatchBtoA,
        nameMatchAtoB: best.nameMatchAtoB,
        nameMatchBtoA: best.nameMatchBtoA,
        payIdMatch: best.payIdMatch,
      });
      continue;
    }

    usedCredits.add(best.credit.tx.id);

    const matchId = `v3_${item.debit.tx.id.slice(0, 8)}_${best.credit.tx.id.slice(0, 8)}`;
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
        refId: item.debit.evidence.refId || best.credit.evidence.refId,
        accountKeyMatchAtoB: best.accountKeyMatchAtoB,
        accountKeyMatchBtoA: best.accountKeyMatchBtoA,
        nameMatchAtoB: best.nameMatchAtoB,
        nameMatchBtoA: best.nameMatchBtoA,
        payIdMatch: best.payIdMatch,
        evidenceA: item.debit.evidence,
        evidenceB: best.credit.evidence,
        accountMetaA: item.debit.accountMeta
          ? {
              accountName: item.debit.accountMeta.accountName,
              accountKey: item.debit.accountMeta.accountKey,
            }
          : undefined,
        accountMetaB: best.credit.accountMeta
          ? {
              accountName: best.credit.accountMeta.accountName,
              accountKey: best.credit.accountMeta.accountKey,
            }
          : undefined,
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

  const topIgnoredReasons = [...ignoredReasonCounter.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);

  const collisions: TransferV3CollisionBucket[] = [...bucketCollision.values()]
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
    params: matcherParams,
    rows: sortedRows,
    ignoredRows: sortIgnoredRows(ignoredRows),
    collisions,
    stats: {
      txCount: params.transactions.length,
      candidateCount: baseCandidates.length,
      matchedPairs: matchedRows.length,
      uncertainPairs: uncertainRows.length,
      ignoredPairsCount: ignoredRows.length,
      excludedFromKpiCount,
      excludedFromKpiAmountAbs,
      topPenalties,
      topHints,
      topIgnoredReasons,
      ambiguousBuckets: collisions.length,
    },
  };
}
