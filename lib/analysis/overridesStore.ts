import { promises as fs } from "fs";
import path from "path";
import { Category, CategoryOverrides } from "@/lib/analysis/types";

const OVERRIDES_PATH = path.join(
  process.cwd(),
  "uploads",
  "category-overrides.json"
);
let overridesWriteChain: Promise<void> = Promise.resolve();

async function ensureParentDir() {
  await fs.mkdir(path.dirname(OVERRIDES_PATH), { recursive: true });
}

export async function readCategoryOverrides(): Promise<CategoryOverrides> {
  try {
    const raw = await fs.readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<CategoryOverrides>;
    return {
      merchantMap: parsed.merchantMap || {},
      transactionMap: parsed.transactionMap || {},
      updatedAt: parsed.updatedAt,
    };
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return { merchantMap: {}, transactionMap: {} };
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
  category: Category
) {
  await queueOverrideWrite(async () => {
    const current = await readCategoryOverrides();
    current.transactionMap[transactionId] = category;
    current.updatedAt = new Date().toISOString();
    await writeCategoryOverrides(current);
  });
}

export async function setMerchantOverride(merchantNorm: string, category: Category) {
  await queueOverrideWrite(async () => {
    const current = await readCategoryOverrides();
    current.merchantMap[merchantNorm] = category;
    current.updatedAt = new Date().toISOString();
    await writeCategoryOverrides(current);
  });
}
