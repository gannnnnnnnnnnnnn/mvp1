import { InboxItem } from "@/lib/analysis/inbox";
import { InboxOverrides } from "@/lib/analysis/inboxStore";

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function metadataString(item: InboxItem, key: string) {
  return readString(item.metadata?.[key]);
}

function unknownMerchantRuleKey(item: InboxItem) {
  return (
    metadataString(item, "merchantRuleKey") ||
    metadataString(item, "merchantNorm") ||
    ""
  );
}

function transferRuleKey(item: InboxItem) {
  return (
    metadataString(item, "transferSignature") ||
    metadataString(item, "pairKey") ||
    metadataString(item, "matchId") ||
    ""
  );
}

function parseRuleKey(item: InboxItem) {
  return (
    metadataString(item, "parseRuleKey") ||
    readString(item.reason) ||
    ""
  );
}

export function inboxRuleKeyForItem(item: InboxItem): string {
  if (item.kind === "UNKNOWN_MERCHANT") return unknownMerchantRuleKey(item);
  if (item.kind === "UNCERTAIN_TRANSFER") return transferRuleKey(item);
  return parseRuleKey(item);
}

export function isInboxItemSuppressedByRule(
  item: InboxItem,
  overrides: InboxOverrides
) {
  const key = inboxRuleKeyForItem(item);
  if (!key) return false;
  if (item.kind === "UNKNOWN_MERCHANT") {
    return Boolean(overrides.merchantRules[key]);
  }
  if (item.kind === "UNCERTAIN_TRANSFER") {
    return Boolean(overrides.transferRules[key]);
  }
  return Boolean(overrides.parseRules[key]);
}

