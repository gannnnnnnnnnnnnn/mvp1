"use client";

import { useEffect, useMemo, useState } from "react";

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
    const warnings = typeof row.warnings === "number" ? row.warnings : 0;
    const txCount = typeof row.txCount === "number" ? row.txCount : 0;
    const review = row.needsReview ? " · needs review" : "";
    return `parsed · ${txCount} tx · ${warnings} warnings${review}`;
  }
  return row.stage;
}

export default function FilesManagerPage() {
  const [rows, setRows] = useState<UploadItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [boundaryWarning, setBoundaryWarning] = useState<string>("");
  const [confirmFile, setConfirmFile] = useState<UploadItem | null>(null);
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
      const res = await fetch(
        `/api/uploads?fileHash=${encodeURIComponent(file.fileHash)}`,
        { method: "DELETE" }
      );
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
    const confirmation = window.prompt(
      "Type DELETE ALL to remove all uploaded PDFs and derived caches."
    );
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

  const totalSizeLabel = useMemo(() => {
    const total = rows.reduce((sum, row) => sum + row.size, 0);
    return formatSize(total);
  }, [rows]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-6xl space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Uploaded Files</h1>
              <p className="mt-1 text-sm text-slate-600">
                Manage local PDFs and derived cache artifacts.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="/onboarding"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Go to Onboarding
              </a>
              <a
                href="/phase3"
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                Open Report
              </a>
              <button
                type="button"
                onClick={() => void handleDeleteAll()}
                disabled={deletingAll || rows.length === 0}
                className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingAll ? "Deleting..." : "Delete all"}
              </button>
            </div>
          </div>

          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            files: {rows.length} · total size: {totalSizeLabel}
          </div>

          {loading ? <p className="mt-4 text-sm text-slate-500">Loading files...</p> : null}
          {error ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          ) : null}
          {status ? (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              {status}
            </div>
          ) : null}
          {boundaryWarning ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {boundaryWarning}
            </div>
          ) : null}

          {!loading && rows.length === 0 ? (
            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              <p>No uploaded files yet.</p>
              <a
                href="/onboarding"
                className="mt-2 inline-flex items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Upload first PDF
              </a>
            </div>
          ) : null}

          {!loading && rows.length > 0 ? (
            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">File</th>
                    <th className="px-3 py-2">Bank/Account</th>
                    <th className="px-3 py-2">Uploaded</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Parse status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white text-slate-700">
                  {rows.map((row) => (
                    <tr key={row.fileHash}>
                      <td className="max-w-[280px] px-3 py-2">
                        <div className="truncate font-medium text-slate-900">{row.originalName}</div>
                        <div className="text-xs text-slate-500">{row.fileHash.slice(0, 16)}...</div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div>{row.bankId?.toUpperCase() || "unknown"}</div>
                        <div className="text-slate-500">
                          {(row.accountIds || []).join(", ") || "n/a"}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">{row.uploadedAt.slice(0, 10)}</td>
                      <td className="px-3 py-2 text-xs">{formatSize(row.size)}</td>
                      <td className="px-3 py-2 text-xs">{formatStage(row.parseStatus)}</td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            setError("");
                            setConfirmFile(row);
                          }}
                          className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100"
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </div>

      {confirmFile ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/35 px-4">
          <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
            <h2 className="text-base font-semibold text-slate-900">Delete uploaded file?</h2>
            <p className="mt-2 text-sm text-slate-600">
              This removes the PDF and related caches for:
              <span className="mt-1 block font-medium text-slate-900">
                {confirmFile.originalName}
              </span>
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Review state entries linked to this file will also be cleaned.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmFile(null)}
                disabled={deletingHash === confirmFile.fileHash}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete(confirmFile)}
                disabled={deletingHash === confirmFile.fileHash}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                {deletingHash === confirmFile.fileHash ? "Deleting..." : "Confirm delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
