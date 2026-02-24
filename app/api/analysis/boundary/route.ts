import { NextResponse } from "next/server";
import { readBoundaryConfig, writeBoundaryConfig } from "@/lib/boundary/store";
import { readIndex } from "@/lib/fileStore";

type KnownAccountRow = {
  bankId: string;
  accountId: string;
  accountName?: string;
  accountKey?: string;
  bsb?: string;
  accountNumber?: string;
  fileCount: number;
  dateRange?: { from: string; to: string };
};

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function buildKnownAccounts(indexRows: Awaited<ReturnType<typeof readIndex>>): KnownAccountRow[] {
  const byKey = new Map<
    string,
    {
      bankId: string;
      accountId: string;
      accountName?: string;
      accountKey?: string;
      bsb?: string;
      accountNumber?: string;
      fileCount: number;
      minUploadedAt: string;
      maxUploadedAt: string;
    }
  >();

  for (const row of indexRows) {
    const bankId = row.bankId || "cba";
    const accountId = row.accountId || "default";
    const key = `${bankId}|${accountId}`;
    const uploadedAt = row.uploadedAt || "";

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        bankId,
        accountId,
        accountName: row.accountMeta?.accountName,
        accountKey: row.accountMeta?.accountKey,
        bsb: row.accountMeta?.bsb,
        accountNumber: row.accountMeta?.accountNumber,
        fileCount: 1,
        minUploadedAt: uploadedAt,
        maxUploadedAt: uploadedAt,
      });
      continue;
    }

    existing.fileCount += 1;
    existing.accountName = existing.accountName || row.accountMeta?.accountName;
    existing.accountKey = existing.accountKey || row.accountMeta?.accountKey;
    existing.bsb = existing.bsb || row.accountMeta?.bsb;
    existing.accountNumber = existing.accountNumber || row.accountMeta?.accountNumber;
    if (uploadedAt && (!existing.minUploadedAt || uploadedAt < existing.minUploadedAt)) {
      existing.minUploadedAt = uploadedAt;
    }
    if (uploadedAt && (!existing.maxUploadedAt || uploadedAt > existing.maxUploadedAt)) {
      existing.maxUploadedAt = uploadedAt;
    }
  }

  return [...byKey.values()]
    .map((item) => ({
      bankId: item.bankId,
      accountId: item.accountId,
      accountName: item.accountName,
      accountKey: item.accountKey,
      bsb: item.bsb,
      accountNumber: item.accountNumber,
      fileCount: item.fileCount,
      dateRange:
        item.minUploadedAt && item.maxUploadedAt
          ? {
              from: item.minUploadedAt.slice(0, 10),
              to: item.maxUploadedAt.slice(0, 10),
            }
          : undefined,
    }))
    .sort((a, b) => {
      const bankDiff = a.bankId.localeCompare(b.bankId);
      if (bankDiff !== 0) return bankDiff;
      return a.accountId.localeCompare(b.accountId);
    });
}

async function loadBoundaryPayload() {
  const indexRows = await readIndex();
  const knownAccounts = buildKnownAccounts(indexRows);
  const knownAccountIds = [...new Set(knownAccounts.map((item) => item.accountId))];
  const { config, exists } = await readBoundaryConfig(knownAccountIds);
  const persistedConfig = exists
    ? config
    : await writeBoundaryConfig({ boundaryAccountIds: config.boundaryAccountIds });

  return {
    config: persistedConfig,
    knownAccounts,
    needsSetup: !exists || persistedConfig.boundaryAccountIds.length === 0,
  };
}

export async function GET() {
  try {
    const payload = await loadBoundaryPayload();
    return NextResponse.json({ ok: true, ...payload });
  } catch (err) {
    console.error("/api/analysis/boundary GET failed", err);
    return errorJson(500, "IO_FAIL", "Failed to load boundary configuration.");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      boundaryAccountIds?: unknown;
      accountAliases?: unknown;
    };
    if (!Array.isArray(body?.boundaryAccountIds)) {
      return errorJson(400, "BAD_REQUEST", "boundaryAccountIds must be an array.");
    }

    const boundaryAccountIds = body.boundaryAccountIds
      .map((id) => String(id || "").trim())
      .filter(Boolean);
    const accountAliases =
      typeof body.accountAliases === "object" &&
      body.accountAliases !== null &&
      !Array.isArray(body.accountAliases)
        ? Object.fromEntries(
            Object.entries(body.accountAliases).map(([key, value]) => [
              String(key || "").trim(),
              String(value || "").trim(),
            ])
          )
        : {};

    const nextConfig = await writeBoundaryConfig({
      boundaryAccountIds,
      accountAliases,
    });

    const indexRows = await readIndex();
    const knownAccounts = buildKnownAccounts(indexRows);
    return NextResponse.json({
      ok: true,
      config: nextConfig,
      knownAccounts,
      needsSetup: nextConfig.boundaryAccountIds.length === 0,
    });
  } catch (err) {
    console.error("/api/analysis/boundary POST failed", err);
    return errorJson(500, "IO_FAIL", "Failed to save boundary configuration.");
  }
}
