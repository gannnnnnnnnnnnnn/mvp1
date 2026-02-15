import { NextResponse } from "next/server";
import { rejectIfProdApi } from "@/lib/devOnly";
import { filterInspectorRows, runTransferInspector } from "@/app/api/dev/transfers/_lib";

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
    const { scope, params, result } = await runTransferInspector(searchParams);
    const rows = filterInspectorRows(result, searchParams);

    return NextResponse.json({
      ok: true,
      scope,
      params: {
        ...params,
        state: (searchParams.get("state") || "all").trim() || "all",
        amountCents: (searchParams.get("amountCents") || "").trim() || undefined,
        q: (searchParams.get("q") || "").trim() || undefined,
        limit: Number(searchParams.get("limit") || "200"),
      },
      rows,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_FILES_SELECTED") {
      return errorJson(400, "BAD_REQUEST", "No files selected for transfer inspector.");
    }
    console.error("/api/dev/transfers/matches failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build transfer matches payload.");
  }
}
