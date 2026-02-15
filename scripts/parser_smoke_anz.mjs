import { promises as fs } from "fs";
import path from "path";

const root = process.cwd();
const indexPath = path.join(root, "uploads", "index.json");
const devRunsRoot = path.join(root, "uploads", "dev-runs");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

function sanitizeDirSegment(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 128) || "unknown";
}

async function latestRunPayload(fileHash) {
  const dir = path.join(devRunsRoot, sanitizeDirSegment(fileHash));
  let entries = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  entries.sort((a, b) => b.localeCompare(a));
  for (const runId of entries) {
    const outputPath = path.join(dir, runId, "rerun-output.json");
    try {
      const payload = await readJson(outputPath);
      return { runId, payload, outputPath };
    } catch {
      // ignore malformed files
    }
  }
  return null;
}

function isAnzCandidate(row) {
  const name = String(row?.originalName || "").toLowerCase();
  return /anz/.test(name);
}

async function main() {
  let rows = [];
  try {
    rows = await readJson(indexPath);
  } catch {
    console.log("parser-smoke-anz SKIP: uploads/index.json not found.");
    process.exit(0);
  }

  const anzRows = rows.filter(isAnzCandidate);
  if (anzRows.length === 0) {
    console.log("parser-smoke-anz SKIP: no ANZ files detected in uploads/index.json");
    process.exit(0);
  }

  let checked = 0;
  for (const row of anzRows) {
    const fileHash = row.contentHash || `id:${row.id}`;
    const latestRun = await latestRunPayload(fileHash);
    assert(
      latestRun,
      `Missing dev-run output for ANZ file ${row.originalName}. Run /api/dev/file/[fileHash]/rerun first.`
    );

    const out = latestRun.payload;
    assert(out && out.ok === true, `${row.originalName}: rerun output must have ok=true`);
    assert(
      out.detected?.templateId === "anz_v1",
      `${row.originalName}: expected detected.templateId=anz_v1, got ${out.detected?.templateId}`
    );
    assert(
      typeof out.accountId === "string" && out.accountId.length > 0 && out.accountId !== "unknown",
      `${row.originalName}: accountId missing in rerun output`
    );

    const tx = Array.isArray(out.sampleTransactions) ? out.sampleTransactions : [];
    assert(tx.length > 0, `${row.originalName}: transactions should not be empty`);

    const continuity = Number(out.debug?.continuity || 0);
    assert(
      continuity >= 0.995,
      `${row.originalName}: continuity below threshold (${continuity})`
    );

    const badEffectiveRows = tx.filter((rowItem) =>
      String(rowItem?.descriptionRaw || "").trim().toUpperCase().startsWith("EFFECTIVE DATE")
    );
    assert(
      badEffectiveRows.length === 0,
      `${row.originalName}: found standalone Effective Date transaction rows`
    );

    checked += 1;
    console.log(
      `parser-smoke-anz PASS: ${row.originalName} template=${out.detected?.templateId} account=${out.accountId} tx=${tx.length} continuity=${continuity}`
    );
  }

  console.log(`parser-smoke-anz PASS: validated ${checked} ANZ file(s)`);
}

main().catch((err) => {
  console.error("parser-smoke-anz FAIL");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
