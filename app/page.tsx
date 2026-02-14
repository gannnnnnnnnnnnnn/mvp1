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

type ParseTransactionsApiSuccess = {
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

type UploadFlowStatus = {
  localKey: string;
  fileName: string;
  stage: "queued" | "uploading" | "uploaded" | "parsing" | "parsed" | "failed";
  fileId?: string;
  txCount?: number;
  needsReview?: boolean;
  error?: string;
};

type UploadFlowSummary = {
  uploadedCount: number;
  parsedCount: number;
  totalTxCount: number;
  reviewCount: number;
  failedCount: number;
  latestMonth?: string;
  unknownMerchantCount?: number;
};

export default function Home() {
  // Local UI state hooks.
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isRunningMainFlow, setIsRunningMainFlow] = useState(false);
  const [flowStatuses, setFlowStatuses] = useState<UploadFlowStatus[]>([]);
  const [flowSummary, setFlowSummary] = useState<UploadFlowSummary | null>(null);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

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
  const [unknownSummaryForParsedFile, setUnknownSummaryForParsedFile] = useState<{
    merchantCount: number;
    transactionCount: number;
  } | null>(null);

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

  const isPdfUploadFile = (file: File) => {
    const type = (file.type || "").toLowerCase();
    const name = (file.name || "").toLowerCase();
    return type === "application/pdf" || name.endsWith(".pdf");
  };

  const updateFlowStatus = (localKey: string, patch: Partial<UploadFlowStatus>) => {
    setFlowStatuses((prev) =>
      prev.map((item) =>
        item.localKey === localKey
          ? {
              ...item,
              ...patch,
            }
          : item
      )
    );
  };

  const monthRangeFromKey = (key: string) => {
    const match = /^(\d{4})-(\d{2})$/.exec(key);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month < 1 || month > 12) return null;
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);
    return { dateFrom: toIsoDate(start), dateTo: toIsoDate(end) };
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

  const fetchUnknownSummaryForFileIds = async (fileIds: string[]) => {
    if (fileIds.length === 0) {
      return { latestMonth: "", unknownMerchantCount: 0 };
    }

    const overviewParams = new URLSearchParams();
    overviewParams.set("scope", "selected");
    for (const fileId of fileIds) {
      overviewParams.append("fileIds", fileId);
    }
    overviewParams.set("granularity", "month");

    const overviewRes = await fetch(`/api/analysis/overview?${overviewParams.toString()}`);
    const overviewData = (await overviewRes.json()) as
      | { ok: true; availableMonths?: string[] }
      | { ok: false; error: ApiError };
    if (!overviewData.ok) {
      return { latestMonth: "", unknownMerchantCount: 0 };
    }

    const months = [...(overviewData.availableMonths || [])].sort();
    const latestMonth = months[months.length - 1] || "";
    const latestRange = monthRangeFromKey(latestMonth);
    if (!latestRange) {
      return { latestMonth, unknownMerchantCount: 0 };
    }

    const triageParams = new URLSearchParams();
    triageParams.set("scope", "selected");
    for (const fileId of fileIds) {
      triageParams.append("fileIds", fileId);
    }
    triageParams.set("dateFrom", latestRange.dateFrom);
    triageParams.set("dateTo", latestRange.dateTo);

    const triageRes = await fetch(
      `/api/analysis/triage/unknown-merchants?${triageParams.toString()}`
    );
    const triageData = (await triageRes.json()) as
      | { ok: true; unknownMerchantCount?: number }
      | { ok: false; error: ApiError };

    if (!triageData.ok) {
      return { latestMonth, unknownMerchantCount: 0 };
    }

    return {
      latestMonth,
      unknownMerchantCount: triageData.unknownMerchantCount || 0,
    };
  };

  const handleUploadAndParseMainFlow = async () => {
    if (selectedFiles.length === 0) {
      setError({ code: "NO_FILE", message: "请选择至少一个 PDF 文件。" });
      return;
    }

    setIsRunningMainFlow(true);
    setError(null);
    setSuccessMsg(null);
    setFlowSummary(null);
    setUnknownSummaryForParsedFile(null);
    setFlowStatuses(
      selectedFiles.map((file, idx) => ({
        localKey: `${file.name}-${file.lastModified}-${idx}`,
        fileName: file.name,
        stage: "queued",
      }))
    );

    let uploadedCount = 0;
    let parsedCount = 0;
    let totalTxCount = 0;
    let failedCount = 0;
    let reviewCount = 0;
    const parsedFileIds: string[] = [];
    let latestParseResult: ParseTransactionsResult | null = null;

    try {
      for (let idx = 0; idx < selectedFiles.length; idx += 1) {
        const file = selectedFiles[idx];
        const localKey = `${file.name}-${file.lastModified}-${idx}`;

        if (!isPdfUploadFile(file)) {
          failedCount += 1;
          updateFlowStatus(localKey, {
            stage: "failed",
            error: "Main flow only parses PDF files.",
          });
          continue;
        }

        updateFlowStatus(localKey, { stage: "uploading", error: undefined });
        const form = new FormData();
        form.append("file", file);

        const uploadRes = await fetch("/api/upload", {
          method: "POST",
          body: form,
        });
        const uploadData = (await uploadRes.json()) as
          | { ok: true; file: FileMeta }
          | { ok: false; error: ApiError };

        if (!uploadData.ok) {
          failedCount += 1;
          updateFlowStatus(localKey, {
            stage: "failed",
            error: `${uploadData.error.code}: ${uploadData.error.message}`,
          });
          continue;
        }

        uploadedCount += 1;
        updateFlowStatus(localKey, {
          stage: "uploaded",
          fileId: uploadData.file.id,
        });

        updateFlowStatus(localKey, { stage: "parsing" });
        const parseRes = await fetch("/api/parse/pdf-transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileId: uploadData.file.id }),
        });
        const parseData = (await parseRes.json()) as
          | ParseTransactionsApiSuccess
          | { ok: false; error: ApiError };

        if (!parseData.ok) {
          failedCount += 1;
          updateFlowStatus(localKey, {
            stage: "failed",
            error: `${parseData.error.code}: ${parseData.error.message}`,
          });
          continue;
        }

        parsedCount += 1;
        totalTxCount += parseData.transactions.length;
        if (parseData.needsReview) {
          reviewCount += 1;
        }
        parsedFileIds.push(uploadData.file.id);
        latestParseResult = {
          fileId: uploadData.file.id,
          originalName: uploadData.file.originalName,
          templateType: parseData.templateType ?? "unknown",
          transactions: parseData.transactions,
          warnings: parseData.warnings,
          quality: parseData.quality,
          needsReview: parseData.needsReview === true,
          reviewReasons: Array.isArray(parseData.reviewReasons)
            ? parseData.reviewReasons
            : [],
          sectionTextPreview:
            typeof parseData.sectionTextPreview === "string"
              ? parseData.sectionTextPreview
              : "",
          debug: parseData.debug,
        };

        updateFlowStatus(localKey, {
          stage: "parsed",
          fileId: uploadData.file.id,
          txCount: parseData.transactions.length,
          needsReview: parseData.needsReview === true,
        });
      }

      setTxResult(latestParseResult);
      await fetchFiles();
      const unknownSummary = await fetchUnknownSummaryForFileIds(parsedFileIds);
      setFlowSummary({
        uploadedCount,
        parsedCount,
        totalTxCount,
        reviewCount,
        failedCount,
        latestMonth: unknownSummary.latestMonth || undefined,
        unknownMerchantCount: unknownSummary.unknownMerchantCount,
      });

      if (failedCount > 0 || reviewCount > 0) {
        setSuccessMsg("Upload & Parse completed with partial issues. See progress and Advanced.");
      } else {
        setSuccessMsg("Upload & Parse completed.");
      }
    } catch {
      setError({
        code: "FLOW_FAILED",
        message: "批量上传并解析失败，请重试或打开 Advanced 查看细节。",
      });
    } finally {
      setIsRunningMainFlow(false);
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
        | ParseTransactionsApiSuccess
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
      try {
        const triageRes = await fetch(
          `/api/analysis/triage/unknown-merchants?fileId=${encodeURIComponent(file.id)}`
        );
        const triageData = (await triageRes.json()) as
          | { ok: true; unknownMerchantCount?: number; unknownTransactionsCount?: number }
          | { ok: false; error: ApiError };
        if (triageData.ok) {
          setUnknownSummaryForParsedFile({
            merchantCount: triageData.unknownMerchantCount || 0,
            transactionCount: triageData.unknownTransactionsCount || 0,
          });
        } else {
          setUnknownSummaryForParsedFile(null);
        }
      } catch {
        setUnknownSummaryForParsedFile(null);
      }
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
      setUnknownSummaryForParsedFile(null);
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
      setUnknownSummaryForParsedFile(null);
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

  const parsedMonthKey = useMemo(() => {
    if (!txResult || txResult.transactions.length === 0) return "";
    const dates = txResult.transactions
      .map((tx) => tx.date.slice(0, 7))
      .filter((value) => /^\d{4}-\d{2}$/.test(value))
      .sort();
    return dates[dates.length - 1] || "";
  }, [txResult]);

  const flowProgress = useMemo(() => {
    const total = flowStatuses.length;
    if (total === 0) {
      return { total: 0, done: 0 };
    }
    const done = flowStatuses.filter(
      (item) => item.stage === "parsed" || item.stage === "failed"
    ).length;
    return { total, done };
  }, [flowStatuses]);

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-4xl font-semibold text-slate-900">Personal Cashflow</h1>
          <p className="mt-2 text-slate-600">
            Upload CommBank PDFs, auto-parse, then jump to dataset analysis.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Upload & Parse</h2>
          <p className="mt-1 text-sm text-slate-600">
            Main flow: choose one or more PDFs and run parse automatically.
          </p>

          <div className="mt-4">
            <label
              className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-sm text-slate-700 hover:border-blue-500 hover:bg-blue-50"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const dropped = Array.from(event.dataTransfer?.files || []);
                setSelectedFiles(dropped);
                setError(null);
                setSuccessMsg(null);
                setFlowSummary(null);
              }}
            >
              <input
                type="file"
                multiple
                accept=".pdf,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const next = Array.from(e.target.files || []);
                  setSelectedFiles(next);
                  setError(null);
                  setSuccessMsg(null);
                  setFlowSummary(null);
                }}
              />
              <span className="font-medium">Drop PDFs here or click to select</span>
              <span className="text-xs text-slate-500">
                {selectedFiles.length > 0
                  ? `${selectedFiles.length} file(s) selected`
                  : "Supports multi-file selection"}
              </span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              onClick={() => {
                void handleUploadAndParseMainFlow();
              }}
              disabled={isRunningMainFlow}
              className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
            >
              {isRunningMainFlow ? "Uploading & Parsing..." : "Upload & Parse"}
            </button>
            <a
              href="/phase3"
              className="inline-flex items-center justify-center rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100"
            >
              Open Dataset
            </a>
            {selectedFiles.length > 0 && (
              <div className="text-xs text-slate-600">
                {selectedFiles.map((file) => file.name).join(" · ")}
              </div>
            )}
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

        {flowStatuses.length > 0 && (
          <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h3 className="text-base font-semibold text-slate-900">Run Progress</h3>
            <p className="mt-1 text-xs text-slate-600">
              Auto-parse runs for each uploaded PDF. Progress: {flowProgress.done}/
              {flowProgress.total}
            </p>
            <div className="mt-3 space-y-2 text-sm text-slate-700">
              {flowStatuses.map((item) => (
                <div key={item.localKey} className="rounded border border-slate-200 bg-slate-50 p-2">
                  <div className="font-medium text-slate-800">{item.fileName}</div>
                  <div className="mt-1 text-xs text-slate-600">
                    status: {item.stage}
                    {typeof item.txCount === "number" ? ` · tx: ${item.txCount}` : ""}
                    {item.needsReview ? " · needsReview" : ""}
                  </div>
                  {item.error && <div className="mt-1 text-xs text-red-700">{item.error}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {flowSummary && (
          <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-2xl text-white">
                ✓
              </div>
              <div>
                <h3 className="text-lg font-semibold text-emerald-900">Parsed successfully</h3>
                <p className="text-sm text-emerald-800">
                  Parsed {flowSummary.parsedCount} files, {flowSummary.totalTxCount} transactions.
                </p>
                <p className="text-xs text-emerald-800">
                  Uploaded {flowSummary.uploadedCount} file(s) in this run.
                </p>
                {(flowSummary.failedCount > 0 || flowSummary.reviewCount > 0) && (
                  <p className="text-xs text-amber-800">
                    Some files need review: failed {flowSummary.failedCount}, needsReview{" "}
                    {flowSummary.reviewCount}.
                  </p>
                )}
                {flowSummary.failedCount === 0 && flowSummary.reviewCount === 0 && (
                  <p className="text-xs text-emerald-800">
                    Next step: open dataset and start period-based analysis.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href="/phase3"
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
              >
                Go to Dataset
              </a>
              {(flowSummary.unknownMerchantCount || 0) > 0 && (
                <a
                  href={`/phase3/period?type=month${flowSummary.latestMonth ? `&key=${encodeURIComponent(flowSummary.latestMonth)}` : ""}&openInbox=1`}
                  className="rounded border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-900 hover:bg-emerald-100"
                >
                  Review unknown merchants ({flowSummary.unknownMerchantCount || 0})
                </a>
              )}
            </div>
          </section>
        )}

        <details
          open={isAdvancedOpen}
          onToggle={(event) => setIsAdvancedOpen(event.currentTarget.open)}
          className="rounded-2xl border border-slate-200 bg-white shadow-sm"
        >
          <summary className="cursor-pointer px-6 py-4 text-sm font-semibold text-slate-700">
            Advanced (legacy manual controls)
          </summary>
          <div className="space-y-6 px-6 pb-6">

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Advanced Upload</h2>
          <p className="mt-1 text-sm text-slate-600">Manual upload/debug entry, preserved for diagnostics.</p>

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
              <span className="font-medium">选择单个文件</span>
              <span className="text-xs text-slate-500">legacy mode</span>
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
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">已上传文件列表（Advanced）</h2>
              <p className="text-sm text-slate-600">Legacy debug list with manual Extract/Segment/Parse actions.</p>
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

              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-lg text-white">
                    ✓
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-emerald-900">Parsed successfully</div>
                    <div className="text-xs text-emerald-800">
                      Parsed 1 file, {txResult.transactions.length} transactions.
                    </div>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <a
                    href="/phase3"
                    className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800"
                  >
                    Go to Dashboard
                  </a>
                  {(unknownSummaryForParsedFile?.merchantCount || 0) > 0 && (
                    <a
                      href={`/phase3/period?scope=selected&fileIds=${encodeURIComponent(
                        txResult.fileId
                      )}&type=month${parsedMonthKey ? `&key=${encodeURIComponent(parsedMonthKey)}` : ""}&openInbox=1`}
                      className="rounded border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100"
                    >
                      Review unknown merchants ({unknownSummaryForParsedFile?.merchantCount || 0})
                    </a>
                  )}
                </div>
              </div>

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
          </div>
        </details>
      </div>
    </main>
  );
}
