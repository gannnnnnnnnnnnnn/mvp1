import { NextResponse } from "next/server";
import {
  buildPeriodComparison,
  CompareGranularity,
  loadCategorizedTransactionsForScope,
} from "@/lib/analysis/analytics";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function parseFileIds(searchParams: URLSearchParams) {
  const direct = searchParams.getAll("fileIds").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
  return [...new Set(direct)];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = (searchParams.get("fileId") || "").trim();
  const fileIds = parseFileIds(searchParams);
  const scopeRaw = (searchParams.get("scope") || "").trim();
  const scope = scopeRaw === "all" ? "all" : fileId ? "file" : fileIds.length > 0 ? "selected" : "service";
  const mode = (searchParams.get("mode") || "current_vs_previous").trim();
  const granularityRaw = (searchParams.get("granularity") || "month").trim();
  const granularity: CompareGranularity =
    granularityRaw === "quarter" || granularityRaw === "year" ? granularityRaw : "month";

  if (!fileId && fileIds.length === 0 && scope !== "all") {
    return errorJson(400, "BAD_REQUEST", "fileId or fileIds (or scope=all) is required.");
  }

  if (mode !== "current_vs_previous") {
    return errorJson(400, "BAD_REQUEST", "Only mode=current_vs_previous is supported.");
  }

  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom,
      dateTo,
    });

    const comparison = buildPeriodComparison({
      transactions: result.transactions,
      granularity,
    });

    return NextResponse.json({
      ok: true,
      fileId: result.fileId,
      fileIds: result.fileIds,
      filesIncludedCount: result.filesIncludedCount,
      txCountBeforeDedupe: result.txCountBeforeDedupe,
      dedupedCount: result.dedupedCount,
      accountId: result.accountId,
      mode,
      granularity,
      templateType: result.templateType,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: {
        ...result.appliedFilters,
        mode,
        granularity,
      },
      txCount: result.transactions.length,
      ...comparison,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_FILES_SELECTED") {
      return errorJson(400, "BAD_REQUEST", "No files selected for analysis.");
    }

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
