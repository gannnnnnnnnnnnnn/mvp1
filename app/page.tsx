'use client';

import { useEffect, useMemo, useState } from "react";

/**
 * Metadata shape from the backend. Duplicated here for clarity and type safety.
 */
type FileMeta = {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
};

type ApiError = { code: string; message: string };

type ParseTextMeta = {
  extractor: string;
  length: number;
  cached: boolean;
  truncated?: boolean;
  emptyText?: boolean;
};

type ParseTextResult = {
  fileId: string;
  originalName: string;
  text: string;
  meta: ParseTextMeta;
};

type SegmentDebug = {
  startLine?: number;
  endLine?: number;
  removedLines: number;
  headerFound: boolean;
};

type SegmentResult = {
  fileId: string;
  originalName: string;
  sectionText: string;
  debug: SegmentDebug;
};

type ParsedTransaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  amountSource?: "parsed_token" | "balance_diff_inferred";
  debit?: number;
  credit?: number;
  balance?: number;
  currency?: string;
  rawLine: string;
  confidence: number;
};

type ParseWarning = {
  rawLine: string;
  reason: string;
  confidence: number;
};

type ParseQuality = {
  headerFound: boolean;
  balanceContinuityPassRate: number;
  balanceContinuityChecked: number;
  balanceContinuityTotalRows?: number;
  balanceContinuitySkipped?: number;
  balanceContinuitySkippedReasons?: Record<string, number>;
  needsReviewReasons: string[];
};

type ParseTransactionsResult = {
  fileId: string;
  originalName: string;
  templateType: "commbank_manual_amount_balance" | "commbank_auto_debit_credit" | "unknown";
  transactions: ParsedTransaction[];
  warnings: ParseWarning[];
  quality?: ParseQuality;
  needsReview: boolean;
  reviewReasons: string[];
  sectionTextPreview: string;
  debug?: SegmentDebug;
};

type PipelineStatus = {
  key: string;
  fileId?: string;
  fileName: string;
  stage: "uploading" | "parsing" | "done" | "failed";
  message?: string;
  txCount?: number;
};

export default function Home() {
  // Local UI state hooks.
  const [sessionUserId, setSessionUserId] = useState<string>("");
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isAutoPipelineRunning, setIsAutoPipelineRunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [pipelineStatuses, setPipelineStatuses] = useState<PipelineStatus[]>([]);
  const [showAdvancedActions, setShowAdvancedActions] = useState(false);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);

  // Phase 2.1 UI state.
  const [extractingFileId, setExtractingFileId] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<ApiError | null>(null);
  const [extractResult, setExtractResult] = useState<ParseTextResult | null>(null);
  const [showFullText, setShowFullText] = useState(false);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);

  // Phase 2.2 UI state.
  const [segmentingFileId, setSegmentingFileId] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState<ApiError | null>(null);
  const [segmentResult, setSegmentResult] = useState<SegmentResult | null>(null);

  // Phase 2.3 UI state.
  const [parsingTxFileId, setParsingTxFileId] = useState<string | null>(null);
  const [txError, setTxError] = useState<ApiError | null>(null);
  const [txResult, setTxResult] = useState<ParseTransactionsResult | null>(null);
  const [expandedRawLines, setExpandedRawLines] = useState<Record<string, boolean>>({});

  // Phase 1.5 cleanup UI state.
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [isClearingAll, setIsClearingAll] = useState(false);

  /**
   * Helper: format bytes to something human friendly.
   */
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  /**
   * We only enable parse buttons for likely PDF rows.
   */
  const isPdfFile = (file: FileMeta) => {
    const mimeOk = (file.mimeType || "").toLowerCase() === "application/pdf";
    const extOk = file.originalName.toLowerCase().endsWith(".pdf");
    return mimeOk || extOk;
  };

  /**
   * Fetch file list from the API. Errors are surfaced to the UI.
   */
  const fetchFiles = async () => {
    setIsLoadingList(true);
    setError(null);
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setFiles(data.files as FileMeta[]);
    } catch {
      setError({ code: "FETCH_FAILED", message: "获取文件列表失败。" });
    } finally {
      setIsLoadingList(false);
    }
  };

  const upsertPipelineStatus = (next: PipelineStatus) => {
    setPipelineStatuses((prev) => {
      const idx = prev.findIndex((item) => item.key === next.key);
      if (idx === -1) return [...prev, next];
      const clone = [...prev];
      clone[idx] = { ...clone[idx], ...next };
      return clone;
    });
  };

  const runAutoPipeline = async (file: FileMeta, key: string) => {
    upsertPipelineStatus({
      key,
      fileId: file.id,
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
      | {
          ok: true;
          txCount?: number;
          parsed?: {
            ok: true;
            templateType?: "commbank_manual_amount_balance" | "commbank_auto_debit_credit" | "unknown";
            transactions: ParsedTransaction[];
            warnings: ParseWarning[];
            quality?: ParseQuality;
            needsReview?: boolean;
            reviewReasons?: string[];
            sectionTextPreview?: string;
            debug?: SegmentDebug;
          };
          cached?: { text?: boolean; segment?: boolean; parsed?: boolean };
        }
      | { ok: false; error: ApiError };

    if (!data.ok) {
      upsertPipelineStatus({
        key,
        fileId: file.id,
        fileName: file.originalName,
        stage: "failed",
        message: `${data.error.code}: ${data.error.message}`,
      });
      return;
    }

    if (data.parsed?.ok) {
      setTxResult({
        fileId: file.id,
        originalName: file.originalName,
        templateType: data.parsed.templateType ?? "unknown",
        transactions: data.parsed.transactions,
        warnings: data.parsed.warnings,
        quality: data.parsed.quality,
        needsReview: data.parsed.needsReview === true,
        reviewReasons: Array.isArray(data.parsed.reviewReasons) ? data.parsed.reviewReasons : [],
        sectionTextPreview:
          typeof data.parsed.sectionTextPreview === "string"
            ? data.parsed.sectionTextPreview
            : "",
        debug: data.parsed.debug,
      });
    }

    const cacheHint = data.cached
      ? `cache(text:${data.cached.text ? "Y" : "N"}, segment:${data.cached.segment ? "Y" : "N"}, parsed:${data.cached.parsed ? "Y" : "N"})`
      : "";

    upsertPipelineStatus({
      key,
      fileId: file.id,
      fileName: file.originalName,
      stage: "done",
      txCount: data.txCount,
      message: `Pipeline complete. ${cacheHint}`.trim(),
    });
  };

  /**
   * Upload handler: validates presence of a selected file then POSTs to API.
   */
  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      setError({ code: "NO_FILE", message: "Please select at least one PDF file." });
      return;
    }

    setIsUploading(true);
    setIsAutoPipelineRunning(true);
    setError(null);
    setSuccessMsg(null);
    setPipelineStatuses([]);

    try {
      let failedCount = 0;
      for (let idx = 0; idx < selectedFiles.length; idx += 1) {
        const current = selectedFiles[idx];
        const statusKey = `${current.name}-${current.lastModified}-${idx}`;

        upsertPipelineStatus({
          key: statusKey,
          fileName: current.name,
          stage: "uploading",
          message: "Uploading...",
        });

        const form = new FormData();
        form.append("file", current);
        const res = await fetch("/api/upload", {
          method: "POST",
          body: form,
        });
        const data = (await res.json()) as
          | { ok: true; file: FileMeta }
          | { ok: false; error: ApiError };

        if (!data.ok) {
          failedCount += 1;
          upsertPipelineStatus({
            key: statusKey,
            fileName: current.name,
            stage: "failed",
            message:
              data.error.code === "DUPLICATE_FILE"
                ? "Already uploaded."
                : `${data.error.code}: ${data.error.message}`,
          });
          continue;
        }

        upsertPipelineStatus({
          key: statusKey,
          fileId: data.file.id,
          fileName: data.file.originalName,
          stage: "parsing",
          message: "Uploaded. Parsing...",
        });
        await runAutoPipeline(data.file as FileMeta, statusKey);
      }

      if (failedCount > 0) {
        setSuccessMsg("Upload run finished. Some files need review in Advanced.");
      } else {
        setSuccessMsg("Upload run finished. All selected files parsed.");
      }
      setSelectedFiles([]);
      await fetchFiles();
    } catch {
      setError({ code: "UPLOAD_FAILED", message: "Upload failed. Please try again." });
    } finally {
      setIsUploading(false);
      setIsAutoPipelineRunning(false);
    }
  };

  /**
   * Phase 2.1: Extract text from PDF with optional force re-parse.
   */
  const handleExtractText = async (file: FileMeta, force = false) => {
    setExtractingFileId(file.id);
    setExtractError(null);
    setCopyMsg(null);

    try {
      const res = await fetch("/api/parse/pdf-text", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: file.id, force }),
      });

      const data = (await res.json()) as
        | { ok: true; fileId: string; text: string; meta: ParseTextMeta }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setExtractError(data.error);
        return;
      }

      setExtractResult({
        fileId: data.fileId,
        originalName: file.originalName,
        text: data.text,
        meta: data.meta,
      });
      setShowFullText(false);
    } catch {
      setExtractError({
        code: "EXTRACT_REQUEST_FAIL",
        message: "调用文本抽取接口失败，请稍后重试。",
      });
    } finally {
      setExtractingFileId(null);
    }
  };

  /**
   * Phase 2.2: Segment transaction section from cached raw text.
   */
  const handleSegment = async (file: FileMeta) => {
    setSegmentingFileId(file.id);
    setSegmentError(null);

    try {
      const res = await fetch("/api/parse/pdf-segment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: file.id }),
      });

      const data = (await res.json()) as
        | { ok: true; fileId: string; sectionText: string; debug: SegmentDebug }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setSegmentError(data.error);
        return;
      }

      setSegmentResult({
        fileId: data.fileId,
        originalName: file.originalName,
        sectionText: data.sectionText,
        debug: data.debug,
      });
    } catch {
      setSegmentError({
        code: "SEGMENT_REQUEST_FAIL",
        message: "调用分段接口失败，请稍后重试。",
      });
    } finally {
      setSegmentingFileId(null);
    }
  };

  /**
   * Phase 2.3: Parse structured transactions from cached text.
   */
  const handleParseTransactions = async (file: FileMeta) => {
    setParsingTxFileId(file.id);
    setTxError(null);

    try {
      const res = await fetch("/api/parse/pdf-transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId: file.id }),
      });

      const data = (await res.json()) as
        | {
            ok: true;
            templateType?: "commbank_manual_amount_balance" | "commbank_auto_debit_credit" | "unknown";
            transactions: ParsedTransaction[];
            warnings: ParseWarning[];
            quality?: ParseQuality;
            needsReview?: boolean;
            reviewReasons?: string[];
            sectionTextPreview?: string;
            debug?: SegmentDebug;
          }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setTxError(data.error);
        return;
      }

      setTxResult({
        fileId: file.id,
        originalName: file.originalName,
        templateType: data.templateType ?? "unknown",
        transactions: data.transactions,
        warnings: data.warnings,
        quality: data.quality,
        needsReview: data.needsReview === true,
        reviewReasons: Array.isArray(data.reviewReasons) ? data.reviewReasons : [],
        sectionTextPreview: typeof data.sectionTextPreview === "string" ? data.sectionTextPreview : "",
        debug: data.debug,
      });
      setExpandedRawLines({});
    } catch {
      setTxError({
        code: "TRANSACTIONS_REQUEST_FAIL",
        message: "调用交易解析接口失败，请稍后重试。",
      });
    } finally {
      setParsingTxFileId(null);
    }
  };

  /**
   * When a file is deleted, clear stale parse panels that still point to that file.
   */
  const clearPanelsForFile = (fileId: string) => {
    if (extractResult?.fileId === fileId) {
      setExtractResult(null);
      setExtractError(null);
      setCopyMsg(null);
    }
    if (segmentResult?.fileId === fileId) {
      setSegmentResult(null);
      setSegmentError(null);
    }
    if (txResult?.fileId === fileId) {
      setTxResult(null);
      setTxError(null);
      setExpandedRawLines({});
    }
  };

  /**
   * Phase 1.5: delete one file + caches via DELETE /api/files/[id].
   */
  const handleDeleteFile = async (file: FileMeta) => {
    const ok = window.confirm(`确定删除文件 "${file.originalName}" 吗？`);
    if (!ok) return;

    setDeletingFileId(file.id);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      const data = (await res.json()) as
        | { ok: true }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setError(data.error);
        return;
      }

      clearPanelsForFile(file.id);
      setSuccessMsg("文件删除成功。");
      await fetchFiles();
    } catch {
      setError({ code: "DELETE_FAILED", message: "删除文件失败，请稍后重试。" });
    } finally {
      setDeletingFileId(null);
    }
  };

  /**
   * Phase 1.5: clear all files + text cache with a typed confirmation token.
   */
  const handleDeleteAll = async () => {
    const token = window.prompt('危险操作：输入 "DELETE" 以清空全部文件');
    if (token === null) return;
    if (token !== "DELETE") {
      setError({ code: "BAD_CONFIRM", message: '确认口令错误，必须输入 "DELETE"。' });
      return;
    }

    setIsClearingAll(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await fetch("/api/files/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "DELETE" }),
      });

      const data = (await res.json()) as
        | { ok: true; deletedCount: number }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setError(data.error);
        return;
      }

      setExtractResult(null);
      setExtractError(null);
      setSegmentResult(null);
      setSegmentError(null);
      setTxResult(null);
      setTxError(null);
      setExpandedRawLines({});
      setCopyMsg(null);
      setSuccessMsg(`已清空全部文件，删除 ${data.deletedCount} 条记录。`);
      await fetchFiles();
    } catch {
      setError({ code: "CLEAR_FAILED", message: "清空文件失败，请稍后重试。" });
    } finally {
      setIsClearingAll(false);
    }
  };

  const handleToggleRawLine = (txId: string) => {
    setExpandedRawLines((prev) => ({ ...prev, [txId]: !prev[txId] }));
  };

  const handleCopyText = async () => {
    if (!extractResult) return;

    try {
      await navigator.clipboard.writeText(extractResult.text);
      setCopyMsg("已复制文本到剪贴板。");
    } catch {
      setCopyMsg("复制失败（请检查浏览器权限）。");
    }
  };

  useEffect(() => {
    fetchFiles();
  }, []);

  useEffect(() => {
    const cookieName = "pc_user_id";
    const existing = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`));

    if (existing) {
      setSessionUserId(existing.split("=")[1] || "");
      return;
    }

    const nextId =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `u_${Math.random().toString(36).slice(2)}`;
    document.cookie = `${cookieName}=${nextId}; Max-Age=31536000; Path=/; SameSite=Lax`;
    setSessionUserId(nextId);
  }, []);

  const selectedSummary = useMemo(() => {
    if (selectedFiles.length === 0) return "No files selected";
    if (selectedFiles.length === 1) {
      const one = selectedFiles[0];
      return `${one.name} · ${formatSize(one.size)} · ${one.type || "unknown"}`;
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

  const visibleExtractText = useMemo(() => {
    if (!extractResult) return "";
    if (showFullText) return extractResult.text;
    return extractResult.text.slice(0, 4000);
  }, [extractResult, showFullText]);

  const templateLabel = (templateType: ParseTransactionsResult["templateType"]) => {
    switch (templateType) {
      case "commbank_manual_amount_balance":
        return "manual";
      case "commbank_auto_debit_credit":
        return "auto";
      default:
        return "unknown";
    }
  };

  const continuitySummary = (quality?: ParseQuality) => {
    if (!quality || typeof quality.balanceContinuityPassRate !== "number") {
      return "-";
    }
    const checked = quality.balanceContinuityChecked ?? 0;
    const total = quality.balanceContinuityTotalRows ?? checked;
    return `${(quality.balanceContinuityPassRate * 100).toFixed(1)}% (checked ${checked}/${total})`;
  };

  const skippedSummary = (quality?: ParseQuality) => {
    if (!quality) return "-";
    const skipped = quality.balanceContinuitySkipped ?? 0;
    const reasons = quality.balanceContinuitySkippedReasons || {};
    const reasonText = Object.entries(reasons)
      .map(([reason, count]) => `${reason}:${count}`)
      .join(", ");
    return skipped > 0 ? `${skipped}${reasonText ? ` · ${reasonText}` : ""}` : "0";
  };

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-4xl font-semibold text-slate-900">Personal Cashflow</h1>
          <p className="mt-2 text-slate-600">
            Upload CommBank statements. We&apos;ll parse and build your dashboard.
          </p>
        </header>

        {files.length > 0 && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-semibold text-slate-900">Welcome back</h2>
            <p className="mt-1 text-sm text-slate-600">
              You have {files.length} statement{files.length > 1 ? "s" : ""} already parsed.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href="/phase3"
                className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Open Dashboard
              </a>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Upload &amp; Parse</h2>
          <p className="mt-1 text-sm text-slate-600">Drop PDFs here. PDF only, text-based.</p>

          <div className="mt-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-sm text-slate-700 hover:border-blue-500 hover:bg-blue-50">
              <input
                type="file"
                multiple
                accept=".pdf,.csv,application/pdf,text/csv"
                className="hidden"
                onChange={(e) => {
                  const next = Array.from(e.target.files || []);
                  setSelectedFiles(next);
                  setError(null);
                  setSuccessMsg(null);
                }}
              />
              <span className="text-base font-medium">Drop PDFs here</span>
              <span className="text-xs text-slate-500">CommBank only for now. No OCR.</span>
            </label>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="text-sm text-slate-700">{selectedSummary}</div>

            <button
              onClick={handleUpload}
              disabled={isUploading || isAutoPipelineRunning}
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isUploading || isAutoPipelineRunning ? "Uploading..." : "Upload & Parse"}
            </button>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {error.code}: {error.message}
            </div>
          )}
          {successMsg && (
            <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {successMsg}
            </div>
          )}

          {pipelineStatuses.length > 0 && (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Auto Pipeline Progress
              </div>
              <div className="mt-1 text-xs text-slate-600">
                done {pipelineSummary.done}/{pipelineSummary.total} · failed {pipelineSummary.failed}
              </div>
              <div className="mt-2 space-y-2 text-xs text-slate-700">
                {pipelineStatuses.map((item) => (
                  <div key={item.key} className="rounded border border-slate-200 bg-white p-2">
                    <div className="font-medium text-slate-800">{item.fileName}</div>
                    <div className="mt-1">
                      stage: {item.stage}
                      {typeof item.txCount === "number" ? ` · txCount: ${item.txCount}` : ""}
                    </div>
                    {item.message && <div className="mt-1 text-slate-600">{item.message}</div>}
                  </div>
                ))}
              </div>
              {pipelineSummary.finished && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href="/phase3"
                    className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    Open Dashboard
                  </a>
                  {pipelineSummary.failed > 0 && (
                    <span className="text-xs text-amber-700">
                      Some files need review. Use Advanced: File Library &amp; Debug.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="mt-3 text-xs text-slate-500">
            CommBank only for now. No OCR.
          </div>
          <div className="sr-only">
            session {sessionUserId ? "ready" : "initializing"}
          </div>
        </section>

        <details className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <summary className="cursor-pointer text-sm font-semibold text-slate-700">
            Advanced: File Library &amp; Debug
          </summary>
          <section className="mt-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">File Library</h2>
              <p className="text-sm text-slate-600">Download, delete, and re-run parse actions.</p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => setShowAdvancedActions((prev) => !prev)}
                className="text-sm font-medium text-slate-600 hover:text-slate-800"
              >
                {showAdvancedActions ? "Hide Debug actions" : "Show Debug actions"}
              </button>
              <button
                onClick={() => {
                  void handleDeleteAll();
                }}
                disabled={isClearingAll || files.length === 0}
                className="text-sm font-medium text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:text-red-300"
              >
                {isClearingAll ? "Clearing..." : "Delete All"}
              </button>
              <button onClick={fetchFiles} className="text-sm font-medium text-blue-600 hover:text-blue-700">
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-700">
              <thead>
                <tr className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Uploaded At</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingList ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">Loading...</td>
                  </tr>
                ) : files.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">No files yet.</td>
                  </tr>
                ) : (
                  files.map((file) => (
                    <tr key={file.id} className="border-b last:border-none">
                      <td className="px-3 py-2 font-medium text-slate-900">{file.originalName}</td>
                      <td className="px-3 py-2">{formatSize(file.size)}</td>
                      <td className="px-3 py-2">{file.mimeType}</td>
                      <td className="px-3 py-2">{new Date(file.uploadedAt).toLocaleString()}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <a href={`/api/files/${file.id}/download`} className="text-blue-600 hover:underline">
                            Download
                          </a>

                          {showAdvancedActions && isPdfFile(file) && (
                            <>
                              <span className="text-[11px] text-slate-400">Debug actions:</span>
                              <button
                                onClick={() => {
                                  void handleExtractText(file, false);
                                }}
                                disabled={extractingFileId === file.id}
                                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {extractingFileId === file.id ? "Extracting..." : "Extract Text"}
                              </button>

                              <button
                                onClick={() => {
                                  void handleSegment(file);
                                }}
                                disabled={segmentingFileId === file.id}
                                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {segmentingFileId === file.id ? "Segmenting..." : "Segment"}
                              </button>

                              <button
                                onClick={() => {
                                  void handleParseTransactions(file);
                                }}
                                disabled={parsingTxFileId === file.id}
                                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                {parsingTxFileId === file.id ? "Parsing..." : "Re-run parse"}
                              </button>
                            </>
                          )}

                          <button
                            onClick={() => {
                              void handleDeleteFile(file);
                            }}
                            disabled={deletingFileId === file.id || isClearingAll}
                            className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {deletingFileId === file.id ? "Deleting..." : "Delete"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {extractError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Extract error ({extractError.code}): {extractError.message}
            </div>
          )}

          {segmentError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Segment error ({segmentError.code}): {segmentError.message}
            </div>
          )}

          {txError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              Parse error ({txError.code}): {txError.message}
            </div>
          )}

          {extractResult && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-base font-semibold text-slate-900">Extracted Text Preview</h3>
              <p className="mt-1 text-xs text-slate-600">
                fileId: <span className="font-mono">{extractResult.fileId}</span> · 文件名: {extractResult.originalName}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                extractor: {extractResult.meta.extractor} · length: {extractResult.meta.length} · cached: {extractResult.meta.cached ? "true" : "false"} · truncated: {extractResult.meta.truncated ? "true" : "false"} · emptyText: {extractResult.meta.emptyText ? "true" : "false"}
              </p>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    void handleCopyText();
                  }}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                >
                  Copy text
                </button>

                <button
                  onClick={() => setShowFullText((prev) => !prev)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100"
                >
                  {showFullText ? "Collapse" : "Show full"}
                </button>

                <button
                  onClick={() => {
                    const file = files.find((item) => item.id === extractResult.fileId);
                    if (file) {
                      void handleExtractText(file, true);
                    }
                  }}
                  disabled={extractingFileId === extractResult.fileId}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Re-extract
                </button>
              </div>

              {copyMsg && <div className="mt-2 text-xs text-green-700">{copyMsg}</div>}

              <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-800">
                {visibleExtractText || "(empty text)"}
              </div>
            </div>
          )}

          {segmentResult && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-base font-semibold text-slate-900">Segment Preview</h3>
              <p className="mt-1 text-xs text-slate-600">
                fileId: <span className="font-mono">{segmentResult.fileId}</span> · 文件名: {segmentResult.originalName}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                headerFound: {segmentResult.debug.headerFound ? "true" : "false"} · startLine:{" "}
                {segmentResult.debug.startLine ?? "not found"} · endLine:{" "}
                {segmentResult.debug.endLine ?? "not found"} · removedLines:{" "}
                {segmentResult.debug.removedLines}
              </p>
              <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-800">
                {segmentResult.sectionText || "(empty section)"}
              </div>
            </div>
          )}

          {txResult && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-base font-semibold text-slate-900">Parsed Transactions v2 (CommBank)</h3>
              <p className="mt-1 text-xs text-slate-600">
                fileId: <span className="font-mono">{txResult.fileId}</span> · 文件名: {txResult.originalName}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                transactions: {txResult.transactions.length} · warnings: {txResult.warnings.length}
              </p>

              <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-xs text-slate-700">
                <p>
                  Template: <span className="font-medium">{templateLabel(txResult.templateType)}</span> (
                  {txResult.templateType})
                </p>
                <p>Header: {txResult.quality?.headerFound ? "found" : "not found"}</p>
                <p>
                  Continuity: {continuitySummary(txResult.quality)}
                </p>
                <p>
                  Continuity skipped: {skippedSummary(txResult.quality)}
                </p>
                <p>Review Required: {txResult.needsReview ? "yes" : "no"}</p>
                {txResult.needsReview && (
                  <p>
                    Reasons:{" "}
                    {txResult.quality?.needsReviewReasons?.length
                      ? txResult.quality.needsReviewReasons.join(", ")
                      : txResult.reviewReasons.join(", ") || "-"}
                  </p>
                )}
              </div>

              {txResult.needsReview && (
                <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-xs text-red-800">
                  <div className="font-medium">Review Required</div>
                  <ul className="mt-1 list-disc pl-5">
                    {txResult.reviewReasons.map((reason, idx) => (
                      <li key={`${idx}-${reason.slice(0, 12)}`}>{reason}</li>
                    ))}
                  </ul>
                  <div className="mt-2">
                    Continuity: {continuitySummary(txResult.quality)}
                  </div>
                  <div className="mt-1">
                    Continuity skipped: {skippedSummary(txResult.quality)}
                  </div>
                  <div className="mt-2 font-medium">Section Preview</div>
                  <div className="mt-1 max-h-48 overflow-auto rounded border border-red-200 bg-white p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap text-slate-700">
                    {txResult.sectionTextPreview || "(empty section preview)"}
                  </div>
                </div>
              )}

              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-left text-xs text-slate-700">
                  <thead>
                    <tr className="border-b bg-slate-50 text-slate-500">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Description</th>
                      {txResult.templateType === "commbank_auto_debit_credit" ? (
                        <>
                          <th className="px-3 py-2">Debit</th>
                          <th className="px-3 py-2">Credit</th>
                        </>
                      ) : (
                        <th className="px-3 py-2">Amount</th>
                      )}
                      <th className="px-3 py-2">Balance</th>
                      <th className="px-3 py-2">Confidence</th>
                      <th className="px-3 py-2">Raw</th>
                    </tr>
                  </thead>
                  <tbody>
                    {txResult.transactions.map((tx) => (
                      <tr
                        key={tx.id}
                        className={`border-b last:border-none ${
                          tx.confidence < 0.6 ? "bg-amber-50" : ""
                        }`}
                      >
                        <td className="px-3 py-2">{tx.date ? new Date(tx.date).toISOString().slice(0, 10) : "-"}</td>
                        <td className="px-3 py-2">{tx.description}</td>
                        {txResult.templateType === "commbank_auto_debit_credit" ? (
                          <>
                            <td className="px-3 py-2">
                              {typeof tx.debit === "number"
                                ? `${Math.abs(tx.debit).toFixed(2)} ${tx.currency || ""}`
                                : tx.amountSource === "balance_diff_inferred" && tx.amount < 0
                                  ? `${Math.abs(tx.amount).toFixed(2)} ${tx.currency || ""} (inferred)`
                                : "-"}
                            </td>
                            <td className="px-3 py-2">
                              {typeof tx.credit === "number"
                                ? `${Math.abs(tx.credit).toFixed(2)} ${tx.currency || ""}`
                                : tx.amountSource === "balance_diff_inferred" && tx.amount >= 0
                                  ? `${Math.abs(tx.amount).toFixed(2)} ${tx.currency || ""} (inferred)`
                                : "-"}
                            </td>
                          </>
                        ) : (
                          <td className="px-3 py-2">
                            {tx.amount.toFixed(2)} {tx.currency || ""}
                          </td>
                        )}
                        <td className="px-3 py-2">
                          {typeof tx.balance === "number"
                            ? `${tx.balance.toFixed(2)} ${tx.currency || ""}`
                            : "-"}
                        </td>
                        <td className="px-3 py-2">{tx.confidence.toFixed(2)}</td>
                        <td className="px-3 py-2">
                          <button
                            onClick={() => handleToggleRawLine(tx.id)}
                            className="rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-100"
                          >
                            {expandedRawLines[tx.id] ? "Hide" : "Show"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {txResult.transactions.map((tx) =>
                expandedRawLines[tx.id] ? (
                  <div key={`${tx.id}-raw`} className="mt-2 rounded border border-slate-200 bg-white p-2 font-mono text-xs whitespace-pre-wrap">
                    {txResult.templateType === "commbank_auto_debit_credit" && (
                      <div className="mb-1 text-[11px] text-slate-600">
                        parsed: debit={typeof tx.debit === "number" ? tx.debit.toFixed(2) : "-"} ·
                        credit={typeof tx.credit === "number" ? tx.credit.toFixed(2) : "-"} ·
                        amount={Number.isFinite(tx.amount) ? tx.amount.toFixed(2) : "-"} ·
                        amountSource={tx.amountSource || "parsed_token"} ·
                        balance={typeof tx.balance === "number" ? tx.balance.toFixed(2) : "-"}
                      </div>
                    )}
                    [{tx.id}]\n{tx.rawLine}
                  </div>
                ) : null
              )}

              {txResult.warnings.length > 0 && (
                <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <div className="font-medium">Warnings (Top 20)</div>
                  <ul className="mt-1 list-disc pl-5">
                    {txResult.warnings.slice(0, 20).map((w, idx) => (
                      <li key={`${idx}-${w.rawLine.slice(0, 12)}`}>
                        confidence {w.confidence.toFixed(2)} · {w.reason} · raw: {w.rawLine}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          </section>
        </details>
      </div>
    </main>
  );
}
