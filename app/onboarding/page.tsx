"use client";

import { useEffect, useMemo, useState } from "react";
import {
  formatAccountLabel,
  formatAccountSupportText,
  isUnknownAccountIdentity,
} from "@/lib/boundary/accountLabels";

type ApiError = { code: string; message: string };

type FileMeta = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

type PipelineStatus = {
  key: string;
  fileName: string;
  stage: "uploading" | "parsing" | "done" | "failed";
  message?: string;
  txCount?: number;
};

type KnownAccount = {
  bankId: string;
  accountId: string;
  accountName?: string;
  accountKey?: string;
  accountNumber?: string;
  fileCount: number;
  sampleFileName?: string;
  dateRange?: { from: string; to: string };
};

type BoundaryResponse = {
  ok: true;
  config: {
    version: 1;
    mode: "customAccounts";
    boundaryAccountIds: string[];
    accountAliases: Record<string, string>;
    lastUpdatedAt: string;
  };
  knownAccounts: KnownAccount[];
  needsSetup: boolean;
} | {
  ok: false;
  error: ApiError;
};

type Step = 1 | 2 | 3;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [pipelineStatuses, setPipelineStatuses] = useState<PipelineStatus[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [success, setSuccess] = useState("");
  const [boundary, setBoundary] = useState<BoundaryResponse | null>(null);
  const [boundaryDraft, setBoundaryDraft] = useState<string[]>([]);
  const [boundaryAliasDraft, setBoundaryAliasDraft] = useState<Record<string, string>>({});
  const [isSavingBoundary, setIsSavingBoundary] = useState(false);
  const [existingUploads, setExistingUploads] = useState(0);

  const selectedSummary = useMemo(() => {
    if (selectedFiles.length === 0) return "No files selected";
    if (selectedFiles.length === 1) {
      const file = selectedFiles[0];
      return `${file.name} · ${formatSize(file.size)}`;
    }
    const totalSize = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    return `${selectedFiles.length} files · ${formatSize(totalSize)}`;
  }, [selectedFiles]);

  const pipelineSummary = useMemo(() => {
    const total = pipelineStatuses.length;
    const done = pipelineStatuses.filter((item) => item.stage === "done").length;
    const failed = pipelineStatuses.filter((item) => item.stage === "failed").length;
    const finished = total > 0 && done + failed === total;
    return { total, done, failed, finished };
  }, [pipelineStatuses]);

  function updateStatus(next: PipelineStatus) {
    setPipelineStatuses((prev) => {
      const idx = prev.findIndex((item) => item.key === next.key);
      if (idx === -1) return [...prev, next];
      const clone = [...prev];
      clone[idx] = { ...clone[idx], ...next };
      return clone;
    });
  }

  async function fetchBoundarySummary() {
    try {
      const res = await fetch("/api/analysis/boundary", { cache: "no-store" });
      const data = (await res.json()) as BoundaryResponse;
      setBoundary(data);
      if (data.ok) {
        setBoundaryDraft(data.config.boundaryAccountIds);
        setBoundaryAliasDraft(data.config.accountAliases || {});
        if (data.knownAccounts.length > 0) {
          setStep(2);
        }
      }
    } catch {
      setBoundary({
        ok: false,
        error: { code: "BOUNDARY_FAILED", message: "Failed to load detected accounts." },
      });
    }
  }

  async function fetchExistingUploadsCount() {
    try {
      const res = await fetch("/api/uploads", { cache: "no-store" });
      const data = (await res.json()) as
        | { ok: true; files: unknown[] }
        | { ok: false; error: ApiError };
      if (!data.ok) return;
      setExistingUploads(Array.isArray(data.files) ? data.files.length : 0);
    } catch {
      // Keep onboarding resilient; missing count is non-blocking.
    }
  }

  async function runAutoPipeline(file: FileMeta, key: string) {
    updateStatus({
      key,
      fileName: file.originalName,
      stage: "parsing",
      message: "Running extract/segment/parse...",
    });

    const res = await fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileId: file.id }),
    });

    const data = (await res.json()) as
      | { ok: true; txCount?: number }
      | { ok: false; error: ApiError };

    if (!data.ok) {
      updateStatus({
        key,
        fileName: file.originalName,
        stage: "failed",
        message: `${data.error.code}: ${data.error.message}`,
      });
      return false;
    }

    updateStatus({
      key,
      fileName: file.originalName,
      stage: "done",
      txCount: data.txCount,
      message: "Pipeline complete.",
    });
    return true;
  }

  async function handleUploadAndParse() {
    if (selectedFiles.length === 0) {
      setError({ code: "NO_FILE", message: "Please select at least one PDF file." });
      return;
    }
    setIsRunning(true);
    setPipelineStatuses([]);
    setError(null);
    setSuccess("");

    try {
      let uploaded = 0;
      for (let idx = 0; idx < selectedFiles.length; idx += 1) {
        const file = selectedFiles[idx];
        const key = `${file.name}-${file.lastModified}-${idx}`;
        updateStatus({ key, fileName: file.name, stage: "uploading", message: "Uploading..." });

        const form = new FormData();
        form.append("file", file);
        const uploadRes = await fetch("/api/upload", { method: "POST", body: form });
        const uploadData = (await uploadRes.json()) as
          | { ok: true; file: FileMeta }
          | { ok: false; error: ApiError };

        if (!uploadData.ok) {
          updateStatus({
            key,
            fileName: file.name,
            stage: "failed",
            message:
              uploadData.error.code === "DUPLICATE_FILE"
                ? "Already uploaded."
                : `${uploadData.error.code}: ${uploadData.error.message}`,
          });
          continue;
        }

        uploaded += 1;
        const ok = await runAutoPipeline(uploadData.file, key);
        if (!ok) continue;
      }

      setSelectedFiles([]);
      setSuccess(
        uploaded > 0
          ? "Upload and parse finished. Continue to boundary setup."
          : "No new files uploaded. Continue to boundary setup."
      );
      await fetchBoundarySummary();
      await fetchExistingUploadsCount();
      setStep(2);
    } catch {
      setError({ code: "UPLOAD_FAILED", message: "Upload failed. Please try again." });
    } finally {
      setIsRunning(false);
    }
  }

  function toggleBoundary(accountId: string) {
    setBoundaryDraft((prev) => {
      if (prev.includes(accountId)) {
        return prev.filter((id) => id !== accountId);
      }
      return [...prev, accountId].sort();
    });
  }

  async function handleSaveBoundaryAndContinue() {
    if (!boundary || !boundary.ok) return;
    setIsSavingBoundary(true);
    setError(null);
    try {
      const res = await fetch("/api/analysis/boundary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          boundaryAccountIds: boundaryDraft,
          accountAliases: boundaryAliasDraft,
        }),
      });
      const data = (await res.json()) as BoundaryResponse;
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setBoundary(data);
      setStep(3);
      window.location.href = "/phase3?onboarding=1";
    } catch {
      setError({ code: "BOUNDARY_SAVE_FAILED", message: "Failed to save boundary config." });
    } finally {
      setIsSavingBoundary(false);
    }
  }

  useEffect(() => {
    void fetchBoundarySummary();
    void fetchExistingUploadsCount();
  }, []);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Onboarding</h1>
          <p className="mt-1 text-sm text-slate-600">
            3-minute setup to your first report.
          </p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-600">
            <span className={`rounded-full border px-2 py-1 ${step >= 1 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-slate-50"}`}>1) Upload</span>
            <span className={`rounded-full border px-2 py-1 ${step >= 2 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-slate-50"}`}>2) Boundary</span>
            <span className={`rounded-full border px-2 py-1 ${step >= 3 ? "border-blue-300 bg-blue-50 text-blue-700" : "border-slate-200 bg-slate-50"}`}>3) Report</span>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Step 1: Upload PDF</h2>
          <p className="mt-1 text-sm text-slate-600">Drop PDFs here. We will upload and auto-parse.</p>
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Existing uploads: {existingUploads} ·{" "}
            <a href="/files" className="font-medium text-blue-700 hover:underline">
              Open Files manager
            </a>
          </div>

          <div className="mt-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-700 hover:border-blue-500 hover:bg-blue-50">
              <input
                type="file"
                multiple
                accept=".pdf,.csv,application/pdf,text/csv"
                className="hidden"
                onChange={(e) => {
                  setSelectedFiles(Array.from(e.target.files || []));
                  setError(null);
                }}
              />
              <span className="text-base font-medium">Drop PDFs here</span>
              <span className="text-xs text-slate-500">CommBank/ANZ text-based PDFs.</span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <div className="text-sm text-slate-700">{selectedSummary}</div>
            <button
              type="button"
              onClick={() => void handleUploadAndParse()}
              disabled={isRunning}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isRunning ? "Running..." : "Upload & Parse"}
            </button>
          </div>

          {pipelineStatuses.length > 0 ? (
            <div className="mt-4 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
              <div>
                done {pipelineSummary.done}/{pipelineSummary.total} · failed {pipelineSummary.failed}
              </div>
              {pipelineStatuses.map((item) => (
                <div key={item.key} className="rounded border border-slate-200 bg-white p-2">
                  <div className="font-medium text-slate-800">{item.fileName}</div>
                  <div className="mt-1">
                    stage: {item.stage}
                    {typeof item.txCount === "number" ? ` · txCount: ${item.txCount}` : ""}
                  </div>
                  {item.message ? <div className="mt-1 text-slate-600">{item.message}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Step 2: Confirm boundary</h2>
          <p className="mt-1 text-sm text-slate-600">
            Boundary defines which accounts are inside your world. Transfers inside boundary can be offset.
          </p>

          {boundary?.ok ? (
            boundary.knownAccounts.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">No accounts detected yet. Complete step 1 first.</p>
            ) : (
              <>
                <div className="mt-4 max-h-72 space-y-2 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3">
                  {boundary.knownAccounts.map((account) => (
                    <label
                      key={`${account.bankId}:${account.accountId}`}
                      className="flex cursor-pointer items-start gap-2 rounded border border-slate-200 bg-white px-3 py-2"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 h-4 w-4 rounded border-slate-300"
                        checked={boundaryDraft.includes(account.accountId)}
                        onChange={() => toggleBoundary(account.accountId)}
                      />
                      <span className="text-xs text-slate-700">
                        <span className="font-medium text-slate-900">
                          {account.bankId.toUpperCase()} ·{" "}
                          {formatAccountLabel({
                            ...account,
                            alias: boundaryAliasDraft[account.accountId],
                          })}
                        </span>
                        <span className="ml-2 text-slate-500">
                          {formatAccountSupportText({
                            ...account,
                            alias: boundaryAliasDraft[account.accountId],
                          })}
                        </span>
                        <span className="ml-2 text-slate-500">
                          files: {account.fileCount}
                          {account.dateRange
                            ? ` · ${account.dateRange.from} → ${account.dateRange.to}`
                            : ""}
                        </span>
                        {isUnknownAccountIdentity(account) ? (
                          <span className="mt-1 block text-amber-700">
                            Unknown/default identity. Not auto-selected.
                          </span>
                        ) : null}
                        <span className="mt-2 block">
                          <input
                            type="text"
                            value={boundaryAliasDraft[account.accountId] || ""}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) =>
                              setBoundaryAliasDraft((prev) => ({
                                ...prev,
                                [account.accountId]: e.target.value,
                              }))
                            }
                            placeholder="Rename / alias (optional)"
                            className="h-8 w-full rounded border border-slate-300 bg-white px-2 text-xs text-slate-700"
                          />
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                <div className="mt-4">
                  <button
                    type="button"
                    disabled={isSavingBoundary || boundaryDraft.length === 0}
                    onClick={() => void handleSaveBoundaryAndContinue()}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                  >
                    {isSavingBoundary ? "Saving..." : "Continue"}
                  </button>
                </div>
              </>
            )
          ) : (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {boundary?.error.code || "BOUNDARY_FAILED"}: {boundary?.error.message || "Failed to load boundary config."}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Step 3: Go to report</h2>
          <p className="mt-1 text-sm text-slate-600">
            You will be redirected to Dataset Home. We will show a reminder about uncertain transfers and Inbox review.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <a
              href="/phase3?onboarding=1"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Open /phase3
            </a>
            <a
              href="/inbox"
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Open Inbox
            </a>
          </div>
        </section>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error.code}: {error.message}
          </div>
        ) : null}
        {success ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">
            {success}
          </div>
        ) : null}
      </div>
    </main>
  );
}
