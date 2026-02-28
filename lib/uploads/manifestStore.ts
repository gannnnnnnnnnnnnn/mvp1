import { promises as fs } from "fs";
import path from "path";

export type UploadManifestFile = {
  fileHash: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  bankId?: string;
  accountIds?: string[];
  parseStatus?: "uploaded" | "extracted" | "segmented" | "parsed";
  warnings?: number;
  templateId?: string;
  fileId?: string;
  storedName?: string;
};

export type UploadManifest = {
  version: 1;
  files: UploadManifestFile[];
  updatedAt?: string;
};

const manifestPath = path.join(process.cwd(), "uploads", "manifest.json");
let manifestWriteQueue: Promise<void> = Promise.resolve();

function defaultManifest(): UploadManifest {
  return {
    version: 1,
    files: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeFiles(files: unknown): UploadManifestFile[] {
  if (!Array.isArray(files)) return [];
  const out: UploadManifestFile[] = [];
  for (const raw of files) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const fileHash = String(row.fileHash || "").trim();
    const originalName = String(row.originalName || "").trim();
    const uploadedAt = String(row.uploadedAt || "").trim();
    const size = Number(row.size);
    if (!fileHash || !originalName || !uploadedAt || !Number.isFinite(size)) continue;

    out.push({
      fileHash,
      originalName,
      size,
      uploadedAt,
      bankId: String(row.bankId || "").trim() || undefined,
      accountIds: Array.isArray(row.accountIds)
        ? row.accountIds
            .map((id) => String(id || "").trim())
            .filter(Boolean)
        : undefined,
      parseStatus:
        row.parseStatus === "uploaded" ||
        row.parseStatus === "extracted" ||
        row.parseStatus === "segmented" ||
        row.parseStatus === "parsed"
          ? row.parseStatus
          : undefined,
      warnings: Number.isFinite(Number(row.warnings)) ? Number(row.warnings) : undefined,
      templateId: String(row.templateId || "").trim() || undefined,
      fileId: String(row.fileId || "").trim() || undefined,
      storedName: String(row.storedName || "").trim() || undefined,
    });
  }
  return out;
}

function normalizeManifest(input: unknown): UploadManifest {
  if (!input || typeof input !== "object") {
    return defaultManifest();
  }
  const row = input as Record<string, unknown>;
  return {
    version: 1,
    files: normalizeFiles(row.files),
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : undefined,
  };
}

function withWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = manifestWriteQueue;
  let release: (() => void) | undefined;
  manifestWriteQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  return previous.then(async () => {
    try {
      return await work();
    } finally {
      release?.();
    }
  });
}

async function writeManifestSafe(manifest: UploadManifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const payload: UploadManifest = {
    ...manifest,
    version: 1,
    updatedAt: new Date().toISOString(),
  };
  const tmpPath = `${manifestPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, manifestPath);
}

export async function readUploadManifest(): Promise<UploadManifest> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    if (!raw.trim()) return defaultManifest();
    try {
      return normalizeManifest(JSON.parse(raw));
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backup = path.join(
          path.dirname(manifestPath),
          `manifest.corrupt.${stamp}.json`
        );
        try {
          await fs.rename(manifestPath, backup);
        } catch {
          // Best effort.
        }
        return defaultManifest();
      }
      throw err;
    }
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return defaultManifest();
    }
    throw err;
  }
}

export async function replaceUploadManifest(files: UploadManifestFile[]) {
  const next: UploadManifest = {
    version: 1,
    files: normalizeFiles(files),
  };
  await withWriteLock(async () => {
    await writeManifestSafe(next);
  });
  return next;
}

export async function findManifestByHash(fileHash: string) {
  const normalized = String(fileHash || "").trim();
  if (!normalized) return undefined;
  const manifest = await readUploadManifest();
  return manifest.files.find((row) => row.fileHash === normalized);
}

export async function appendUploadManifestEntry(entry: UploadManifestFile) {
  const normalized = normalizeFiles([entry])[0];
  if (!normalized) {
    throw new Error("BAD_MANIFEST_ENTRY");
  }

  return withWriteLock(async () => {
    const current = await readUploadManifest();
    const duplicate = current.files.find((row) => row.fileHash === normalized.fileHash);
    if (duplicate) {
      return { duplicate, manifest: current };
    }
    const nextFiles = [...current.files, normalized];
    const next = {
      version: 1 as const,
      files: nextFiles,
    };
    await writeManifestSafe(next);
    return { duplicate: null, manifest: next };
  });
}

export async function removeManifestByHash(fileHash: string) {
  const normalized = String(fileHash || "").trim();
  if (!normalized) return undefined;

  return withWriteLock(async () => {
    const current = await readUploadManifest();
    const idx = current.files.findIndex((row) => row.fileHash === normalized);
    if (idx < 0) return undefined;
    const nextFiles = [...current.files];
    const [removed] = nextFiles.splice(idx, 1);
    await writeManifestSafe({
      version: 1,
      files: nextFiles,
    });
    return removed;
  });
}
