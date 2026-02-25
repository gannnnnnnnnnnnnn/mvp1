import { NextResponse } from "next/server";
import { loadCategorizedTransactionsForScope } from "@/lib/analysis/analytics";
import { toCsv } from "@/lib/analysis/exportCsv";

type ExportType = "transactions" | "annual";
type ExportFormat = "csv";
type ShowTransfers = "all" | "excludeMatched" | "onlyMatched";

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

function parseType(value: string | null): ExportType | null {
  if (value === "transactions" || value === "annual") return value;
  return null;
}

function parseFormat(value: string | null): ExportFormat | null {
  if (value === "csv") return value;
  return null;
}

function parseShowTransfers(value: string | null): ShowTransfers {
  if (value === "all" || value === "onlyMatched") return value;
  return "excludeMatched";
}

function csvResponse(filename: string, csv: string) {
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const type = parseType(searchParams.get("type"));
  const format = parseFormat(searchParams.get("format"));
  if (!type) {
    return errorJson(400, "BAD_REQUEST", "type must be transactions or annual.");
  }
  if (!format) {
    return errorJson(400, "BAD_REQUEST", "format must be csv.");
  }

  const fileId = (searchParams.get("fileId") || "").trim();
  const fileIds = parseFileIds(searchParams);
  const scopeRaw = (searchParams.get("scope") || "").trim();
  const scope = scopeRaw === "all" ? "all" : fileId ? "file" : fileIds.length > 0 ? "selected" : "all";

  const showTransfers = parseShowTransfers(searchParams.get("showTransfers"));

  try {
    const result = await loadCategorizedTransactionsForScope({
      fileId,
      fileIds,
      scope,
      bankId: (searchParams.get("bankId") || "").trim() || undefined,
      accountId: (searchParams.get("accountId") || "").trim() || undefined,
      dateFrom: (searchParams.get("dateFrom") || "").trim() || undefined,
      dateTo: (searchParams.get("dateTo") || "").trim() || undefined,
      q: (searchParams.get("q") || "").trim() || undefined,
      showTransfers,
    });

    if (type === "transactions") {
      const rows = [
        [
          "date",
          "bankId",
          "accountId",
          "fileId",
          "transactionId",
          "category",
          "categorySource",
          "merchantNorm",
          "description",
          "amount",
          "balance",
          "transferState",
          "transferDecision",
          "transferKpiEffect",
          "transferMatchId",
          "transferConfidence",
        ],
        ...result.transactions.map((tx) => [
          tx.date,
          tx.bankId,
          tx.accountId,
          tx.source.fileId,
          tx.id,
          tx.category,
          tx.categorySource,
          tx.merchantNorm,
          tx.descriptionRaw,
          tx.amount,
          tx.balance ?? "",
          tx.transfer?.state ?? "",
          tx.transfer?.decision ?? "",
          tx.transfer?.kpiEffect ?? "",
          tx.transfer?.matchId ?? "",
          tx.transfer?.confidence ?? "",
        ]),
      ];
      const csv = toCsv(rows);
      const dateTag = new Date().toISOString().slice(0, 10);
      return csvResponse(`transactions-${dateTag}.csv`, csv);
    }

    const yearRaw = (searchParams.get("year") || "").trim();
    const targetYear =
      /^\d{4}$/.test(yearRaw)
        ? yearRaw
        : [...(result.availableYears || [])].sort().at(-1) || new Date().getUTCFullYear().toString();
    const inYear = result.transactions.filter((tx) => tx.date.slice(0, 4) === targetYear);
    const byCategory = new Map<string, { inflow: number; outflow: number; net: number }>();

    for (const tx of inYear) {
      const bucket = byCategory.get(tx.category) || { inflow: 0, outflow: 0, net: 0 };
      if (tx.amount > 0) bucket.inflow += tx.amount;
      if (tx.amount < 0) bucket.outflow += Math.abs(tx.amount);
      bucket.net += tx.amount;
      byCategory.set(tx.category, bucket);
    }

    const rows = [
      ["year", "category", "inflow", "outflow", "net"],
      ...[...byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, bucket]) => [
          targetYear,
          category,
          Number(bucket.inflow.toFixed(2)),
          Number(bucket.outflow.toFixed(2)),
          Number(bucket.net.toFixed(2)),
        ]),
    ];
    const csv = toCsv(rows);
    return csvResponse(`annual-summary-${targetYear}.csv`, csv);
  } catch (err: unknown) {
    if (err instanceof Error && err.message === "NO_FILES_SELECTED") {
      return errorJson(400, "BAD_REQUEST", "No files selected for export.");
    }
    if (err instanceof Error && err.message === "BAD_FILE_ID") {
      return errorJson(400, "BAD_REQUEST", "Invalid fileId format.");
    }
    console.error("/api/analysis/export failed", err);
    return errorJson(500, "IO_FAIL", "Failed to export analysis CSV.");
  }
}

