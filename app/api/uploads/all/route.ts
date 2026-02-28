import { NextResponse } from "next/server";
import { deleteAllUploads } from "@/lib/uploads/manager";

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
    const result = await deleteAllUploads();
    return NextResponse.json(result);
  } catch (err) {
    console.error("DELETE /api/uploads/all failed", err);
    return errorJson(500, "IO_FAIL", "Failed to delete all uploads.");
  }
}
