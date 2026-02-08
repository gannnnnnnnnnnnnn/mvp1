/**
 * Route: GET /api/files
 * Returns all stored metadata in reverse chronological order.
 */
import { NextResponse } from "next/server";
import { readIndex } from "@/lib/fileStore";

const API_TOKEN = process.env.API_TOKEN;

function isAuthorized(request: Request) {
  if (!API_TOKEN) return true;
  return request.headers.get("x-api-token") === API_TOKEN;
}

export async function GET(request: Request) {
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
    const files = await readIndex();
    // Sort newest first to match UX expectation.
    const sorted = [...files].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    const sanitized = sorted.map(
      ({ id, originalName, size, mimeType, uploadedAt }) => ({
        id,
        originalName,
        size,
        mimeType,
        uploadedAt,
      })
    );
    return NextResponse.json({ ok: true, files: sanitized });
  } catch (err) {
    console.error("List files error", err);
    return NextResponse.json(
      {
        ok: false,
        error: { code: "SERVER_ERROR", message: "读取文件列表失败。" },
      },
      { status: 500 }
    );
  }
}
