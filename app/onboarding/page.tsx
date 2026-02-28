"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  MotionCard,
  SectionHeader,
  Toast,
} from "@/components/ui";
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
  bsb?: string;
  accountNumber?: string;
  fileCount: number;
  sampleFileName?: string;
  dateRange?: { from: string; to: string };
};

type BoundaryResponse =
  | {
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
    }
  | {
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
      // Non-blocking.
    }
  }

  async function runAutoPipeline(file: FileMeta, key: string) {
    updateStatus({
      key,
      fileName: file.originalName,
      stage: "parsing",
      message: "Running extract, segment, and parse.",
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
      message: "Ready for your report.",
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
          ? "Upload finished. Confirm your boundary and open the report."
          : "No new files were added. You can still confirm your boundary."
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
    <main className="px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <MotionCard className="overflow-hidden bg-[linear-gradient(135deg,rgba(255,255,255,0.98),rgba(247,248,244,0.98))]">
          <SectionHeader
            eyebrow="Get Started"
            title="Build your first report in three minutes"
            description="Upload statements, confirm which accounts belong inside your world, then open a clean cashflow report."
          />
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge tone={step >= 1 ? "blue" : "neutral"}>1. Upload</Badge>
            <Badge tone={step >= 2 ? "blue" : "neutral"}>2. Boundary</Badge>
            <Badge tone={step >= 3 ? "blue" : "neutral"}>3. Report</Badge>
          </div>
        </MotionCard>

        <Toast message={error ? `${error.code}: ${error.message}` : success} tone={error ? "error" : success ? "success" : "neutral"} />

        <MotionCard>
          <SectionHeader
            eyebrow="Step 1"
            title="Upload PDFs"
            description="Use text-based CommBank or ANZ PDFs. We upload, parse, and prepare your report automatically."
            action={<ButtonLink href="/files" variant="secondary">Existing uploads: {existingUploads}</ButtonLink>}
          />

          <label className="mt-6 flex cursor-pointer flex-col items-center justify-center gap-3 rounded-[28px] border border-dashed border-slate-300 bg-slate-50 px-6 py-14 text-center transition-colors hover:border-slate-900 hover:bg-white">
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
            <div className="text-lg font-semibold text-slate-900">Drop PDFs here</div>
            <div className="max-w-md text-sm leading-6 text-slate-600">
              {selectedSummary}. Local only, no OCR, no cloud sync.
            </div>
            <Button type="button" size="lg" disabled={isRunning} onClick={() => void handleUploadAndParse()}>
              {isRunning ? "Working..." : "Upload & Parse"}
            </Button>
          </label>

          {pipelineStatuses.length > 0 ? (
            <div className="mt-6 space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                <Badge tone="neutral">Done {pipelineSummary.done}/{pipelineSummary.total}</Badge>
                {pipelineSummary.failed > 0 ? <Badge tone="amber">Failed {pipelineSummary.failed}</Badge> : null}
              </div>
              <div className="grid gap-3">
                {pipelineStatuses.map((item) => (
                  <motion.div
                    key={item.key}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="font-medium text-slate-900">{item.fileName}</div>
                      <Badge tone={item.stage === "done" ? "green" : item.stage === "failed" ? "red" : "blue"}>
                        {item.stage}
                      </Badge>
                    </div>
                    <div className="mt-1 text-sm text-slate-600">
                      {item.message || "Working..."}
                      {typeof item.txCount === "number" ? ` · ${item.txCount} transactions` : ""}
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          ) : null}
        </MotionCard>

        <MotionCard>
          <SectionHeader
            eyebrow="Step 2"
            title="Choose your boundary"
            description="Boundary defines which accounts are inside your world. Transfers inside boundary can be offset."
          />

          {boundary?.ok ? (
            boundary.knownAccounts.length === 0 ? (
              <div className="mt-6">
                <EmptyState
                  title="No accounts detected yet"
                  body="Finish Step 1 first. Once a file is parsed, your detected accounts will appear here."
                />
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {boundary.knownAccounts.map((account) => {
                  const checked = boundaryDraft.includes(account.accountId);
                  return (
                    <label
                      key={`${account.bankId}:${account.accountId}`}
                      className="flex cursor-pointer gap-4 rounded-[24px] border border-slate-200 bg-slate-50 px-4 py-4 transition-colors hover:bg-white"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                        checked={checked}
                        onChange={() => toggleBoundary(account.accountId)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-900">
                            {account.bankId.toUpperCase()} ·{" "}
                            {formatAccountLabel({
                              ...account,
                              alias: boundaryAliasDraft[account.accountId],
                            })}
                          </span>
                          {isUnknownAccountIdentity(account) ? (
                            <Badge tone="amber">Account details incomplete</Badge>
                          ) : null}
                        </div>
                        <div className="mt-1 text-sm text-slate-600">
                          {formatAccountSupportText({
                            ...account,
                            alias: boundaryAliasDraft[account.accountId],
                          }) || "No extra account details yet"}
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {account.fileCount} files
                          {account.dateRange ? ` · ${account.dateRange.from} → ${account.dateRange.to}` : ""}
                        </div>
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
                          placeholder="Rename this account (optional)"
                          className="mt-3 h-10 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                        />
                      </div>
                    </label>
                  );
                })}
                <div className="pt-2">
                  <Button
                    type="button"
                    size="lg"
                    disabled={isSavingBoundary || boundaryDraft.length === 0}
                    onClick={() => void handleSaveBoundaryAndContinue()}
                  >
                    {isSavingBoundary ? "Saving..." : "Continue"}
                  </Button>
                </div>
              </div>
            )
          ) : (
            <div className="mt-6">
              <Toast
                message={`${boundary?.error.code || "BOUNDARY_FAILED"}: ${boundary?.error.message || "Failed to load boundary config."}`}
                tone="error"
              />
            </div>
          )}
        </MotionCard>

        <MotionCard>
          <SectionHeader
            eyebrow="Step 3"
            title="Open your report"
            description="You can jump straight into the report. Uncertain transfers are never offset automatically, and you can review them later in Inbox."
            action={
              <div className="flex flex-wrap gap-2">
                <ButtonLink href="/phase3?onboarding=1">Open Report</ButtonLink>
                <ButtonLink href="/inbox" variant="secondary">Open Inbox</ButtonLink>
              </div>
            }
          />
        </MotionCard>
      </div>
    </main>
  );
}
