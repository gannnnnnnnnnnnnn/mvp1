import test from "node:test";
import assert from "node:assert/strict";
import { aggregateInboxItems } from "./inbox";
import type { NormalizedTransaction } from "./types";
import type { ParsedFileAnalysis } from "./loadParsed";

function makeTx(partial: Partial<NormalizedTransaction>): NormalizedTransaction {
  const id = partial.id || "tx-default";
  return {
    id,
    dedupeKey: partial.dedupeKey || id,
    bankId: partial.bankId || "cba",
    accountId: partial.accountId || "default",
    templateId: partial.templateId || "cba_v1",
    date: partial.date || "2026-02-01",
    descriptionRaw: partial.descriptionRaw || "DESC",
    descriptionNorm: partial.descriptionNorm || "DESC",
    merchantNorm: partial.merchantNorm || "UNKNOWN_MERCHANT",
    amount: partial.amount ?? -10,
    balance: partial.balance,
    currency: "AUD",
    source: {
      bankId: partial.source?.bankId || "cba",
      accountId: partial.source?.accountId || "default",
      templateId: partial.source?.templateId || "cba_v1",
      fileId: partial.source?.fileId || "file-1",
      fileHash: partial.source?.fileHash,
      lineIndex: partial.source?.lineIndex || 1,
      rowIndex: partial.source?.rowIndex,
      page: partial.source?.page,
      parserVersion: partial.source?.parserVersion,
    },
    quality: {
      warnings: partial.quality?.warnings || [],
      confidence: partial.quality?.confidence ?? 0.9,
      rawLine: partial.quality?.rawLine || "RAW",
      rawText: partial.quality?.rawText || "RAW",
    },
    category: partial.category || "Other",
    categorySource: partial.categorySource || "default",
    categoryRuleId: partial.categoryRuleId,
    flags: partial.flags,
    transfer: partial.transfer ?? null,
  };
}

function makeParsedFile(
  partial: Partial<ParsedFileAnalysis> & Pick<ParsedFileAnalysis, "fileId">
): ParsedFileAnalysis {
  return {
    fileId: partial.fileId,
    templateType: partial.templateType || "commbank_manual_amount_balance",
    bankId: partial.bankId || "cba",
    accountId: partial.accountId || "default",
    templateId: partial.templateId || "cba_v1",
    accountMeta: partial.accountMeta,
    transactions: partial.transactions || [],
    warnings: partial.warnings || [],
    needsReview: partial.needsReview ?? true,
    quality: partial.quality || {
      headerFound: true,
      balanceContinuityPassRate: 1,
      balanceContinuityChecked: 1,
      balanceContinuityTotalRows: 1,
      balanceContinuitySkipped: 0,
      balanceContinuitySkippedReasons: {},
      needsReviewReasons: ["AUTO_PARSE_LOW_COVERAGE"],
      nonBlockingWarnings: [],
    },
    debug: partial.debug || {},
    sectionTextPreview: partial.sectionTextPreview || "",
  };
}

test("aggregateInboxItems builds all three item kinds", () => {
  const tx1 = makeTx({
    id: "tx-1",
    merchantNorm: "UNKNOWN_MERCHANT",
    category: "Other",
    categorySource: "default",
  });
  const tx2 = makeTx({
    id: "tx-2",
    amount: -281,
    transfer: {
      matchId: "m-1",
      state: "uncertain",
      role: "out",
      counterpartyTransactionId: "tx-3",
      method: "amount_time_window_v2",
      confidence: 0.63,
      decision: "UNCERTAIN_NO_OFFSET",
      kpiEffect: "INCLUDED",
      explain: {
        amountCents: 28100,
        dateDiffDays: 0,
        sameAccount: false,
        descHints: ["TRANSFER"],
        penalties: ["AMBIGUOUS_MULTI_MATCH"],
        score: 0.63,
      },
    },
  });
  const tx3 = makeTx({
    id: "tx-3",
    amount: 281,
    transfer: {
      matchId: "m-1",
      state: "uncertain",
      role: "in",
      counterpartyTransactionId: "tx-2",
      method: "amount_time_window_v2",
      confidence: 0.63,
    },
  });

  const parsed = makeParsedFile({
    fileId: "file-1",
    quality: {
      headerFound: true,
      balanceContinuityPassRate: 0.8,
      balanceContinuityChecked: 10,
      balanceContinuityTotalRows: 10,
      balanceContinuitySkipped: 0,
      balanceContinuitySkippedReasons: {},
      needsReviewReasons: ["BALANCE_CONTINUITY_LOW"],
      nonBlockingWarnings: [],
    },
    warnings: [{ rawLine: "bad", reason: "BALANCE_CONTINUITY_LOW", confidence: 0.2 }],
  });

  const result = aggregateInboxItems({
    transactions: [tx1, tx2, tx3],
    parsedFiles: [parsed],
  });

  assert.equal(result.counts.UNKNOWN_MERCHANT, 1);
  assert.equal(result.counts.UNCERTAIN_TRANSFER, 1);
  assert.equal(result.counts.PARSE_ISSUE, 1);
  assert.equal(result.totals.unresolved, 3);
});

test("aggregateInboxItems filters resolved items", () => {
  const tx = makeTx({ id: "tx-1" });
  const resolvedId = "UNKNOWN_MERCHANT:tx-1";
  const result = aggregateInboxItems({
    transactions: [tx],
    parsedFiles: [],
    resolvedIds: {
      [resolvedId]: {
        resolvedAt: "2026-02-24T00:00:00.000Z",
      },
    },
  });

  assert.equal(result.counts.UNKNOWN_MERCHANT, 0);
  assert.equal(result.totals.unresolved, 0);
  assert.equal(result.totals.resolved, 1);
});
