/**
 * Route: POST /api/files/clear
 *
 * Protected bulk cleanup operation.
 * Caller must provide { confirm: "DELETE" }.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  readIndex,
  replaceIndex,
  uploadsDirAbsolute,
} from "@/lib/fileStore";

const API_TOKEN = process.env.API_TOKEN;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");
const INDEX_BASENAME = "index.json";

type ClearRequest = {
  confirm: string;
};

function isAuthorized(request: Request) {
  if (!API_TOKEN) return true;
  return request.headers.get("x-api-token") === API_TOKEN;
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

/**
 * Delete file path if present; ignore ENOENT for idempotent cleanup.
 */
async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

/**
 * Delete all cache files inside uploads/text-cache while preserving the folder.
 */
async function clearTextCacheDir() {
  await fs.mkdir(TEXT_CACHE_ROOT, { recursive: true });
  const entries = await fs.readdir(TEXT_CACHE_ROOT, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(TEXT_CACHE_ROOT, entry.name);
    if (entry.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await unlinkIfExists(fullPath);
    }
  }
}

/**
 * Safety net: remove leftover binary files directly under uploads/.
 * We explicitly keep index.json and text-cache folder structure.
 */
async function clearDanglingUploads() {
  await fs.mkdir(uploadsDirAbsolute, { recursive: true });
  const entries = await fs.readdir(uploadsDirAbsolute, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(uploadsDirAbsolute, entry.name);
    if (entry.name === INDEX_BASENAME) continue;
    if (entry.name === "text-cache") continue;
    if (entry.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
      continue;
    }
    await unlinkIfExists(fullPath);
  }
}

/**
 * Resolve upload path under uploads root safely.
 */
function resolveSafeStoredPath(storedName: string) {
  const base = path.basename(storedName);
  if (base !== storedName) return null;

  const uploadsRoot = path.resolve(uploadsDirAbsolute);
  const resolved = path.resolve(uploadsRoot, base);
  if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  return resolved;
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return errorJson(401, "UNAUTHORIZED", "未授权访问。");
  }

  let body: ClearRequest | null = null;
  try {
    const raw = (await request.json()) as Record<string, unknown>;
    if (typeof raw.confirm === "string") {
      body = { confirm: raw.confirm };
    }
  } catch {
    return errorJson(400, "BAD_REQUEST", "请求体读取失败，请传入 JSON。");
  }

  if (!body || body.confirm !== "DELETE") {
    return errorJson(
      400,
      "BAD_REQUEST",
      "确认口令错误，请传入 { confirm: \"DELETE\" }。"
    );
  }

  try {
    const records = await readIndex();

    // Delete each indexed upload file first.
    for (const record of records) {
      const uploadPath = resolveSafeStoredPath(record.storedName);
      if (!uploadPath) continue;
      await unlinkIfExists(uploadPath);
    }

    // Clear all text-cache files.
    await clearTextCacheDir();
    await clearDanglingUploads();

    // Atomically reset index to empty array.
    await fs.mkdir(uploadsDirAbsolute, { recursive: true });
    await replaceIndex([]);

    return NextResponse.json({ ok: true, deletedCount: records.length });
  } catch (err) {
    console.error("POST /api/files/clear failed", err);
    return errorJson(500, "IO_FAIL", "清空文件失败，请稍后重试。");
  }
}
