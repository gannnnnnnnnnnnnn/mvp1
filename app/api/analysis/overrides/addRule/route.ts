import { NextResponse } from "next/server";
import {
  readInboxOverrides,
  readReviewState,
  writeInboxOverrides,
  writeReviewState,
} from "@/lib/analysis/inboxStore";

type AddRuleKind = "UNKNOWN_MERCHANT" | "UNCERTAIN_TRANSFER" | "PARSE_ISSUE";

type AddRuleBody = {
  id?: string;
  kind?: AddRuleKind;
  note?: string;
  category?: string;
  merchantNorm?: string;
  transferSignature?: string;
  parseRuleKey?: string;
  reason?: string;
  templateType?: string;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function parseRuleKeyFromBody(body: AddRuleBody) {
  const parseRuleKey = typeof body.parseRuleKey === "string" ? body.parseRuleKey.trim() : "";
  if (parseRuleKey) return parseRuleKey;
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const templateType = typeof body.templateType === "string" ? body.templateType.trim() : "";
  if (!reason) return "";
  return `${reason}::${templateType || "unknown"}`;
}

export async function POST(request: Request) {
  let body: AddRuleBody;
  try {
    body = (await request.json()) as AddRuleBody;
  } catch {
    return jsonError(400, "BAD_JSON", "Invalid JSON body.");
  }

  const id = String(body.id || "").trim();
  const kind = String(body.kind || "").trim() as AddRuleKind;
  if (!id) return jsonError(400, "BAD_REQUEST", "id is required.");
  if (!kind) return jsonError(400, "BAD_REQUEST", "kind is required.");

  const now = new Date().toISOString();
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  const [overrides, reviewState] = await Promise.all([
    readInboxOverrides(),
    readReviewState(),
  ]);

  let key = "";
  if (kind === "UNKNOWN_MERCHANT") {
    key = String(body.merchantNorm || "").trim();
    if (!key) return jsonError(400, "BAD_REQUEST", "merchantNorm is required.");
    overrides.merchantRules[key] = {
      action: "always",
      kind,
      category: body.category || undefined,
      note,
      updatedAt: now,
    };
  } else if (kind === "UNCERTAIN_TRANSFER") {
    key = String(body.transferSignature || "").trim();
    if (!key) return jsonError(400, "BAD_REQUEST", "transferSignature is required.");
    overrides.transferRules[key] = {
      action: "always",
      kind,
      note,
      updatedAt: now,
    };
  } else {
    key = parseRuleKeyFromBody(body);
    if (!key) return jsonError(400, "BAD_REQUEST", "parseRuleKey or reason is required.");
    overrides.parseRules[key] = {
      action: "always",
      kind,
      note,
      updatedAt: now,
    };
  }

  reviewState.resolved[id] = { resolvedAt: now, note };

  const [nextOverrides, nextReviewState] = await Promise.all([
    writeInboxOverrides({
      merchantRules: overrides.merchantRules,
      transferRules: overrides.transferRules,
      parseRules: overrides.parseRules,
      updatedAt: now,
    }),
    writeReviewState({
      resolved: reviewState.resolved,
      updatedAt: now,
    }),
  ]);

  return NextResponse.json({
    ok: true,
    id,
    kind,
    ruleKey: key,
    resolvedCount: Object.keys(nextReviewState.resolved).length,
    overrideCounts: {
      merchantRules: Object.keys(nextOverrides.merchantRules).length,
      transferRules: Object.keys(nextOverrides.transferRules).length,
      parseRules: Object.keys(nextOverrides.parseRules).length,
    },
  });
}

