import type { HTMLAttributes, TableHTMLAttributes, ThHTMLAttributes, TdHTMLAttributes } from "react";

export function TableFrame({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["overflow-x-auto rounded-[24px] border border-slate-200 bg-white", className].join(" ")} {...props} />;
}

export function Table({ className = "", ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={["min-w-full text-sm", className].join(" ")} {...props} />;
}

export function THead({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={["bg-slate-50 text-left text-xs uppercase tracking-[0.18em] text-slate-500", className].join(" ")} {...props} />;
}

export function TBody({ className = "", ...props }: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={["divide-y divide-slate-100 text-slate-700", className].join(" ")} {...props} />;
}

export function TH({ className = "", ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={["px-4 py-3 font-medium", className].join(" ")} {...props} />;
}

export function TD({ className = "", ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={["px-4 py-3 align-top", className].join(" ")} {...props} />;
}

export function TR({ className = "", ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={["transition-colors duration-150 hover:bg-slate-50/80", className].join(" ")} {...props} />;
}
