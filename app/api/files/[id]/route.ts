/**
 * Route: DELETE /api/files/[id]
 *
 * Phase 1.5 cleanup utility:
 * - delete one uploaded file
 * - delete its text-cache files
 * - remove metadata row from uploads/index.json atomically
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  findById,
  removeById,
  uploadsDirAbsolute,
} from "@/lib/fileStore";

const API_TOKEN = process.env.API_TOKEN;
const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

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
 * Build safe absolute path for stored upload file.
 * We only allow basename (no "../") and require final path under uploads root.
 */
function resolveSafeStoredPath(storedName: string) {
  const base = path.basename(storedName);
  if (base !== storedName) return null;

  const uploadsRoot = path.resolve(uploadsDirAbsolute);
  const resolved = path.resolve(uploadsRoot, base);
  if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  return resolved;
}

async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorized(request)) {
    return errorJson(401, "UNAUTHORIZED", "未授权访问。");
  }

  const { id } = await params;
  if (!FILE_ID_RE.test(id)) {
    return errorJson(400, "BAD_REQUEST", "fileId 格式非法。");
  }

  try {
    const meta = await findById(id);
    if (!meta) {
      return errorJson(404, "NOT_FOUND", "文件不存在或已被删除。");
    }

    const uploadPath = resolveSafeStoredPath(meta.storedName);
    if (!uploadPath) {
      return errorJson(400, "IO_FAIL", "文件路径非法，拒绝删除。");
    }

    // Delete binary + optional text cache files (ignore missing cache files).
    await unlinkIfExists(uploadPath);
    await unlinkIfExists(path.join(TEXT_CACHE_ROOT, `${id}.txt`));
    await unlinkIfExists(path.join(TEXT_CACHE_ROOT, `${id}.json`));

    // Remove metadata row atomically from index.json.
    const removed = await removeById(id);
    if (!removed) {
      // Extremely rare race: record disappeared between findById and removeById.
      return errorJson(404, "NOT_FOUND", "文件不存在或已被删除。");
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/files/[id] failed", err);
    return errorJson(500, "IO_FAIL", "删除文件失败，请稍后重试。");
  }
}
