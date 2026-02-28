import { promises as fs } from "fs";
import path from "path";
import {
  FileMeta,
  readIndex,
  removeById,
  replaceIndex,
  uploadsDirAbsolute,
} from "@/lib/fileStore";
import {
  readReviewState,
  writeReviewState,
  type InboxReviewState,
} from "@/lib/analysis/inboxStore";
import {
  readBoundaryConfig,
  type BoundaryConfig,
} from "@/lib/boundary/store";
import {
  readUploadManifest,
  removeManifestByHash,
  replaceUploadManifest,
  type UploadManifest,
  type UploadManifestFile,
} from "@/lib/uploads/manifestStore";

export type UploadParseStage = "uploaded" | "extracted" | "segmented" | "parsed";
export type UploadWarning = {
  code: string;
  message?: string;
  meta?: Record<string, unknown>;
};

export type UploadListItem = {
  fileHash: string;
  fileId: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  bankId?: string;
  accountIds: string[];
  templateId?: string;
  warnings: UploadWarning[];
  parseStatus: {
    stage: UploadParseStage;
    txCount?: number;
    warnings?: number;
    needsReview?: boolean;
  };
};

export type DeleteUploadResult =
  | {
      ok: true;
      deleted: UploadListItem;
      reviewStatePrunedCount: number;
      boundaryWarning: {
        missingAccountIds: string[];
        message: string;
      } | null;
    }
  | {
      ok: false;
      error: { code: string; message: string };
    };

type ManagerOptions = {
  uploadsRoot?: string;
  readIndexFn?: () => Promise<FileMeta[]>;
  removeByIdFn?: (id: string) => Promise<FileMeta | undefined>;
  replaceIndexFn?: (entries: FileMeta[]) => Promise<void>;
  readManifestFn?: () => Promise<UploadManifest>;
  removeManifestByHashFn?: (fileHash: string) => Promise<UploadManifestFile | undefined>;
  replaceManifestFn?: (files: UploadManifestFile[]) => Promise<UploadManifest>;
  readReviewStateFn?: () => Promise<InboxReviewState>;
  writeReviewStateFn?: (
    next: Omit<InboxReviewState, "version">
  ) => Promise<InboxReviewState>;
  readBoundaryConfigFn?: (
    knownAccountIds: string[]
  ) => Promise<{ config: BoundaryConfig; exists: boolean }>;
};

const TRANSFER_CACHE_DIR = "transfer-cache";
const ANALYSIS_CACHE_DIR = "analysis-cache";
const DERIVED_DIRS = [
  "text-cache",
  "segment-cache",
  "parsed-cache",
  "dev-runs",
  ANALYSIS_CACHE_DIR,
  TRANSFER_CACHE_DIR,
];

function hasErrnoCode(err: unknown, code: string) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

async function rmDirIfExists(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return;
    throw err;
  }
}

function sanitizeDirSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function resolveSafeUploadPath(uploadsRoot: string, storedName: string) {
  const base = path.basename(storedName);
  if (base !== storedName) return null;

  const root = path.resolve(uploadsRoot);
  const resolved = path.resolve(root, base);
  if (!resolved.startsWith(`${root}${path.sep}`)) return null;
  return resolved;
}

function cachePaths(uploadsRoot: string, fileId: string) {
  return {
    textTxt: path.join(uploadsRoot, "text-cache", `${fileId}.txt`),
    textJson: path.join(uploadsRoot, "text-cache", `${fileId}.json`),
    segment: path.join(uploadsRoot, "segment-cache", `${fileId}.json`),
    parsed: path.join(uploadsRoot, "parsed-cache", `${fileId}.json`),
  };
}

async function readWarningItemsFromParsedCache(uploadsRoot: string, fileId?: string) {
  if (!fileId) return [] as UploadWarning[];
  const parsedPath = cachePaths(uploadsRoot, fileId).parsed;
  try {
    const raw = await fs.readFile(parsedPath, "utf8");
    const parsed = JSON.parse(raw) as {
      warnings?: Array<{ reason?: unknown; rawLine?: unknown; confidence?: unknown }>;
    };
    if (!Array.isArray(parsed.warnings)) return [];
    return parsed.warnings
      .map((warning) => {
        const code = String(warning?.reason || "").trim();
        if (!code) return null;
        return {
          code,
          message:
            typeof warning?.rawLine === "string" && warning.rawLine.trim()
              ? warning.rawLine.trim().slice(0, 180)
              : undefined,
          meta:
            typeof warning?.confidence === "number"
              ? { confidence: warning.confidence }
              : undefined,
        } satisfies UploadWarning;
      })
      .filter(Boolean) as UploadWarning[];
  } catch {
    return [];
  }
}

async function parseStageForFile(uploadsRoot: string, fileId?: string, fallback?: UploadManifestFile) {
  if (!fileId) {
    return {
      stage: fallback?.parseStatus || "uploaded",
      warnings: typeof fallback?.warnings === "number" ? fallback.warnings : 0,
      txCount: undefined,
      needsReview: false,
    };
  }

  const paths = cachePaths(uploadsRoot, fileId);
  const parsedExists = await fileExists(paths.parsed);
  if (parsedExists) {
    try {
      const raw = await fs.readFile(paths.parsed, "utf8");
      const parsed = JSON.parse(raw) as {
        transactions?: unknown[];
        warnings?: unknown[];
        needsReview?: unknown;
      };
      return {
        stage: "parsed" as const,
        txCount: Array.isArray(parsed.transactions) ? parsed.transactions.length : 0,
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings.length : 0,
        needsReview: parsed.needsReview === true,
      };
    } catch {
      return { stage: "parsed" as const };
    }
  }

  if (await fileExists(paths.segment)) {
    return { stage: "segmented" as const };
  }

  if ((await fileExists(paths.textTxt)) || (await fileExists(paths.textJson))) {
    return { stage: "extracted" as const };
  }

  return {
    stage: fallback?.parseStatus || "uploaded",
    warnings: typeof fallback?.warnings === "number" ? fallback.warnings : 0,
  };
}

async function readTransactionIdsFromParsedCache(
  uploadsRoot: string,
  fileId?: string
) {
  if (!fileId) return [];
  const parsedPath = cachePaths(uploadsRoot, fileId).parsed;
  try {
    const raw = await fs.readFile(parsedPath, "utf8");
    const parsed = JSON.parse(raw) as { transactions?: Array<{ id?: unknown }> };
    if (!Array.isArray(parsed.transactions)) return [];
    return parsed.transactions
      .map((tx) => (typeof tx?.id === "string" ? tx.id : ""))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveIndexRow(manifestRow: UploadManifestFile, indexRows: FileMeta[]) {
  if (manifestRow.fileId) {
    const byId = indexRows.find((row) => row.id === manifestRow.fileId);
    if (byId) return byId;
  }
  const byHash = indexRows.find((row) => row.contentHash === manifestRow.fileHash);
  if (byHash) return byHash;
  if (manifestRow.storedName) {
    return indexRows.find((row) => row.storedName === manifestRow.storedName);
  }
  return undefined;
}

function toListItem(
  manifestRow: UploadManifestFile,
  stage: UploadListItem["parseStatus"],
  warnings: UploadWarning[],
  indexRow?: FileMeta
): UploadListItem {
  return {
    fileHash: manifestRow.fileHash,
    fileId: manifestRow.fileId || indexRow?.id || "",
    originalName: manifestRow.originalName,
    size: manifestRow.size,
    uploadedAt: manifestRow.uploadedAt,
    bankId: manifestRow.bankId || indexRow?.bankId,
    accountIds:
      (manifestRow.accountIds && manifestRow.accountIds.length > 0
        ? manifestRow.accountIds
        : indexRow?.accountId
          ? [indexRow.accountId]
          : []) || [],
    templateId: manifestRow.templateId || indexRow?.templateId || indexRow?.templateType,
    warnings,
    parseStatus: stage,
  };
}

function shouldPruneResolvedKey(
  key: string,
  fileHash: string,
  fileId: string | undefined,
  txIds: Set<string>
) {
  if (!key) return false;
  if (key.includes(fileHash)) return true;
  if (fileId && key.includes(`:${fileId}:`)) return true;

  if (key.startsWith("UNKNOWN_MERCHANT:")) {
    const txId = key.slice("UNKNOWN_MERCHANT:".length);
    return txIds.has(txId);
  }

  if (key.startsWith("UNCERTAIN_TRANSFER:")) {
    const pairKey = key.slice("UNCERTAIN_TRANSFER:".length);
    for (const txId of txIds) {
      if (pairKey.includes(txId)) return true;
    }
  }

  return false;
}

async function pruneReviewStateForDeletedFile(
  fileHash: string,
  fileId: string | undefined,
  txIds: string[],
  options: ManagerOptions
) {
  const readFn = options.readReviewStateFn || readReviewState;
  const writeFn = options.writeReviewStateFn || writeReviewState;
  const reviewState = await readFn();
  const txSet = new Set(txIds);
  let changed = false;
  const nextResolved: InboxReviewState["resolved"] = {};

  for (const [key, value] of Object.entries(reviewState.resolved || {})) {
    if (shouldPruneResolvedKey(key, fileHash, fileId, txSet)) {
      changed = true;
      continue;
    }
    nextResolved[key] = value;
  }

  if (!changed) {
    return 0;
  }

  await writeFn({ resolved: nextResolved });
  return Object.keys(reviewState.resolved || {}).length - Object.keys(nextResolved).length;
}

async function cleanupCachesForFile(uploadsRoot: string, fileHash: string, fileId?: string) {
  if (fileId) {
    const paths = cachePaths(uploadsRoot, fileId);
    await unlinkIfExists(paths.textTxt);
    await unlinkIfExists(paths.textJson);
    await unlinkIfExists(paths.segment);
    await unlinkIfExists(paths.parsed);

    await unlinkIfExists(path.join(uploadsRoot, TRANSFER_CACHE_DIR, `${fileId}.json`));
    await unlinkIfExists(path.join(uploadsRoot, ANALYSIS_CACHE_DIR, `${fileId}.json`));

    const legacyHashDir = sanitizeDirSegment(`id:${fileId}`);
    await rmDirIfExists(path.join(uploadsRoot, "dev-runs", legacyHashDir));
  }

  await unlinkIfExists(path.join(uploadsRoot, TRANSFER_CACHE_DIR, `${fileHash}.json`));
  await unlinkIfExists(path.join(uploadsRoot, ANALYSIS_CACHE_DIR, `${fileHash}.json`));
  const hashDir = sanitizeDirSegment(fileHash);
  await rmDirIfExists(path.join(uploadsRoot, "dev-runs", hashDir));
}

export async function listUploads(options: ManagerOptions = {}) {
  const uploadsRoot = options.uploadsRoot || uploadsDirAbsolute;
  const readManifestFn = options.readManifestFn || readUploadManifest;
  const readIndexFn = options.readIndexFn || readIndex;

  const [manifest, indexRows] = await Promise.all([readManifestFn(), readIndexFn()]);
  const rows = await Promise.all(
    (manifest.files || []).map(async (manifestRow) => {
      const indexRow = resolveIndexRow(manifestRow, indexRows);
      const fileId = manifestRow.fileId || indexRow?.id;
      const stage = await parseStageForFile(uploadsRoot, fileId, manifestRow);
      const warnings = await readWarningItemsFromParsedCache(uploadsRoot, fileId);
      return toListItem(manifestRow, stage, warnings, indexRow);
    })
  );

  return rows.sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
}

export async function deleteUploadByHash(
  fileHash: string,
  options: ManagerOptions = {}
): Promise<DeleteUploadResult> {
  const normalizedHash = String(fileHash || "").trim();
  if (!normalizedHash) {
    return {
      ok: false,
      error: { code: "BAD_REQUEST", message: "fileHash is required." },
    };
  }

  const uploadsRoot = options.uploadsRoot || uploadsDirAbsolute;
  const readManifestFn = options.readManifestFn || readUploadManifest;
  const readIndexFn = options.readIndexFn || readIndex;
  const removeByIdFn = options.removeByIdFn || removeById;
  const removeManifestByHashFn = options.removeManifestByHashFn || removeManifestByHash;
  const readBoundaryConfigFn = options.readBoundaryConfigFn || readBoundaryConfig;

  const [manifest, indexRows] = await Promise.all([readManifestFn(), readIndexFn()]);
  const manifestRow = manifest.files.find((row) => row.fileHash === normalizedHash);
  if (!manifestRow) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "Upload not found in manifest." },
    };
  }

  const indexRow = resolveIndexRow(manifestRow, indexRows);
  const fileId = manifestRow.fileId || indexRow?.id;
  const storedName = manifestRow.storedName || indexRow?.storedName;
  const deletedStage = await parseStageForFile(uploadsRoot, fileId, manifestRow);
  const txIds = await readTransactionIdsFromParsedCache(uploadsRoot, fileId);

  if (storedName) {
    const storedPath = resolveSafeUploadPath(uploadsRoot, storedName);
    if (!storedPath) {
      return {
        ok: false,
        error: { code: "IO_FAIL", message: "Invalid stored file path." },
      };
    }
    await unlinkIfExists(storedPath);
  }

  await cleanupCachesForFile(uploadsRoot, normalizedHash, fileId);

  if (indexRow?.id) {
    await removeByIdFn(indexRow.id);
  }
  await removeManifestByHashFn(normalizedHash);

  const prunedCount = await pruneReviewStateForDeletedFile(
    normalizedHash,
    fileId,
    txIds,
    options
  );
  const remaining = await readIndexFn();
  const knownAccountIds = [
    ...new Set(remaining.map((row) => String(row.accountId || "").trim()).filter(Boolean)),
  ];
  const boundary = await readBoundaryConfigFn(knownAccountIds);
  const knownSet = new Set(knownAccountIds);
  const missingBoundaryAccountIds = boundary.config.boundaryAccountIds.filter(
    (accountId) => !knownSet.has(accountId)
  );

  return {
    ok: true,
    deleted: toListItem(manifestRow, deletedStage, indexRow),
    reviewStatePrunedCount: prunedCount,
    boundaryWarning:
      missingBoundaryAccountIds.length > 0
        ? {
            missingAccountIds: missingBoundaryAccountIds,
            message:
              "Some boundary accounts are missing after delete; review boundary settings.",
          }
        : null,
  };
}

export async function deleteAllUploads(options: ManagerOptions = {}) {
  const uploadsRoot = options.uploadsRoot || uploadsDirAbsolute;
  const readManifestFn = options.readManifestFn || readUploadManifest;
  const readIndexFn = options.readIndexFn || readIndex;
  const replaceManifestFn = options.replaceManifestFn || replaceUploadManifest;
  const replaceIndexFn = options.replaceIndexFn || replaceIndex;

  const manifest = await readManifestFn();
  const files = [...(manifest.files || [])];

  for (const file of files) {
    const storedName = file.storedName;
    if (storedName) {
      const storedPath = resolveSafeUploadPath(uploadsRoot, storedName);
      if (storedPath) {
        await unlinkIfExists(storedPath);
      }
    }
  }

  // Also remove any direct PDF/CSV files left in uploads root.
  try {
    const rootEntries = await fs.readdir(uploadsRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      if (!/\.(pdf|csv)$/i.test(entry.name)) continue;
      await unlinkIfExists(path.join(uploadsRoot, entry.name));
    }
  } catch (err: unknown) {
    if (!hasErrnoCode(err, "ENOENT")) throw err;
  }

  for (const dirName of DERIVED_DIRS) {
    await rmDirIfExists(path.join(uploadsRoot, dirName));
  }

  await replaceManifestFn([]);
  await replaceIndexFn([]);

  // Remove review state entries only if they refer to now non-existing tx/file keys.
  const readReview = options.readReviewStateFn || readReviewState;
  const writeReview = options.writeReviewStateFn || writeReviewState;
  const currentReview = await readReview();
  if (Object.keys(currentReview.resolved || {}).length > 0) {
    await writeReview({ resolved: {} });
  }

  // Boundary warning is not needed for all-delete path.
  const remainingIndex = await readIndexFn();
  return {
    ok: true as const,
    total: files.length,
    deletedCount: files.length,
    remainingIndexCount: remainingIndex.length,
  };
}
