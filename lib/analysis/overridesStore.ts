import { promises as fs } from "fs";
import path from "path";
import {
  Category,
  CategoryOverrides,
  DEFAULT_OVERRIDE_SCOPE,
  ScopedCategoryMap,
} from "@/lib/analysis/types";

const OVERRIDES_PATH = path.join(process.cwd(), "uploads", "category-overrides.json");
let overridesWriteChain: Promise<void> = Promise.resolve();

async function ensureParentDir() {
  await fs.mkdir(path.dirname(OVERRIDES_PATH), { recursive: true });
}

function emptyOverrides(): CategoryOverrides {
  return {
    merchantMap: { [DEFAULT_OVERRIDE_SCOPE]: {} },
    transactionMap: { [DEFAULT_OVERRIDE_SCOPE]: {} },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeScopedMap(input: unknown): ScopedCategoryMap {
  if (!isPlainObject(input)) {
    return { [DEFAULT_OVERRIDE_SCOPE]: {} };
  }

  // Backward compatibility: old format was flat Record<string, Category>.
  // If every value is a string, treat the map as global scope.
  const values = Object.values(input);
  const isLegacyFlat = values.length > 0 && values.every((value) => typeof value === "string");
  if (isLegacyFlat) {
    return {
      [DEFAULT_OVERRIDE_SCOPE]: Object.fromEntries(
        Object.entries(input)
          .filter(([, category]) => typeof category === "string")
          .map(([key, category]) => [key, category as Category])
      ),
    };
  }

  const normalized: ScopedCategoryMap = {};
  for (const [scopeKey, rawMap] of Object.entries(input)) {
    if (!isPlainObject(rawMap)) continue;
    normalized[scopeKey] = Object.fromEntries(
      Object.entries(rawMap)
        .filter(([, category]) => typeof category === "string")
        .map(([key, category]) => [key, category as Category])
    );
  }

  if (!normalized[DEFAULT_OVERRIDE_SCOPE]) {
    normalized[DEFAULT_OVERRIDE_SCOPE] = {};
  }

  return normalized;
}

export async function readCategoryOverrides(): Promise<CategoryOverrides> {
  try {
    const raw = await fs.readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      merchantMap: normalizeScopedMap(parsed.merchantMap),
      transactionMap: normalizeScopedMap(parsed.transactionMap),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
    };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return emptyOverrides();
    }
    throw err;
  }
}

async function writeCategoryOverrides(next: CategoryOverrides) {
  await ensureParentDir();
  const tmp = `${OVERRIDES_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.rename(tmp, OVERRIDES_PATH);
}

function queueOverrideWrite(task: () => Promise<void>) {
  overridesWriteChain = overridesWriteChain.then(task, task);
  return overridesWriteChain;
}

export async function setTransactionOverride(
  transactionId: string,
  category: Category,
  scopeKey = DEFAULT_OVERRIDE_SCOPE
) {
  await queueOverrideWrite(async () => {
    const current = await readCategoryOverrides();
    current.transactionMap[scopeKey] = current.transactionMap[scopeKey] || {};
    current.transactionMap[scopeKey][transactionId] = category;
    current.updatedAt = new Date().toISOString();
    await writeCategoryOverrides(current);
  });
}

export async function setMerchantOverride(
  merchantNorm: string,
  category: Category,
  scopeKey = DEFAULT_OVERRIDE_SCOPE
) {
  await queueOverrideWrite(async () => {
    const current = await readCategoryOverrides();
    current.merchantMap[scopeKey] = current.merchantMap[scopeKey] || {};
    current.merchantMap[scopeKey][merchantNorm] = category;
    current.updatedAt = new Date().toISOString();
    await writeCategoryOverrides(current);
  });
}
