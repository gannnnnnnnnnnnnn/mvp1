import { NextResponse } from "next/server";
import { buildMonthComparison, loadCategorizedTransactions } from "@/lib/analysis/analytics";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = (searchParams.get("fileId") || "").trim();
  const mode = (searchParams.get("mode") || "month").trim();

  if (!fileId) {
    return errorJson(400, "BAD_REQUEST", "fileId is required.");
  }

  if (mode !== "month") {
    return errorJson(400, "BAD_REQUEST", "Only mode=month is supported in MVP.");
  }

  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;

  try {
    const result = await loadCategorizedTransactions({
      fileId,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom,
      dateTo,
    });

    const comparison = buildMonthComparison(result.transactions);

    return NextResponse.json({
      ok: true,
      fileId,
      accountId: result.accountId,
      mode,
      templateType: result.templateType,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: {
        ...result.appliedFilters,
        mode,
      },
      txCount: result.transactions.length,
      ...comparison,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "BAD_FILE_ID") {
      return errorJson(400, "BAD_REQUEST", "Invalid fileId format.");
    }

    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return errorJson(404, "NOT_FOUND", "Text cache not found. Run Extract Text first.");
    }

    console.error("/api/analysis/compare failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build comparison analysis.");
  }
}
