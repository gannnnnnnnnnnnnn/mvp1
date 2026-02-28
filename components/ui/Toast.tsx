"use client";

import { AnimatePresence, motion } from "framer-motion";

const toneClass = {
  neutral: "border-slate-200 bg-white text-slate-700",
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
} as const;

export function Toast({ message, tone = "neutral" }: { message: string; tone?: keyof typeof toneClass }) {
  return (
    <AnimatePresence>
      {message ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          className={["rounded-2xl border px-4 py-3 text-sm shadow-sm", toneClass[tone]].join(" ")}
        >
          {message}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
