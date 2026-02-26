import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { FileMeta } from "@/lib/fileStore";
import {
  deleteUploadByHash,
  listUploads,
} from "@/lib/uploads/manager";
import type { InboxReviewState } from "@/lib/analysis/inboxStore";
import type { BoundaryConfig } from "@/lib/boundary/store";

function buildMeta(overrides: Partial<FileMeta> = {}): FileMeta {
  return {
    id: "file-1",
    originalName: "sample.pdf",
    storedName: "file-1.pdf",
    size: 1234,
    mimeType: "application/pdf",
    uploadedAt: "2026-02-26T10:00:00.000Z",
    path: "uploads/file-1.pdf",
    contentHash: "hash-1",
    bankId: "cba",
    accountId: "acc-1",
    templateId: "cba_v1",
    ...overrides,
  };
}

test("listUploads returns empty when index is empty", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "uploads-manager-"));
  try {
    const result = await listUploads({
      uploadsRoot: tmpRoot,
      readIndexFn: async () => [],
    });
    assert.equal(result.length, 0);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("deleteUploadByHash removes file and index entry", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "uploads-manager-"));
  const meta = buildMeta();
  const indexRows: FileMeta[] = [meta];
  let reviewState: InboxReviewState = {
    version: 1,
    resolved: {
      "PARSE_ISSUE:file-1:HEADER_NOT_FOUND:abc": {
        resolvedAt: "2026-02-26T00:00:00.000Z",
      },
    },
  };

  try {
    await mkdir(path.join(tmpRoot, "parsed-cache"), { recursive: true });
    await mkdir(path.join(tmpRoot, "text-cache"), { recursive: true });
    await writeFile(path.join(tmpRoot, "file-1.pdf"), "PDF");
    await writeFile(path.join(tmpRoot, "parsed-cache", "file-1.json"), JSON.stringify({
      transactions: [{ id: "tx-1" }],
    }));
    await writeFile(path.join(tmpRoot, "text-cache", "file-1.txt"), "TEXT");

    const readBoundaryConfigFn = async () => {
      const config: BoundaryConfig = {
        version: 1,
        mode: "customAccounts",
        boundaryAccountIds: ["acc-1"],
        accountAliases: {},
        lastUpdatedAt: new Date().toISOString(),
      };
      return { config, exists: true };
    };

    const result = await deleteUploadByHash("hash-1", {
      uploadsRoot: tmpRoot,
      readIndexFn: async () => indexRows,
      removeByIdFn: async (id) => {
        const idx = indexRows.findIndex((row) => row.id === id);
        if (idx < 0) return undefined;
        const [removed] = indexRows.splice(idx, 1);
        return removed;
      },
      readReviewStateFn: async () => reviewState,
      writeReviewStateFn: async (next) => {
        reviewState = {
          version: 1,
          resolved: next.resolved,
        };
        return reviewState;
      },
      readBoundaryConfigFn,
    });

    assert.equal(result.ok, true);
    assert.equal(indexRows.length, 0);
    assert.equal(
      await fileExists(path.join(tmpRoot, "file-1.pdf")),
      false
    );
    assert.equal(reviewState.resolved["PARSE_ISSUE:file-1:HEADER_NOT_FOUND:abc"], undefined);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

async function fileExists(filePath: string) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
