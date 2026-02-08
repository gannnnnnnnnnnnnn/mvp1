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
  const previous = indexWriteQueue;
  let release: (() => void) | undefined;
  indexWriteQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    const current = await readIndex();
    current.push(entry);
    await writeIndexSafe(current);
  } finally {
    release?.();
  }
}

/**
 * Find a single metadata record by id.
 */
export async function findById(id: string): Promise<FileMeta | undefined> {
  const current = await readIndex();
  return current.find((item) => item.id === id);
}
