import { NextResponse } from "next/server";
import {
  deleteUploadByHash,
  listUploads,
} from "@/lib/uploads/manager";

export const runtime = "nodejs";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

export async function GET() {
  try {
    const files = await listUploads();
    return NextResponse.json({ ok: true, files });
  } catch (err) {
    console.error("GET /api/uploads failed", err);
    return errorJson(500, "IO_FAIL", "Failed to list uploads.");
  }
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileHash = (searchParams.get("fileHash") || "").trim();
  if (!fileHash) {
    return errorJson(400, "BAD_REQUEST", "fileHash is required.");
  }

  try {
    const result = await deleteUploadByHash(fileHash);
    if (!result.ok) {
      const status = result.error.code === "NOT_FOUND" ? 404 : 400;
      return errorJson(status, result.error.code, result.error.message);
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error("DELETE /api/uploads failed", err);
    return errorJson(500, "IO_FAIL", "Failed to delete upload.");
  }
}
