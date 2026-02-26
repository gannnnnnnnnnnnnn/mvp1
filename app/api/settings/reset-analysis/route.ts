import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";

const uploadsRoot = path.join(process.cwd(), "uploads");
const resetFiles = ["review_state.json", "overrides.json"];
const resetDirs = ["analysis-cache", "transfer-cache"];

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function hasErrnoCode(err: unknown, code: string) {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

async function unlinkIfExists(filePath: string) {
  try {
    await fs.unlink(filePath);
    return true;
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

async function removeDirIfExists(dirPath: string) {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
    return true;
  } catch (err: unknown) {
    if (hasErrnoCode(err, "ENOENT")) return false;
    throw err;
  }
}

export async function POST() {
  try {
    await fs.mkdir(uploadsRoot, { recursive: true });

    const removedFiles: string[] = [];
    const removedDirs: string[] = [];

    for (const fileName of resetFiles) {
      const removed = await unlinkIfExists(path.join(uploadsRoot, fileName));
      if (removed) removedFiles.push(fileName);
    }

    for (const dirName of resetDirs) {
      const removed = await removeDirIfExists(path.join(uploadsRoot, dirName));
      if (removed) removedDirs.push(dirName);
    }

    return NextResponse.json({
      ok: true,
      removedFiles,
      removedDirs,
    });
  } catch (err) {
    console.error("POST /api/settings/reset-analysis failed", err);
    return errorJson(500, "IO_FAIL", "Failed to reset analysis state.");
  }
}
