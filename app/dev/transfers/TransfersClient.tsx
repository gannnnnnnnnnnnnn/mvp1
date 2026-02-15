"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const CURRENCY = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 2,
});

type ApiError = { code: string; message: string };

type SummaryResponse = {
  ok: true;
  scope: { bankId?: string; accountId?: string; dateFrom?: string; dateTo?: string };
  params: { windowDays: number; minMatched: number; minUncertain: number };
  boundary: {
    mode: "customAccounts";
    boundaryAccountIds: string[];
    lastUpdatedAt: string;
  };
  options: { bankIds: string[]; accountIds: string[] };
  stats: {
    txCount: number;
    candidateCount: number;
    matchedPairs: number;
    uncertainPairs: number;
    excludedFromKpiCount: number;
    excludedFromKpiAmountAbs: number;
    topPenalties: Array<{ penalty: string; count: number }>;
    topHints: Array<{ hint: string; count: number }>;
    ambiguousBuckets: number;
  };
  decisionStats: {
    internalOffsetPairs: number;
    boundaryTransferPairs: number;
    uncertainPairs: number;
  };
};

type MatchRow = {
  matchId: string;
  state: "matched" | "uncertain";
  confidence: number;
  amountCents: number;
  dateA: string;
  dateB: string;
  dateDiffDays: number;
  decision: "INTERNAL_OFFSET" | "BOUNDARY_TRANSFER" | "UNCERTAIN" | "IGNORED";
  kpiEffect: "EXCLUDED" | "INCLUDED";
  sameFile: boolean;
  why: string;
  a: {
    transactionId: string;
    bankId: string;
    accountId: string;
    date: string;
    description: string;
    amountSigned: number;
    balance?: number;
    source: { fileId?: string; fileHash?: string; lineIndex: number };
    merchantNorm?: string;
  };
  b: {
    transactionId: string;
    bankId: string;
    accountId: string;
    date: string;
    description: string;
    amountSigned: number;
    balance?: number;
    source: { fileId?: string; fileHash?: string; lineIndex: number };
    merchantNorm?: string;
  };
  explain: {
    amountCents: number;
    dateDiffDays: number;
    sameAccount: boolean;
    descHints: string[];
    penalties: string[];
    score: number;
  };
};

type MatchesResponse = {
  ok: true;
  params: {
    state?: string;
    decision?: string;
    sameFile?: string;
    amountCents?: string;
    q?: string;
    limit?: number;
    windowDays: number;
    minMatched: number;
    minUncertain: number;
  };
  rows: MatchRow[];
};

type CollisionsResponse = {
  ok: true;
  buckets: Array<{
    amountCents: number;
    dates: string[];
    txIds: string[];
    suggested: Array<{
      debitId: string;
      creditId: string;
      bestScore: number;
      secondBestScore: number | null;
    }>;
  }>;
};

function buildParams(state: {
  bankId: string;
  accountId: string;
  dateFrom: string;
  dateTo: string;
  windowDays: number;
  minMatched: number;
  minUncertain: number;
  matchState: "all" | "matched" | "uncertain";
  decision: "all" | "INTERNAL_OFFSET" | "BOUNDARY_TRANSFER" | "UNCERTAIN" | "IGNORED";
  sameFile: "all" | "yes" | "no";
  q: string;
  amountCents: string;
  limit: number;
}) {
  const params = new URLSearchParams();
  if (state.bankId) params.set("bankId", state.bankId);
  if (state.accountId) params.set("accountId", state.accountId);
  if (state.dateFrom) params.set("dateFrom", state.dateFrom);
  if (state.dateTo) params.set("dateTo", state.dateTo);
  params.set("windowDays", String(state.windowDays));
  params.set("minMatched", String(state.minMatched));
  params.set("minUncertain", String(state.minUncertain));
  params.set("state", state.matchState);
  params.set("decision", state.decision);
  params.set("sameFile", state.sameFile);
  if (state.q) params.set("q", state.q);
  if (state.amountCents) params.set("amountCents", state.amountCents);
  params.set("limit", String(state.limit));
  return params;
}

function toSentence(row: MatchRow) {
  const sideHint = row.explain.sameAccount
    ? "same account"
    : "cross-account";
  const hintText = row.explain.descHints.length
    ? `hints: ${row.explain.descHints.join(", ")}`
    : "no strong text hints";
  const penaltyText = row.explain.penalties.length
    ? `penalties: ${row.explain.penalties.join(", ")}`
    : "no penalties";
  return `${row.decision} (${row.kpiEffect}) · ${row.why} Amount ${CURRENCY.format(
    row.amountCents / 100
  )}, ${row.explain.dateDiffDays} day gap, ${sideHint}; ${hintText}; ${penaltyText}; score ${row.explain.score.toFixed(
    2
  )}.`;
}

export default function TransfersClient() {
  const [bankId, setBankId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [windowDays, setWindowDays] = useState(1);
  const [minMatched, setMinMatched] = useState(0.85);
  const [minUncertain, setMinUncertain] = useState(0.6);
  const [matchState, setMatchState] = useState<"all" | "matched" | "uncertain">("all");
  const [decision, setDecision] = useState<
    "all" | "INTERNAL_OFFSET" | "BOUNDARY_TRANSFER" | "UNCERTAIN" | "IGNORED"
  >("all");
  const [sameFile, setSameFile] = useState<"all" | "yes" | "no">("all");
  const [q, setQ] = useState("");
  const [amountCents, setAmountCents] = useState("");
  const [limit, setLimit] = useState(200);

  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [collisions, setCollisions] = useState<CollisionsResponse["buckets"]>([]);
  const [selected, setSelected] = useState<MatchRow | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"matches" | "details" | "collisions">("matches");
  const [copyStatus, setCopyStatus] = useState("");

  const controls = useMemo(
    () => ({
      bankId,
      accountId,
      dateFrom,
      dateTo,
      windowDays,
      minMatched,
      minUncertain,
      matchState,
      decision,
      sameFile,
      q,
      amountCents,
      limit,
    }),
    [
      bankId,
      accountId,
      dateFrom,
      dateTo,
      windowDays,
      minMatched,
      minUncertain,
      matchState,
      decision,
      sameFile,
      q,
      amountCents,
      limit,
    ]
  );

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setCopyStatus("");
    try {
      const params = buildParams(controls);
      const [summaryRes, matchesRes, collisionsRes] = await Promise.all([
        fetch(`/api/dev/transfers/summary?${params.toString()}`, { cache: "no-store" }),
        fetch(`/api/dev/transfers/matches?${params.toString()}`, { cache: "no-store" }),
        fetch(`/api/dev/transfers/collisions?${params.toString()}`, { cache: "no-store" }),
      ]);

      const summaryData = (await summaryRes.json()) as SummaryResponse | { ok: false; error: ApiError };
      const matchesData = (await matchesRes.json()) as MatchesResponse | { ok: false; error: ApiError };
      const collisionsData = (await collisionsRes.json()) as
        | CollisionsResponse
        | { ok: false; error: ApiError };

      if (!summaryData.ok) {
        setError(summaryData.error);
        return;
      }
      if (!matchesData.ok) {
        setError(matchesData.error);
        return;
      }
      if (!collisionsData.ok) {
        setError(collisionsData.error);
        return;
      }

      setSummary(summaryData);
      setMatches(matchesData.rows);
      setCollisions(collisionsData.buckets);
      setSelected(matchesData.rows[0] || null);
    } catch {
      setError({ code: "FETCH_FAILED", message: "Failed to load transfer inspector payload." });
    } finally {
      setLoading(false);
    }
  }, [controls]);

  async function copyJson() {
    const payload = {
      controls,
      summary,
      matches,
      collisions,
    };
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setCopyStatus("Copied.");
    window.setTimeout(() => setCopyStatus(""), 1500);
  }

  useEffect(() => {
    void run();
    // Initial load only; subsequent runs are manual via refresh button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-6 text-slate-900 sm:px-8">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h1 className="text-2xl font-semibold text-slate-900">Transfer Offset Inspector (v2)</h1>
          <p className="mt-1 text-sm text-slate-700">
            Dev-only read-only inspector for transfer matching quality and explainability.
          </p>

          <div className="mt-4 grid gap-3 md:grid-cols-6">
            <label className="text-xs font-medium text-slate-700">
              Bank
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={bankId}
                onChange={(e) => setBankId(e.target.value)}
              >
                <option value="">All</option>
                {(summary?.options.bankIds || []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700">
              Account
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">All</option>
                {(summary?.options.accountIds || []).map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs font-medium text-slate-700">
              Date from
              <input
                type="date"
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              Date to
              <input
                type="date"
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              windowDays
              <input
                type="number"
                min={0}
                max={7}
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value) || 0)}
              />
            </label>

            <label className="text-xs font-medium text-slate-700">
              minMatched
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={minMatched}
                onChange={(e) => setMinMatched(Number(e.target.value) || 0)}
              />
            </label>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-8">
            <label className="text-xs font-medium text-slate-700">
              minUncertain
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={minUncertain}
                onChange={(e) => setMinUncertain(Number(e.target.value) || 0)}
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              State
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={matchState}
                onChange={(e) => setMatchState(e.target.value as "all" | "matched" | "uncertain")}
              >
                <option value="all">all</option>
                <option value="matched">matched</option>
                <option value="uncertain">uncertain</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Decision
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={decision}
                onChange={(e) =>
                  setDecision(
                    e.target.value as
                      | "all"
                      | "INTERNAL_OFFSET"
                      | "BOUNDARY_TRANSFER"
                      | "UNCERTAIN"
                      | "IGNORED"
                  )
                }
              >
                <option value="all">all</option>
                <option value="INTERNAL_OFFSET">INTERNAL_OFFSET</option>
                <option value="BOUNDARY_TRANSFER">BOUNDARY_TRANSFER</option>
                <option value="UNCERTAIN">UNCERTAIN</option>
                <option value="IGNORED">IGNORED</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              sameFile
              <select
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={sameFile}
                onChange={(e) => setSameFile(e.target.value as "all" | "yes" | "no")}
              >
                <option value="all">all</option>
                <option value="yes">yes</option>
                <option value="no">no</option>
              </select>
            </label>
            <label className="text-xs font-medium text-slate-700">
              Search q
              <input
                type="text"
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              amountCents
              <input
                type="number"
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={amountCents}
                onChange={(e) => setAmountCents(e.target.value)}
              />
            </label>
            <label className="text-xs font-medium text-slate-700">
              limit
              <input
                type="number"
                min={1}
                max={2000}
                className="mt-1 h-9 w-full rounded border border-slate-300 bg-white px-2 text-sm text-slate-900"
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value) || 200)}
              />
            </label>
            <div className="flex items-end gap-2">
              <button
                type="button"
                onClick={() => void run()}
                className="h-9 rounded bg-blue-600 px-3 text-sm font-medium text-white hover:bg-blue-700"
              >
                {loading ? "Running..." : "Run / Refresh"}
              </button>
              <button
                type="button"
                onClick={() => void copyJson()}
                className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
                disabled={!summary}
              >
                Copy debug JSON
              </button>
            </div>
          </div>
          {copyStatus && <p className="mt-2 text-xs text-emerald-700">{copyStatus}</p>}
          {error && (
            <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">
              {error.code}: {error.message}
            </div>
          )}
        </section>

        {summary && (
          <section className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="font-medium">Boundary accounts</span>:{" "}
                {summary.boundary.boundaryAccountIds.length > 0
                  ? summary.boundary.boundaryAccountIds.join(", ")
                  : "(empty)"}
                <span className="ml-2 text-blue-700">
                  · mode {summary.boundary.mode} · updated {summary.boundary.lastUpdatedAt.slice(0, 10)}
                </span>
              </div>
              <a
                href="/phase3"
                className="rounded border border-blue-300 bg-white px-2 py-1 font-medium text-blue-800 hover:bg-blue-100"
              >
                Configure in /phase3
              </a>
            </div>
          </section>
        )}

        {summary && (
          <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">txCount</p>
              <p className="text-xl font-semibold text-slate-900">{summary.stats.txCount}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">candidateCount</p>
              <p className="text-xl font-semibold text-slate-900">{summary.stats.candidateCount}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">internalOffsetPairs</p>
              <p className="text-xl font-semibold text-emerald-700">
                {summary.decisionStats.internalOffsetPairs}
              </p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">boundaryTransferPairs</p>
              <p className="text-xl font-semibold text-blue-700">
                {summary.decisionStats.boundaryTransferPairs}
              </p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">uncertainPairs</p>
              <p className="text-xl font-semibold text-amber-700">
                {summary.decisionStats.uncertainPairs}
              </p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">excludedFromKpiAmountAbs (internal)</p>
              <p className="text-xl font-semibold text-slate-900">
                {CURRENCY.format(summary.stats.excludedFromKpiAmountAbs)}
              </p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3">
              <p className="text-xs text-slate-700">ambiguousBuckets</p>
              <p className="text-xl font-semibold text-slate-900">{summary.stats.ambiguousBuckets}</p>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3 md:col-span-3 xl:col-span-3">
              <p className="text-xs text-slate-700">topPenalties</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-900">
                {summary.stats.topPenalties.length === 0 && <span>-</span>}
                {summary.stats.topPenalties.map((item) => (
                  <span key={item.penalty} className="rounded bg-rose-100 px-2 py-1 text-rose-800">
                    {item.penalty}: {item.count}
                  </span>
                ))}
              </div>
            </article>
            <article className="rounded-xl border border-slate-200 bg-white p-3 md:col-span-3 xl:col-span-3">
              <p className="text-xs text-slate-700">topHints</p>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-900">
                {summary.stats.topHints.length === 0 && <span>-</span>}
                {summary.stats.topHints.map((item) => (
                  <span key={item.hint} className="rounded bg-emerald-100 px-2 py-1 text-emerald-800">
                    {item.hint}: {item.count}
                  </span>
                ))}
              </div>
            </article>
          </section>
        )}

        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex gap-2">
            <button
              type="button"
              onClick={() => setActiveTab("matches")}
              className={`rounded px-3 py-1 text-sm font-medium ${
                activeTab === "matches"
                  ? "bg-blue-600 text-white"
                  : "border border-slate-300 bg-white text-slate-900"
              }`}
            >
              Matches
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("details")}
              className={`rounded px-3 py-1 text-sm font-medium ${
                activeTab === "details"
                  ? "bg-blue-600 text-white"
                  : "border border-slate-300 bg-white text-slate-900"
              }`}
            >
              Match details
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("collisions")}
              className={`rounded px-3 py-1 text-sm font-medium ${
                activeTab === "collisions"
                  ? "bg-blue-600 text-white"
                  : "border border-slate-300 bg-white text-slate-900"
              }`}
            >
              Collisions
            </button>
          </div>

          {activeTab === "matches" && (
            <div className="overflow-x-auto">
              <table className="min-w-[1500px] divide-y divide-slate-200 text-sm text-slate-900">
                <thead className="bg-slate-50 text-xs text-slate-700">
                  <tr>
                    <th className="px-2 py-2 text-left">State</th>
                    <th className="px-2 py-2 text-left">Decision</th>
                    <th className="px-2 py-2 text-left">KPI effect</th>
                    <th className="px-2 py-2 text-left">sameFile</th>
                    <th className="px-2 py-2 text-left">Conf</th>
                    <th className="px-2 py-2 text-left">Amount</th>
                    <th className="px-2 py-2 text-left">Δdays</th>
                    <th className="px-2 py-2 text-left">A side</th>
                    <th className="px-2 py-2 text-left">B side</th>
                    <th className="px-2 py-2 text-left">Why</th>
                    <th className="px-2 py-2 text-left">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {matches.map((row) => (
                    <tr key={row.matchId} className="hover:bg-slate-50">
                      <td className="px-2 py-2">
                        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                          {row.decision}
                        </span>
                      </td>
                      <td className="px-2 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            row.kpiEffect === "EXCLUDED"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-slate-100 text-slate-800"
                          }`}
                        >
                          {row.kpiEffect}
                        </span>
                      </td>
                      <td className="px-2 py-2">{row.sameFile ? "yes" : "no"}</td>
                      <td className="px-2 py-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-medium ${
                            row.state === "matched"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                          }`}
                        >
                          {row.state}
                        </span>
                      </td>
                      <td className="px-2 py-2">{row.confidence.toFixed(2)}</td>
                      <td className="px-2 py-2">{CURRENCY.format(row.amountCents / 100)}</td>
                      <td className="px-2 py-2">{row.dateDiffDays}</td>
                      <td className="px-2 py-2">
                        <div className="font-medium">{row.a.date} · {row.a.accountId}</div>
                        <div className="max-w-[320px] truncate text-xs text-slate-700">
                          {row.a.description}
                        </div>
                        <div className="text-xs text-slate-700">{CURRENCY.format(row.a.amountSigned)}</div>
                      </td>
                      <td className="px-2 py-2">
                        <div className="font-medium">{row.b.date} · {row.b.accountId}</div>
                        <div className="max-w-[320px] truncate text-xs text-slate-700">
                          {row.b.description}
                        </div>
                        <div className="text-xs text-slate-700">{CURRENCY.format(row.b.amountSigned)}</div>
                      </td>
                      <td className="px-2 py-2 max-w-[280px] text-xs text-slate-700">{row.why}</td>
                      <td className="px-2 py-2">
                        <button
                          type="button"
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-900 hover:bg-slate-50"
                          onClick={() => {
                            setSelected(row);
                            setActiveTab("details");
                          }}
                        >
                          Open details
                        </button>
                      </td>
                    </tr>
                  ))}
                  {matches.length === 0 && (
                    <tr>
                      <td className="px-2 py-4 text-sm text-slate-700" colSpan={11}>
                        No rows for current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === "details" && (
            <div className="space-y-3 text-sm text-slate-900">
              {!selected && <p className="text-slate-700">Select a match row first.</p>}
              {selected && (
                <>
                  <article className="rounded border border-slate-200 bg-slate-50 p-3">
                    <h3 className="font-semibold text-slate-900">{selected.matchId}</h3>
                    <p className="mt-1 text-slate-700">{toSentence(selected)}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      decision: {selected.decision} · effect: {selected.kpiEffect} · sameFile:{" "}
                      {selected.sameFile ? "yes" : "no"}
                    </p>
                  </article>
                  <div className="grid gap-3 md:grid-cols-2">
                    <article className="rounded border border-slate-200 bg-white p-3">
                      <h4 className="font-semibold text-slate-900">A side (out)</h4>
                      <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
{JSON.stringify(selected.a, null, 2)}
                      </pre>
                    </article>
                    <article className="rounded border border-slate-200 bg-white p-3">
                      <h4 className="font-semibold text-slate-900">B side (in)</h4>
                      <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
{JSON.stringify(selected.b, null, 2)}
                      </pre>
                    </article>
                  </div>
                  <article className="rounded border border-slate-200 bg-white p-3">
                    <h4 className="font-semibold text-slate-900">Explain</h4>
                    <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
{JSON.stringify(selected.explain, null, 2)}
                    </pre>
                  </article>
                  <article className="rounded border border-slate-200 bg-white p-3">
                    <h4 className="font-semibold text-slate-900">Decision</h4>
                    <pre className="mt-2 whitespace-pre-wrap text-xs text-slate-800">
{JSON.stringify(
  {
    decision: selected.decision,
    kpiEffect: selected.kpiEffect,
    sameFile: selected.sameFile,
    why: selected.why,
    sourceA: selected.a.source,
    sourceB: selected.b.source,
  },
  null,
  2
)}
                    </pre>
                  </article>
                </>
              )}
            </div>
          )}

          {activeTab === "collisions" && (
            <div className="space-y-3 text-sm text-slate-900">
              {collisions.map((bucket) => (
                <article key={bucket.amountCents} className="rounded border border-slate-200 bg-slate-50 p-3">
                  <h3 className="font-semibold text-slate-900">
                    amountCents {bucket.amountCents} ({CURRENCY.format(bucket.amountCents / 100)})
                  </h3>
                  <p className="mt-1 text-xs text-slate-700">dates: {bucket.dates.join(", ")}</p>
                  <p className="mt-1 text-xs text-slate-700">txIds: {bucket.txIds.join(", ")}</p>
                  <div className="mt-2 overflow-x-auto">
                    <table className="min-w-[680px] text-xs text-slate-900">
                      <thead>
                        <tr className="text-left text-slate-700">
                          <th className="pr-4">debitId</th>
                          <th className="pr-4">creditId</th>
                          <th className="pr-4">bestScore</th>
                          <th className="pr-4">secondBestScore</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.suggested.map((s) => (
                          <tr key={`${bucket.amountCents}_${s.debitId}_${s.creditId}`}>
                            <td className="pr-4">{s.debitId}</td>
                            <td className="pr-4">{s.creditId}</td>
                            <td className="pr-4">{s.bestScore.toFixed(2)}</td>
                            <td className="pr-4">
                              {typeof s.secondBestScore === "number"
                                ? s.secondBestScore.toFixed(2)
                                : "-"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </article>
              ))}
              {collisions.length === 0 && (
                <p className="text-slate-700">No collision buckets for current scope.</p>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
