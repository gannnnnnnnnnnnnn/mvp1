import { NextResponse } from "next/server";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import { aggregateInboxItems, InboxKind } from "@/lib/analysis/inbox";
import { readInboxOverrides, readReviewState } from "@/lib/analysis/inboxStore";
import { isInboxItemSuppressedByRule } from "@/lib/analysis/inboxRules";
import { loadParsedTransactions } from "@/lib/analysis/loadParsed";

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
  const scope =
    scopeRaw === "all"
      ? "all"
      : scopeRaw === "service"
        ? "service"
        : fileId
          ? "file"
          : fileIds.length > 0
            ? "selected"
            : "all";

  try {
    const [loaded, reviewState, overrides] = await Promise.all([
      loadCategorizedTransactionsForScope({
        fileId,
        fileIds,
        scope,
        bankId: (searchParams.get("bankId") || "").trim() || undefined,
        accountId: (searchParams.get("accountId") || "").trim() || undefined,
        dateFrom: (searchParams.get("dateFrom") || "").trim() || undefined,
        dateTo: (searchParams.get("dateTo") || "").trim() || undefined,
        q: (searchParams.get("q") || "").trim() || undefined,
        showTransfers: "all",
      }),
      readReviewState(),
      readInboxOverrides(),
    ]);

    const parsedFiles = await Promise.all(
      loaded.fileIds.map(async (id) => loadParsedTransactions(id))
    );

    const aggregated = aggregateInboxItems({
      transactions: loaded.transactions,
      parsedFiles,
      resolvedIds: reviewState.resolved,
    });
    const visibleItems = aggregated.items.filter(
      (item) => !isInboxItemSuppressedByRule(item, overrides)
    );
    const suppressedByRule = aggregated.items.length - visibleItems.length;
    const visibleCounts: Record<InboxKind, number> = {
      UNKNOWN_MERCHANT: 0,
      UNCERTAIN_TRANSFER: 0,
      PARSE_ISSUE: 0,
    };
    for (const item of visibleItems) {
      visibleCounts[item.kind] += 1;
    }

    return NextResponse.json({
      ok: true,
      appliedFilters: loaded.appliedFilters,
      filesIncludedCount: loaded.filesIncludedCount,
      fileIds: loaded.fileIds,
      counts: visibleCounts,
      totals: {
        all: aggregated.totals.all,
        unresolved: visibleItems.length,
        resolved: aggregated.totals.resolved + suppressedByRule,
      },
      suppressedByRule,
      items: visibleItems,
      reviewState: {
        version: reviewState.version,
        resolvedCount: Object.keys(reviewState.resolved).length,
        updatedAt: reviewState.updatedAt,
      },
      overrides: {
        version: overrides.version,
        merchantRulesCount: Object.keys(overrides.merchantRules).length,
        transferRulesCount: Object.keys(overrides.transferRules).length,
        parseRulesCount: Object.keys(overrides.parseRules).length,
        updatedAt: overrides.updatedAt,
      },
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_FILES_SELECTED") {
      return errorJson(400, "BAD_REQUEST", "No files selected for inbox.");
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

    console.error("/api/analysis/inbox failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build review inbox.");
  }
}
