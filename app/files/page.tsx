"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { getWarningCatalogEntry } from "@/lib/warnings/catalog";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  Modal,
  MotionCard,
  SectionHeader,
  Table,
  TableFrame,
  TBody,
  TD,
  TH,
  THead,
  Toast,
  TR,
} from "@/components/ui";

type ApiError = { code: string; message: string };

type UploadItem = {
  fileHash: string;
  fileId: string;
  originalName: string;
  size: number;
  uploadedAt: string;
  bankId?: string;
  accountIds: string[];
  templateId?: string;
  warnings: Array<{
    code: string;
    message?: string;
    meta?: Record<string, unknown>;
  }>;
  parseStatus: {
    stage: "uploaded" | "extracted" | "segmented" | "parsed";
    txCount?: number;
    warnings?: number;
    needsReview?: boolean;
  };
};

type ListResponse =
  | { ok: true; files: UploadItem[] }
  | { ok: false; error: ApiError };

type DeleteResponse =
  | {
      ok: true;
      boundaryWarning: {
        missingAccountIds: string[];
        message: string;
      } | null;
    }
  | { ok: false; error: ApiError };

type DeleteAllResponse =
  | { ok: true; total: number; deletedCount: number }
  | { ok: false; error: ApiError };

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatStage(row: UploadItem["parseStatus"]) {
  if (row.stage === "parsed") {
    const notes = typeof row.warnings === "number" ? row.warnings : 0;
    const txCount = typeof row.txCount === "number" ? row.txCount : 0;
    const review = row.needsReview ? " · review needed" : "";
    return `Parsed · ${txCount} transactions · ${notes} notes${review}`;
  }
  return row.stage;
}

export default function FilesManagerPage() {
  const [rows, setRows] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [boundaryWarning, setBoundaryWarning] = useState("");
  const [confirmFile, setConfirmFile] = useState<UploadItem | null>(null);
  const [warningFile, setWarningFile] = useState<UploadItem | null>(null);
  const [deletingHash, setDeletingHash] = useState("");
  const [deletingAll, setDeletingAll] = useState(false);

  async function loadRows() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/uploads", { cache: "no-store" });
      const data = (await res.json()) as ListResponse;
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setRows(data.files);
    } catch {
      setError("Failed to load uploads.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadRows();
  }, []);

  async function handleDelete(file: UploadItem) {
    setDeletingHash(file.fileHash);
    setStatus("");
    setBoundaryWarning("");
    try {
      const res = await fetch(`/api/uploads?fileHash=${encodeURIComponent(file.fileHash)}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as DeleteResponse;
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(`Deleted ${file.originalName}.`);
      if (data.boundaryWarning?.message) {
        setBoundaryWarning(data.boundaryWarning.message);
      }
      setConfirmFile(null);
      await loadRows();
    } catch {
      setError("Delete failed.");
    } finally {
      setDeletingHash("");
    }
  }

  async function handleDeleteAll() {
    const confirmation = window.prompt("Type DELETE ALL to remove all uploaded PDFs and derived caches.");
    if (confirmation !== "DELETE ALL") {
      setStatus("Delete all uploads cancelled.");
      return;
    }

    setDeletingAll(true);
    setStatus("");
    setError("");
    setBoundaryWarning("");
    try {
      const res = await fetch("/api/uploads/all", { method: "DELETE" });
      const data = (await res.json()) as DeleteAllResponse;
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(`Deleted ${data.deletedCount} / ${data.total} uploads.`);
      await loadRows();
    } catch {
      setError("Delete all uploads failed.");
    } finally {
      setDeletingAll(false);
    }
  }

  const totalSizeLabel = useMemo(() => formatSize(rows.reduce((sum, row) => sum + row.size, 0)), [rows]);

  return (
    <main className="px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <MotionCard>
          <SectionHeader
            eyebrow="Files"
            title="Manage uploaded statements"
            description="Remove PDFs you no longer need and inspect import notes before they affect your report."
            action={
              <div className="flex flex-wrap gap-2">
                <ButtonLink href="/onboarding" variant="secondary">Add more files</ButtonLink>
                <Button variant="destructive" onClick={() => void handleDeleteAll()} disabled={deletingAll || rows.length === 0}>
                  {deletingAll ? "Deleting..." : "Delete all uploads"}
                </Button>
              </div>
            }
          />
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge>Files {rows.length}</Badge>
            <Badge>Storage {totalSizeLabel}</Badge>
          </div>
        </MotionCard>

        <Toast message={error || boundaryWarning || status} tone={error ? "error" : boundaryWarning ? "warning" : status ? "success" : "neutral"} />

        {loading ? <MotionCard><p className="text-sm text-slate-500">Loading files...</p></MotionCard> : null}

        {!loading && rows.length === 0 ? (
          <EmptyState
            title="No uploaded files yet"
            body="Upload your first statement to start building a report. You can always come back here to clean up older files."
            action={<ButtonLink href="/onboarding">Upload first PDF</ButtonLink>}
          />
        ) : null}

        {!loading && rows.length > 0 ? (
          <MotionCard>
            <SectionHeader
              title="Library"
              description="Local-first storage. Deleting a file also removes its derived caches and linked review state."
            />
            <div className="mt-5">
              <TableFrame>
                <Table>
                  <THead>
                    <tr>
                      <TH>File</TH>
                      <TH>Account</TH>
                      <TH>Uploaded</TH>
                      <TH>Size</TH>
                      <TH>Notes</TH>
                      <TH className="text-right">Action</TH>
                    </tr>
                  </THead>
                  <TBody>
                    {rows.map((row) => (
                      <TR key={row.fileHash}>
                        <TD className="max-w-[320px]">
                          <div className="truncate font-medium text-slate-900">{row.originalName}</div>
                          <div className="mt-1 text-xs text-slate-500">{formatStage(row.parseStatus)}</div>
                        </TD>
                        <TD>
                          <div className="text-sm text-slate-900">{row.bankId?.toUpperCase() || "Account details incomplete"}</div>
                          <div className="mt-1 text-xs text-slate-500">{(row.accountIds || []).join(", ") || "No account details yet"}</div>
                        </TD>
                        <TD className="text-sm text-slate-600">{row.uploadedAt.slice(0, 10)}</TD>
                        <TD className="text-sm text-slate-600">{formatSize(row.size)}</TD>
                        <TD>
                          {row.warnings.length > 0 ? (
                            <button
                              type="button"
                              onClick={() => setWarningFile(row)}
                              className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 transition hover:bg-amber-100"
                            >
                              {row.warnings.length} notes
                            </button>
                          ) : (
                            <Badge tone="green">No notes</Badge>
                          )}
                        </TD>
                        <TD className="text-right">
                          <Button variant="destructive" size="sm" onClick={() => setConfirmFile(row)}>
                            Delete
                          </Button>
                        </TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </TableFrame>
            </div>
          </MotionCard>
        ) : null}
      </div>

      <Modal
        open={Boolean(confirmFile)}
        onClose={() => setConfirmFile(null)}
        title="Delete this PDF?"
        subtitle="This removes the PDF, its derived caches, and linked review state."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmFile(null)} disabled={!!confirmFile && deletingHash === confirmFile.fileHash}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => confirmFile && void handleDelete(confirmFile)}
              disabled={!confirmFile || deletingHash === confirmFile.fileHash}
            >
              {confirmFile && deletingHash === confirmFile.fileHash ? "Deleting..." : "Confirm delete"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          <span className="font-medium text-slate-900">{confirmFile?.originalName}</span>
          {" "}will be removed from local storage.
        </p>
      </Modal>

      <Modal
        open={Boolean(warningFile)}
        onClose={() => setWarningFile(null)}
        title="Import notes"
        subtitle={warningFile?.originalName || ""}
        footer={
          <>
            <ButtonLink href="/onboarding" variant="secondary">Review boundary setup</ButtonLink>
            <Button
              variant="destructive"
              onClick={() => {
                if (!warningFile) return;
                setConfirmFile(warningFile);
                setWarningFile(null);
              }}
            >
              Delete this PDF
            </Button>
          </>
        }
      >
        <div className="max-h-[60vh] space-y-3 overflow-y-auto">
          {warningFile?.warnings.map((warning, idx) => {
            const catalog = getWarningCatalogEntry(warning.code);
            return (
              <motion.div
                key={`${warning.code}-${idx}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-[22px] border border-slate-200 bg-slate-50 px-4 py-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold text-slate-900">{catalog.title}</div>
                    <div className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">{warning.code}</div>
                  </div>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-700">{catalog.explain}</p>
                <p className="mt-2 text-sm text-slate-500">Suggested action: {catalog.suggestion}</p>
                {warning.message ? (
                  <details className="mt-3 text-xs text-slate-500">
                    <summary className="cursor-pointer list-none font-medium text-slate-600">Details</summary>
                    <div className="mt-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">{warning.message}</div>
                  </details>
                ) : null}
              </motion.div>
            );
          })}
          {warningFile && warningFile.warnings.length === 0 ? (
            <p className="text-sm text-slate-500">No notes stored for this file.</p>
          ) : null}
        </div>
      </Modal>
    </main>
  );
}
