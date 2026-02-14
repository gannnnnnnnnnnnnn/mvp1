import { promises as fs } from "fs";
import path from "path";

const baseUrl = process.env.AUTO_REGRESSION_BASE_URL || "http://localhost:3000";
const explicitFileId = process.env.AUTO_INFERENCE_FILE_ID || "";
const indexPath = path.join(process.cwd(), "uploads", "index.json");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readIndexSafe() {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function callJson(pathname, init) {
  const res = await fetch(`${baseUrl}${pathname}`, init);
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
}

function listAutoCandidateFiles(files) {
  const candidates = files.filter((f) => {
    const name = String(f.originalName || "").toLowerCase();
    return name.includes("auto") || name.includes("statement");
  });

  candidates.sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  return candidates;
}

async function parseFile(fileId) {
  const extract = await callJson("/api/parse/pdf-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, force: false }),
  });
  if (!extract.ok || extract.data?.ok !== true) {
    throw new Error(`pdf-text failed: status=${extract.status} body=${JSON.stringify(extract.data).slice(0, 400)}`);
  }

  const parse = await callJson("/api/parse/pdf-transactions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId }),
  });

  if (!parse.ok || parse.data?.ok !== true) {
    throw new Error(`pdf-transactions failed: status=${parse.status} body=${JSON.stringify(parse.data).slice(0, 400)}`);
  }

  return parse.data;
}

async function main() {
  const files = await readIndexSafe();
  let fileId = "";
  let data = null;

  if (explicitFileId) {
    const target = files.find((f) => f.id === explicitFileId) || null;
    if (!target) {
      console.log(`auto-inference-regression SKIP: AUTO_INFERENCE_FILE_ID=${explicitFileId} not found in uploads/index.json`);
      return;
    }
    fileId = target.id;
    data = await parseFile(fileId);
  } else {
    const candidates = listAutoCandidateFiles(files);
    if (candidates.length === 0) {
      console.log("auto-inference-regression SKIP: no auto-like file found in uploads/index.json");
      return;
    }

    // Prefer a sample that actually triggers balance-diff inference so this
    // regression stays targeted to the known failure mode.
    for (const candidate of candidates) {
      const parsed = await parseFile(candidate.id);
      const inferredCount = (parsed.transactions || []).filter(
        (tx) => tx.amountSource === "balance_diff_inferred"
      ).length;
      if (inferredCount > 0) {
        fileId = candidate.id;
        data = parsed;
        break;
      }
    }

    if (!data) {
      console.log("auto-inference-regression SKIP: no inferred-row case found in current auto samples");
      return;
    }
  }
  if (!data) {
    throw new Error("Unexpected empty parse result.");
  }
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];

  const inferredRows = transactions.filter((tx) => tx.amountSource === "balance_diff_inferred");
  if (explicitFileId) {
    assert(inferredRows.length > 0, "Expected at least one balance_diff_inferred row for explicit AUTO_INFERENCE_FILE_ID");
  }

  for (const row of inferredRows) {
    const conflicting = warnings.find(
      (w) => w.rawLine === row.rawLine && String(w.reason || "").startsWith("AMOUNT_SIGN_UNCERTAIN")
    );
    assert(!conflicting, "Suppressed warning leaked: AMOUNT_SIGN_UNCERTAIN is still visible for inferred row");
  }

  const quality = data.quality || {};
  const checked = Number(quality.balanceContinuityChecked || 0);
  const passRate = Number(quality.balanceContinuityPassRate || 0);
  const reasons = Array.isArray(quality.needsReviewReasons) ? quality.needsReviewReasons : [];

  if (checked >= 5 && passRate >= 0.95 && inferredRows.length > 0) {
    assert(
      !reasons.includes("AMOUNT_SIGN_UNCERTAIN"),
      "AMOUNT_SIGN_UNCERTAIN should not be a review reason when inference succeeded and continuity is strong"
    );
  }

  console.log(
    `auto-inference-regression PASS: fileId=${fileId}, inferredRows=${inferredRows.length}, continuity=${passRate} (${checked} checked)`
  );
}

main().catch((err) => {
  console.error("auto-inference-regression FAIL");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
