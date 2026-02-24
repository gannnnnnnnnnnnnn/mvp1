import { promises as fs } from "fs";
import path from "path";

export type BoundaryMode = "customAccounts";

export type BoundaryConfig = {
  version: 1;
  mode: BoundaryMode;
  boundaryAccountIds: string[];
  accountAliases: Record<string, string>;
  lastUpdatedAt: string;
};

const BOUNDARY_FILE = path.join(process.cwd(), "uploads", "boundary.json");
let boundaryWriteQueue: Promise<void> = Promise.resolve();

function normalizeAccountIds(ids: string[]) {
  return [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))].sort();
}

function defaultBoundaryConfig(knownAccountIds: string[]): BoundaryConfig {
  return {
    version: 1,
    mode: "customAccounts",
    boundaryAccountIds: normalizeAccountIds(knownAccountIds),
    accountAliases: {},
    lastUpdatedAt: new Date().toISOString(),
  };
}

function normalizeAliases(input: Record<string, unknown> | undefined) {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const id = String(key || "").trim();
    if (!id) continue;
    const alias = String(value || "").trim();
    if (!alias) continue;
    out[id] = alias;
  }
  return out;
}

async function writeBoundarySafe(config: BoundaryConfig) {
  await fs.mkdir(path.dirname(BOUNDARY_FILE), { recursive: true });
  const tmpPath = `${BOUNDARY_FILE}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), "utf8");
  await fs.rename(tmpPath, BOUNDARY_FILE);
}

function withBoundaryWriteLock<T>(work: () => Promise<T>) {
  const previous = boundaryWriteQueue;
  let release: (() => void) | undefined;
  boundaryWriteQueue = new Promise<void>((resolve) => {
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

export async function readBoundaryConfig(
  knownAccountIds: string[]
): Promise<{ config: BoundaryConfig; exists: boolean }> {
  try {
    const raw = await fs.readFile(BOUNDARY_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<BoundaryConfig>;
    const config: BoundaryConfig = {
      version: 1,
      mode: "customAccounts",
      boundaryAccountIds:
        parsed.boundaryAccountIds && Array.isArray(parsed.boundaryAccountIds)
          ? normalizeAccountIds(parsed.boundaryAccountIds)
          : normalizeAccountIds(knownAccountIds),
      accountAliases: normalizeAliases(
        parsed.accountAliases as Record<string, unknown> | undefined
      ),
      lastUpdatedAt:
        typeof parsed.lastUpdatedAt === "string"
          ? parsed.lastUpdatedAt
          : new Date().toISOString(),
    };
    return { config, exists: true };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return { config: defaultBoundaryConfig(knownAccountIds), exists: false };
    }
    throw err;
  }
}

export async function writeBoundaryConfig(next: {
  boundaryAccountIds: string[];
  accountAliases?: Record<string, string>;
}): Promise<BoundaryConfig> {
  const config: BoundaryConfig = {
    version: 1,
    mode: "customAccounts",
    boundaryAccountIds: normalizeAccountIds(next.boundaryAccountIds),
    accountAliases: normalizeAliases(next.accountAliases),
    lastUpdatedAt: new Date().toISOString(),
  };

  await withBoundaryWriteLock(async () => {
    await writeBoundarySafe(config);
  });

  return config;
}

export async function getBoundaryAccountIds(knownAccountIds: string[]) {
  const { config } = await readBoundaryConfig(knownAccountIds);
  return config.boundaryAccountIds;
}
