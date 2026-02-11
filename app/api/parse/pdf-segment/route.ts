/**
 * Route: POST /api/parse/pdf-segment
 *
 * Reads cached text from Phase 2.1.5 and extracts likely transaction section.
 * We do not parse transactions here; this endpoint only segments text.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { segmentTransactionSection } from "@/lib/segmentTransactionSection";
import { detectCommBankTemplate } from "@/lib/commbankTemplate";

const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

type SegmentRequest = {
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
  let body: SegmentRequest | null = null;

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
    const segmented = segmentTransactionSection(text, templateType);

    return NextResponse.json({
      ok: true,
      fileId: body.fileId,
      templateType,
      sectionText: segmented.sectionText,
      debug: segmented.debug,
    });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) {
      return errorJson(404, "NOT_FOUND", "未找到文本缓存，请先执行 Extract Text。");
    }

    console.error("/api/parse/pdf-segment failed", err);
    return errorJson(500, "IO_FAIL", "分段失败，请稍后重试。");
  }
}
