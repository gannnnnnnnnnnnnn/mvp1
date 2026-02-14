import { NextResponse } from "next/server";
import { setMerchantOverride, setTransactionOverride } from "@/lib/analysis/overridesStore";
import { CATEGORY_TAXONOMY } from "@/lib/analysis/types";

function errorJson(status: number, code: string, message: string) {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message },
    },
    { status }
  );
}

function isCategory(value: string): value is (typeof CATEGORY_TAXONOMY)[number] {
  return CATEGORY_TAXONOMY.includes(value as (typeof CATEGORY_TAXONOMY)[number]);
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorJson(400, "BAD_REQUEST", "Invalid JSON body.");
  }

  const category = typeof body.category === "string" ? body.category.trim() : "";
  const transactionId =
    typeof body.transactionId === "string" ? body.transactionId.trim() : "";
  const merchantNorm =
    typeof body.merchantNorm === "string" ? body.merchantNorm.trim() : "";
  const applyToMerchant = body.applyToMerchant === true;

  if (!isCategory(category)) {
    return errorJson(400, "BAD_REQUEST", "Invalid category.");
  }

  try {
    if (applyToMerchant) {
      if (!merchantNorm) {
        return errorJson(400, "BAD_REQUEST", "merchantNorm is required when applyToMerchant=true.");
      }
      await setMerchantOverride(merchantNorm, category);
      return NextResponse.json({
        ok: true,
        scope: "merchant",
        merchantNorm,
        category,
      });
    }

    if (!transactionId) {
      return errorJson(400, "BAD_REQUEST", "transactionId is required for transaction override.");
    }

    await setTransactionOverride(transactionId, category);
    return NextResponse.json({
      ok: true,
      scope: "transaction",
      transactionId,
      category,
    });
  } catch (err) {
    console.error("/api/analysis/category-override failed", err);
    return errorJson(500, "IO_FAIL", "Failed to save category override.");
  }
}
