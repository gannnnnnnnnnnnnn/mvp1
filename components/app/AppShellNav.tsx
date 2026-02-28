"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui";

type ApiError = { code: string; message: string };

const navItems = [
  { href: "/phase3", label: "Report" },
  { href: "/inbox", label: "Inbox" },
  { href: "/settings", label: "Settings" },
] as const;

export function AppShellNav() {
  const pathname = usePathname();
  const [inboxCount, setInboxCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/analysis/inbox?scope=all", { cache: "no-store" })
      .then(async (res) => {
        const data = (await res.json()) as
          | { ok: true; totals?: { unresolved?: number } }
          | { ok: false; error: ApiError };
        if (cancelled || !data.ok) return;
        setInboxCount(Number(data.totals?.unresolved || 0));
      })
      .catch(() => {
        if (!cancelled) setInboxCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  return (
    <div className="flex items-center gap-1 rounded-full border border-slate-200/80 bg-white/85 p-1 shadow-sm backdrop-blur">
      {navItems.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "relative inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors",
              active ? "text-slate-950" : "text-slate-500 hover:text-slate-900",
            ].join(" ")}
          >
            {active ? (
              <motion.span
                layoutId="app-shell-nav"
                className="absolute inset-0 -z-10 rounded-full bg-slate-100"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            ) : null}
            <span>{item.label}</span>
            {item.href === "/inbox" && inboxCount > 0 ? (
              <Badge tone="blue" className="px-2 py-0.5 text-[10px]">
                {inboxCount}
              </Badge>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}
