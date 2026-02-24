import { NextResponse } from "next/server";
import { readReviewState, writeReviewState } from "@/lib/analysis/inboxStore";

type ResolveBody = {
  id?: string;
  note?: string;
};

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status });
}

export async function POST(request: Request) {
  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return jsonError(400, "BAD_JSON", "Invalid JSON body.");
  }

  const id = String(body.id || "").trim();
  if (!id) {
    return jsonError(400, "BAD_REQUEST", "id is required.");
  }

  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : undefined;
  const reviewState = await readReviewState();
  const nextResolved = {
    ...reviewState.resolved,
    [id]: {
      resolvedAt: new Date().toISOString(),
      note,
    },
  };
  const next = await writeReviewState({
    resolved: nextResolved,
    updatedAt: new Date().toISOString(),
  });

  return NextResponse.json({
    ok: true,
    id,
    resolvedCount: Object.keys(next.resolved).length,
    resolvedAt: next.resolved[id]?.resolvedAt,
  });
}

