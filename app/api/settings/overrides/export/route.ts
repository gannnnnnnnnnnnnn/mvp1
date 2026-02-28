import { readInboxOverrides } from "@/lib/analysis/inboxStore";

export const runtime = "nodejs";

export async function GET() {
  try {
    const overrides = await readInboxOverrides();
    const stamp = new Date().toISOString().slice(0, 10);
    return new Response(JSON.stringify(overrides, null, 2), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename=\"overrides.${stamp}.json\"`,
      },
    });
  } catch (err) {
    console.error("GET /api/settings/overrides/export failed", err);
    return Response.json(
      {
        ok: false,
        error: { code: "IO_FAIL", message: "Failed to export overrides." },
      },
      { status: 500 }
    );
  }
}
