"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";

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

type DevTxRow = {
  tableIndex: number;
  id?: string;
  date: string;
  description: string;
  debit?: number;
  credit?: number;
  balance?: number;
  amount: number;
  direction: "debit" | "credit";
  confidence?: number;
  source: {
    fileId?: string;
    fileHash?: string;
    rowIndex?: number;
    lineIndex?: number;
  };
  rawLine: string;
  rawLines: string[];
};

type DevWarningRow = {
  warningIndex: number;
  reason: string;
  message?: string;
  severity: "high" | "medium" | "low";
  confidence?: number;
  rawLine?: string;
  lineIndex?: number;
  txnIndex?: number;
};

type InspectorPayload = {
  source?: string;
  devRun?: { runId: string; path: string };
  indexEntry: Record<string, unknown>;
  debug: {
    templateType: string;
    bankId?: string;
    accountId?: string;
    mode?: string;
    confidence?: number;
    evidence?: string[];
    continuity: number;
    checked: number;
    dedupedCount: number;
    warningCount: number;
    needsReview: boolean;
    needsReviewReasons: string[];
  };
  transactions: DevTxRow[];
  warnings: DevWarningRow[];
  warningsGrouped: {
    high: WarningGroupedItem[];
    medium: WarningGroupedItem[];
    low: WarningGroupedItem[];
  };
  warningsSample: DevWarningRow[];
  artifacts: {
    hasText: boolean;
    hasSegment: boolean;
    hasParsed: boolean;
    hasDevRun?: boolean;
  };
  rawArtifacts: {
    textPreview: string;
    sectionTextPreview?: string;
    parsedLines?: Array<{ lineIndex: number; text: string }>;
  };
};

type RerunResult = {
  runId: string;
  runPath: string;
};

type WarningFilter = "all" | "critical" | "warning" | "info";

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function fileOptionLabel(file: DevFileRow) {
  const coverage = file.coverage
    ? `${file.coverage.startDate} → ${file.coverage.endDate}`
    : "coverage: n/a";
  return `${file.fileName} · ${coverage} · ${file.bankId}/${file.accountId}/${file.templateId}`;
}

function formatAmount(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return CURRENCY.format(value);
}

function severityLabel(severity: DevWarningRow["severity"]) {
  if (severity === "high") return "Critical";
  if (severity === "medium") return "Warning";
  return "Info";
}

function matchesFilter(
  warning: DevWarningRow,
  filter: WarningFilter
) {
  if (filter === "all") return true;
  if (filter === "critical") return warning.severity === "high";
  if (filter === "warning") return warning.severity === "medium";
  return warning.severity === "low";
}

function warningRank(severity: DevWarningRow["severity"]) {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function getContextLines(
  parsedLines: Array<{ lineIndex: number; text: string }> | undefined,
  lineIndex: number | undefined
) {
  if (!parsedLines || typeof lineIndex !== "number") return [];
  const start = Math.max(1, lineIndex - 3);
  const end = lineIndex + 3;
  return parsedLines.filter((line) => line.lineIndex >= start && line.lineIndex <= end);
}

export default function PlaygroundClient() {
  const [files, setFiles] = useState<DevFileRow[]>([]);
  const [selectedFileHash, setSelectedFileHash] = useState<string>("");
  const [inspector, setInspector] = useState<InspectorPayload | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [inspectorLoading, setInspectorLoading] = useState(false);
  const [rerunLoading, setRerunLoading] = useState(false);
  const [runLegacyCommBankParser, setRunLegacyCommBankParser] = useState(false);
  const [error, setError] = useState<string>("");
  const [rerunResult, setRerunResult] = useState<RerunResult | null>(null);
  const [warningFilter, setWarningFilter] = useState<WarningFilter>("all");
  const [selectedTableIndex, setSelectedTableIndex] = useState<number | null>(null);
  const [flashTableIndex, setFlashTableIndex] = useState<number | null>(null);
  const [expandedRawRows, setExpandedRawRows] = useState<Set<number>>(new Set());

  const rowRefs = useRef<Record<number, HTMLTableRowElement | null>>({});

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
        source: data.source,
        devRun: data.devRun,
        indexEntry: data.indexEntry,
        debug: data.debug,
        transactions: data.transactions,
        warnings: data.warnings,
        warningsGrouped: data.warningsGrouped,
        warningsSample: data.warningsSample,
        artifacts: data.artifacts,
        rawArtifacts: data.rawArtifacts,
      });
      setSelectedTableIndex(null);
      setFlashTableIndex(null);
      setExpandedRawRows(new Set());
      rowRefs.current = {};
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
      const payload = {
        force: true,
        runLegacyCommBankParser,
      };
      const rerunRes = await fetch(
        `/api/dev/file/${encodeURIComponent(selectedFileHash)}/rerun`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }
      );
      const rerunData = (await rerunRes.json()) as
        | { ok: true; runId: string; runPath: string }
        | { ok: false; error?: { message?: string } };

      if (!rerunRes.ok || !rerunData.ok) {
        throw new Error(
          rerunData.ok ? "Rerun failed." : rerunData.error?.message || "Rerun failed."
        );
      }

      setRerunResult({ runId: rerunData.runId, runPath: rerunData.runPath });
      await loadInspector(selectedFileHash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to rerun parse.");
    } finally {
      setRerunLoading(false);
    }
  }

  function jumpToWarningRow(warning: DevWarningRow) {
    if (typeof warning.txnIndex !== "number") return;
    const tableIndex = warning.txnIndex + 1;
    const target = rowRefs.current[tableIndex];
    if (!target) return;

    setSelectedTableIndex(tableIndex);
    setFlashTableIndex(tableIndex);
    setExpandedRawRows((prev) => new Set(prev).add(tableIndex));
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => setFlashTableIndex((curr) => (curr === tableIndex ? null : curr)), 2000);
  }

  function toggleRawRow(tableIndex: number) {
    setExpandedRawRows((prev) => {
      const next = new Set(prev);
      if (next.has(tableIndex)) {
        next.delete(tableIndex);
      } else {
        next.add(tableIndex);
      }
      return next;
    });
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

  const warningsByReason = useMemo(() => {
    const map = new Map<string, DevWarningRow[]>();
    const rows = inspector?.warnings || [];
    for (const warning of rows) {
      if (!matchesFilter(warning, warningFilter)) continue;
      const list = map.get(warning.reason) || [];
      list.push(warning);
      map.set(warning.reason, list);
    }
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [inspector?.warnings, warningFilter]);

  const warningByTransaction = useMemo(() => {
    const map = new Map<number, DevWarningRow["severity"]>();
    for (const warning of inspector?.warnings || []) {
      if (typeof warning.txnIndex !== "number") continue;
      const tableIndex = warning.txnIndex + 1;
      const current = map.get(tableIndex);
      if (!current || warningRank(warning.severity) > warningRank(current)) {
        map.set(tableIndex, warning.severity);
      }
    }
    return map;
  }, [inspector?.warnings]);

  const selectedTransaction = useMemo(() => {
    if (!inspector || selectedTableIndex === null) return null;
    return inspector.transactions.find((tx) => tx.tableIndex === selectedTableIndex) || null;
  }, [inspector, selectedTableIndex]);

  const selectedContextLines = useMemo(() => {
    if (!inspector || !selectedTransaction) return [];
    const lineIndex = selectedTransaction.source.lineIndex || selectedTransaction.source.rowIndex;
    return getContextLines(inspector.rawArtifacts.parsedLines, lineIndex);
  }, [inspector, selectedTransaction]);

  return (
    <section className="space-y-4">
      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div className="min-w-0 flex-1">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-700">
              File Selector
            </label>
            <select
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
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
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={runLegacyCommBankParser}
                onChange={(event) => setRunLegacyCommBankParser(event.target.checked)}
              />
              Run legacy CommBank parser fallback
            </label>
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
          <p className="mt-2 text-xs text-slate-700">
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
        <section className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
          Loading inspector...
        </section>
      ) : null}

      {!inspectorLoading && inspector ? (
        <>
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Dev Template Run (registry)</h2>
            {inspector.source ? (
              <p className="mt-1 text-xs text-slate-700">
                source: <span className="font-mono">{inspector.source}</span>
                {inspector.devRun ? (
                  <>
                    {" "}· runId: <span className="font-mono">{inspector.devRun.runId}</span>
                  </>
                ) : null}
              </p>
            ) : null}
            <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Template Type</div>
                <div className="font-medium text-slate-900">{inspector.debug.templateType}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Bank / Account</div>
                <div className="font-medium text-slate-900">
                  {(inspector.debug.bankId || "-")}/{inspector.debug.accountId || "-"}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Mode / Confidence</div>
                <div className="font-medium text-slate-900">
                  {inspector.debug.mode || "-"}
                  {typeof inspector.debug.confidence === "number"
                    ? ` · ${inspector.debug.confidence.toFixed(2)}`
                    : ""}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Continuity</div>
                <div className="font-medium text-slate-900">
                  {(inspector.debug.continuity * 100).toFixed(1)}% · checked {inspector.debug.checked}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Needs Review</div>
                <div className="font-medium text-slate-900">
                  {inspector.debug.needsReview ? "true" : "false"}
                </div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Warnings</div>
                <div className="font-medium text-slate-900">{inspector.debug.warningCount}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Deduped Count</div>
                <div className="font-medium text-slate-900">{inspector.debug.dedupedCount}</div>
              </div>
              <div className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-xs text-slate-700">Artifacts</div>
                <div className="font-medium text-slate-900">
                  text:{inspector.artifacts.hasText ? "Y" : "N"} · segment:{" "}
                  {inspector.artifacts.hasSegment ? "Y" : "N"} · parsed:{" "}
                  {inspector.artifacts.hasParsed ? "Y" : "N"} · devRun:{" "}
                  {inspector.artifacts.hasDevRun ? "Y" : "N"}
                </div>
              </div>
            </div>
            {inspector.debug.needsReviewReasons.length > 0 ? (
              <p className="mt-2 text-xs text-amber-700">
                reasons: {inspector.debug.needsReviewReasons.join(", ")}
              </p>
            ) : null}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold text-slate-900">Parsed Table</h2>
              <p className="text-xs text-slate-700">
                {inspector.transactions.length} rows shown (max 300)
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full border-collapse text-xs text-slate-900">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-700">
                    <th className="px-2 py-2">#</th>
                    <th className="px-2 py-2">Date</th>
                    <th className="px-2 py-2">Description</th>
                    <th className="px-2 py-2">Debit</th>
                    <th className="px-2 py-2">Credit</th>
                    <th className="px-2 py-2">Balance</th>
                    <th className="px-2 py-2">Amount</th>
                    <th className="px-2 py-2">Confidence</th>
                    <th className="px-2 py-2">Source</th>
                    <th className="px-2 py-2">Raw</th>
                  </tr>
                </thead>
                <tbody>
                  {inspector.transactions.map((tx) => {
                    const warningSeverity = warningByTransaction.get(tx.tableIndex);
                    const isSelected = selectedTableIndex === tx.tableIndex;
                    const isFlash = flashTableIndex === tx.tableIndex;
                    const isRawOpen = expandedRawRows.has(tx.tableIndex);

                    return (
                      <Fragment key={`tx-row-${tx.tableIndex}`}>
                        <tr
                          ref={(node) => {
                            rowRefs.current[tx.tableIndex] = node;
                          }}
                          onClick={() => setSelectedTableIndex(tx.tableIndex)}
                          className={`cursor-pointer border-b border-slate-100 align-top ${
                            warningSeverity === "high"
                              ? "bg-rose-50"
                              : warningSeverity === "medium"
                                ? "bg-amber-50"
                                : ""
                          } ${isSelected ? "ring-1 ring-blue-200" : ""} ${
                            isFlash ? "bg-blue-100" : ""
                          }`}
                        >
                          <td className="px-2 py-2 font-mono">{tx.tableIndex}</td>
                          <td className="px-2 py-2 whitespace-nowrap">{tx.date || "-"}</td>
                          <td className="px-2 py-2 max-w-[420px] whitespace-pre-wrap break-words">
                            {tx.description || "-"}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-rose-700">
                            {formatAmount(tx.debit)}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap text-emerald-700">
                            {formatAmount(tx.credit)}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">{formatAmount(tx.balance)}</td>
                          <td className="px-2 py-2 whitespace-nowrap font-medium">
                            {formatAmount(tx.amount)}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            {typeof tx.confidence === "number"
                              ? tx.confidence.toFixed(2)
                              : "-"}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap font-mono text-[11px] text-slate-700">
                            {tx.source.lineIndex || tx.source.rowIndex
                              ? `L${tx.source.lineIndex || tx.source.rowIndex}`
                              : "-"}
                          </td>
                          <td className="px-2 py-2 whitespace-nowrap">
                            <button
                              type="button"
                              className="rounded border border-slate-300 px-2 py-1 text-[11px] text-slate-700"
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleRawRow(tx.tableIndex);
                                setSelectedTableIndex(tx.tableIndex);
                              }}
                            >
                              {isRawOpen ? "Hide" : "Show"} raw
                            </button>
                          </td>
                        </tr>
                        {isRawOpen ? (
                          <tr className="border-b border-slate-100 bg-slate-50">
                            <td className="px-2 py-2" colSpan={10}>
                              <pre className="overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
                                {tx.rawLine || "(raw line unavailable)"}
                              </pre>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Warnings</h2>
              <div className="flex flex-wrap gap-2 text-xs">
                {(
                  [
                    ["all", "All"],
                    ["critical", "Critical"],
                    ["warning", "Warning"],
                    ["info", "Info"],
                  ] as Array<[WarningFilter, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`rounded border px-2 py-1 ${
                      warningFilter === value
                        ? "border-slate-900 bg-slate-900 text-white"
                        : "border-slate-300 text-slate-700"
                    }`}
                    onClick={() => setWarningFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {warningsByReason.length === 0 ? (
              <p className="text-sm text-slate-500">No warnings for selected filter.</p>
            ) : (
              <div className="space-y-2">
                {warningsByReason.map(([reason, rows]) => (
                  <details key={reason} className="rounded-lg border border-slate-200 p-3" open>
                    <summary className="cursor-pointer text-sm font-medium text-slate-800">
                      {reason} ({rows.length})
                    </summary>
                    <div className="mt-2 space-y-2">
                      {rows.map((warning) => (
                        <div
                          key={`${reason}-${warning.warningIndex}`}
                          className="rounded border border-slate-200 bg-slate-50 p-2"
                        >
                          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                            <span className="rounded bg-slate-900 px-2 py-0.5 text-white">
                              {severityLabel(warning.severity)}
                            </span>
                            <span className="text-slate-700">{warning.message || warning.reason}</span>
                            {typeof warning.confidence === "number" ? (
                              <span className="text-slate-500">
                                confidence: {warning.confidence.toFixed(2)}
                              </span>
                            ) : null}
                            {typeof warning.lineIndex === "number" ? (
                              <span className="font-mono text-slate-500">L{warning.lineIndex}</span>
                            ) : null}
                          </div>
                          <pre className="overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-slate-700">
                            {warning.rawLine || "(no rawLine)"}
                          </pre>
                          <div className="mt-2">
                            <button
                              type="button"
                              className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 disabled:opacity-50"
                              disabled={typeof warning.txnIndex !== "number"}
                              onClick={() => jumpToWarningRow(warning)}
                            >
                              Go to row
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-slate-900">Raw context</h2>
            {!selectedTransaction ? (
              <p className="mt-2 text-sm text-slate-700">
                Select a table row or click a warning &quot;Go to row&quot; to inspect raw context.
              </p>
            ) : (
              <div className="mt-3 space-y-2">
                <div className="text-xs text-slate-700">
                  Row #{selectedTransaction.tableIndex} · line:{" "}
                  <span className="font-mono">
                    {selectedTransaction.source.lineIndex || selectedTransaction.source.rowIndex || "-"}
                  </span>
                </div>
                <pre className="overflow-auto whitespace-pre-wrap rounded bg-slate-900 p-2 font-mono text-[11px] text-slate-100">
                  {selectedTransaction.rawLine || "(raw line unavailable)"}
                </pre>
                {selectedContextLines.length > 0 ? (
                  <pre className="overflow-auto whitespace-pre rounded bg-slate-100 p-2 font-mono text-[11px] text-slate-700">
                    {selectedContextLines
                      .map((line) => {
                        const marker =
                          line.lineIndex ===
                          (selectedTransaction.source.lineIndex || selectedTransaction.source.rowIndex)
                            ? ">"
                            : " ";
                        return `${marker} ${String(line.lineIndex).padStart(4, " ")} | ${line.text}`;
                      })
                      .join("\n")}
                  </pre>
                ) : null}
              </div>
            )}
          </section>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Index (normalized entry JSON)
            </summary>
            <pre className="mt-3 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {prettyJson(inspector.indexEntry)}
            </pre>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Raw artifacts
            </summary>
            <p className="mt-2 text-xs text-slate-700">
              Text preview and section preview are capped for readability.
            </p>
            <pre className="mt-3 max-h-[240px] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {inspector.rawArtifacts.textPreview || "(no text preview available)"}
            </pre>
            <pre className="mt-3 max-h-[220px] overflow-auto rounded-lg bg-slate-100 p-3 text-xs text-slate-700">
              {inspector.rawArtifacts.sectionTextPreview || "(no section preview available)"}
            </pre>
          </details>

          <details className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer text-base font-semibold text-slate-900">
              Legacy warning groups / samples
            </summary>
            <pre className="mt-3 max-h-[260px] overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {prettyJson(inspector.warningsGrouped)}
            </pre>
            <pre className="mt-3 max-h-[220px] overflow-auto rounded-lg bg-slate-100 p-3 text-xs text-slate-700">
              {prettyJson(inspector.warningsSample)}
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
