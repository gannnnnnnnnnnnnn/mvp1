import { NextResponse } from "next/server";
import { deleteUploadByHash, listUploads } from "@/lib/uploads/manager";

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

export async function DELETE() {
  try {
    const files = await listUploads();
    if (files.length === 0) {
      return NextResponse.json({
        ok: true,
        total: 0,
        deletedCount: 0,
        errors: [],
      });
    }

    const errors: Array<{ fileHash: string; code: string; message: string }> = [];
    let deletedCount = 0;

    for (const file of files) {
      const result = await deleteUploadByHash(file.fileHash);
      if (!result.ok) {
        errors.push({
          fileHash: file.fileHash,
          code: result.error.code,
          message: result.error.message,
        });
        continue;
      }
      deletedCount += 1;
    }

    const ok = errors.length === 0;
    return NextResponse.json(
      {
        ok,
        total: files.length,
        deletedCount,
        errors,
      },
      { status: ok ? 200 : 207 }
    );
  } catch (err) {
    console.error("DELETE /api/uploads/all failed", err);
    return errorJson(500, "IO_FAIL", "Failed to delete all uploads.");
  }
}
