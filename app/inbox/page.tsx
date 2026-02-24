"use client";

import { useEffect, useMemo, useState } from "react";

type ApiError = { code: string; message: string };
type InboxKind = "UNKNOWN_MERCHANT" | "UNCERTAIN_TRANSFER" | "PARSE_ISSUE";

type InboxItem = {
  id: string;
  kind: InboxKind;
  bankId?: string;
  accountId?: string;
  fileId?: string;
  transactionId?: string;
  matchId?: string;
  pairKey?: string;
  reason: string;
  title: string;
  summary: string;
  severity: "high" | "medium" | "low";
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type InboxResponse = {
  ok: true;
  items: InboxItem[];
  counts: Record<InboxKind, number>;
  totals: { all: number; unresolved: number; resolved: number };
} | {
  ok: false;
  error: ApiError;
};

const KIND_LABELS: Record<InboxKind, string> = {
  UNKNOWN_MERCHANT: "Unknown merchant",
  UNCERTAIN_TRANSFER: "Uncertain transfer",
  PARSE_ISSUE: "Needs review parse issue",
};

const SEVERITY_CLASS: Record<InboxItem["severity"], string> = {
  high: "border-red-200 bg-red-50 text-red-700",
  medium: "border-amber-200 bg-amber-50 text-amber-700",
  low: "border-slate-200 bg-slate-50 text-slate-700",
};

function buildInboxQueryFromUrl() {
  const params = new URLSearchParams();
  if (typeof window === "undefined") {
    params.set("scope", "all");
    return params;
  }
  const query = new URLSearchParams(window.location.search);
  const fileId = (query.get("fileId") || "").trim();
  const fileIds = (query.get("fileIds") || "").trim();
  const scope = (query.get("scope") || "").trim();
  const bankId = (query.get("bankId") || "").trim();
  const accountId = (query.get("accountId") || "").trim();
  const dateFrom = (query.get("dateFrom") || "").trim();
  const dateTo = (query.get("dateTo") || "").trim();

  if (scope) params.set("scope", scope);
  if (fileId) params.set("fileId", fileId);
  if (fileIds) params.set("fileIds", fileIds);
  if (bankId) params.set("bankId", bankId);
  if (accountId) params.set("accountId", accountId);
  if (dateFrom) params.set("dateFrom", dateFrom);
  if (dateTo) params.set("dateTo", dateTo);
  if (!params.get("scope") && !params.get("fileId") && !params.get("fileIds")) {
    params.set("scope", "all");
  }
  return params;
}

function itemSort(a: InboxItem, b: InboxItem) {
  return b.createdAt.localeCompare(a.createdAt);
}

export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);

  async function fetchInbox() {
    setLoading(true);
    try {
      const params = buildInboxQueryFromUrl();
      const res = await fetch(`/api/analysis/inbox?${params.toString()}`, {
        cache: "no-store",
      });
      const body = (await res.json()) as InboxResponse;
      setData(body);
    } catch {
      setData({
        ok: false,
        error: { code: "FETCH_FAILED", message: "Failed to load inbox." },
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchInbox();
  }, []);

  const grouped = useMemo(() => {
    if (!data?.ok) {
      return {
        UNKNOWN_MERCHANT: [] as InboxItem[],
        UNCERTAIN_TRANSFER: [] as InboxItem[],
        PARSE_ISSUE: [] as InboxItem[],
      };
    }
    return {
      UNKNOWN_MERCHANT: data.items
        .filter((item) => item.kind === "UNKNOWN_MERCHANT")
        .sort(itemSort),
      UNCERTAIN_TRANSFER: data.items
        .filter((item) => item.kind === "UNCERTAIN_TRANSFER")
        .sort(itemSort),
      PARSE_ISSUE: data.items.filter((item) => item.kind === "PARSE_ISSUE").sort(itemSort),
    };
  }, [data]);

  return (
    <main className="min-h-screen bg-slate-100/60 px-6 py-6 sm:px-8 sm:py-8">
      <div className="mx-auto max-w-[1280px] space-y-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-slate-900">Review Inbox</h1>
              <p className="mt-1 text-sm text-slate-600">
                Resolve uncertain items: unknown merchants, uncertain transfers, and parse issues.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void fetchInbox()}
              className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Refresh
            </button>
          </div>

          {loading && <p className="mt-4 text-sm text-slate-500">Loading inbox...</p>}

          {data?.ok ? (
            <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                Total: {data.totals.unresolved}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                Unknown merchant: {data.counts.UNKNOWN_MERCHANT}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                Uncertain transfer: {data.counts.UNCERTAIN_TRANSFER}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">
                Parse issue: {data.counts.PARSE_ISSUE}
              </span>
            </div>
          ) : null}

          {!loading && data && !data.ok && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {data.error.code}: {data.error.message}
            </div>
          )}
        </section>

        {(["UNKNOWN_MERCHANT", "UNCERTAIN_TRANSFER", "PARSE_ISSUE"] as InboxKind[]).map(
          (kind) => (
            <section
              key={kind}
              className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold text-slate-900">{KIND_LABELS[kind]}</h2>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600">
                  {grouped[kind].length}
                </span>
              </div>

              {grouped[kind].length === 0 ? (
                <p className="text-sm text-slate-500">No items.</p>
              ) : (
                <div className="space-y-3">
                  {grouped[kind].map((item) => (
                    <article
                      key={item.id}
                      className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h3 className="text-sm font-semibold text-slate-900">{item.title}</h3>
                          <p className="mt-1 text-xs text-slate-600">{item.summary}</p>
                        </div>
                        <span
                          className={`rounded-full border px-2 py-1 text-[11px] font-medium ${SEVERITY_CLASS[item.severity]}`}
                        >
                          {item.severity.toUpperCase()}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-1 text-xs text-slate-600 sm:grid-cols-2">
                        <div>
                          <span className="font-medium text-slate-700">Reason:</span>{" "}
                          {item.reason}
                        </div>
                        <div>
                          <span className="font-medium text-slate-700">Date:</span>{" "}
                          {item.createdAt}
                        </div>
                        {item.bankId ? (
                          <div>
                            <span className="font-medium text-slate-700">Bank:</span> {item.bankId}
                          </div>
                        ) : null}
                        {item.accountId ? (
                          <div>
                            <span className="font-medium text-slate-700">Account:</span>{" "}
                            {item.accountId}
                          </div>
                        ) : null}
                        {item.fileId ? (
                          <div className="sm:col-span-2">
                            <span className="font-medium text-slate-700">File:</span> {item.fileId}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-500"
                          title="Will be enabled after actions API is added."
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          disabled
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-500"
                          title="Will be enabled after actions API is added."
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          disabled
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-500"
                          title="Will be enabled after actions API is added."
                        >
                          Always do this
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )
        )}
      </div>
    </main>
  );
}

