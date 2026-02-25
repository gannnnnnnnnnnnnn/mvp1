import test from "node:test";
import assert from "node:assert/strict";
import { isInboxItemSuppressedByRule } from "./inboxRules";
import type { InboxItem } from "./inbox";
import type { InboxOverrides } from "./inboxStore";

function makeOverrides(partial: Partial<InboxOverrides>): InboxOverrides {
  return {
    version: 1,
    merchantRules: {},
    transferRules: {},
    parseRules: {},
    ...partial,
  };
}

function makeItem(partial: Partial<InboxItem>): InboxItem {
  return {
    id: partial.id || "i1",
    kind: partial.kind || "UNKNOWN_MERCHANT",
    reason: partial.reason || "UNKNOWN",
    title: partial.title || "title",
    summary: partial.summary || "summary",
    severity: partial.severity || "medium",
    createdAt: partial.createdAt || "2026-02-24",
    metadata: partial.metadata || {},
  };
}

test("suppresses unknown merchant by merchantRuleKey", () => {
  const item = makeItem({
    kind: "UNKNOWN_MERCHANT",
    metadata: { merchantRuleKey: "PAYMENT TO SOMEONE" },
  });
  const overrides = makeOverrides({
    merchantRules: { "PAYMENT TO SOMEONE": { action: "always" } },
  });
  assert.equal(isInboxItemSuppressedByRule(item, overrides), true);
});

test("suppresses uncertain transfer by transfer signature", () => {
  const item = makeItem({
    kind: "UNCERTAIN_TRANSFER",
    metadata: { transferSignature: "TXFER:1000:abcd" },
  });
  const overrides = makeOverrides({
    transferRules: { "TXFER:1000:abcd": { action: "always" } },
  });
  assert.equal(isInboxItemSuppressedByRule(item, overrides), true);
});

test("suppresses parse issues by parseRuleKey", () => {
  const item = makeItem({
    kind: "PARSE_ISSUE",
    metadata: { parseRuleKey: "BALANCE_CONTINUITY_LOW::anz_v1" },
  });
  const overrides = makeOverrides({
    parseRules: { "BALANCE_CONTINUITY_LOW::anz_v1": { action: "always" } },
  });
  assert.equal(isInboxItemSuppressedByRule(item, overrides), true);
});

