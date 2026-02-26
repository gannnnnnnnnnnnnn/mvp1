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

type UploadListResponse =
  | { ok: true; files: UploadItem[] }
  | { ok: false; error: ApiError };

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SettingsPage() {
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [loadingUploads, setLoadingUploads] = useState(true);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [deleteAllBusy, setDeleteAllBusy] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);

  async function loadUploads() {
    setLoadingUploads(true);
    setError("");
    try {
      const res = await fetch("/api/uploads", { cache: "no-store" });
      const data = (await res.json()) as UploadListResponse;
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setUploads(data.files);
    } catch {
      setError("Failed to load uploads.");
    } finally {
      setLoadingUploads(false);
    }
  }

  useEffect(() => {
    void loadUploads();
  }, []);

  const totalUploadSize = useMemo(
    () => uploads.reduce((sum, item) => sum + item.size, 0),
    [uploads]
  );

  async function handleDeleteAll() {
    const confirmation = window.prompt(
      "Type DELETE ALL to remove all uploaded PDFs and derived caches."
    );
    if (confirmation !== "DELETE ALL") {
      setStatus("Delete all uploads cancelled.");
      return;
    }

    setDeleteAllBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/uploads/all", { method: "DELETE" });
      const data = (await res.json()) as
        | { ok: true; total: number; deletedCount: number }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(`Deleted ${data.deletedCount} / ${data.total} uploads.`);
      await loadUploads();
    } catch {
      setError("Failed to delete all uploads.");
    } finally {
      setDeleteAllBusy(false);
    }
  }

  async function handleResetAnalysisState() {
    const confirmation = window.prompt(
      "Type RESET ANALYSIS to clear review state and overrides."
    );
    if (confirmation !== "RESET ANALYSIS") {
      setStatus("Reset analysis state cancelled.");
      return;
    }

    setResetBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/settings/reset-analysis", {
        method: "POST",
      });
      const data = (await res.json()) as
        | { ok: true; removedFiles: string[]; removedDirs: string[] }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(
        `Analysis state reset. Removed files: ${data.removedFiles.length}, caches: ${data.removedDirs.length}.`
      );
    } catch {
      setError("Failed to reset analysis state.");
    } finally {
      setResetBusy(false);
    }
  }

  async function handleImportOverrides(file: File | null) {
    if (!file) return;
    setImportBusy(true);
    setError("");
    setStatus("");
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        setError("Invalid JSON file. Please select a valid overrides backup.");
        return;
      }

      const res = await fetch("/api/settings/overrides/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = (await res.json()) as
        | { ok: true; counts: Record<string, number> }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(
        `Overrides imported. merchant=${data.counts.merchantRules}, transfer=${data.counts.transferRules}, parse=${data.counts.parseRules}.`
      );
    } catch {
      setError("Failed to import overrides.");
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Settings</h1>
          <p className="mt-1 text-sm text-slate-600">
            Manage local data and safe reset actions.
          </p>
        </section>

        <section id="uploads-list" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Uploads</h2>
              <p className="mt-1 text-sm text-slate-600">
                Uploaded PDFs: {uploads.length} · total {formatBytes(totalUploadSize)}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href="#uploads-list"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Manage uploads
              </a>
              <button
                type="button"
                onClick={() => void handleDeleteAll()}
                disabled={deleteAllBusy}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-300"
              >
                {deleteAllBusy ? "Deleting..." : "Delete all uploads"}
              </button>
            </div>
          </div>

          {loadingUploads ? (
            <p className="mt-4 text-sm text-slate-500">Loading uploads...</p>
          ) : uploads.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No uploads found.</p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-3 py-2">File</th>
                    <th className="px-3 py-2">Bank/Account</th>
                    <th className="px-3 py-2">Uploaded</th>
                    <th className="px-3 py-2">Size</th>
                    <th className="px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 bg-white">
                  {uploads.map((item) => (
                    <tr key={item.fileHash}>
                      <td className="px-3 py-2 text-slate-900">{item.originalName}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {(item.bankId || "unknown").toUpperCase()} ·{" "}
                        {(item.accountIds || []).join(", ") || "n/a"}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">
                        {item.uploadedAt.slice(0, 10)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-600">{formatBytes(item.size)}</td>
                      <td className="px-3 py-2 text-xs text-slate-600">{item.parseStatus.stage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Analysis State</h2>
          <p className="mt-1 text-sm text-slate-600">
            Reset review state, overrides, and derived analysis caches. PDFs are kept.
          </p>
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void handleResetAnalysisState()}
              disabled={resetBusy}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {resetBusy ? "Resetting..." : "Reset analysis state"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Overrides</h2>
          <p className="mt-1 text-sm text-slate-600">
            Backup and import merchant/transfer/parse rules.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a
              href="/api/settings/overrides/export"
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              Backup overrides.json
            </a>
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100">
              {importBusy ? "Importing..." : "Import overrides.json"}
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                disabled={importBusy}
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  void handleImportOverrides(file);
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Invalid JSON is rejected safely; existing overrides stay unchanged.
          </p>
        </section>

        {status ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {status}
          </div>
        ) : null}
        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}
