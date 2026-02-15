/**
 * A tiny file metadata store built on top of a JSON file.
 * Phase 1 requirement: keep things simple, no database, only the filesystem.
 *
 * File paths are kept relative to the project root so that we never expose
 * absolute Windows paths to the browser.
 */
import { promises as fs } from "fs";
import path from "path";

/**
 * Shape of the metadata that lives inside uploads/index.json.
 */
export type FileMeta = {
  id: string;
  // Optional bank identifier for template development and future multi-bank support.
  bankId?: string;
  // Optional account scoping field for future multi-account analytics.
  accountId?: string;
  // Canonical parser template id when available.
  templateId?: string;
  // SHA-256 hash of the file content for duplicate prevention.
  contentHash?: string;
  // Optional parser template tag populated after parsing.
  templateType?: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  path: string; // relative path such as "uploads/abc.pdf"
};

// Centralized constants so route handlers do not repeat strings.
const UPLOADS_DIR = "uploads";
const INDEX_FILE = "index.json";

/**
 * Absolute path to the uploads folder (e.g., C:\repo\uploads on Windows).
 */
export const uploadsDirAbsolute = path.join(process.cwd(), UPLOADS_DIR);

/**
 * Absolute path to the metadata JSON file.
 */
const indexFileAbsolute = path.join(uploadsDirAbsolute, INDEX_FILE);

// In-process write lock to avoid read-modify-write races on index.json.
let indexWriteQueue: Promise<void> = Promise.resolve();

/**
 * Serialize write operations against index.json.
 * Keeping one helper avoids duplicating lock logic in each mutation function.
 */
async function withIndexWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = indexWriteQueue;
  let release: (() => void) | undefined;
  indexWriteQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await work();
  } finally {
    release?.();
  }
}

/**
 * Ensure the uploads directory exists. Safe to call multiple times.
 */
export async function ensureUploadsDir() {
  await fs.mkdir(uploadsDirAbsolute, { recursive: true });
}

/**
 * Read and parse the metadata file. If missing, treat as empty.
 * Any malformed content will throw, surfacing as a 500 in the route handler.
 */
export async function readIndex(): Promise<FileMeta[]> {
  try {
    const buf = await fs.readFile(indexFileAbsolute, "utf8");
    try {
      const data = JSON.parse(buf);
      if (!Array.isArray(data)) return [];
      return data as FileMeta[];
    } catch {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const corruptPath = `${indexFileAbsolute}.corrupt-${stamp}`;
      try {
        await fs.rename(indexFileAbsolute, corruptPath);
      } catch {
        // Best effort only: if rename fails we still return an empty list.
      }
      return [];
    }
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }
}

/**
 * Persist metadata to disk with a simple "write temp then rename" strategy.
 * This helps avoid partially written files if the process crashes mid-write.
 */
async function writeIndexSafe(files: FileMeta[]) {
  const tmpPath = `${indexFileAbsolute}.tmp`;
  const payload = JSON.stringify(files, null, 2);
  await fs.writeFile(tmpPath, payload, "utf8");
  await fs.rename(tmpPath, indexFileAbsolute);
}

/**
 * Append a new metadata record and persist.
 */
export async function appendMetadata(entry: FileMeta) {
  await withIndexWriteLock(async () => {
    const current = await readIndex();
    current.push(entry);
    await writeIndexSafe(current);
  });
}

/**
 * Append a metadata record only when its content hash does not already exist.
 * This keeps duplicate uploads out of index.json in the common case.
 */
export async function appendMetadataDedupByHash(
  entry: FileMeta
): Promise<{ duplicate: FileMeta | null }> {
  return withIndexWriteLock(async () => {
    const current = await readIndex();
    const duplicate =
      entry.contentHash
        ? current.find((item) => item.contentHash && item.contentHash === entry.contentHash)
        : undefined;
    if (duplicate) {
      return { duplicate };
    }
    current.push(entry);
    await writeIndexSafe(current);
    return { duplicate: null };
  });
}

/**
 * Find a single metadata record by id.
 */
export async function findById(id: string): Promise<FileMeta | undefined> {
  const current = await readIndex();
  return current.find((item) => item.id === id);
}

export async function findByContentHash(
  contentHash: string
): Promise<FileMeta | undefined> {
  const current = await readIndex();
  return current.find((item) => item.contentHash === contentHash);
}

/**
 * Replace the entire index atomically.
 * Useful for cleanup endpoints that reset metadata to [].
 */
export async function replaceIndex(entries: FileMeta[]) {
  await withIndexWriteLock(async () => {
    await writeIndexSafe(entries);
  });
}

/**
 * Remove a single metadata row by id atomically.
 * Returns removed row if found.
 */
export async function removeById(id: string): Promise<FileMeta | undefined> {
  return withIndexWriteLock(async () => {
    const current = await readIndex();
    const idx = current.findIndex((item) => item.id === id);
    if (idx < 0) return undefined;

    const [removed] = current.splice(idx, 1);
    await writeIndexSafe(current);
    return removed;
  });
}
