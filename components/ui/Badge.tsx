import type { HTMLAttributes } from "react";

const toneClass = {
  neutral: "border-slate-200 bg-slate-50 text-slate-600",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  green: "border-emerald-200 bg-emerald-50 text-emerald-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  red: "border-red-200 bg-red-50 text-red-700",
} as const;

export function Badge({
  className = "",
  children,
  tone = "neutral",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof toneClass }) {
  return (
    <span
      className={[
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium",
        toneClass[tone],
        className,
      ].join(" ")}
      {...rest}
    >
      {children}
    </span>
  );
}
