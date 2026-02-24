import { NextResponse } from "next/server";
import {
  buildOverview,
  Granularity,
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

function parseGranularity(value: string | null): Granularity {
  return value === "week" ? "week" : "month";
}

function parseShowTransfers(value: string | null): "all" | "excludeMatched" | "onlyMatched" {
  if (value === "all" || value === "onlyMatched") return value;
  return "excludeMatched";
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

  if (!fileId && fileIds.length === 0 && scope !== "all") {
    return errorJson(400, "BAD_REQUEST", "fileId or fileIds (or scope=all) is required.");
  }

  const granularity = parseGranularity(searchParams.get("granularity"));
  const showTransfers = parseShowTransfers(searchParams.get("showTransfers"));
  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      bankId: (searchParams.get("bankId") || "").trim() || undefined,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom,
      dateTo,
      granularity,
      showTransfers,
    });

    const overview = buildOverview({
      transactions: result.transactions,
      granularity,
      appliedFilters: result.appliedFilters,
    });

    return NextResponse.json({
      ok: true,
      fileId: result.fileId,
      fileIds: result.fileIds,
      filesIncludedCount: result.filesIncludedCount,
      txCountBeforeDedupe: result.txCountBeforeDedupe,
      dedupedCount: result.dedupedCount,
      datasetDateMin: result.datasetDateMin,
      datasetDateMax: result.datasetDateMax,
      availableMonths: result.availableMonths,
      availableQuarters: result.availableQuarters,
      availableYears: result.availableYears,
      bankIds: result.bankIds,
      bankId: result.bankId,
      accountIds: result.accountIds,
      accountId: result.accountId,
      accountDisplayOptions: result.accountDisplayOptions,
      granularity,
      templateType: result.templateType,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: {
        ...result.appliedFilters,
        granularity,
        showTransfers,
      },
      warnings: result.warnings,
      txCount: result.transactions.length,
      transferStats: result.transferStats,
      balanceSeriesDisabledReason:
        result.appliedFilters.balanceScope === "none"
          ? "Balance curve is disabled for mixed multi-file scope. Pick a single file/account."
          : undefined,
      ...overview,
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

    console.error("/api/analysis/overview failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build analysis overview.");
  }
}
