import { readInboxOverrides, writeInboxOverrides } from "@/lib/analysis/inboxStore";

export const runtime = "nodejs";

type OverridePayload = {
  merchantRules?: unknown;
  transferRules?: unknown;
  parseRules?: unknown;
};

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function validateOverridePayload(input: unknown) {
  if (!isPlainObject(input)) {
    return { ok: false as const, code: "BAD_REQUEST", message: "JSON object expected." };
  }
  const body = input as OverridePayload;
  if (
    body.merchantRules !== undefined &&
    !isPlainObject(body.merchantRules)
  ) {
    return {
      ok: false as const,
      code: "BAD_REQUEST",
      message: "merchantRules must be an object.",
    };
  }
  if (
    body.transferRules !== undefined &&
    !isPlainObject(body.transferRules)
  ) {
    return {
      ok: false as const,
      code: "BAD_REQUEST",
      message: "transferRules must be an object.",
    };
  }
  if (
    body.parseRules !== undefined &&
    !isPlainObject(body.parseRules)
  ) {
    return {
      ok: false as const,
      code: "BAD_REQUEST",
      message: "parseRules must be an object.",
    };
  }

  return { ok: true as const, body };
}

export async function POST(request: Request) {
  try {
    const raw = await request.json();
    const validated = validateOverridePayload(raw);
    if (!validated.ok) {
      return Response.json(
        {
          ok: false,
          error: { code: validated.code, message: validated.message },
        },
        { status: 400 }
      );
    }

    // Read current state first so invalid or partial payloads never wipe other rules.
    const current = await readInboxOverrides();
    const merchantRules =
      validated.body.merchantRules !== undefined
        ? (validated.body.merchantRules as Record<string, unknown>)
        : current.merchantRules;
    const transferRules =
      validated.body.transferRules !== undefined
        ? (validated.body.transferRules as Record<string, unknown>)
        : current.transferRules;
    const parseRules =
      validated.body.parseRules !== undefined
        ? (validated.body.parseRules as Record<string, unknown>)
        : current.parseRules;

    const merged = {
      merchantRules,
      transferRules,
      parseRules,
    };

    const saved = await writeInboxOverrides(merged);
    return Response.json({
      ok: true,
      counts: {
        merchantRules: Object.keys(saved.merchantRules || {}).length,
        transferRules: Object.keys(saved.transferRules || {}).length,
        parseRules: Object.keys(saved.parseRules || {}).length,
      },
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return Response.json(
        {
          ok: false,
          error: { code: "BAD_JSON", message: "Invalid JSON file." },
        },
        { status: 400 }
      );
    }
    console.error("POST /api/settings/overrides/import failed", err);
    return Response.json(
      {
        ok: false,
        error: { code: "IO_FAIL", message: "Failed to import overrides." },
      },
      { status: 500 }
    );
  }
}
