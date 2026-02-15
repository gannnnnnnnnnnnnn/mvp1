import {
  TransferDecision,
  TransferKpiEffect,
} from "@/lib/analysis/types";
import { TransferInspectorRow } from "@/lib/analysis/transfers/matchTransfersV2";

export type TransferDecisionResult = {
  decision: TransferDecision;
  kpiEffect: TransferKpiEffect;
  why: string;
  sameFile: boolean;
};

function toMoneyCents(amountSigned: number) {
  return Math.round(Math.abs(amountSigned) * 100);
}

function resolveSourceKey(source: { fileId?: string; fileHash?: string }) {
  return String(source.fileHash || source.fileId || "").trim();
}

export function decideTransferEffect(
  row: TransferInspectorRow,
  boundaryAccountIds: string[]
): TransferDecisionResult {
  const boundarySet = new Set(
    boundaryAccountIds.map((id) => String(id || "").trim()).filter(Boolean)
  );

  const sourceA = resolveSourceKey(row.a.source);
  const sourceB = resolveSourceKey(row.b.source);
  const sameFile = sourceA && sourceB ? sourceA === sourceB : true;

  const oppositeSign = row.a.amountSigned < 0 && row.b.amountSigned > 0;
  const amountMatch = toMoneyCents(row.a.amountSigned) === toMoneyCents(row.b.amountSigned);
  const differentAccount = row.a.accountId !== row.b.accountId;
  const matchedState = row.state === "matched";

  if (!matchedState) {
    return {
      decision: "UNCERTAIN",
      kpiEffect: "INCLUDED",
      sameFile,
      why: "Matcher state is uncertain.",
    };
  }

  if (!oppositeSign || !amountMatch || !differentAccount || sameFile) {
    const reasons: string[] = [];
    if (!oppositeSign) reasons.push("sign mismatch");
    if (!amountMatch) reasons.push("amount mismatch");
    if (!differentAccount) reasons.push("same account");
    if (sameFile) reasons.push("same source file");
    return {
      decision: "UNCERTAIN",
      kpiEffect: "INCLUDED",
      sameFile,
      why: `Strict internal constraints failed: ${reasons.join(", ")}.`,
    };
  }

  const outInBoundary = boundarySet.has(row.a.accountId);
  const inInBoundary = boundarySet.has(row.b.accountId);

  if (outInBoundary && inInBoundary) {
    return {
      decision: "INTERNAL_OFFSET",
      kpiEffect: "EXCLUDED",
      sameFile,
      why: "Matched cross-account transfer fully inside boundary.",
    };
  }

  return {
    decision: "BOUNDARY_TRANSFER",
    kpiEffect: "INCLUDED",
    sameFile,
    why: "Matched transfer crosses boundary (one side outside selected accounts).",
  };
}
