"use client";

import { useEffect, useMemo, useState } from "react";
import { CATEGORY_TAXONOMY } from "@/lib/analysis/types";

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
  suppressedByRule?: number;
} | {
  ok: false;
  error: ApiError;
};

type ChangeModalState = {
  item: InboxItem;
  category: string;
  note: string;
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

function readMetaString(item: InboxItem, key: string) {
  const value = item.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function readMetaNumber(item: InboxItem, key: string) {
  const value = item.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

export default function InboxPage() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [actionBusyId, setActionBusyId] = useState("");
  const [changeModal, setChangeModal] = useState<ChangeModalState | null>(null);

  async function postJson<T>(url: string, body: Record<string, unknown>) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as T;
  }

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

  async function resolveItem(item: InboxItem) {
    setActionBusyId(item.id);
    setStatus("");
    try {
      const result = await postJson<{ ok: boolean; error?: ApiError }>(
        "/api/analysis/inbox/resolve",
        { id: item.id }
      );
      if (!result.ok) {
        setStatus(`${result.error?.code || "API_FAIL"}: ${result.error?.message || "Failed."}`);
        return;
      }
      setStatus("Resolved.");
      await fetchInbox();
    } catch {
      setStatus("Failed to resolve item.");
    } finally {
      setActionBusyId("");
    }
  }

  async function applyAlways(item: InboxItem) {
    setActionBusyId(item.id);
    setStatus("");
    try {
      const payload: Record<string, unknown> = {
        id: item.id,
        kind: item.kind,
      };
      if (item.kind === "UNKNOWN_MERCHANT") {
        payload.merchantNorm = readMetaString(item, "merchantNorm");
      } else if (item.kind === "UNCERTAIN_TRANSFER") {
        payload.transferSignature = readMetaString(item, "transferSignature");
      } else {
        payload.parseRuleKey = readMetaString(item, "parseRuleKey");
        payload.reason = item.reason;
      }
      const result = await postJson<{ ok: boolean; error?: ApiError }>(
        "/api/analysis/overrides/addRule",
        payload
      );
      if (!result.ok) {
        setStatus(`${result.error?.code || "API_FAIL"}: ${result.error?.message || "Failed."}`);
        return;
      }
      setStatus("Rule saved.");
      await fetchInbox();
    } catch {
      setStatus("Failed to save rule.");
    } finally {
      setActionBusyId("");
    }
  }

  async function submitChange() {
    if (!changeModal) return;
    const item = changeModal.item;
    setActionBusyId(item.id);
    setStatus("");
    try {
      const payload: Record<string, unknown> = {
        id: item.id,
        kind: item.kind,
        note: changeModal.note || undefined,
      };
      if (item.kind === "UNKNOWN_MERCHANT") {
        payload.merchantNorm = readMetaString(item, "merchantNorm");
        payload.category = changeModal.category || "Other";
      } else if (item.kind === "UNCERTAIN_TRANSFER") {
        payload.transferSignature = readMetaString(item, "transferSignature");
      } else {
        payload.parseRuleKey = readMetaString(item, "parseRuleKey");
        payload.reason = item.reason;
      }

      const result = await postJson<{ ok: boolean; error?: ApiError }>(
        "/api/analysis/overrides/applyOnce",
        payload
      );
      if (!result.ok) {
        setStatus(`${result.error?.code || "API_FAIL"}: ${result.error?.message || "Failed."}`);
        return;
      }
      setStatus("One-off change applied.");
      setChangeModal(null);
      await fetchInbox();
    } catch {
      setStatus("Failed to apply one-off change.");
    } finally {
      setActionBusyId("");
    }
  }

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
              {typeof data.suppressedByRule === "number" && data.suppressedByRule > 0 ? (
                <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">
                  Suppressed by rule: {data.suppressedByRule}
                </span>
              ) : null}
            </div>
          ) : null}

          {!loading && data && !data.ok && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
              {data.error.code}: {data.error.message}
            </div>
          )}
          {status ? (
            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
              {status}
            </div>
          ) : null}
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
                        {item.kind === "UNKNOWN_MERCHANT" ? (
                          <>
                            <div>
                              <span className="font-medium text-slate-700">Merchant:</span>{" "}
                              {readMetaString(item, "merchantNorm") || "-"}
                            </div>
                            <div>
                              <span className="font-medium text-slate-700">Amount:</span>{" "}
                              {typeof readMetaNumber(item, "amount") === "number"
                                ? readMetaNumber(item, "amount")
                                : "-"}
                            </div>
                          </>
                        ) : null}
                        {item.kind === "UNCERTAIN_TRANSFER" ? (
                          <>
                            <div>
                              <span className="font-medium text-slate-700">Confidence:</span>{" "}
                              {typeof readMetaNumber(item, "confidence") === "number"
                                ? readMetaNumber(item, "confidence")?.toFixed(2)
                                : "-"}
                            </div>
                            <div>
                              <span className="font-medium text-slate-700">Why:</span>{" "}
                              {readMetaString(item, "whySentence") || "Uncertain transfer"}
                            </div>
                          </>
                        ) : null}
                        {item.kind === "PARSE_ISSUE" ? (
                          <div className="sm:col-span-2">
                            <span className="font-medium text-slate-700">Template:</span>{" "}
                            {readMetaString(item, "templateType") || "-"}
                          </div>
                        ) : null}
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void resolveItem(item)}
                          disabled={actionBusyId === item.id}
                          className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          Confirm
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setChangeModal({
                              item,
                              category:
                                readMetaString(item, "category") ||
                                CATEGORY_TAXONOMY[CATEGORY_TAXONOMY.length - 1],
                              note: "",
                            })
                          }
                          disabled={actionBusyId === item.id}
                          className="rounded-lg border border-blue-300 bg-white px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-slate-400"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() => void applyAlways(item)}
                          disabled={actionBusyId === item.id}
                          className="rounded-lg border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:text-slate-400"
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

      {changeModal ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-slate-900">Change (one-off)</h2>
              <button
                type="button"
                className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-50"
                onClick={() => setChangeModal(null)}
              >
                Close
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-600">
              This applies only to this inbox item and marks it resolved.
            </p>

            {changeModal.item.kind === "UNKNOWN_MERCHANT" ? (
              <label className="mt-4 block space-y-1 text-xs font-medium text-slate-700">
                Category (this item only)
                <select
                  value={changeModal.category}
                  onChange={(e) =>
                    setChangeModal((prev) =>
                      prev
                        ? {
                            ...prev,
                            category: e.target.value,
                          }
                        : prev
                    )
                  }
                  className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                >
                  {CATEGORY_TAXONOMY.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="mt-4 block space-y-1 text-xs font-medium text-slate-700">
              Note (optional)
              <textarea
                value={changeModal.note}
                onChange={(e) =>
                  setChangeModal((prev) =>
                    prev
                      ? {
                          ...prev,
                          note: e.target.value,
                        }
                      : prev
                  )
                }
                rows={3}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900"
                placeholder="Why are you changing this one-off item?"
              />
            </label>

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setChangeModal(null)}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitChange()}
                disabled={actionBusyId === changeModal.item.id}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {actionBusyId === changeModal.item.id ? "Saving..." : "Apply one-off"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
