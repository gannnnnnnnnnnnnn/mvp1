/**
 * Route: POST /api/parse/pdf-transactions
 *
 * Parses cached text into structured transactions using the main template parser.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { findById, patchMetadataById } from "@/lib/fileStore";
import { parseMainText } from "@/lib/parsing/mainParse";

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
    const fileMeta = await findById(body.fileId);

    const parsed = parseMainText({
      fileId: body.fileId,
      text,
      fileHash: fileMeta?.contentHash,
      fileName: fileMeta?.originalName,
      accountIdHint: fileMeta?.accountId,
    });

    // Stamp parsed bank/account/template metadata back to index for multi-bank readiness.
    await patchMetadataById(body.fileId, {
      bankId: parsed.bankId,
      accountId: parsed.accountId,
      templateId: parsed.templateId,
      templateType: parsed.templateType,
      accountMeta: parsed.accountMeta,
    });

    const reviewReasons = parsed.quality.needsReviewReasons;

    return NextResponse.json({
      ok: true,
      transactions: parsed.transactions,
      warnings: parsed.warnings,
      needsReview: parsed.needsReview,
      reviewReasons,
      debug: parsed.debug,
      quality: parsed.quality,
      templateType: parsed.templateType,
      bankId: parsed.bankId,
      accountId: parsed.accountId,
      sectionTextPreview: parsed.sectionTextPreview,
    });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) {
      return errorJson(404, "NOT_FOUND", "未找到文本缓存，请先执行 Extract Text。");
    }

    console.error("/api/parse/pdf-transactions failed", err);
    return errorJson(500, "IO_FAIL", "交易解析失败，请稍后重试。");
  }
}
