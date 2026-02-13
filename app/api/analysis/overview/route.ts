import { NextResponse } from "next/server";
import { buildOverview, Granularity, loadCategorizedTransactions } from "@/lib/analysis/analytics";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function parseGranularity(value: string | null): Granularity {
  return value === "week" ? "week" : "month";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = (searchParams.get("fileId") || "").trim();

  if (!fileId) {
    return errorJson(400, "BAD_REQUEST", "fileId is required.");
  }

  const granularity = parseGranularity(searchParams.get("granularity"));
  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;

  try {
    const result = await loadCategorizedTransactions({
      fileId,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom,
      dateTo,
      granularity,
    });

    const overview = buildOverview({
      transactions: result.transactions,
      granularity,
      appliedFilters: result.appliedFilters,
    });

    return NextResponse.json({
      ok: true,
      fileId,
      accountId: result.accountId,
      granularity,
      templateType: result.templateType,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: {
        ...result.appliedFilters,
        granularity,
      },
      warnings: result.warnings,
      txCount: result.transactions.length,
      ...overview,
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

    console.error("/api/analysis/overview failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build analysis overview.");
  }
}
