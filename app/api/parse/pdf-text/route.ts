/**
 * Route: POST /api/parse/pdf-text
 *
 * Phase 2.1 goal:
 * - Given a fileId, extract plain text from a text-based PDF.
 * - Cache full extracted text under uploads/text-cache/{fileId}.txt.
 * - Return cached text when possible unless force=true.
 *
 * Why this lives in an API route:
 * - We must read from local disk using Node APIs (fs/path).
 * - We must not expose absolute local paths to the browser.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { createRequire } from "module";
import { findById, uploadsDirAbsolute } from "@/lib/fileStore";

// Important:
// `pdf-parse` package main entry has debug-side-effect code that can try to read
// ./test/data/*.pdf when module.parent is unavailable in bundled runtimes.
// We load the core parser file directly to avoid that path in Next route handlers.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  buffer: Buffer
) => Promise<{ text?: string }>;

// Security: only allow simple fileId characters to prevent path traversal attempts.
const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;

// Response-size guardrails requested by Phase 2.1.
const MAX_RETURN_TEXT_BYTES = 2 * 1024 * 1024; // 2MB
const TRUNCATED_RETURN_BYTES = 200 * 1024; // 200KB

const TEXT_CACHE_DIR = "text-cache";
const EXTRACTOR_NAME = "pdf-parse";

type ParseRequestBody = {
  fileId: string;
  force: boolean;
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

/**
 * Parse and validate request body strictly so we return clear 4xx errors.
 */
function parseBody(body: unknown): ParseRequestBody | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;

  if (typeof raw.fileId !== "string") return null;
  const fileId = raw.fileId.trim();
  const force = raw.force === true;

  return { fileId, force };
}

/**
 * PDF validation is intentionally permissive across historical metadata:
 * - mimeType may be missing or generic in some browsers
 * - extension is available from storedName/originalName
 */
function isPdfMeta(meta: { mimeType?: string; storedName: string; originalName: string }) {
  const mime = (meta.mimeType || "").toLowerCase();
  const byMime = mime === "application/pdf";
  const byStoredExt = path.extname(meta.storedName || "").toLowerCase() === ".pdf";
  const byOriginalExt =
    path.extname(meta.originalName || "").toLowerCase() === ".pdf";
  return byMime || byStoredExt || byOriginalExt;
}

/**
 * Build an absolute path to a stored upload safely:
 * - only basename is allowed
 * - resolved path must remain inside uploads root
 */
function resolveStoredUploadPath(storedName: string) {
  const base = path.basename(storedName);
  if (base !== storedName) return null;

  const uploadsRoot = path.resolve(uploadsDirAbsolute);
  const resolved = path.resolve(uploadsRoot, base);
  if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  return resolved;
}

function getCachePaths(fileId: string) {
  const cacheDir = path.join(uploadsDirAbsolute, TEXT_CACHE_DIR);
  const txtPath = path.join(cacheDir, `${fileId}.txt`);
  const jsonPath = path.join(cacheDir, `${fileId}.json`);
  return { cacheDir, txtPath, jsonPath };
}

/**
 * Apply API response payload limit without losing full cache on disk.
 * We still persist full text to TXT cache, but only return preview if too large.
 */
function toResponseText(fullText: string) {
  const byteLength = Buffer.byteLength(fullText, "utf8");
  if (byteLength <= MAX_RETURN_TEXT_BYTES) {
    return {
      text: fullText,
      truncated: false,
    };
  }

  // Byte-level cut keeps server response bounded. This may trim mid-char in rare cases.
  const preview = Buffer.from(fullText, "utf8")
    .subarray(0, TRUNCATED_RETURN_BYTES)
    .toString("utf8");

  return {
    text: preview,
    truncated: true,
  };
}

async function readCachedText(fileId: string) {
  const { txtPath } = getCachePaths(fileId);

  try {
    const text = await fs.readFile(txtPath, "utf8");
    return text;
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return null;
    throw err;
  }
}

async function writeTextCache(fileId: string, fullText: string) {
  const { cacheDir, txtPath, jsonPath } = getCachePaths(fileId);

  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(txtPath, fullText, "utf8");

  // Small metadata sidecar helps future Phase 2.2/2.3 traceability.
  const meta = {
    fileId,
    extractor: EXTRACTOR_NAME,
    cachedAt: new Date().toISOString(),
    length: fullText.length,
    byteLength: Buffer.byteLength(fullText, "utf8"),
  };
  await fs.writeFile(jsonPath, JSON.stringify(meta, null, 2), "utf8");
}

async function extractPdfText(pdfAbsolutePath: string) {
  const pdfBuffer = await fs.readFile(pdfAbsolutePath);
  // Use pdf-parse function API and trim trailing whitespace for stable previews.
  const parsed = await pdfParse(pdfBuffer);
  return (parsed?.text ?? "").trim();
}

export async function POST(request: Request) {
  let parsedBody: ParseRequestBody | null = null;

  try {
    const body = await request.json();
    parsedBody = parseBody(body);
  } catch {
    return errorJson(400, "BAD_REQUEST", "请求体读取失败，请传入 JSON。");
  }

  if (!parsedBody) {
    return errorJson(400, "BAD_REQUEST", "请求体格式不正确，期望 { fileId, force? }。");
  }

  const { fileId, force } = parsedBody;

  if (!FILE_ID_RE.test(fileId)) {
    return errorJson(
      400,
      "BAD_REQUEST",
      "fileId 格式非法，仅允许字母数字下划线和连字符。"
    );
  }

  try {
    const fileMeta = await findById(fileId);
    if (!fileMeta) {
      return errorJson(404, "NOT_FOUND", "找不到对应文件记录。");
    }

    if (!isPdfMeta(fileMeta)) {
      return errorJson(400, "NOT_PDF", "该文件不是 PDF，无法抽取文本。");
    }

    if (!force) {
      try {
        const cachedText = await readCachedText(fileId);
        if (cachedText !== null) {
          const payload = toResponseText(cachedText);
          return NextResponse.json({
            ok: true,
            fileId,
            text: payload.text,
            meta: {
              extractor: EXTRACTOR_NAME,
              length: cachedText.length,
              cached: true,
              truncated: payload.truncated,
              emptyText: cachedText.length === 0,
            },
          });
        }
      } catch (cacheReadErr) {
        console.error("Read text cache failed", cacheReadErr);
        return errorJson(500, "IO_FAIL", "读取文本缓存失败。");
      }
    }

    const pdfAbsolutePath = resolveStoredUploadPath(fileMeta.storedName);
    if (!pdfAbsolutePath) {
      return errorJson(400, "IO_FAIL", "文件路径非法，拒绝访问。");
    }

    let fullText = "";
    try {
      fullText = await extractPdfText(pdfAbsolutePath);
    } catch (extractErr) {
      console.error("PDF extract failed", extractErr);
      return errorJson(
        500,
        "EXTRACT_FAIL",
        "PDF 文本抽取失败，请确认是可复制文本的 PDF。"
      );
    }

    try {
      await writeTextCache(fileId, fullText);
    } catch (cacheWriteErr) {
      console.error("Write text cache failed", cacheWriteErr);
      return errorJson(500, "IO_FAIL", "写入文本缓存失败。");
    }

    const payload = toResponseText(fullText);
    return NextResponse.json({
      ok: true,
      fileId,
      text: payload.text,
      meta: {
        extractor: EXTRACTOR_NAME,
        length: fullText.length,
        cached: false,
        truncated: payload.truncated,
        emptyText: fullText.length === 0,
      },
    });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) {
      return errorJson(404, "NOT_FOUND", "PDF 文件不存在或已丢失。");
    }

    console.error("/api/parse/pdf-text failed", err);
    return errorJson(500, "IO_FAIL", "服务器处理失败，请稍后重试。");
  }
}
