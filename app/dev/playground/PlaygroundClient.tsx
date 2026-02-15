"use client";

import { useEffect, useMemo, useState } from "react";

type DevFileRow = {
  fileHash: string;
  fileId: string;
  fileName: string;
  coverage: { startDate: string; endDate: string } | null;
  bankId: string;
  accountId: string;
  templateId: string;
  parseStatus: {
    textCached: boolean;
    segmentCached: boolean;
    parsedCached: boolean;
  };
  createdAt: string;
};

type WarningGroupedItem = {
  reason: string;
  count: number;
  samples: string[];
};

type InspectorPayload = {
  indexEntry: Record<string, unknown>;
  debug: {
    templateType: string;
    continuity: number;
    checked: number;
    dedupedCount: number;
    warningCount: number;
    needsReview: boolean;
    needsReviewReasons: string[];
  };
  transactions: Array<Record<string, unknown>>;
  warningsGrouped: {
    high: WarningGroupedItem[];
    medium: WarningGroupedItem[];
    low: WarningGroupedItem[];
  };
  warningsSample: Array<Record<string, unknown>>;
  artifacts: {
    hasText: boolean;
    hasSegment: boolean;
    hasParsed: boolean;
  };
  rawArtifacts: {
    textPreview: string;
  };
};

type RerunResult = {
  runId: string;
  runPath: string;
};

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function fileOptionLabel(file: DevFileRow) {
  const coverage = file.coverage
    ? `${file.coverage.startDate} → ${file.coverage.endDate}`
    : "coverage: n/a";
  return `${file.fileName} · ${coverage} · ${file.bankId}/${file.accountId}/${file.templateId}`;
}

export default function PlaygroundClient() {
  const [files, setFiles] = useState<DevFileRow[]>([]);
  const [selectedFileHash, setSelectedFileHash] = useState<string>("");
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [rerunResult, setRerunResult] = useState<RerunResult | null>(null);

  async function loadFiles() {
    setListLoading(true);
    setError("");
    try {
      const res = await fetch("/api/dev/files", { cache: "no-store" });
      const data = (await res.json()) as
        | { ok: true; files: DevFileRow[] }
        | { ok: false; error?: { message?: string } };
      if (!res.ok || !data.ok) {
        throw new Error(data.ok ? "Failed to load files." : data.error?.message || "Failed to load files.");
      }
      setFiles(data.files || []);
      setSelectedFileHash((current) =>
        current && data.files.some((file) => file.fileHash === current)
          ? current
          : data.files[0]?.fileHash || ""
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dev files.");
      setFiles([]);
      setSelectedFileHash("");
    } finally {
      setListLoading(false);
    }
  }

  async function loadInspector(fileHash: string) {
    if (!fileHash) {
      setInspector(null);
      return;
    }

    setInspectorLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/dev/file/${encodeURIComponent(fileHash)}`, {
        cache: "no-store",
      });
      const data = (await res.json()) as
        | ({ ok: true } & InspectorPayload)
        | { ok: false; error?: { message?: string } };
      if (!res.ok || !data.ok) {
        throw new Error(data.ok ? "Failed to load inspector." : data.error?.message || "Failed to load inspector.");
      }
      setInspector({
        indexEntry: data.indexEntry,
        debug: data.debug,
        transactions: data.transactions,
        warningsGrouped: data.warningsGrouped,
        warningsSample: data.warningsSample,
        artifacts: data.artifacts,
        rawArtifacts: data.rawArtifacts,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load file inspector.");
      setInspector(null);
    } finally {
      setInspectorLoading(false);
    }
  }

  async function rerunSelected() {
    if (!selectedFileHash) return;
    if (!window.confirm("Re-run parse for this file in dev mode?")) return;

    setRerunLoading(true);
    setError("");
    setRerunResult(null);
    try {
      const res = await fetch(
        `/api/dev/file/${encodeURIComponent(selectedFileHash)}/rerun`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        }
      );
      const data = (await res.json()) as
        | { ok: true; runId: string; runPath: string }
        | { ok: false; error?: { message?: string } };

      if (!res.ok || !data.ok) {
        throw new Error(data.ok ? "Rerun failed." : data.error?.message || "Rerun failed.");
      }

      setRerunResult({ runId: data.runId, runPath: data.runPath });
      await loadInspector(selectedFileHash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rerun parse.");
    } finally {
      setRerunLoading(false);
    }
  }

  useEffect(() => {
    void loadFiles();
  }, []);

  useEffect(() => {
    void loadInspector(selectedFileHash);
  }, [selectedFileHash]);

  const selectedFile = useMemo(
    () => files.find((file) => file.fileHash === selectedFileHash) || null,
    [files, selectedFileHash]
  );

  return (
    <section className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 flex-1">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              File Selector
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
              value={selectedFileHash}
              onChange={(event) => setSelectedFileHash(event.target.value)}
              disabled={listLoading || files.length === 0}
            >
              {files.map((file) => (
                <option key={file.fileHash} value={file.fileHash}>
                  {fileOptionLabel(file)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadFiles()}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700"
              disabled={listLoading}
            >
              Refresh Files
            </button>
            <button
              type="button"
              onClick={() => void rerunSelected()}
              className="rounded-lg bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              disabled={rerunLoading || !selectedFileHash}
            >
              {rerunLoading ? "Re-running..." : "Re-run parse (this file)"}
            </button>
          </div>
        </div>

        {selectedFile ? (
          <p className="mt-2 text-xs text-slate-500">
            fileHash: <span className="font-mono">{selectedFile.fileHash}</span> · fileId:{" "}
            <span className="font-mono">{selectedFile.fileId}</span>
          </p>
        ) : null}

        {rerunResult ? (
          <p className="mt-2 text-xs text-emerald-700">
            Dev rerun saved: <span className="font-mono">{rerunResult.runPath}</span> (runId: {" "}
            <span className="font-mono">{rerunResult.runId}</span>)
          </p>
        ) : null}

        {error ? <p className="mt-2 text-sm text-red-600">{error}</p> : null}
      </section>

      {inspectorLoading ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          Loading inspector...
        </section>
      ) : null}

      {!inspectorLoading && inspector ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Debug Summary</h2>
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Template Type</div>
                <div className="font-medium text-slate-800">{inspector.debug.templateType}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Continuity</div>
                <div className="font-medium text-slate-800">
                  {(inspector.debug.continuity * 100).toFixed(1)}% · checked {inspector.debug.checked}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Needs Review</div>
                <div className="font-medium text-slate-800">
                  {inspector.debug.needsReview ? "true" : "false"}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Warnings</div>
                <div className="font-medium text-slate-800">{inspector.debug.warningCount}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Deduped Count</div>
                <div className="font-medium text-slate-800">{inspector.debug.dedupedCount}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-500">Artifacts</div>
                <div className="font-medium text-slate-800">
                  text:{inspector.artifacts.hasText ? "Y" : "N"} · segment:{" "}
                  {inspector.artifacts.hasSegment ? "Y" : "N"} · parsed:{" "}
                  {inspector.artifacts.hasParsed ? "Y" : "N"}
                </div>
              </div>
            </div>
            {inspector.debug.needsReviewReasons.length > 0 ? (
              <p className="mt-2 text-xs text-amber-700">
                reasons: {inspector.debug.needsReviewReasons.join(", ")}
              </p>
            ) : null}
          </section>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Index (normalized entry JSON)
            </summary>
            <pre className="mt-3 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {prettyJson(inspector.indexEntry)}
            </pre>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Transactions sample (first 50)
            </summary>
            <pre className="mt-3 max-h-[460px] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {prettyJson(inspector.transactions)}
            </pre>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Warnings (grouped by severity)
            </summary>
            <pre className="mt-3 max-h-[360px] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {prettyJson(inspector.warningsGrouped)}
            </pre>
            <pre className="mt-3 max-h-[260px] overflow-auto rounded-lg bg-slate-100 p-3 text-xs text-slate-700">
              {prettyJson(inspector.warningsSample)}
            </pre>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm" open>
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Raw artifacts
            </summary>
            <p className="mt-2 text-xs text-slate-500">
              Text preview is capped for readability. Segment/raw files can be added later.
            </p>
            <pre className="mt-3 max-h-[300px] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {inspector.rawArtifacts.textPreview || "(no text preview available)"}
            </pre>
          </details>
        </>
      ) : null}

      {!listLoading && files.length === 0 ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
          No files found in uploads index.
        </section>
      ) : null}
    </section>
  );
}
