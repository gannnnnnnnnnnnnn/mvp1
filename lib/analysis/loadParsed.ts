import { promises as fs } from "fs";
import path from "path";
import { findById } from "@/lib/fileStore";
import { parseMainText } from "@/lib/parsing/mainParse";

const FILE_ID_RE = /^[a-zA-Z0-9_-]+$/;
const TEXT_CACHE_ROOT = path.join(process.cwd(), "uploads", "text-cache");

export type ParsedFileAnalysis = ReturnType<typeof parseMainText> & {
  fileId: string;
};

/**
 * Load cached text and run the canonical parser entry used by API routes.
 * This keeps analysis and parse endpoints on the same template detection/parsing behavior.
 */
export async function loadParsedTransactions(fileId: string): Promise<ParsedFileAnalysis> {
  if (!FILE_ID_RE.test(fileId)) {
    throw new Error("BAD_FILE_ID");
  }

  const textPath = path.join(TEXT_CACHE_ROOT, `${fileId}.txt`);
  const text = await fs.readFile(textPath, "utf8");
  const fileMeta = await findById(fileId);

  const parsed = parseMainText({
    fileId,
    text,
    fileHash: fileMeta?.contentHash,
    fileName: fileMeta?.originalName,
    accountIdHint: fileMeta?.accountId,
  });

  return {
    fileId,
    ...parsed,
  };
}
