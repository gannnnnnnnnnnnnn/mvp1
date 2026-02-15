import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readIndex } from "@/lib/fileStore";
import { rejectIfProdApi } from "@/lib/devOnly";

type ParsedCacheShape = {
  transactions?: Array<{
    date?: string;
  }>;
};

const TEXT_CACHE_DIR = path.join(process.cwd(), "uploads", "text-cache");
const SEGMENT_CACHE_DIR = path.join(process.cwd(), "uploads", "segment-cache");
const PARSED_CACHE_DIR = path.join(process.cwd(), "uploads", "parsed-cache");

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function deriveCoverage(fileId: string) {
  const parsedPath = path.join(PARSED_CACHE_DIR, `${fileId}.json`);
  try {
    const raw = await fs.readFile(parsedPath, "utf8");
    const parsed = JSON.parse(raw) as ParsedCacheShape;
    const dates = (parsed.transactions || [])
      .map((tx) => (typeof tx.date === "string" ? tx.date.slice(0, 10) : ""))
      .filter(Boolean)
      .sort();
    if (dates.length === 0) return null;
    return {
      startDate: dates[0],
      endDate: dates[dates.length - 1],
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const rejected = rejectIfProdApi();
  if (rejected) return rejected;

  try {
    const rows = await readIndex();
    const sorted = [...rows].sort(
      (a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
    );

    const files = await Promise.all(
      sorted.map(async (row) => {
        const coverage = await deriveCoverage(row.id);
        const hasTextCache = await fileExists(path.join(TEXT_CACHE_DIR, `${row.id}.txt`));
        const hasSegmentCache = await fileExists(
          path.join(SEGMENT_CACHE_DIR, `${row.id}.json`)
        );
        const hasParsedCache = await fileExists(path.join(PARSED_CACHE_DIR, `${row.id}.json`));

        return {
          fileHash: row.contentHash || `id:${row.id}`,
          fileId: row.id,
          fileName: row.originalName,
          coverage,
          bankId: row.bankId || "cba",
          accountId: row.accountId || "default",
          templateId: row.templateId || "unknown",
          parseStatus: {
            textCached: hasTextCache,
            segmentCached: hasSegmentCache,
            parsedCached: hasParsedCache,
          },
          createdAt: row.uploadedAt,
        };
      })
    );

    return NextResponse.json({ ok: true, files });
  } catch (err) {
    console.error("/api/dev/files failed", err);
    return NextResponse.json(
      {
        ok: false,
        error: { code: "IO_FAIL", message: "Failed to load dev file list." },
      },
      { status: 500 }
    );
  }
}
