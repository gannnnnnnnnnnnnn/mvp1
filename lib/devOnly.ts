import { NextResponse } from "next/server";
import { notFound } from "next/navigation";

export function isDevRuntime() {
  return process.env.NODE_ENV !== "production";
}

export function assertDevOnlyPage() {
  if (!isDevRuntime()) {
    notFound();
  }
}

export function rejectIfProdApi() {
  if (isDevRuntime()) return null;
  return NextResponse.json(
    {
      ok: false,
      error: { code: "NOT_FOUND", message: "Dev-only endpoint." },
    },
    { status: 404 }
  );
}

