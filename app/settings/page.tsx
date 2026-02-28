"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Button,
  ButtonLink,
  Card,
  MotionCard,
  SectionHeader,
  Toast,
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

  const totalUploadSize = useMemo(() => uploads.reduce((sum, item) => sum + item.size, 0), [uploads]);

  async function handleDeleteAll() {
    const confirmation = window.prompt("Type DELETE ALL to remove all uploaded PDFs and derived caches.");
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
    const confirmation = window.prompt("Type RESET ANALYSIS to clear review state and overrides.");
    if (confirmation !== "RESET ANALYSIS") {
      setStatus("Reset analysis state cancelled.");
      return;
    }

    setResetBusy(true);
    setError("");
    setStatus("");
    try {
      const res = await fetch("/api/settings/reset-analysis", { method: "POST" });
      const data = (await res.json()) as
        | { ok: true; removedFiles: string[]; removedDirs: string[] }
        | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(`${data.error.code}: ${data.error.message}`);
        return;
      }
      setStatus(`Analysis state reset. Removed files: ${data.removedFiles.length}, caches: ${data.removedDirs.length}.`);
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
      setStatus(`Overrides imported. merchant=${data.counts.merchantRules}, transfer=${data.counts.transferRules}, parse=${data.counts.parseRules}.`);
    } catch {
      setError("Failed to import overrides.");
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <main className="px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl space-y-6">
        <MotionCard>
          <SectionHeader
            eyebrow="Settings"
            title="Local data and safeguards"
            description="Everything stays on this machine. Use Settings to manage uploaded files, reset analysis state, and back up your rules."
          />
        </MotionCard>

        <Toast message={error || status} tone={error ? "error" : status ? "success" : "neutral"} />

        <MotionCard>
          <SectionHeader
            title="Uploads"
            description="Quick view of your local statement library."
            action={
              <div className="flex flex-wrap gap-2">
                <ButtonLink href="/onboarding" variant="secondary">Add PDFs</ButtonLink>
                <ButtonLink href="/files" variant="secondary">Manage uploads</ButtonLink>
              </div>
            }
          />
          <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
            <div>
              <div className="text-3xl font-semibold tracking-tight text-slate-900">{uploads.length}</div>
              <div className="mt-1 text-sm text-slate-600">PDFs stored locally · {formatBytes(totalUploadSize)}</div>
              {!loadingUploads && uploads.length > 0 ? (
                <div className="mt-3 text-sm text-slate-500">Latest: {uploads[0]?.originalName}</div>
              ) : null}
            </div>
            <div>
              <Button variant="destructive" onClick={() => void handleDeleteAll()} disabled={deleteAllBusy}>
                {deleteAllBusy ? "Deleting..." : "Delete all uploads"}
              </Button>
            </div>
          </div>
        </MotionCard>

        <MotionCard>
          <SectionHeader
            title="Analysis state"
            description="Clear review state, saved decisions, and derived caches without deleting the original PDFs."
          />
          <div className="mt-5 flex flex-wrap gap-3">
            <Button variant="secondary" onClick={() => void handleResetAnalysisState()} disabled={resetBusy}>
              {resetBusy ? "Resetting..." : "Reset analysis state"}
            </Button>
          </div>
        </MotionCard>

        <MotionCard>
          <SectionHeader
            title="Overrides"
            description="Back up or restore your merchant, transfer, and parse rules."
          />
          <div className="mt-5 flex flex-wrap gap-3">
            <ButtonLink href="/api/settings/overrides/export" variant="secondary">Backup overrides.json</ButtonLink>
            <label className="inline-flex cursor-pointer items-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:bg-slate-50">
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
          <p className="mt-3 text-sm text-slate-500">Invalid JSON is rejected safely. Your current overrides stay unchanged.</p>
        </MotionCard>

        <Card>
          <SectionHeader
            title="Advanced"
            description="These tools are still available, but they are outside the main day-to-day workflow."
          />
          <div className="mt-5 flex flex-wrap gap-3">
            <ButtonLink href="/phase3/compare" variant="secondary">Compare view</ButtonLink>
            <ButtonLink href="/transactions" variant="secondary">Transactions workspace</ButtonLink>
          </div>
        </Card>
      </div>
    </main>
  );
}
