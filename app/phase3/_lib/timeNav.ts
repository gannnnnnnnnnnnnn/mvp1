export type ScopeMode = "all" | "selected";

export function monthRange(month: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthNum = Number(match[2]);
  const start = new Date(Date.UTC(year, monthNum - 1, 1));
  const end = new Date(Date.UTC(year, monthNum, 0));
  const toDate = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: toDate(start), dateTo: toDate(end) };
}

export function quarterRange(period: string) {
  const match = /^(\d{4})-Q([1-4])$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const quarter = Number(match[2]);
  const startMonth = (quarter - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  const toDate = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: toDate(start), dateTo: toDate(end) };
}

export function yearRange(yearText: string) {
  const year = Number(yearText);
  if (!Number.isInteger(year)) return null;
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  const toDate = (d: Date) => d.toISOString().slice(0, 10);
  return { dateFrom: toDate(start), dateTo: toDate(end) };
}

export function parseScopeFromWindow() {
  if (typeof window === "undefined") {
    return { scopeMode: "all" as ScopeMode, fileIds: [] as string[] };
  }
  const query = new URLSearchParams(window.location.search);
  const scopeRaw = (query.get("scope") || "").trim();
  const ids = query
    .getAll("fileIds")
    .flatMap((value) => value.split(","))
    .map((item) => item.trim())
    .filter(Boolean);

  if (scopeRaw === "selected" || ids.length > 0) {
    return { scopeMode: "selected" as ScopeMode, fileIds: [...new Set(ids)] };
  }

  return { scopeMode: "all" as ScopeMode, fileIds: [] as string[] };
}

export function buildScopeParams(scopeMode: ScopeMode, selectedFileIds: string[]) {
  const params = new URLSearchParams();
  if (scopeMode === "all") {
    params.set("scope", "all");
  } else {
    for (const fileId of selectedFileIds) {
      params.append("fileIds", fileId);
    }
  }
  return params;
}

export function pushScopeIntoUrl(scopeMode: ScopeMode, selectedFileIds: string[]) {
  if (typeof window === "undefined") return;
  const params = buildScopeParams(scopeMode, selectedFileIds);
  const base = window.location.pathname;
  const next = params.toString();
  const url = next ? `${base}?${next}` : base;
  window.history.replaceState(null, "", url);
}
