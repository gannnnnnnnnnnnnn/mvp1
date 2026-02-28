import type { ReactNode } from "react";

export function StatTile({ label, value, tone = "neutral", footnote }: { label: string; value: string; tone?: "neutral" | "green" | "red"; footnote?: ReactNode }) {
  const valueClass = tone === "green" ? "text-emerald-700" : tone === "red" ? "text-rose-700" : "text-slate-900";
  return (
    <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_18px_60px_rgba(15,23,42,0.06)]">
      <div className="text-[11px] font-medium uppercase tracking-[0.22em] text-slate-400">{label}</div>
      <div className={["mt-3 text-3xl font-semibold tracking-tight", valueClass].join(" ")}>{value}</div>
      {footnote ? <div className="mt-3 text-sm text-slate-500">{footnote}</div> : null}
    </div>
  );
}
