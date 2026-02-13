import { promises as fs } from "fs";
import path from "path";
import { detectCommBankTemplate } from "@/lib/commbankTemplate";
import { segmentTransactionSection } from "@/lib/segmentTransactionSection";
import { parseTransactionsV1 } from "@/lib/parseTransactionsV1";
import { parseCommbankStatementDebitCredit } from "@/lib/parseCommbankStatementDebitCredit";
import { getCommBankTemplateById } from "@/templates/commbank";

const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function assessBalanceContinuity(
  transactions: Array<{ amount: number; balance?: number; debit?: number; credit?: number }>,
  templateType: ReturnType<typeof detectCommBankTemplate>
) {
  if (transactions.length < 2) {
    return { checked: 0, passRate: 0 };
  }

  let pass = 0;
  let checked = 0;
  for (let i = 1; i < transactions.length; i += 1) {
    const previous = transactions[i - 1];
    const current = transactions[i];
    if (
      typeof previous.balance !== "number" ||
      typeof current.balance !== "number" ||
      !Number.isFinite(current.amount)
    ) {
      continue;
    }

    if (
      templateType === "commbank_auto_debit_credit" &&
      typeof current.debit !== "number" &&
      typeof current.credit !== "number"
    ) {
      continue;
    }

    checked += 1;
    const expectedCurr = round2(previous.balance + current.amount);
    const actualCurr = round2(current.balance);
    if (Math.abs(expectedCurr - actualCurr) <= 0.01) {
      pass += 1;
    }
  }

  return checked === 0 ? { checked: 0, passRate: 0 } : { checked, passRate: pass / checked };
}

function pushReasonUnique(reasons: string[], code: string) {
  if (!reasons.includes(code)) reasons.push(code);
}

export type ParsedFileAnalysis = {
  fileId: string;
  templateType: ReturnType<typeof detectCommBankTemplate>;
  transactions: ReturnType<typeof parseTransactionsV1>["transactions"];
  warnings: ReturnType<typeof parseTransactionsV1>["warnings"];
  quality: {
    headerFound: boolean;
    balanceContinuityPassRate: number;
    balanceContinuityChecked: number;
    needsReviewReasons: string[];
    nonBlockingWarnings: string[];
  };
  needsReview: boolean;
  debug: {
    startLine?: number;
    endLine?: number;
    removedLines: number;
    headerFound: boolean;
    stopReason?: string;
  };
};

export async function loadParsedTransactions(fileId: string): Promise<ParsedFileAnalysis> {
  if (!FILE_ID_RE.test(fileId)) {
    throw new Error("BAD_FILE_ID");
  }

  const textPath = path.join(TEXT_CACHE_ROOT, `${fileId}.txt`);
  const text = await fs.readFile(textPath, "utf8");
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
      : { checked: 0, passRate: 0 };

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
    const warnHas = (prefix: string) => parsed.warnings.some((w) => w.reason.startsWith(prefix));

    if (
      parsed.transactions.some(
        (tx) => typeof tx.debit === "number" && typeof tx.credit === "number"
      )
    ) {
      pushReasonUnique(reasons, "DEBIT_CREDIT_BOTH_PRESENT");
    }

    if (warnHas("AUTO_AMOUNT_NOT_FOUND")) pushReasonUnique(reasons, "AUTO_AMOUNT_NOT_FOUND");
    if (warnHas("AUTO_BALANCE_NOT_FOUND")) pushReasonUnique(reasons, "AUTO_BALANCE_NOT_FOUND");
    if (warnHas("AMOUNT_SIGN_UNCERTAIN")) pushReasonUnique(reasons, "AMOUNT_SIGN_UNCERTAIN");
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

  return {
    fileId,
    templateType,
    transactions: parsed.transactions,
    warnings: parsed.warnings,
    quality: {
      headerFound: segmented.debug.headerFound,
      balanceContinuityPassRate: continuity.passRate,
      balanceContinuityChecked: continuity.checked,
      needsReviewReasons: reasons,
      nonBlockingWarnings,
    },
    needsReview: reasons.length > 0,
    debug: segmented.debug,
  };
}
