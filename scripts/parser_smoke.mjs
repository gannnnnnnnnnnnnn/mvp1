import { promises as fs } from "fs";
import path from "path";

const projectRoot = process.cwd();
const expectedPath = path.join(
  projectRoot,
  "expected",
  "TransactionSummary.parsed.json"
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

async function main() {
  const raw = await fs.readFile(expectedPath, "utf8");
  const data = JSON.parse(raw);

  assert(data && typeof data === "object", "Snapshot root must be an object.");
  assert(data.ok === true, "Snapshot must have ok=true.");
  assert(Array.isArray(data.transactions), "Snapshot must include transactions array.");
  assert(data.transactions.length > 0, "Transactions should not be empty.");

  const first = data.transactions[0];
  assert(first && typeof first === "object", "First transaction is missing.");
  assert(typeof first.id === "string" && first.id.length > 0, "Transaction id missing.");
  assert(typeof first.date === "string" && first.date.length > 0, "Transaction date missing.");
  assert(
    typeof first.description === "string" && first.description.length > 0,
    "Transaction description missing."
  );
  assert(isFiniteNumber(first.amount), "Transaction amount must be a finite number.");
  assert(typeof first.rawLine === "string", "Transaction rawLine missing.");
  assert(isFiniteNumber(first.confidence), "Transaction confidence must be a number.");

  // Quality gate fields are part of phase baseline; keep smoke checks lightweight.
  assert(
    data.quality && typeof data.quality === "object",
    "Snapshot must include quality object."
  );
  assert(
    isFiniteNumber(data.quality.balanceContinuityPassRate),
    "quality.balanceContinuityPassRate missing."
  );
  assert(
    Number.isInteger(data.quality.balanceContinuityChecked),
    "quality.balanceContinuityChecked missing."
  );

  console.log(
    `parser-smoke PASS: tx=${data.transactions.length}, continuity=${data.quality.balanceContinuityPassRate}`
  );
}

main().catch((err) => {
  console.error("parser-smoke FAIL");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
