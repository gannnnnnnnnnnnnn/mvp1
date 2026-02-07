'use client';

import { useEffect, useMemo, useState } from "react";

/**
 * Metadata shape from the backend. Duplicated here for clarity and type safety.
 */
type FileMeta = {
  id: string;
  originalName: string;
  storedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
  path: string;
};

type ApiError = { code: string; message: string };

export default function Home() {
  // Local UI state hooks.
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMeta[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);

  /**
   * Helper: format bytes to something human friendly.
   */
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
    } catch (err) {
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
      await fetchFiles(); // Refresh list after successful upload.
    } catch (err) {
      setError({ code: "UPLOAD_FAILED", message: "上传失败，请稍后重试。" });
    } finally {
      setIsUploading(false);
    }
  };

  // On first load, pull the existing file list to prove persistence.
  useEffect(() => {
    fetchFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Derived text describing the selected file.
   */
  const selectedSummary = useMemo(() => {
    if (!selectedFile) return "未选择文件";
    return `${selectedFile.name} · ${formatSize(selectedFile.size)} · ${
      selectedFile.type || "unknown"
    }`;
  }, [selectedFile]);

  return (
    <main className="min-h-screen bg-slate-50 p-8">
      <div className="mx-auto max-w-5xl space-y-8">
        <header>
          <h1 className="text-3xl font-semibold text-slate-900">
            Web Dropbox 1.0 — Phase 1
          </h1>
          <p className="mt-2 text-slate-600">
            上传 PDF/CSV，保存到服务器 uploads/，并查看已上传文件。
          </p>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">文件上传</h2>
          <p className="mt-1 text-sm text-slate-600">
            仅支持 PDF / CSV，单个文件 20MB 以内。
          </p>

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
              <span className="text-xs text-slate-500">
                支持 PDF / CSV
              </span>
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
              <h2 className="text-xl font-semibold text-slate-900">
                已上传文件列表
              </h2>
              <p className="text-sm text-slate-600">
                每次刷新或重新打开页面都会从 uploads/index.json 读取。
              </p>
            </div>
            <button
              onClick={fetchFiles}
              className="text-sm font-medium text-blue-600 hover:text-blue-700"
            >
              刷新
            </button>
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-left text-sm text-slate-700">
              <thead>
                <tr className="border-b bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Size</th>
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Uploaded At</th>
                  <th className="px-3 py-2">Download</th>
                </tr>
              </thead>
              <tbody>
                {isLoadingList ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                      加载中...
                    </td>
                  </tr>
                ) : files.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-center text-slate-500">
                      暂无文件，请先上传。
                    </td>
                  </tr>
                ) : (
                  files.map((file) => (
                    <tr key={file.id} className="border-b last:border-none">
                      <td className="px-3 py-2 font-medium text-slate-900">
                        {file.originalName}
                      </td>
                      <td className="px-3 py-2">{formatSize(file.size)}</td>
                      <td className="px-3 py-2">{file.mimeType}</td>
                      <td className="px-3 py-2">
                        {new Date(file.uploadedAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        <a
                          href={`/api/files/${file.id}/download`}
                          className="text-blue-600 hover:underline"
                        >
                          下载
                        </a>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
