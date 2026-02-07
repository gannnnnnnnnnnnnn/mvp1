/**
 * Route: GET /api/files
 * Returns all stored metadata in reverse chronological order.
 */
import { NextResponse } from "next/server";
import { readIndex } from "@/lib/fileStore";

export async function GET() {
  try {
    const files = await readIndex();
    // Sort newest first to match UX expectation.
    const sorted = [...files].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );
    return NextResponse.json({ ok: true, files: sorted });
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
