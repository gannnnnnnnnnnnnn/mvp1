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
  removedLines: number;
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
  currency?: string;
  rawLine: string;
  confidence: number;
};

type ParseWarning = {
  rawLine: string;
  reason: string;
  confidence: number;
};

type ParseTransactionsResult = {
  fileId: string;
  originalName: string;
  transactions: ParsedTransaction[];
  warnings: ParseWarning[];
};

export default function Home() {
  // Local UI state hooks.
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
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

  /**
   * Upload handler: validates presence of a selected file then POSTs to API.
   */
  const handleUpload = async () => {
    if (!selectedFile) {
      setError({ code: "NO_FILE", message: "请先选择一个 PDF 或 CSV 文件。" });
      return;
    }

    setIsUploading(true);
    setError(null);
    setSuccessMsg(null);

    const form = new FormData();
    form.append("file", selectedFile);

    try {
      const res = await fetch("/api/upload", {
        method: "POST",
        body: form,
      });
      const data = await res.json();

      if (!data.ok) {
        setError(data.error);
        return;
      }

      setSuccessMsg("上传成功！");
      setSelectedFile(null);
      await fetchFiles();
    } catch {
      setError({ code: "UPLOAD_FAILED", message: "上传失败，请稍后重试。" });
    } finally {
      setIsUploading(false);
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
            transactions: ParsedTransaction[];
            warnings: ParseWarning[];
          }
        | { ok: false; error: ApiError };

      if (!data.ok) {
        setTxError(data.error);
        return;
      }

      setTxResult({
        fileId: file.id,
        originalName: file.originalName,
        transactions: data.transactions,
        warnings: data.warnings,
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

  const selectedSummary = useMemo(() => {
    if (!selectedFile) return "未选择文件";
    return `${selectedFile.name} · ${formatSize(selectedFile.size)} · ${
      selectedFile.type || "unknown"
    }`;
  }, [selectedFile]);

  const visibleExtractText = useMemo(() => {
    if (!extractResult) return "";
    if (showFullText) return extractResult.text;
    return extractResult.text.slice(0, 4000);
  }, [extractResult, showFullText]);

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-3xl font-semibold text-slate-900">
            Web Dropbox 1.0 — Phase 2.3
          </h1>
          <p className="mt-2 text-slate-600">
            PDF-only pipeline：Extract Text → Segment → Parse Transactions。
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">文件上传</h2>
          <p className="mt-1 text-sm text-slate-600">仅支持 PDF / CSV，单个文件 20MB 以内。</p>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <label className="inline-flex cursor-pointer items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700 hover:border-blue-500 hover:bg-blue-50">
              <input
                type="file"
                accept=".pdf,.csv,application/pdf,text/csv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  setSelectedFile(file ?? null);
                  setError(null);
                  setSuccessMsg(null);
                }}
              />
              <span className="font-medium">选择文件</span>
              <span className="text-xs text-slate-500">支持 PDF / CSV</span>
            </label>

            <div className="text-sm text-slate-700">{selectedSummary}</div>

            <button
              onClick={handleUpload}
              disabled={isUploading}
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isUploading ? "上传中..." : "Upload"}
            </button>
          </div>

          {error && (
            <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              错误（{error.code}）：{error.message}
            </div>
          )}
          {successMsg && (
            <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
              {successMsg}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">已上传文件列表</h2>
              <p className="text-sm text-slate-600">每次刷新或重新打开页面都会从 uploads/index.json 读取。</p>
            </div>
            <div className="flex items-center gap-3">
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
                刷新
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
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">加载中...</td>
                  </tr>
                ) : files.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">暂无文件，请先上传。</td>
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
                            下载
                          </a>

                          {isPdfFile(file) && (
                            <>
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
                                {parsingTxFileId === file.id ? "Parsing..." : "Parse Transactions"}
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
              文本抽取错误（{extractError.code}）：{extractError.message}
            </div>
          )}

          {segmentError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              分段错误（{segmentError.code}）：{segmentError.message}
            </div>
          )}

          {txError && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              交易解析错误（{txError.code}）：{txError.message}
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
                startLine: {segmentResult.debug.startLine ?? "not found"} · removedLines: {segmentResult.debug.removedLines}
              </p>
              <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-slate-200 bg-white p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-slate-800">
                {segmentResult.sectionText || "(empty section)"}
              </div>
            </div>
          )}

          {txResult && (
            <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <h3 className="text-base font-semibold text-slate-900">Parsed Transactions v1</h3>
              <p className="mt-1 text-xs text-slate-600">
                fileId: <span className="font-mono">{txResult.fileId}</span> · 文件名: {txResult.originalName}
              </p>
              <p className="mt-1 text-xs text-slate-600">
                transactions: {txResult.transactions.length} · warnings: {txResult.warnings.length}
              </p>

              <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
                <table className="min-w-full text-left text-xs text-slate-700">
                  <thead>
                    <tr className="border-b bg-slate-50 text-slate-500">
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Description</th>
                      <th className="px-3 py-2">Amount</th>
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
                        <td className="px-3 py-2">
                          {tx.amount.toFixed(2)} {tx.currency || ""}
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
                    [{tx.id}]\n{tx.rawLine}
                  </div>
                ) : null
              )}

              {txResult.warnings.length > 0 && (
                <div className="mt-3 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  <div className="font-medium">Warnings</div>
                  <ul className="mt-1 list-disc pl-5">
                    {txResult.warnings.map((w, idx) => (
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
      </div>
    </main>
  );
}
