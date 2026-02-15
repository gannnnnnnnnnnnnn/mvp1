import { NextResponse } from "next/server";
import { CATEGORY_TAXONOMY } from "@/lib/analysis/types";
import {
  buildExplicitPeriodComparison,
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

function isCategory(value: string) {
  return CATEGORY_TAXONOMY.includes(value as (typeof CATEGORY_TAXONOMY)[number]);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fileId = (searchParams.get("fileId") || "").trim();
  const fileIds = parseFileIds(searchParams);
  const scopeRaw = (searchParams.get("scope") || "").trim();
  const scope = scopeRaw === "all" ? "all" : fileId ? "file" : fileIds.length > 0 ? "selected" : "service";
  const periodAStart = (searchParams.get("periodAStart") || "").trim();
  const periodAEnd = (searchParams.get("periodAEnd") || "").trim();
  const periodBStart = (searchParams.get("periodBStart") || "").trim();
  const periodBEnd = (searchParams.get("periodBEnd") || "").trim();

  if (!fileId && fileIds.length === 0 && scope !== "all") {
    return errorJson(400, "BAD_REQUEST", "fileId or fileIds (or scope=all) is required.");
  }

  if (!periodAStart || !periodAEnd || !periodBStart || !periodBEnd) {
    return errorJson(
      400,
      "BAD_REQUEST",
      "periodAStart, periodAEnd, periodBStart, periodBEnd are required."
    );
  }

  const q = (searchParams.get("q") || "").trim() || undefined;
  const categoryRaw = (searchParams.get("category") || "").trim() || undefined;
  if (categoryRaw && !isCategory(categoryRaw)) {
    return errorJson(400, "BAD_REQUEST", `Unsupported category: ${categoryRaw}`);
  }

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      bankId: (searchParams.get("bankId") || "").trim() || undefined,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      q,
      category: categoryRaw as (typeof CATEGORY_TAXONOMY)[number] | undefined,
    });

    const comparison = buildExplicitPeriodComparison({
      transactions: result.transactions,
      periodAStart,
      periodAEnd,
      periodBStart,
      periodBEnd,
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
      templateType: result.templateType,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: {
        ...result.appliedFilters,
        periodAStart,
        periodAEnd,
        periodBStart,
        periodBEnd,
        q,
        category: categoryRaw,
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
