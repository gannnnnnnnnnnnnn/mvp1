/**
 * Route: POST /api/parse/pdf-transactions
 *
 * Reads text cache, segments likely transaction area, then applies
 * rule-based transaction parser v1.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { segmentTransactionSection } from "@/lib/segmentTransactionSection";
import { parseTransactionsV1 } from "@/lib/parseTransactionsV1";
import { detectCommBankTemplate } from "@/lib/commbankTemplate";
import { parseCommbankStatementDebitCredit } from "@/lib/parseCommbankStatementDebitCredit";
import { getCommBankTemplateById } from "@/templates/commbank";

const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

type ParseRequest = {
  fileId: string;
};

type ParseQuality = {
  headerFound: boolean;
  balanceContinuityPassRate: number;
  balanceContinuityChecked: number;
  needsReviewReasons: string[];
  statementTotalsCheck?: {
    available: boolean;
    pass?: boolean;
    opening?: number;
    totalDebits?: number;
    totalCredits?: number;
    closing?: number;
    expectedClosing?: number;
  };
};

function round2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * Balance continuity check:
 * Statement semantics: each row balance is post-transaction balance.
 * So we validate current row by previous balance + current amount ~= current balance.
 */
function assessBalanceContinuity(
  transactions: Array<{ amount: number; balance?: number; debit?: number; credit?: number }>,
  templateType: ReturnType<typeof detectCommBankTemplate>
) {
  if (transactions.length < 2) {
    return { checked: 0, passRate: 0 };
  }

  let pass = 0;
  let checked = 0;

  // Start from i=1 because the first row has no previous row to reconcile against.
  for (let i = 1; i < transactions.length; i += 1) {
    const previous = transactions[i - 1];
    const current = transactions[i];
    const previousBalance = previous.balance;
    const currentBalance = current.balance;

    if (
      typeof previousBalance !== "number" ||
      typeof currentBalance !== "number" ||
      !Number.isFinite(current.amount as number)
    ) {
      continue;
    }

    // For auto debit/credit template, only compare rows where amount was
    // explicitly mapped from debit or credit (not fallback placeholder).
    if (
      templateType === "commbank_auto_debit_credit" &&
      typeof current.debit !== "number" &&
      typeof current.credit !== "number"
    ) {
      continue;
    }
    checked += 1;

    const expectedCurr = round2(previousBalance + current.amount);
    const actualCurr = round2(currentBalance);
    if (Math.abs(expectedCurr - actualCurr) <= 0.01) {
      pass += 1;
    }
  }

  if (checked === 0) {
    return { checked: 0, passRate: 0 };
  }

  return {
    checked,
    passRate: pass / checked,
  };
}

function pushReasonUnique(reasons: string[], code: string) {
  if (!reasons.includes(code)) {
    reasons.push(code);
  }
}

function parseSignedMoneyToken(token: string) {
  const upper = token.toUpperCase().replace(/\s+/g, "");
  const hasParens = upper.startsWith("(") && upper.endsWith(")");
  const hasMinus = upper.includes("-");
  const hasCR = upper.endsWith("CR");
  const hasDR = upper.endsWith("DR");

  const numeric = upper
    .replace(/CR$|DR$/i, "")
    .replace(/[()$,]/g, "");
  const value = Number(numeric);
  if (!Number.isFinite(value)) return null;

  const abs = Math.abs(value);
  if (hasCR) return abs;
  if (hasDR || hasMinus || hasParens) return -abs;
  return abs;
}

function extractLooseMoneyTokens(text: string) {
  const re = /(?:\(?\$?(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?(?:\s?(?:CR|DR))?)/gi;
  const tokens: string[] = [];
  for (const m of text.matchAll(re)) {
    tokens.push(m[0]);
  }
  return tokens;
}

function assessStatementTotals(fullText: string) {
  const lines = (fullText || "").replace(/\r\n/g, "\n").split("\n");
  const labelIndex = lines.findIndex((line) =>
    line
      .toLowerCase()
      .replace(/\s+/g, "")
      .includes("openingbalance-totaldebits+totalcredits=closingbalance")
  );
  if (labelIndex < 0) {
    return { available: false as const };
  }

  const valueLine = lines[labelIndex + 1] || "";
  const combined = `${lines[labelIndex] || ""} ${valueLine}`.trim();
  const tokens = extractLooseMoneyTokens(combined);
  if (tokens.length < 3) {
    return { available: false as const };
  }

  const opening = parseSignedMoneyToken(tokens[0]);
  const totalDebits = parseSignedMoneyToken(tokens[1]);
  const totalCredits = parseSignedMoneyToken(tokens[2]);
  if (
    typeof opening !== "number" ||
    typeof totalDebits !== "number" ||
    typeof totalCredits !== "number"
  ) {
    return { available: false as const };
  }

  let closing: number | undefined;
  if (tokens.length >= 4) {
    const parsedClosing = parseSignedMoneyToken(tokens[3]);
    if (typeof parsedClosing === "number") {
      closing = parsedClosing;
    }
  }
  if (typeof closing !== "number" && /nil/i.test(combined)) {
    closing = 0;
  }
  if (typeof closing !== "number") {
    return { available: false as const };
  }

  const expectedClosing = round2(opening - Math.abs(totalDebits) + Math.abs(totalCredits));
  const pass = Math.abs(expectedClosing - round2(closing)) <= 0.01;
  return {
    available: true as const,
    pass,
    opening,
    totalDebits: Math.abs(totalDebits),
    totalCredits: Math.abs(totalCredits),
    closing: round2(closing),
    expectedClosing,
  };
}

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function hasErrnoCode(err: unknown, code: string) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

export async function POST(request: Request) {
  let body: ParseRequest | null = null;

  try {
    const raw = (await request.json()) as Record<string, unknown>;
    if (typeof raw.fileId === "string") {
      body = { fileId: raw.fileId.trim() };
    }
  } catch {
    return errorJson(400, "BAD_REQUEST", "请求体读取失败，请传入 JSON。");
  }

  if (!body || !body.fileId) {
    return errorJson(400, "BAD_REQUEST", "请求体格式不正确，期望 { fileId }。");
  }

  if (!FILE_ID_RE.test(body.fileId)) {
    return errorJson(400, "BAD_REQUEST", "fileId 格式非法。");
  }

  const textPath = path.join(TEXT_CACHE_ROOT, `${body.fileId}.txt`);

  try {
    const text = await fs.readFile(textPath, "utf8");
    const templateType = detectCommBankTemplate(text);
    const templateConfig = getCommBankTemplateById(templateType);
    const segmented = segmentTransactionSection(text, templateType);
    let parsed:
      | ReturnType<typeof parseTransactionsV1>
      | ReturnType<typeof parseCommbankStatementDebitCredit>;

    switch (templateType) {
      case "commbank_manual_amount_balance":
        parsed = parseTransactionsV1(segmented.sectionText, body.fileId);
        break;
      case "commbank_auto_debit_credit":
        parsed = parseCommbankStatementDebitCredit(segmented.sectionText, body.fileId, text);
        break;
      default:
        parsed = { transactions: [], warnings: [] };
        break;
    }

    const needsReviewReasons: string[] = [];
    const continuity =
      templateConfig?.quality.enableContinuityGate === true
        ? assessBalanceContinuity(parsed.transactions, templateType)
        : { checked: 0, passRate: 0 };
    const statementTotalsCheck =
      templateType === "commbank_auto_debit_credit"
        ? assessStatementTotals(text)
        : { available: false as const };

    if (templateType === "unknown") {
      pushReasonUnique(needsReviewReasons, "TEMPLATE_UNKNOWN");
    }

    // Milestone A (header gate):
    // Use machine-readable reason code for stable downstream checks.
    if (!segmented.debug.headerFound) {
      pushReasonUnique(needsReviewReasons, "HEADER_NOT_FOUND");
    }
    // Keep old "too few transactions" behavior for compatibility.
    if (parsed.transactions.length < 5) {
      pushReasonUnique(needsReviewReasons, "TRANSACTIONS_TOO_FEW");
    }
    // Milestone B (balance continuity gate):
    // Require enough comparisons first to avoid small-sample false alarms.
    if (
      templateConfig?.quality.enableContinuityGate === true &&
      continuity.checked >= templateConfig.quality.minContinuityChecked &&
      continuity.passRate < templateConfig.quality.continuityThreshold
    ) {
      pushReasonUnique(needsReviewReasons, "BALANCE_CONTINUITY_LOW");
    }

    if (templateType === "commbank_auto_debit_credit") {
      // If parser detected both debit and credit in the same block, mark review.
      if (parsed.warnings.some((w) => w.reason === "DEBIT_CREDIT_BOTH_PRESENT")) {
        pushReasonUnique(needsReviewReasons, "DEBIT_CREDIT_BOTH_PRESENT");
      }
      if (
        parsed.transactions.some(
          (tx) => typeof tx.debit === "number" && typeof tx.credit === "number"
        )
      ) {
        pushReasonUnique(needsReviewReasons, "DEBIT_CREDIT_BOTH_PRESENT");
      }
      if (parsed.warnings.some((w) => w.reason.startsWith("AUTO_AMOUNT_NOT_FOUND"))) {
        pushReasonUnique(needsReviewReasons, "AUTO_AMOUNT_NOT_FOUND");
      }
      if (parsed.warnings.some((w) => w.reason.startsWith("AUTO_BALANCE_NOT_FOUND"))) {
        pushReasonUnique(needsReviewReasons, "AUTO_BALANCE_NOT_FOUND");
      }
      if (parsed.warnings.some((w) => w.reason.startsWith("AMOUNT_SIGN_UNCERTAIN"))) {
        pushReasonUnique(needsReviewReasons, "AMOUNT_SIGN_UNCERTAIN");
      }
      if (parsed.warnings.some((w) => w.reason.startsWith("AMOUNT_OUTLIER"))) {
        pushReasonUnique(needsReviewReasons, "AMOUNT_OUTLIER");
      }
      if (statementTotalsCheck.available && statementTotalsCheck.pass === false) {
        pushReasonUnique(needsReviewReasons, "STATEMENT_TOTALS_MISMATCH");
      }

      // Low coverage = too many rows missing amount mapping or running balance.
      const coverageTotal = parsed.transactions.length;
      if (coverageTotal > 0) {
        const lowCoverageCount = parsed.transactions.filter(
          (tx) =>
            typeof tx.balance !== "number" ||
            (typeof tx.debit !== "number" && typeof tx.credit !== "number")
        ).length;
        const lowCoverageRate = lowCoverageCount / coverageTotal;
        if (lowCoverageRate > 0.1) {
          pushReasonUnique(needsReviewReasons, "AUTO_PARSE_LOW_COVERAGE");
        }
      }
    }

    // Keep legacy reviewReasons field so existing UI/clients do not break.
    const legacyReasonMessageMap: Record<string, string> = {
      TEMPLATE_UNKNOWN:
        "Template unknown. Please review raw text and add/update CommBank template config.",
      HEADER_NOT_FOUND: "Segment header not found. Please review original extracted text.",
      TRANSACTIONS_TOO_FEW:
        "Parsed transactions are too few (< 5). Please review segment/parsing result.",
      BALANCE_CONTINUITY_LOW:
        "Balance continuity is below threshold (passRate < 0.85). Please review parsed rows.",
      DEBIT_CREDIT_BOTH_PRESENT:
        "Both debit and credit values were detected in one parsed block. Please review this statement format.",
      AUTO_PARSE_LOW_COVERAGE:
        "Auto template parse coverage is low (missing amount or balance in many rows).",
      AUTO_AMOUNT_NOT_FOUND:
        "Could not find a valid auto-template amount candidate for some blocks.",
      AUTO_BALANCE_NOT_FOUND:
        "Could not find a valid auto-template running balance candidate for some blocks.",
      AMOUNT_SIGN_UNCERTAIN:
        "Amount sign is uncertain for some auto-template rows after balance reconciliation.",
      AMOUNT_OUTLIER:
        "Outlier amount candidates were detected and ignored during auto-template parsing.",
      STATEMENT_TOTALS_MISMATCH:
        "Statement totals check failed: opening - totalDebits + totalCredits does not match closing.",
    };
    const reviewReasons = needsReviewReasons.map(
      (code) => legacyReasonMessageMap[code] || code
    );

    const quality: ParseQuality = {
      headerFound: segmented.debug.headerFound,
      balanceContinuityPassRate: continuity.passRate,
      balanceContinuityChecked: continuity.checked,
      needsReviewReasons: [...needsReviewReasons],
      statementTotalsCheck:
        statementTotalsCheck.available === true
          ? {
              available: true,
              pass: statementTotalsCheck.pass,
              opening: statementTotalsCheck.opening,
              totalDebits: statementTotalsCheck.totalDebits,
              totalCredits: statementTotalsCheck.totalCredits,
              closing: statementTotalsCheck.closing,
              expectedClosing: statementTotalsCheck.expectedClosing,
            }
          : { available: false },
    };
    const needsReview = quality.needsReviewReasons.length > 0;

    return NextResponse.json({
      ok: true,
      transactions: parsed.transactions,
      warnings: parsed.warnings,
      needsReview,
      reviewReasons,
      debug: segmented.debug,
      quality,
      templateType,
      // Keep preview bounded for UI readability.
      sectionTextPreview: segmented.sectionText.slice(0, 4000),
    });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) {
      return errorJson(404, "NOT_FOUND", "未找到文本缓存，请先执行 Extract Text。");
    }

    console.error("/api/parse/pdf-transactions failed", err);
    return errorJson(500, "IO_FAIL", "交易解析失败，请稍后重试。");
  }
}
