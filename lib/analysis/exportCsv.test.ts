import test from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "./exportCsv";

test("toCsv escapes commas and quotes", () => {
  const csv = toCsv([
    ["name", "note"],
    ["Alice", 'hello, "world"'],
  ]);
  assert.equal(csv, 'name,note\nAlice,"hello, ""world"""');
});

test("toCsv preserves new lines by quoting", () => {
  const csv = toCsv([
    ["k", "v"],
    ["a", "line1\nline2"],
  ]);
  assert.equal(csv, 'k,v\na,"line1\nline2"');
});

