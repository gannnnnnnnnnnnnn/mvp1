import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { rejectIfProdApi } from "@/lib/devOnly";
import { patchMetadataById, readIndex } from "@/lib/fileStore";
import {
  extractCbaAccountMeta,
  resolveAccountIdFromMeta,
} from "@/lib/parsing/accountMeta";

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");

type RebuildFailure = {
  fileId: string;
  fileName: string;
  reason: string;
};

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status }
  );
}

export async function POST() {
  const blocked = rejectIfProdApi();
  if (blocked) return blocked;

  try {
    const rows = await readIndex();
    const cbaRows = rows.filter((row) => (row.bankId || "cba") === "cba");

    let updatedCount = 0;
    const failures: RebuildFailure[] = [];

    for (const row of cbaRows) {
      const textPath = path.join(TEXT_CACHE_DIR, `${row.id}.txt`);
      let text = "";
      try {
        text = await fs.readFile(textPath, "utf8");
      } catch {
        failures.push({
          fileId: row.id,
          fileName: row.originalName,
          reason: "TEXT_CACHE_MISSING",
        });
        continue;
      }

      try {
        const templateId =
          String(row.templateId || row.templateType || "").trim() ||
          "commbank_manual_amount_balance";
        const extracted = extractCbaAccountMeta({
          text,
          accountId: row.accountId || "default",
          templateId,
        });
        const resolvedAccountId = resolveAccountIdFromMeta({
          bankId: "cba",
          existingAccountId: row.accountId,
          accountMeta: extracted,
        });
        const accountMeta = {
          ...extracted,
          accountId: resolvedAccountId,
        };

        const patched = await patchMetadataById(row.id, {
          bankId: "cba",
          accountId: resolvedAccountId,
          templateId,
          templateType: row.templateType || templateId,
          accountMeta,
        });
        if (!patched) {
          failures.push({
            fileId: row.id,
            fileName: row.originalName,
            reason: "INDEX_PATCH_FAILED",
          });
          continue;
        }
        updatedCount += 1;
      } catch (err) {
        failures.push({
          fileId: row.id,
          fileName: row.originalName,
          reason: err instanceof Error ? err.message : "UNKNOWN_ERROR",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      updatedCount,
      failureCount: failures.length,
      failures,
    });
  } catch (err) {
    console.error("/api/dev/accounts/rebuild failed", err);
    return errorJson(500, "IO_FAIL", "Failed to rebuild account identity metadata.");
  }
}

