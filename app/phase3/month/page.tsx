"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function LegacyMonthRouteRedirect() {
  const router = useRouter();

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const target = new URLSearchParams();

    const scope = (query.get("scope") || "").trim();
    if (scope === "all") {
      target.set("scope", "all");
    }

    const fileIds = query
      .getAll("fileIds")
      .flatMap((item) => item.split(","))
      .map((item) => item.trim())
      .filter(Boolean);

    for (const fileId of fileIds) {
      target.append("fileIds", fileId);
    }

    const bankId = (query.get("bankId") || "").trim();
    if (bankId) {
      target.set("bankId", bankId);
    }
    const accountId = (query.get("accountId") || "").trim();
    if (accountId) {
      target.set("accountId", accountId);
    }

    const legacyMonth = (query.get("m") || "").trim();
    if (legacyMonth) {
      target.set("type", "month");
      target.set("key", legacyMonth);
    } else {
      target.set("type", "month");
    }

    const openInbox = (query.get("openInbox") || "").trim();
    if (openInbox) {
      target.set("openInbox", openInbox);
    }

    router.replace(`/phase3/period?${target.toString()}`);
  }, [router]);

  return (
    <main className="min-h-screen bg-slate-100 px-6 py-10">
      <div className="mx-auto max-w-3xl rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-600 shadow-sm">
        Redirecting to Specific Period View...
      </div>
    </main>
  );
}
