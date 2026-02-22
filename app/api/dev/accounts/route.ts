import { NextResponse } from "next/server";
import { rejectIfProdApi } from "@/lib/devOnly";
import { readIndex } from "@/lib/fileStore";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

export async function GET() {
  const blocked = rejectIfProdApi();
  if (blocked) return blocked;

  try {
    const rows = await readIndex();
    const accounts = rows
      .map((row) => ({
        fileId: row.id,
        fileName: row.originalName,
        uploadedAt: row.uploadedAt,
        bankId: row.bankId || "cba",
        templateId: row.templateId || row.templateType || "unknown",
        accountId: row.accountId || "default",
        accountMeta: {
          accountName: row.accountMeta?.accountName,
          bsb: row.accountMeta?.bsb,
          accountNumber: row.accountMeta?.accountNumber,
          accountKey: row.accountMeta?.accountKey,
          metaWarnings: row.accountMeta?.metaWarnings || [],
        },
      }))
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));

    return NextResponse.json({ ok: true, count: accounts.length, accounts });
  } catch (err) {
    console.error("/api/dev/accounts failed", err);
    return errorJson(500, "IO_FAIL", "Failed to load dev account identities.");
  }
}
