import { NextResponse } from "next/server";
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

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom: (searchParams.get("dateFrom") || "").trim() || undefined,
      dateTo: (searchParams.get("dateTo") || "").trim() || undefined,
    });

    const unknown = result.transactions.filter(
      (tx) => tx.category === "Other" && tx.categorySource === "default"
    );

    const grouped = new Map<
      string,
      {
        merchantNorm: string;
        displayName: string;
        txCount: number;
        totalSpend: number;
        lastDate: string;
        sampleTransactions: Array<{
          id: string;
          date: string;
          amount: number;
          descriptionRaw: string;
          fileId: string;
        }>;
      }
    >();

    for (const tx of unknown) {
      const key = tx.merchantNorm;
      const current = grouped.get(key) || {
        merchantNorm: key,
        displayName: key,
        txCount: 0,
        totalSpend: 0,
        lastDate: tx.date.slice(0, 10),
        sampleTransactions: [],
      };

      current.txCount += 1;
      if (tx.amount < 0) {
        current.totalSpend += Math.abs(tx.amount);
      }
      if (tx.date.slice(0, 10) > current.lastDate) {
        current.lastDate = tx.date.slice(0, 10);
      }

      if (current.sampleTransactions.length < 5) {
        current.sampleTransactions.push({
          id: tx.id,
          date: tx.date.slice(0, 10),
          amount: tx.amount,
          descriptionRaw: tx.descriptionRaw,
          fileId: tx.source.fileId,
        });
      }

      grouped.set(key, current);
    }

    const merchants = [...grouped.values()].sort((a, b) => b.totalSpend - a.totalSpend);

    return NextResponse.json({
      ok: true,
      fileId: result.fileId,
      fileIds: result.fileIds,
      filesIncludedCount: result.filesIncludedCount,
      appliedFilters: result.appliedFilters,
      unknownMerchants: merchants,
      unknownMerchantCount: merchants.length,
      unknownTransactionsCount: unknown.length,
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

    console.error("/api/analysis/triage/unknown-merchants failed", err);
    return errorJson(500, "IO_FAIL", "Failed to build unknown merchant triage list.");
  }
}
