"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { CATEGORY_TAXONOMY } from "@/lib/analysis/types";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Modal,
  MotionCard,
  SectionHeader,
  Toast,
} from "@/components/ui";

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

type InboxResponse =
  | {
      ok: true;
      items: InboxItem[];
      counts: Record<InboxKind, number>;
      totals: { all: number; unresolved: number; resolved: number };
      suppressedByRule?: number;
    }
  | {
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
  PARSE_ISSUE: "Parse issue",
};

function severityTone(severity: InboxItem["severity"]) {
  if (severity === "high") return "red" as const;
  if (severity === "medium") return "amber" as const;
  return "neutral" as const;
}

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

function compactSupportingLine(item: InboxItem) {
  if (item.kind === "UNKNOWN_MERCHANT") {
    const merchant = readMetaString(item, "merchantNorm") || "Merchant not recognised";
    const amount = readMetaNumber(item, "amount");
    return amount ? `${merchant} · ${amount}` : merchant;
  }
  if (item.kind === "UNCERTAIN_TRANSFER") {
    return readMetaString(item, "whySentence") || "Candidate transfer found, but no offset applied.";
  }
  return readMetaString(item, "templateType") || item.reason;
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
      setStatus("Confirmed. You can undo this later from history once it is wired.");
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
      const payload: Record<string, unknown> = { id: item.id, kind: item.kind };
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
      setStatus("Saved as the default rule for next time.");
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
      setStatus("Applied to this item only.");
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
      UNKNOWN_MERCHANT: data.items.filter((item) => item.kind === "UNKNOWN_MERCHANT").sort(itemSort),
      UNCERTAIN_TRANSFER: data.items.filter((item) => item.kind === "UNCERTAIN_TRANSFER").sort(itemSort),
      PARSE_ISSUE: data.items.filter((item) => item.kind === "PARSE_ISSUE").sort(itemSort),
    };
  }, [data]);

  return (
    <main className="px-5 py-8 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-6xl space-y-6">
        <MotionCard>
          <SectionHeader
            eyebrow="Inbox"
            title="Review what still needs a decision"
            description="Work through merchants, transfers, and parse issues. Uncertain transfers are left in totals until you confirm them."
            action={<Button variant="secondary" onClick={() => void fetchInbox()}>Refresh</Button>}
          />
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge tone="neutral">Total {data?.ok ? data.totals.unresolved : 0}</Badge>
            <Badge tone="neutral">Unknown merchant {data?.ok ? data.counts.UNKNOWN_MERCHANT : 0}</Badge>
            <Badge tone="neutral">Uncertain transfer {data?.ok ? data.counts.UNCERTAIN_TRANSFER : 0}</Badge>
            <Badge tone="neutral">Parse issue {data?.ok ? data.counts.PARSE_ISSUE : 0}</Badge>
            <Button variant="ghost" size="sm" disabled>
              Undo last action
            </Button>
          </div>
        </MotionCard>

        <Toast message={status} tone={status.includes("Failed") ? "error" : status ? "success" : "neutral"} />

        {loading ? <Card><p className="text-sm text-slate-500">Loading inbox...</p></Card> : null}
        {!loading && data && !data.ok ? (
          <Card>
            <Toast message={`${data.error.code}: ${data.error.message}`} tone="error" />
          </Card>
        ) : null}

        {data?.ok && data.totals.unresolved === 0 ? (
          <EmptyState
            title="Nothing to review"
            body="Your inbox is clear. When the parser finds something uncertain or incomplete, it will appear here."
          />
        ) : null}

        {(["UNKNOWN_MERCHANT", "UNCERTAIN_TRANSFER", "PARSE_ISSUE"] as InboxKind[]).map((kind) => (
          <MotionCard key={kind}>
            <div className="flex items-center justify-between gap-3">
              <SectionHeader title={KIND_LABELS[kind]} description="" />
              <Badge>{grouped[kind].length}</Badge>
            </div>

            {grouped[kind].length === 0 ? (
              <div className="mt-2 text-sm text-slate-500">Nothing to review in this section.</div>
            ) : (
              <div className="mt-4 space-y-3">
                {grouped[kind].map((item) => (
                  <motion.article
                    key={item.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-[24px] border border-slate-200 bg-slate-50 px-5 py-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-base font-semibold text-slate-900">{item.title}</h3>
                          <Badge tone={severityTone(item.severity)}>{item.severity}</Badge>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{item.summary}</p>
                        <div className="mt-3 text-sm text-slate-500">{compactSupportingLine(item)}</div>
                        <details className="mt-3 text-xs text-slate-500">
                          <summary className="cursor-pointer list-none font-medium text-slate-600">Details</summary>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            <div>Reason: {item.reason}</div>
                            <div>Date: {item.createdAt}</div>
                            {item.bankId ? <div>Bank: {item.bankId}</div> : null}
                            {item.accountId ? <div>Account: {item.accountId}</div> : null}
                            {item.fileId ? <div className="sm:col-span-2">File: {item.fileId}</div> : null}
                            {typeof readMetaNumber(item, "confidence") === "number" ? (
                              <div>Confidence: {readMetaNumber(item, "confidence")?.toFixed(2)}</div>
                            ) : null}
                          </div>
                        </details>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void resolveItem(item)}
                          disabled={actionBusyId === item.id}
                        >
                          Confirm
                        </Button>
                        <Button
                          variant="subtle"
                          size="sm"
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
                        >
                          Change
                        </Button>
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void applyAlways(item)}
                          disabled={actionBusyId === item.id}
                        >
                          Always do this
                        </Button>
                      </div>
                    </div>
                  </motion.article>
                ))}
              </div>
            )}
          </MotionCard>
        ))}
      </div>

      <Modal
        open={Boolean(changeModal)}
        onClose={() => setChangeModal(null)}
        title="Change this item only"
        subtitle="This does not create a permanent rule."
        footer={
          <>
            <Button variant="secondary" onClick={() => setChangeModal(null)}>
              Cancel
            </Button>
            <Button onClick={() => void submitChange()} disabled={!changeModal || actionBusyId === changeModal.item.id}>
              {changeModal && actionBusyId === changeModal.item.id ? "Saving..." : "Apply one-off"}
            </Button>
          </>
        }
      >
        {changeModal ? (
          <div className="space-y-4">
            {changeModal.item.kind === "UNKNOWN_MERCHANT" ? (
              <label className="block space-y-2 text-sm font-medium text-slate-700">
                Category
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
                  className="h-11 w-full rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-900"
                >
                  {CATEGORY_TAXONOMY.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="block space-y-2 text-sm font-medium text-slate-700">
              Note
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
                rows={4}
                className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm text-slate-900"
                placeholder="Optional context for this one-off decision"
              />
            </label>
          </div>
        ) : null}
      </Modal>
    </main>
  );
}
