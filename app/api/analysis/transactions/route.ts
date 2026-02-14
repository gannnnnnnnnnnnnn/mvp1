import { NextResponse } from "next/server";
import { CATEGORY_TAXONOMY } from "@/lib/analysis/types";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function isCategory(value: string) {
  return CATEGORY_TAXONOMY.includes(value as (typeof CATEGORY_TAXONOMY)[number]);
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

  const dateFrom = (searchParams.get("dateFrom") || "").trim() || undefined;
  const dateTo = (searchParams.get("dateTo") || "").trim() || undefined;
  const q = (searchParams.get("q") || "").trim() || undefined;

  const categoryRaw = (searchParams.get("category") || "").trim();
  const category = categoryRaw ? categoryRaw : undefined;
  if (category && !isCategory(category)) {
    return errorJson(400, "BAD_REQUEST", `Unsupported category: ${category}`);
  }

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom,
      dateTo,
      q,
      category: category as (typeof CATEGORY_TAXONOMY)[number] | undefined,
    });

    return NextResponse.json({
      ok: true,
      fileId: result.fileId,
      fileIds: result.fileIds,
      filesIncludedCount: result.filesIncludedCount,
      txCountBeforeDedupe: result.txCountBeforeDedupe,
      dedupedCount: result.dedupedCount,
      templateType: result.templateType,
      accountId: result.accountId,
      needsReview: result.needsReview,
      quality: result.quality,
      appliedFilters: result.appliedFilters,
      warnings: result.warnings,
      transactions: result.transactions,
      totalTransactions: result.transactions.length,
      allTransactionsCount: result.allTransactions.length,
      categories: CATEGORY_TAXONOMY,
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

    console.error("/api/analysis/transactions failed", err);
    return errorJson(500, "IO_FAIL", "Failed to load categorized transactions.");
  }
}
