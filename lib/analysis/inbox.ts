import { createHash } from "crypto";
import { NormalizedTransaction } from "@/lib/analysis/types";
import { ParsedFileAnalysis } from "@/lib/analysis/loadParsed";

export type InboxKind = "UNKNOWN_MERCHANT" | "UNCERTAIN_TRANSFER" | "PARSE_ISSUE";

export type InboxItem = {
  id: string;
  kind: InboxKind;
  bankId?: string;
  accountId?: string;
  fileId?: string;
  transactionId?: string;
  matchId?: string;
  pairKey?: string;
  reason: string;
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  createdAt: string;
  metadata?: Record<string, unknown>;
};

function sha1(input: string) {
  return createHash("sha1").update(input).digest("hex");
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function formatDate(dateIso: string) {
  return String(dateIso || "").slice(0, 10);
}

export function buildUnknownMerchantItems(
  transactions: NormalizedTransaction[]
): InboxItem[] {
  return transactions
    .filter(
      (tx) =>
        (tx.category === "Other" && tx.categorySource === "default") ||
        tx.merchantNorm === "UNKNOWN_MERCHANT"
    )
    .map((tx) => ({
      id: `UNKNOWN_MERCHANT:${tx.id}`,
      kind: "UNKNOWN_MERCHANT",
      bankId: tx.bankId,
      accountId: tx.accountId,
      fileId: tx.source.fileId,
      transactionId: tx.id,
      reason: "UNCLASSIFIED_MERCHANT",
      title: "Unknown merchant/category",
      summary: `${formatDate(tx.date)} · ${tx.merchantNorm} · ${tx.descriptionRaw.slice(0, 120)}`,
      severity: "medium",
      createdAt: formatDate(tx.date),
      metadata: {
        merchantNorm: tx.merchantNorm,
        category: tx.category,
        categorySource: tx.categorySource,
        amount: tx.amount,
      },
    }));
}

export function buildUncertainTransferItems(
  transactions: NormalizedTransaction[]
): InboxItem[] {
  const byId = new Map(transactions.map((tx) => [tx.id, tx]));
  const seen = new Set<string>();
  const items: InboxItem[] = [];

  for (const tx of transactions) {
    const transfer = tx.transfer;
    if (!transfer || transfer.role !== "out") continue;
    const uncertain =
      transfer.state === "uncertain" || transfer.decision === "UNCERTAIN_NO_OFFSET";
    if (!uncertain) continue;

    const otherId = transfer.counterpartyTransactionId || "";
    const pairKey =
      transfer.matchId ||
      unique([tx.id, otherId].filter(Boolean)).sort().join("::") ||
      tx.id;
    const itemId = `UNCERTAIN_TRANSFER:${pairKey}`;
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const other = otherId ? byId.get(otherId) : undefined;
    const penalties = transfer.explain?.penalties || [];
    const reason = penalties[0] || "UNCERTAIN_NO_OFFSET";
    const summaryParts = [
      formatDate(tx.date),
      tx.descriptionRaw.slice(0, 80),
      typeof other?.descriptionRaw === "string"
        ? other.descriptionRaw.slice(0, 80)
        : "counterparty unavailable",
    ];

    items.push({
      id: itemId,
      kind: "UNCERTAIN_TRANSFER",
      bankId: tx.bankId,
      accountId: tx.accountId,
      fileId: tx.source.fileId,
      transactionId: tx.id,
      matchId: transfer.matchId,
      pairKey,
      reason,
      title: "Uncertain transfer match",
      summary: summaryParts.join(" · "),
      severity: "medium",
      createdAt: formatDate(tx.date),
      metadata: {
        confidence: transfer.confidence,
        decision: transfer.decision,
        kpiEffect: transfer.kpiEffect,
        whySentence: transfer.whySentence,
        penalties,
        hints: transfer.explain?.descHints || [],
        counterpartyTransactionId: otherId || undefined,
      },
    });
  }

  return items;
}

function warningSeverity(reason: string) {
  const upper = String(reason || "").toUpperCase();
  if (
    upper.includes("LOW") ||
    upper.includes("MISSING") ||
    upper.includes("FAIL") ||
    upper.includes("NOT_FOUND")
  ) {
    return "high" as const;
  }
  if (upper.includes("UNCERTAIN") || upper.includes("OUTLIER")) {
    return "medium" as const;
  }
  return "low" as const;
}

export function buildParseIssueItems(parsedFiles: ParsedFileAnalysis[]): InboxItem[] {
  const items: InboxItem[] = [];

  for (const parsed of parsedFiles) {
    const reasons = unique(parsed.quality?.needsReviewReasons || []);
    if (reasons.length === 0) continue;

    for (const reason of reasons) {
      const sampleWarning = parsed.warnings.find(
        (warning) =>
          warning.reason === reason || warning.reason.startsWith(reason)
      );
      const rawLine = sampleWarning?.rawLine || "";
      const hash = sha1(`${parsed.fileId}:${reason}:${rawLine}`).slice(0, 10);
      items.push({
        id: `PARSE_ISSUE:${parsed.fileId}:${reason}:${hash}`,
        kind: "PARSE_ISSUE",
        bankId: parsed.bankId,
        accountId: parsed.accountId,
        fileId: parsed.fileId,
        reason,
        title: "Parser quality issue",
        summary: `${parsed.fileId} · ${parsed.templateType} · ${reason}`,
        severity: warningSeverity(reason),
        createdAt: new Date().toISOString().slice(0, 10),
        metadata: {
          templateType: parsed.templateType,
          needsReview: parsed.needsReview,
          warningRawLine: rawLine || undefined,
          warningConfidence: sampleWarning?.confidence,
          warningReason: sampleWarning?.reason,
        },
      });
    }
  }

  return items;
}

export function aggregateInboxItems(params: {
  transactions: NormalizedTransaction[];
  parsedFiles: ParsedFileAnalysis[];
  resolvedIds?: Record<string, { resolvedAt: string; note?: string }>;
}) {
  const unknownMerchantItems = buildUnknownMerchantItems(params.transactions);
  const uncertainTransferItems = buildUncertainTransferItems(params.transactions);
  const parseIssueItems = buildParseIssueItems(params.parsedFiles);

  const all = [
    ...unknownMerchantItems,
    ...uncertainTransferItems,
    ...parseIssueItems,
  ];

  const resolvedIds = params.resolvedIds || {};
  const unresolved = all.filter((item) => !resolvedIds[item.id]);
  const byKind: Record<InboxKind, number> = {
    UNKNOWN_MERCHANT: 0,
    UNCERTAIN_TRANSFER: 0,
    PARSE_ISSUE: 0,
  };
  for (const item of unresolved) {
    byKind[item.kind] += 1;
  }

  return {
    items: unresolved.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    counts: byKind,
    totals: {
      all: all.length,
      unresolved: unresolved.length,
      resolved: all.length - unresolved.length,
    },
  };
}

