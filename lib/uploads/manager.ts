import { promises as fs } from "fs";
import path from "path";
import {
  FileMeta,
  readIndex,
  removeById,
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

export type UploadParseStage = "uploaded" | "extracted" | "segmented" | "parsed";

export type UploadListItem = {
  fileHash: string;
  fileId: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  bankId?: string;
  accountIds: string[];
  templateId?: string;
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

function fileHashForMeta(meta: FileMeta) {
  return meta.contentHash || `id:${meta.id}`;
}

function fileToListItem(meta: FileMeta, stage: UploadListItem["parseStatus"]) {
  return {
    fileHash: fileHashForMeta(meta),
    fileId: meta.id,
    originalName: meta.originalName,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
    bankId: meta.bankId,
    accountIds: meta.accountId ? [meta.accountId] : [],
    templateId: meta.templateId || meta.templateType,
    parseStatus: stage,
  } satisfies UploadListItem;
}

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

async function parseStageForFile(uploadsRoot: string, fileId: string) {
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
      return {
        stage: "parsed" as const,
      };
    }
  }

  if (await fileExists(paths.segment)) {
    return { stage: "segmented" as const };
  }

  if ((await fileExists(paths.textTxt)) || (await fileExists(paths.textJson))) {
    return { stage: "extracted" as const };
  }

  return { stage: "uploaded" as const };
}

async function readTransactionIdsFromParsedCache(
  uploadsRoot: string,
  fileId: string
) {
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

function shouldPruneResolvedKey(
  key: string,
  meta: FileMeta,
  txIds: Set<string>
) {
  if (!key) return false;
  if (key.includes(`:${meta.id}:`)) return true;
  if (meta.contentHash && key.includes(meta.contentHash)) return true;
  if (key.startsWith("PARSE_ISSUE:") && key.includes(meta.id)) return true;

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
  meta: FileMeta,
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
    if (shouldPruneResolvedKey(key, meta, txSet)) {
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

export async function listUploads(options: ManagerOptions = {}) {
  const uploadsRoot = options.uploadsRoot || uploadsDirAbsolute;
  const readIndexFn = options.readIndexFn || readIndex;
  const index = await readIndexFn();
  const sorted = [...index].sort(
    (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
  );
  const rows = await Promise.all(
    sorted.map(async (meta) => {
      const stage = await parseStageForFile(uploadsRoot, meta.id);
      return fileToListItem(meta, stage);
    })
  );
  return rows;
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
  const readIndexFn = options.readIndexFn || readIndex;
  const removeByIdFn = options.removeByIdFn || removeById;
  const readBoundaryConfigFn = options.readBoundaryConfigFn || readBoundaryConfig;

  const index = await readIndexFn();
  const target = index.find(
    (row) => row.contentHash === normalizedHash || `id:${row.id}` === normalizedHash
  );
  if (!target) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "Upload not found." },
    };
  }

  const txIds = await readTransactionIdsFromParsedCache(uploadsRoot, target.id);
  const storedPath = resolveSafeUploadPath(uploadsRoot, target.storedName);
  if (!storedPath) {
    return {
      ok: false,
      error: { code: "IO_FAIL", message: "Invalid stored file path." },
    };
  }

  const paths = cachePaths(uploadsRoot, target.id);
  const deletedStage = await parseStageForFile(uploadsRoot, target.id);
  const legacyHashDir = sanitizeDirSegment(`id:${target.id}`);
  const hashDir = sanitizeDirSegment(fileHashForMeta(target));

  await unlinkIfExists(storedPath);
  await unlinkIfExists(paths.textTxt);
  await unlinkIfExists(paths.textJson);
  await unlinkIfExists(paths.segment);
  await unlinkIfExists(paths.parsed);

  await rmDirIfExists(path.join(uploadsRoot, "dev-runs", hashDir));
  if (hashDir !== legacyHashDir) {
    await rmDirIfExists(path.join(uploadsRoot, "dev-runs", legacyHashDir));
  }

  await unlinkIfExists(path.join(uploadsRoot, TRANSFER_CACHE_DIR, `${target.id}.json`));
  await unlinkIfExists(path.join(uploadsRoot, ANALYSIS_CACHE_DIR, `${target.id}.json`));
  if (target.contentHash) {
    await unlinkIfExists(
      path.join(uploadsRoot, TRANSFER_CACHE_DIR, `${target.contentHash}.json`)
    );
    await unlinkIfExists(
      path.join(uploadsRoot, ANALYSIS_CACHE_DIR, `${target.contentHash}.json`)
    );
  }

  const removed = await removeByIdFn(target.id);
  if (!removed) {
    return {
      ok: false,
      error: { code: "NOT_FOUND", message: "Upload already removed." },
    };
  }

  const prunedCount = await pruneReviewStateForDeletedFile(removed, txIds, options);
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
    deleted: fileToListItem(removed, deletedStage),
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
