import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

type PipelineRequest = {
  fileId?: string;
  force?: boolean;
};

const FILE_ID_SAFE_RE = /^[a-zA-Z0-9_-]+$/;

const uploadsDir = path.join(process.cwd(), "uploads");
const segmentCacheDir = path.join(uploadsDir, "segment-cache");
const parsedCacheDir = path.join(uploadsDir, "parsed-cache");

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      err.code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

async function writeJsonFile(filePath: string, payload: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, filePath);
}

export async function POST(request: Request) {
  let body: PipelineRequest | null = null;
  try {
    body = (await request.json()) as PipelineRequest;
  } catch {
    return errorJson(400, "BAD_JSON", "Request body must be valid JSON.");
  }

  const fileId = (body?.fileId || "").trim();
  const force = body?.force === true;
  if (!fileId) {
    return errorJson(400, "BAD_REQUEST", "fileId is required.");
  }
  if (!FILE_ID_SAFE_RE.test(fileId)) {
    return errorJson(400, "BAD_FILE_ID", "fileId format is invalid.");
  }

  const segmentCachePath = path.join(segmentCacheDir, `${fileId}.json`);
  const parsedCachePath = path.join(parsedCacheDir, `${fileId}.json`);

  try {
    if (!force) {
      const parsedCached = await readJsonFile<Record<string, unknown>>(parsedCachePath);
      if (parsedCached) {
        return NextResponse.json({
          ok: true,
          fileId,
          cached: { text: true, segment: true, parsed: true },
          parsed: parsedCached,
        });
      }
    }

    const origin = new URL(request.url).origin;

    const textRes = await fetch(`${origin}/api/parse/pdf-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId, force }),
    });
    const textData = (await textRes.json()) as
      | { ok: true; text: string; meta: Record<string, unknown> }
      | { ok: false; error: { code: string; message: string } };
    if (!textData.ok) {
      return errorJson(500, "PIPELINE_TEXT_FAIL", textData.error.message);
    }

    let segmentData:
      | { ok: true; fileId: string; sectionText: string; debug: Record<string, unknown> }
      | { ok: false; error: { code: string; message: string } }
      | null = null;
    let segmentCached = false;

    if (!force) {
      const cached = await readJsonFile<{
        ok: true;
        fileId: string;
        sectionText: string;
        debug: Record<string, unknown>;
      }>(segmentCachePath);
      if (cached) {
        segmentCached = true;
        segmentData = cached;
      }
    }

    if (!segmentData) {
      const segmentRes = await fetch(`${origin}/api/parse/pdf-segment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId }),
      });
      segmentData = (await segmentRes.json()) as
        | { ok: true; fileId: string; sectionText: string; debug: Record<string, unknown> }
        | { ok: false; error: { code: string; message: string } };
      if (!segmentData.ok) {
        return errorJson(500, "PIPELINE_SEGMENT_FAIL", segmentData.error.message);
      }
      await writeJsonFile(segmentCachePath, segmentData);
    }

    const parseRes = await fetch(`${origin}/api/parse/pdf-transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId }),
    });
    const parseData = (await parseRes.json()) as
      | { ok: true; transactions?: Array<Record<string, unknown>> }
      | { ok: false; error: { code: string; message: string } };

    if (!parseData.ok) {
      return errorJson(500, "PIPELINE_PARSE_FAIL", parseData.error.message);
    }

    await writeJsonFile(parsedCachePath, parseData);

    return NextResponse.json({
      ok: true,
      fileId,
      cached: {
        text: textData.ok && textData.meta?.cached === true && !force,
        segment: segmentCached,
        parsed: false,
      },
      parsed: parseData,
      txCount: Array.isArray(parseData.transactions) ? parseData.transactions.length : 0,
    });
  } catch (err) {
    console.error("/api/pipeline/run failed", err);
    return errorJson(500, "IO_FAIL", "Pipeline run failed.");
  }
}

