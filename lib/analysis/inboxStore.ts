import { promises as fs } from "fs";
import path from "path";

export type InboxOverrides = {
  version: 1;
  merchantRules: Record<string, unknown>;
  transferRules: Record<string, unknown>;
  parseRules: Record<string, unknown>;
  updatedAt?: string;
};

export type InboxReviewState = {
  version: 1;
  resolved: Record<
    string,
    {
      resolvedAt: string;
      note?: string;
    }
  >;
  updatedAt?: string;
};

const OVERRIDES_PATH = path.join(process.cwd(), "uploads", "overrides.json");
const REVIEW_STATE_PATH = path.join(process.cwd(), "uploads", "review_state.json");

let inboxWriteQueue: Promise<void> = Promise.resolve();

function defaultOverrides(): InboxOverrides {
  return {
    version: 1,
    merchantRules: {},
    transferRules: {},
    parseRules: {},
  };
}

function defaultReviewState(): InboxReviewState {
  return {
    version: 1,
    resolved: {},
  };
}

function normalizeOverrides(input: Partial<InboxOverrides> | null | undefined): InboxOverrides {
  return {
    version: 1,
    merchantRules:
      input?.merchantRules && typeof input.merchantRules === "object"
        ? input.merchantRules
        : {},
    transferRules:
      input?.transferRules && typeof input.transferRules === "object"
        ? input.transferRules
        : {},
    parseRules:
      input?.parseRules && typeof input.parseRules === "object" ? input.parseRules : {},
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined,
  };
}

function normalizeReviewState(
  input: Partial<InboxReviewState> | null | undefined
): InboxReviewState {
  const resolved =
    input?.resolved && typeof input.resolved === "object" ? input.resolved : {};
  const cleanResolved: InboxReviewState["resolved"] = {};
  for (const [id, state] of Object.entries(resolved)) {
    if (!id.trim() || !state || typeof state !== "object") continue;
    const resolvedAt = (state as { resolvedAt?: unknown }).resolvedAt;
    if (typeof resolvedAt !== "string" || !resolvedAt.trim()) continue;
    const note = (state as { note?: unknown }).note;
    cleanResolved[id] = {
      resolvedAt,
      note: typeof note === "string" && note.trim() ? note : undefined,
    };
  }

  return {
    version: 1,
    resolved: cleanResolved,
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : undefined,
  };
}

async function ensureParentDir(filePath: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function readJsonSafe<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) {
      return null;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if (err instanceof SyntaxError) {
        // Corrupted local JSON should never crash runtime.
        // Preserve the invalid file for debugging, then restore defaults.
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const corruptPath = `${filePath}.corrupt.${stamp}.json`;
        try {
          await fs.rename(filePath, corruptPath);
        } catch {
          // Best effort only.
        }
        return null;
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
      return null;
    }
    throw err;
  }
}

async function writeJsonSafe(filePath: string, payload: unknown) {
  await ensureParentDir(filePath);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmpPath, filePath);
}

function withInboxWriteLock<T>(work: () => Promise<T>) {
  const previous = inboxWriteQueue;
  let release: (() => void) | undefined;
  inboxWriteQueue = new Promise<void>((resolve) => {
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

export async function readInboxOverrides(): Promise<InboxOverrides> {
  const parsed = await readJsonSafe<InboxOverrides>(OVERRIDES_PATH);
  return parsed ? normalizeOverrides(parsed) : defaultOverrides();
}

export async function writeInboxOverrides(
  next: Omit<InboxOverrides, "version">
): Promise<InboxOverrides> {
  const normalized = normalizeOverrides({
    ...next,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  await withInboxWriteLock(async () => {
    await writeJsonSafe(OVERRIDES_PATH, normalized);
  });
  return normalized;
}

export async function readReviewState(): Promise<InboxReviewState> {
  const parsed = await readJsonSafe<InboxReviewState>(REVIEW_STATE_PATH);
  return parsed ? normalizeReviewState(parsed) : defaultReviewState();
}

export async function writeReviewState(
  next: Omit<InboxReviewState, "version">
): Promise<InboxReviewState> {
  const normalized = normalizeReviewState({
    ...next,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  await withInboxWriteLock(async () => {
    await writeJsonSafe(REVIEW_STATE_PATH, normalized);
  });
  return normalized;
}
