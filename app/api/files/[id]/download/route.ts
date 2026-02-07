/**
 * Route: GET /api/files/[id]/download
 * Streams the binary back with a content-disposition attachment header.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { findById, uploadsDirAbsolute } from "@/lib/fileStore";

export async function GET(
  _request: Request,
  /**
   * In newer Next.js versions, `params` can be delivered asynchronously.
   * If you access it synchronously (like `params.id`), Next will throw:
   * "params is a Promise and must be unwrapped with await/React.use()".
   *
   * Route Handlers run on the server, so `await params` is the simplest fix.
   */
  { params }: { params: Promise<{ id: string }> }
) {
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

    const absolutePath = path.join(uploadsDirAbsolute, meta.storedName);

    try {
      const data = await fs.readFile(absolutePath);
      return new NextResponse(data, {
        headers: {
          "Content-Type": meta.mimeType || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${encodeURIComponent(
            meta.originalName
          )}"`,
        },
      });
    } catch (readErr: any) {
      if (readErr?.code === "ENOENT") {
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
