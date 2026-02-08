/**
 * Route: GET /api/files/[id]/download
 * Streams the binary back with a content-disposition attachment header.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { findById, uploadsDirAbsolute } from "@/lib/fileStore";

const API_TOKEN = process.env.API_TOKEN;

function isAuthorized(request: Request) {
  if (!API_TOKEN) return true;
  return request.headers.get("x-api-token") === API_TOKEN;
}

function hasErrnoCode(err: unknown, code: string) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

function resolveSafeStoredPath(storedName: string) {
  const base = path.basename(storedName);
  if (base !== storedName) return null;

  const uploadsRoot = path.resolve(uploadsDirAbsolute);
  const resolved = path.resolve(uploadsRoot, base);
  if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) return null;
  return resolved;
}

function buildContentDisposition(originalName: string) {
  const fallback =
    originalName
      .replace(/[\r\n"]/g, "_")
      .replace(/[^\x20-\x7E]/g, "_")
      .trim() || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(
    originalName
  )}`;
}

export async function GET(
  request: Request,
  /**
   * In newer Next.js versions, `params` can be delivered asynchronously.
   * If you access it synchronously (like `params.id`), Next will throw:
   * "params is a Promise and must be unwrapped with await/React.use()".
   *
   * Route Handlers run on the server, so `await params` is the simplest fix.
   */
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isAuthorized(request)) {
    return NextResponse.json(
      {
        ok: false,
        error: { code: "UNAUTHORIZED", message: "未授权访问。" },
      },
      { status: 401 }
    );
  }

  try {
    // IMPORTANT: unwrap params before accessing its properties.
    const { id } = await params;
    const meta = await findById(id);

    if (!meta) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "文件未找到。" } },
        { status: 404 }
      );
    }

    const absolutePath = resolveSafeStoredPath(meta.storedName);
    if (!absolutePath) {
      return NextResponse.json(
        { ok: false, error: { code: "INVALID_PATH", message: "非法文件路径。" } },
        { status: 400 }
      );
    }

    try {
      const data = await fs.readFile(absolutePath);
      return new NextResponse(data, {
        headers: {
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Content-Disposition": buildContentDisposition(meta.originalName),
        },
      });
    } catch (readErr: unknown) {
      if (hasErrnoCode(readErr, "ENOENT")) {
        return NextResponse.json(
          { ok: false, error: { code: "NOT_FOUND", message: "文件已丢失。" } },
          { status: 404 }
        );
      }
      throw readErr;
    }
  } catch (err) {
    console.error("Download error", err);
    return NextResponse.json(
      { ok: false, error: { code: "SERVER_ERROR", message: "下载失败。" } },
      { status: 500 }
    );
  }
}
