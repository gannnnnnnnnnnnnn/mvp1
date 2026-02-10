import { promises as fs } from "fs";
import path from "path";

const mode = process.argv[2];
if (mode !== "generate" && mode !== "compare") {
  console.error("Usage: node scripts/commbank_snapshot.mjs <generate|compare>");
  process.exit(1);
}

const projectRoot = process.cwd();
const baseUrl = process.env.SNAPSHOT_BASE_URL || "http://localhost:3000";
const fixturePath = path.join(projectRoot, "fixtures", "TransactionSummary.pdf");
const expectedPath = path.join(projectRoot, "expected", "TransactionSummary.parsed.json");
const actualPath = path.join(projectRoot, "tmp", "actual.json");

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

function firstDiffIndex(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

function normalizeParseResponse(data) {
  const normalized = JSON.parse(JSON.stringify(data));

  if (Array.isArray(normalized.transactions)) {
    normalized.transactions = normalized.transactions.map((tx, index) => ({
      ...tx,
      // Upload API creates random fileId; normalize tx id for stable snapshot compare.
      id: `tx-${index + 1}`,
    }));
  }

  return normalized;
}

async function parseJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response: status=${res.status}, body=${text.slice(0, 200)}`);
  }
}

async function callJson(pathname, init) {
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const data = await parseJsonResponse(res);

  if (!res.ok || data?.ok !== true) {
    throw new Error(
      `API failed ${pathname}: status=${res.status}, body=${JSON.stringify(data).slice(0, 500)}`
    );
  }

  return data;
}

async function runPipeline() {
  let fileId;

  try {
    const fixtureBytes = await fs.readFile(fixturePath);
    const form = new FormData();
    form.append(
      "file",
      new File([fixtureBytes], "TransactionSummary.pdf", {
        type: "application/pdf",
      })
    );

    const upload = await callJson("/api/upload", {
      method: "POST",
      body: form,
    });

    fileId = upload?.file?.id;
    if (!fileId) {
      throw new Error("Upload response missing file.id");
    }

    await callJson("/api/parse/pdf-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, force: true }),
    });

    const parsed = await callJson("/api/parse/pdf-transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    });

    return normalizeParseResponse(parsed);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `Fixture not found: ${fixturePath}. Please place TransactionSummary.pdf there first.`
      );
    }
    throw err;
  } finally {
    if (fileId) {
      // Best-effort cleanup; leave no extra uploaded rows after snapshot commands.
      await fetch(`${baseUrl}/api/files/${encodeURIComponent(fileId)}`, {
        method: "DELETE",
      }).catch(() => undefined);
    }
  }
}

async function generateSnapshot() {
  const parsed = await runPipeline();
  await fs.mkdir(path.dirname(expectedPath), { recursive: true });
  await fs.writeFile(expectedPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  console.log(`Snapshot generated: ${path.relative(projectRoot, expectedPath)}`);
  console.log(`transactions=${parsed.transactions?.length ?? 0}, needsReview=${parsed.needsReview}`);
}

async function compareSnapshot() {
  const expectedRaw = await fs.readFile(expectedPath, "utf8");
  const expected = JSON.parse(expectedRaw);
  const actual = await runPipeline();

  await fs.mkdir(path.dirname(actualPath), { recursive: true });
  await fs.writeFile(actualPath, `${JSON.stringify(actual, null, 2)}\n`, "utf8");

  const expectedStable = stableStringify(expected);
  const actualStable = stableStringify(actual);

  if (expectedStable === actualStable) {
    console.log("Snapshot compare PASS");
    console.log(`actual written: ${path.relative(projectRoot, actualPath)}`);
    return;
  }

  const idx = firstDiffIndex(expectedStable, actualStable);
  console.error("Snapshot compare FAIL");
  if (idx >= 0) {
    console.error(`first diff index=${idx}`);
    console.error(`expected tail=${expectedStable.slice(idx, idx + 120)}`);
    console.error(`actual tail=${actualStable.slice(idx, idx + 120)}`);
  }
  process.exit(1);
}

if (mode === "generate") {
  await generateSnapshot();
} else {
  await compareSnapshot();
}
