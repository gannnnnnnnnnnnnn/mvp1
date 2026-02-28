import type { HTMLAttributes, ReactNode } from "react";
import { motion } from "framer-motion";

export function Card({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={[
        "rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-[0_18px_60px_rgba(15,23,42,0.06)] backdrop-blur",
        className,
      ].join(" ")}
      {...props}
    />
  );
}

export function MotionCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.28, ease: "easeOut" }}
      className={[
        "rounded-[28px] border border-slate-200/80 bg-white/95 p-6 shadow-[0_18px_60px_rgba(15,23,42,0.06)] backdrop-blur",
        className,
      ].join(" ")}
    >
      {children}
    </motion.div>
  );
}
