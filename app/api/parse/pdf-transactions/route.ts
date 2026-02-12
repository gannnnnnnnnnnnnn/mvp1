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
  transactions: Array<{ amount: number; balance?: number }>
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
      case "commbank_transaction_summary":
        parsed = parseTransactionsV1(segmented.sectionText, body.fileId);
        break;
      case "commbank_statement_debit_credit":
        parsed = parseCommbankStatementDebitCredit(segmented.sectionText, body.fileId, text);
        break;
      default:
        parsed = { transactions: [], warnings: [] };
        break;
    }

    const needsReviewReasons: string[] = [];
    const continuity =
      templateConfig?.quality.enableContinuityGate === true
        ? assessBalanceContinuity(parsed.transactions)
        : { checked: 0, passRate: 0 };

    if (templateType === "unknown") {
      needsReviewReasons.push("TEMPLATE_UNKNOWN");
    }

    // Milestone A (header gate):
    // Use machine-readable reason code for stable downstream checks.
    if (!segmented.debug.headerFound) {
      needsReviewReasons.push("HEADER_NOT_FOUND");
    }
    // Keep old "too few transactions" behavior for compatibility.
    if (parsed.transactions.length < 5) {
      needsReviewReasons.push("TRANSACTIONS_TOO_FEW");
    }
    // Milestone B (balance continuity gate):
    // Require enough comparisons first to avoid small-sample false alarms.
    if (
      templateConfig?.quality.enableContinuityGate === true &&
      continuity.checked >= templateConfig.quality.minContinuityChecked &&
      continuity.passRate < templateConfig.quality.continuityThreshold
    ) {
      needsReviewReasons.push("BALANCE_CONTINUITY_LOW");
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
    };
    const reviewReasons = needsReviewReasons.map(
      (code) => legacyReasonMessageMap[code] || code
    );

    const quality: ParseQuality = {
      headerFound: segmented.debug.headerFound,
      balanceContinuityPassRate: continuity.passRate,
      balanceContinuityChecked: continuity.checked,
      needsReviewReasons: [...needsReviewReasons],
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
