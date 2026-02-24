import { NextResponse } from "next/server";
import { rejectIfProdApi } from "@/lib/devOnly";
import { runTransferInspector } from "@/app/api/dev/transfers/_lib";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

export async function GET(request: Request) {
  const blocked = rejectIfProdApi();
  if (blocked) return blocked;

  try {
    const { searchParams } = new URL(request.url);
    const { scope, params, boundary, loaded, result } = await runTransferInspector(searchParams);

    return NextResponse.json({
      ok: true,
      scope,
      params,
      boundary,
      options: {
        bankIds: loaded.bankIds || [],
        accountIds: loaded.accountIds || [],
      },
      stats: result.stats,
      decisionStats: result.decisionStats,
      diagnostics: result.diagnostics,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_FILES_SELECTED") {
      return errorJson(400, "BAD_REQUEST", "No files selected for transfer inspector.");
    }
    console.error("/api/dev/transfers/summary failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build transfer summary.");
  }
}
