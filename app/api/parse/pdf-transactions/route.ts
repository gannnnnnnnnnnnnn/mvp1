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

const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

type ParseRequest = {
  fileId: string;
};

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
    const segmented = segmentTransactionSection(text);
    const parsed = parseTransactionsV1(segmented.sectionText, body.fileId);
    const reviewReasons: string[] = [];

    // Milestone 2.5.3 quality gate:
    // 1) header not found usually means segmentation failed.
    // 2) very small transaction count is suspicious for full statements.
    if (!segmented.debug.headerFound) {
      reviewReasons.push("Segment header not found. Please review original extracted text.");
    }
    if (parsed.transactions.length < 5) {
      reviewReasons.push("Parsed transactions are too few (< 5). Please review segment/parsing result.");
    }
    const needsReview = reviewReasons.length > 0;

    return NextResponse.json({
      ok: true,
      transactions: parsed.transactions,
      warnings: parsed.warnings,
      needsReview,
      reviewReasons,
      debug: segmented.debug,
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
