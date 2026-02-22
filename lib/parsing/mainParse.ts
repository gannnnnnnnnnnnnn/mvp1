import { detectCommBankTemplate } from "@/lib/commbankTemplate";
import { segmentTransactionSection } from "@/lib/segmentTransactionSection";
import {
  ParseWarning,
  ParsedTransaction,
  parseTransactionsV1,
} from "@/lib/parseTransactionsV1";
import { parseCommbankStatementDebitCredit } from "@/lib/parseCommbankStatementDebitCredit";
import { getCommBankTemplateById } from "@/templates/commbank";
import { detectDevTemplate } from "@/lib/templates/registry";
import {
  extractCbaAccountMeta,
  normalizeAccountMeta,
  resolveAccountIdFromMeta,
  StatementAccountMeta,
} from "@/lib/parsing/accountMeta";

export type ParsedTransactionWithMeta = ParsedTransaction & {
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

export type MainParseQuality = {
  headerFound: boolean;
  balanceContinuityPassRate: number;
  balanceContinuityChecked: number;
  balanceContinuityTotalRows: number;
  balanceContinuitySkipped: number;
  balanceContinuitySkippedReasons: Record<string, number>;
  needsReviewReasons: string[];
  nonBlockingWarnings: string[];
};

export type MainParseOutput = {
  templateType: string;
  bankId: string;
  accountId: string;
  templateId: string;
  accountMeta?: StatementAccountMeta;
  transactions: ParsedTransactionWithMeta[];
  warnings: ParseWarning[];
  needsReview: boolean;
  quality: MainParseQuality;
  debug: {
    startLine?: number;
    endLine?: number;
    removedLines: number;
    headerFound: boolean;
    stopReason?: string;
    evidence?: string[];
    mode?: string;
    confidence?: number;
  };
  sectionTextPreview: string;
};

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function pushReasonUnique(reasons: string[], code: string) {
  if (!reasons.includes(code)) reasons.push(code);
}

function assessBalanceContinuity(
  transactions: Array<{
    amount: number;
    amountSource?: "parsed_token" | "balance_diff_inferred";
    balance?: number;
    debit?: number;
    credit?: number;
  }>,
  templateType: ReturnType<typeof detectCommBankTemplate>
) {
  if (transactions.length < 2) {
    return {
      checked: 0,
      totalRows: 0,
      skipped: 0,
      passRate: 0,
      skippedReasons: {},
    };
  }

  let pass = 0;
  let checked = 0;
  let totalRows = 0;
  const skippedReasons: Record<string, number> = {};
  const markSkip = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] || 0) + 1;
  };

  for (let i = 1; i < transactions.length; i += 1) {
    totalRows += 1;
    const previous = transactions[i - 1];
    const current = transactions[i];

    if (typeof previous.balance !== "number") {
      markSkip("PREV_BALANCE_MISSING");
      continue;
    }
    if (typeof current.balance !== "number") {
      markSkip("CURR_BALANCE_MISSING");
      continue;
    }
    if (!Number.isFinite(current.amount)) {
      markSkip("AMOUNT_NOT_FINITE");
      continue;
    }

    if (
      templateType === "commbank_auto_debit_credit" &&
      typeof current.debit !== "number" &&
      typeof current.credit !== "number" &&
      current.amountSource !== "balance_diff_inferred"
    ) {
      markSkip("AUTO_AMOUNT_SIDE_MISSING");
      continue;
    }

    checked += 1;
    const expectedCurr = round2(previous.balance + current.amount);
    const actualCurr = round2(current.balance);
    if (Math.abs(expectedCurr - actualCurr) <= 0.01) {
      pass += 1;
    }
  }

  if (checked === 0) {
    return { checked: 0, totalRows, skipped: totalRows, passRate: 0, skippedReasons };
  }

  return {
    checked,
    totalRows,
    skipped: totalRows - checked,
    passRate: pass / checked,
    skippedReasons,
  };
}

function mapAnzWarnings(
  warnings: Array<{
    code: string;
    rawLine?: string;
    confidence?: number;
  }>
): ParseWarning[] {
  return warnings.map((warning) => ({
    reason: warning.code,
    rawLine: warning.rawLine || "",
    confidence: typeof warning.confidence === "number" ? warning.confidence : 0.3,
  }));
}

function mapAnzTransactions(
  transactions: Array<{
    id: string;
    date: string;
    descriptionRaw: string;
    amount: number;
    balance?: number;
    debit?: number;
    credit?: number;
    confidence: number;
    rawLine: string;
    bankId: string;
    accountId: string;
    templateId: string;
    source?: {
      fileId?: string;
      fileHash?: string;
      rowIndex?: number;
      parserVersion?: string;
    };
  }>
): ParsedTransactionWithMeta[] {
  return transactions.map((tx) => ({
    id: tx.id,
    date: tx.date,
    description: tx.descriptionRaw,
    amount: tx.amount,
    balance: tx.balance,
    debit: tx.debit,
    credit: tx.credit,
    rawLine: tx.rawLine,
    confidence: tx.confidence,
    amountSource: "parsed_token",
    bankId: tx.bankId,
    accountId: tx.accountId,
    templateId: tx.templateId,
    source: {
      fileId: tx.source?.fileId,
      fileHash: tx.source?.fileHash,
      rowIndex: tx.source?.rowIndex,
      lineIndex: tx.source?.rowIndex,
      parserVersion: tx.source?.parserVersion,
    },
  }));
}

export function parseMainText(params: {
  fileId: string;
  text: string;
  fileHash?: string;
  fileName?: string;
  accountIdHint?: string;
}) : MainParseOutput {
  const { fileId, text, fileHash, fileName, accountIdHint } = params;

  const detected = detectDevTemplate(text);
  if (detected.template && detected.detection.bankId === "anz") {
    const parsed = detected.template.parse({
      fileId,
      fileHash,
      fileName,
      text,
    });

    const transactions = mapAnzTransactions(parsed.transactions);
    const warnings = mapAnzWarnings(parsed.warnings);
    const normalizedAnzMeta = parsed.accountMeta
      ? normalizeAccountMeta({
          ...parsed.accountMeta,
          bankId: parsed.bankId,
          accountId: parsed.accountId || accountIdHint || "default",
          templateId: parsed.templateId,
        })
      : undefined;
    const resolvedAnzAccountId = resolveAccountIdFromMeta({
      bankId: parsed.bankId,
      existingAccountId: parsed.accountId || accountIdHint,
      accountMeta: normalizedAnzMeta,
    });
    const normalizedAnzTransactions = transactions.map((tx) => ({
      ...tx,
      accountId: resolvedAnzAccountId,
    }));

    const reasons = new Set<string>();
    if (parsed.debug.checkedCount >= 5 && parsed.debug.continuityRatio < 0.995) {
      reasons.add("ANZ_BALANCE_CONTINUITY_LOW");
    }
    for (const w of parsed.warnings) {
      if (w.severity === "critical") reasons.add(w.code);
    }

    return {
      templateType: parsed.templateId,
      bankId: parsed.bankId,
      accountId: resolvedAnzAccountId,
      templateId: parsed.templateId,
      accountMeta: normalizedAnzMeta
        ? { ...normalizedAnzMeta, accountId: resolvedAnzAccountId }
        : undefined,
      transactions: normalizedAnzTransactions,
      warnings,
      needsReview: reasons.size > 0,
      quality: {
        headerFound: true,
        balanceContinuityPassRate: parsed.debug.continuityRatio,
        balanceContinuityChecked: parsed.debug.checkedCount,
        balanceContinuityTotalRows: parsed.debug.checkedCount,
        balanceContinuitySkipped: 0,
        balanceContinuitySkippedReasons: {},
        needsReviewReasons: [...reasons],
        nonBlockingWarnings: [],
      },
      debug: {
        headerFound: true,
        removedLines: 0,
        evidence: parsed.debug.detection.evidence,
        mode: parsed.mode,
        confidence: parsed.debug.detection.confidence,
      },
      sectionTextPreview: text.slice(0, 4000),
    };
  }

  const templateType = detectCommBankTemplate(text);
  const templateConfig = getCommBankTemplateById(templateType);
  const segmented = segmentTransactionSection(text, templateType);

  const parsed =
    templateType === "commbank_manual_amount_balance"
      ? parseTransactionsV1(segmented.sectionText, fileId)
      : templateType === "commbank_auto_debit_credit"
        ? parseCommbankStatementDebitCredit(segmented.sectionText, fileId, text)
        : { transactions: [], warnings: [] };

  const reasons: string[] = [];
  const nonBlockingWarnings: string[] = [];

  const continuity =
    templateConfig?.quality.enableContinuityGate === true
      ? assessBalanceContinuity(parsed.transactions, templateType)
      : { checked: 0, totalRows: 0, skipped: 0, passRate: 0, skippedReasons: {} };

  if (templateType === "unknown") pushReasonUnique(reasons, "TEMPLATE_UNKNOWN");
  if (!segmented.debug.headerFound) pushReasonUnique(reasons, "HEADER_NOT_FOUND");
  if (parsed.transactions.length < 5) pushReasonUnique(reasons, "TRANSACTIONS_TOO_FEW");

  if (
    templateConfig?.quality.enableContinuityGate === true &&
    continuity.checked >= templateConfig.quality.minContinuityChecked &&
    continuity.passRate < templateConfig.quality.continuityThreshold
  ) {
    pushReasonUnique(reasons, "BALANCE_CONTINUITY_LOW");
  }

  if (templateType === "commbank_auto_debit_credit") {
    const continuityStrong = continuity.checked >= 5 && continuity.passRate >= 0.95;
    const inferredRawLineSet = new Set(
      parsed.transactions
        .filter((tx) => tx.amountSource === "balance_diff_inferred")
        .map((tx) => tx.rawLine)
    );
    const warnHas = (prefix: string) => parsed.warnings.some((w) => w.reason.startsWith(prefix));
    const hasBlockingSignUncertain = parsed.warnings.some(
      (w) =>
        w.reason.startsWith("AMOUNT_SIGN_UNCERTAIN") &&
        !(continuityStrong && inferredRawLineSet.has(w.rawLine))
    );

    if (
      parsed.transactions.some(
        (tx) => typeof tx.debit === "number" && typeof tx.credit === "number"
      )
    ) {
      pushReasonUnique(reasons, "DEBIT_CREDIT_BOTH_PRESENT");
    }

    if (warnHas("AUTO_AMOUNT_NOT_FOUND")) pushReasonUnique(reasons, "AUTO_AMOUNT_NOT_FOUND");
    if (warnHas("AUTO_BALANCE_NOT_FOUND")) pushReasonUnique(reasons, "AUTO_BALANCE_NOT_FOUND");
    if (hasBlockingSignUncertain) pushReasonUnique(reasons, "AMOUNT_SIGN_UNCERTAIN");
    if (warnHas("BALANCE_SUFFIX_MISSING")) pushReasonUnique(reasons, "BALANCE_SUFFIX_MISSING");

    const coverageTotal = parsed.transactions.length;
    if (coverageTotal > 0) {
      const lowCoverageCount = parsed.transactions.filter(
        (tx) =>
          typeof tx.balance !== "number" ||
          (typeof tx.debit !== "number" && typeof tx.credit !== "number")
      ).length;
      if (lowCoverageCount / coverageTotal > 0.1) {
        pushReasonUnique(reasons, "AUTO_PARSE_LOW_COVERAGE");
      }
    }

    if (warnHas("AMOUNT_OUTLIER")) {
      const parseDegraded =
        reasons.includes("AUTO_AMOUNT_NOT_FOUND") ||
        reasons.includes("AUTO_BALANCE_NOT_FOUND") ||
        reasons.includes("AMOUNT_SIGN_UNCERTAIN") ||
        reasons.includes("BALANCE_SUFFIX_MISSING") ||
        reasons.includes("AUTO_PARSE_LOW_COVERAGE") ||
        reasons.includes("BALANCE_CONTINUITY_LOW");
      if (parseDegraded) {
        pushReasonUnique(reasons, "AMOUNT_OUTLIER");
      } else {
        nonBlockingWarnings.push("AMOUNT_OUTLIER");
      }
    }
  }

  const bankId = "cba";
  const rawAccountMeta = extractCbaAccountMeta({
    text,
    accountId: accountIdHint || "default",
    templateId: templateType,
  });
  const accountId = resolveAccountIdFromMeta({
    bankId,
    existingAccountId: accountIdHint,
    accountMeta: rawAccountMeta,
  });
  const accountMeta = {
    ...rawAccountMeta,
    accountId,
  };
  const normalizedTransactions: ParsedTransactionWithMeta[] = parsed.transactions.map((tx, idx) => ({
    ...tx,
    bankId,
    accountId,
    templateId: templateType,
    source: {
      fileId,
      fileHash,
      rowIndex: idx + 1,
      parserVersion: "cba_v1",
    },
  }));

  return {
    templateType,
    bankId,
    accountId,
    templateId: templateType,
    accountMeta,
    transactions: normalizedTransactions,
    warnings: parsed.warnings,
    needsReview: reasons.length > 0,
    quality: {
      headerFound: segmented.debug.headerFound,
      balanceContinuityPassRate: continuity.passRate,
      balanceContinuityChecked: continuity.checked,
      balanceContinuityTotalRows: continuity.totalRows,
      balanceContinuitySkipped: continuity.skipped,
      balanceContinuitySkippedReasons: continuity.skippedReasons,
      needsReviewReasons: reasons,
      nonBlockingWarnings,
    },
    debug: segmented.debug,
    sectionTextPreview: segmented.sectionText.slice(0, 4000),
  };
}
