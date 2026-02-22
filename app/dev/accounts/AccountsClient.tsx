"use client";

import { useEffect, useMemo, useState } from "react";

type ApiError = { code: string; message: string };

type AccountRow = {
  fileId: string;
  fileName: string;
  uploadedAt: string;
  bankId: string;
  templateId: string;
  accountId: string;
  accountMeta: {
    accountName?: string;
    bsb?: string;
    accountNumber?: string;
    accountKey?: string;
    metaWarnings: string[];
  };
};

type AccountsResponse = {
  ok: true;
  count: number;
  accounts: AccountRow[];
};

type RebuildResponse =
  | {
      ok: true;
      updatedCount: number;
      failureCount: number;
      failures: Array<{ fileId: string; fileName: string; reason: string }>;
    }
  | {
      ok: false;
      error: ApiError;
    };

type SortKey =
  | "uploadedAt"
  | "fileName"
  | "bankId"
  | "templateId"
  | "accountId"
  | "accountName"
  | "accountKey";

const SORT_LABELS: Record<SortKey, string> = {
  uploadedAt: "Uploaded",
  fileName: "File",
  bankId: "Bank",
  templateId: "Template",
  accountId: "Account ID",
  accountName: "Account Name",
  accountKey: "Account Key",
};

function sortValue(row: AccountRow, key: SortKey) {
  if (key === "uploadedAt") return row.uploadedAt || "";
  if (key === "fileName") return row.fileName || "";
  if (key === "bankId") return row.bankId || "";
  if (key === "templateId") return row.templateId || "";
  if (key === "accountId") return row.accountId || "";
  if (key === "accountName") return row.accountMeta.accountName || "";
  return row.accountMeta.accountKey || "";
}

export default function AccountsClient() {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("uploadedAt");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [copyStatus, setCopyStatus] = useState("");
  const [rebuildStatus, setRebuildStatus] = useState("");
  const [rebuildLoading, setRebuildLoading] = useState(false);

  async function fetchRows() {
    setLoading(true);
    setError(null);
    setCopyStatus("");
    try {
      const res = await fetch("/api/dev/accounts", { cache: "no-store" });
      const data = (await res.json()) as AccountsResponse | { ok: false; error: ApiError };
      if (!data.ok) {
        setError(data.error);
        return;
      }
      setRows(data.accounts);
    } catch {
      setError({ code: "FETCH_FAILED", message: "Failed to load /api/dev/accounts" });
    } finally {
      setLoading(false);
    }
  }

  async function copyJson() {
    await navigator.clipboard.writeText(JSON.stringify(rows, null, 2));
    setCopyStatus("Copied.");
    window.setTimeout(() => setCopyStatus(""), 1200);
  }

  async function rebuildAccountIdentity() {
    setRebuildLoading(true);
    setRebuildStatus("");
    try {
      const res = await fetch("/api/dev/accounts/rebuild", {
        method: "POST",
      });
      const data = (await res.json()) as RebuildResponse;
      if (!data.ok) {
        setRebuildStatus(`Rebuild failed: ${data.error.code} ${data.error.message}`);
        return;
      }
      setRebuildStatus(
        `Rebuild complete. updated=${data.updatedCount}, failures=${data.failureCount}`
      );
      await fetchRows();
    } catch {
      setRebuildStatus("Rebuild failed: request error.");
    } finally {
      setRebuildLoading(false);
    }
  }

  useEffect(() => {
    void fetchRows();
  }, []);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const left = sortValue(a, sortKey);
      const right = sortValue(b, sortKey);
      const diff = left.localeCompare(right);
      return sortDir === "asc" ? diff : -diff;
    });
  }, [rows, sortDir, sortKey]);

  const warningCount = useMemo(
    () => sortedRows.filter((row) => row.accountMeta.metaWarnings.length > 0).length,
    [sortedRows]
  );

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-6 text-slate-900 sm:px-8">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Account Identity Inspector</h1>
          <p className="mt-1 text-sm text-slate-700">
            Dev-only identity view from uploads index. Use this to verify accountMeta before transfer offset debugging.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-slate-700">
            <span>rows: {sortedRows.length}</span>
            <span>with warnings: {warningCount}</span>
            <button
              type="button"
              onClick={() => void fetchRows()}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 hover:bg-slate-50"
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
            <button
              type="button"
              onClick={() => void copyJson()}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 hover:bg-slate-50"
              disabled={sortedRows.length === 0}
            >
              Copy JSON
            </button>
            <button
              type="button"
              onClick={() => void rebuildAccountIdentity()}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-slate-900 hover:bg-slate-50"
              disabled={rebuildLoading}
            >
              {rebuildLoading
                ? "Rebuilding..."
                : "Rebuild account identity for existing files"}
            </button>
            {copyStatus ? <span className="text-emerald-700">{copyStatus}</span> : null}
            {rebuildStatus ? (
              <span className="text-indigo-700">{rebuildStatus}</span>
            ) : null}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <label className="text-xs font-medium text-slate-700">
              Sort by
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as SortKey)}
              >
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                  <option key={key} value={key}>
                    {SORT_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Direction
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={sortDir}
                onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}
              >
                <option value="desc">desc</option>
                <option value="asc">asc</option>
              </select>
            </label>
          </div>

          {error && (
            <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
              {error.code}: {error.message}
            </div>
          )}
        </section>

        <section className="overflow-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <table className="min-w-[1200px] text-sm text-slate-900">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-600">
                <th className="px-2 py-2">Uploaded</th>
                <th className="px-2 py-2">File</th>
                <th className="px-2 py-2">Bank</th>
                <th className="px-2 py-2">Template</th>
                <th className="px-2 py-2">Account ID</th>
                <th className="px-2 py-2">Account Name</th>
                <th className="px-2 py-2">BSB</th>
                <th className="px-2 py-2">Account Number</th>
                <th className="px-2 py-2">Account Key</th>
                <th className="px-2 py-2">Warnings</th>
              </tr>
            </thead>
            <tbody>
              {sortedRows.map((row) => {
                const hasWarnings = row.accountMeta.metaWarnings.length > 0;
                return (
                  <tr
                    key={row.fileId}
                    className={`border-b border-slate-100 ${hasWarnings ? "bg-amber-50" : "bg-white"}`}
                  >
                    <td className="px-2 py-2">{row.uploadedAt.slice(0, 19).replace("T", " ")}</td>
                    <td className="px-2 py-2">{row.fileName}</td>
                    <td className="px-2 py-2">{row.bankId}</td>
                    <td className="px-2 py-2">{row.templateId}</td>
                    <td className="px-2 py-2 font-mono text-xs">{row.accountId}</td>
                    <td className="px-2 py-2">{row.accountMeta.accountName || "-"}</td>
                    <td className="px-2 py-2 font-mono text-xs">{row.accountMeta.bsb || "-"}</td>
                    <td className="px-2 py-2 font-mono text-xs">
                      {row.accountMeta.accountNumber || "-"}
                    </td>
                    <td className="px-2 py-2 font-mono text-xs">{row.accountMeta.accountKey || "-"}</td>
                    <td className="px-2 py-2 text-xs">
                      {hasWarnings ? row.accountMeta.metaWarnings.join(", ") : "-"}
                    </td>
                  </tr>
                );
              })}
              {sortedRows.length === 0 && !loading ? (
                <tr>
                  <td colSpan={10} className="px-2 py-4 text-center text-sm text-slate-500">
                    No account rows yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
