import { NextResponse } from "next/server";
import {
  readInboxOverrides,
  readReviewState,
  writeInboxOverrides,
  writeReviewState,
} from "@/lib/analysis/inboxStore";

type ApplyOnceKind = "UNKNOWN_MERCHANT" | "UNCERTAIN_TRANSFER" | "PARSE_ISSUE";

type ApplyOnceBody = {
  id?: string;
  kind?: ApplyOnceKind;
  note?: string;
  category?: string;
  merchantNorm?: string;
  transferSignature?: string;
  parseRuleKey?: string;
  reason?: string;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

function onceKey(id: string) {
  return `once:${id}`;
}

export async function POST(request: Request) {
  let body: ApplyOnceBody;
  try {
    body = (await request.json()) as ApplyOnceBody;
  } catch {
    return jsonError(400, "BAD_JSON", "Invalid JSON body.");
  }

  const id = String(body.id || "").trim();
  const kind = String(body.kind || "").trim() as ApplyOnceKind;
  if (!id) return jsonError(400, "BAD_REQUEST", "id is required.");
  if (!kind) return jsonError(400, "BAD_REQUEST", "kind is required.");

  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  const now = new Date().toISOString();
  const [overrides, reviewState] = await Promise.all([
    readInboxOverrides(),
    readReviewState(),
  ]);

  const entry = {
    action: "applyOnce",
    kind,
    note,
    appliedAt: now,
    merchantNorm: body.merchantNorm,
    transferSignature: body.transferSignature,
    parseRuleKey: body.parseRuleKey,
    reason: body.reason,
    category: body.category,
  };

  const key = onceKey(id);
  if (kind === "UNKNOWN_MERCHANT") {
    overrides.merchantRules[key] = entry;
  } else if (kind === "UNCERTAIN_TRANSFER") {
    overrides.transferRules[key] = entry;
  } else {
    overrides.parseRules[key] = entry;
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
    overrideEntryKey: key,
    resolvedCount: Object.keys(nextReviewState.resolved).length,
    overrideCounts: {
      merchantRules: Object.keys(nextOverrides.merchantRules).length,
      transferRules: Object.keys(nextOverrides.transferRules).length,
      parseRules: Object.keys(nextOverrides.parseRules).length,
    },
  });
}

