/**
 * Route: POST /api/upload
 * Receives multipart/form-data (field name: "file"), validates, writes file to
 * /uploads, and stores metadata in uploads/index.json.
 *
 * This handler is intentionally verbose with comments to serve as a reference
 * for how to handle file uploads in the Next.js App Router using Node APIs.
 */
import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import {
  appendMetadataDedupByHash,
  ensureUploadsDir,
  FileMeta,
  findByContentHash,
  uploadsDirAbsolute,
} from "@/lib/fileStore";

// Hard limits to protect the server.
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB
const ALLOWED_EXT = [".pdf", ".csv"];
const CSV_MIME = ["text/csv", "application/vnd.ms-excel"];

/**
 * Convert a Web File (from request.formData()) to a Node.js Buffer.
 */
async function fileToBuffer(file: File): Promise<Buffer> {
  const arrayBuffer = await file.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Ensure the file is either PDF or CSV based on MIME type or extension.
 */
function isAllowedType(file: File) {
  const ext = path.extname(file.name || "").toLowerCase();
  const extOk = ALLOWED_EXT.includes(ext);
  if (!extOk) return false;

  // Some clients may not send MIME for local files; keep extension as baseline.
  if (!file.type) return true;

  if (ext === ".pdf") return file.type === "application/pdf";
  if (ext === ".csv") return CSV_MIME.includes(file.type);
  return false;
}

/**
 * Build the stored filename. We keep extension to help later downloads.
 */
function buildStoredName(file: File, id: string) {
  const ext = path.extname(file.name || "").toLowerCase();
  return `${id}${ext || ""}`;
}

/**
 * Shape the metadata to be returned to the frontend.
 */
function buildMetadata(params: {
  file: File;
  id: string;
  storedName: string;
  relativePath: string;
  contentHash: string;
}): FileMeta {
  return {
    id: params.id,
    originalName: params.file.name,
    storedName: params.storedName,
    size: params.file.size,
    mimeType: params.file.type || "application/octet-stream",
    uploadedAt: new Date().toISOString(),
    path: params.relativePath,
    contentHash: params.contentHash,
  };
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: { code: "NO_FILE", message: "请选择一个文件上传。" } },
        { status: 400 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "FILE_TOO_LARGE", message: "文件大小不得超过 20MB。" },
        },
        { status: 413 }
      );
    }

    if (!isAllowedType(file)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "INVALID_TYPE",
            message: "仅支持 PDF 或 CSV 文件。",
          },
        },
        { status: 400 }
      );
    }

    // Ensure destination folder exists.
    await ensureUploadsDir();

    // Build identifiers and paths.
    const id = randomUUID();
    const storedName = buildStoredName(file, id);
    const relativePath = path.posix.join("uploads", storedName);
    const absolutePath = path.join(uploadsDirAbsolute, storedName);

    // Write the file to disk.
    const buffer = await fileToBuffer(file);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const existing = await findByContentHash(contentHash);
    if (existing) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "DUPLICATE_FILE",
            message: "File already uploaded.",
          },
        },
        { status: 409 }
      );
    }

    await fs.writeFile(absolutePath, buffer);

    // Build and persist metadata (write temp then rename inside appendMetadata).
    const metadata = buildMetadata({
      file,
      id,
      storedName,
      relativePath,
      contentHash,
    });
    try {
      const dedupResult = await appendMetadataDedupByHash(metadata);
      if (dedupResult.duplicate) {
        await fs.unlink(absolutePath).catch(() => undefined);
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "DUPLICATE_FILE",
              message: "File already uploaded.",
            },
          },
          { status: 409 }
        );
      }
    } catch {
      // Keep file/index consistency if metadata write fails.
      await fs.unlink(absolutePath).catch(() => undefined);
      throw new Error("metadata_write_failed");
    }

    return NextResponse.json({ ok: true, file: metadata });
  } catch (err: unknown) {
    console.error("Upload failed", err);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "SERVER_ERROR",
          message: "服务器处理上传时出现问题，请稍后重试。",
        },
      },
      { status: 500 }
    );
  }
}
