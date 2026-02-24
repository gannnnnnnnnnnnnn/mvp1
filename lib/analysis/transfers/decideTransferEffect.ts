import {
  TransferDecision,
  TransferKpiEffect,
} from "@/lib/analysis/types";

type TransferDecisionRow = {
  state: "matched" | "uncertain";
  a: {
    accountId: string;
    amountSigned: number;
    source: { fileId?: string; fileHash?: string };
  };
  b: {
    accountId: string;
    amountSigned: number;
    source: { fileId?: string; fileHash?: string };
  };
};

export type TransferDecisionResult = {
  decision: TransferDecision;
  kpiEffect: TransferKpiEffect;
  whySentence: string;
  sameFile: boolean;
};

function toMoneyCents(amountSigned: number) {
  return Math.round(Math.abs(amountSigned) * 100);
}

function resolveSourceKey(source: { fileId?: string; fileHash?: string }) {
  return String(source.fileHash || source.fileId || "").trim();
}

export function decideTransferEffect(
  row: TransferDecisionRow,
  boundaryAccountIds: string[]
): TransferDecisionResult {
  const boundarySet = new Set(
    boundaryAccountIds.map((id) => String(id || "").trim()).filter(Boolean)
  );

  const sourceA = resolveSourceKey(row.a.source);
  const sourceB = resolveSourceKey(row.b.source);
  const sameFile = sourceA && sourceB ? sourceA === sourceB : false;

  const oppositeSign = row.a.amountSigned < 0 && row.b.amountSigned > 0;
  const amountMatch = toMoneyCents(row.a.amountSigned) === toMoneyCents(row.b.amountSigned);
  const matchedState = row.state === "matched";
  const bothInsideBoundary =
    boundarySet.has(row.a.accountId) && boundarySet.has(row.b.accountId);
  const fileHashA = String(row.a.source.fileHash || "").trim();
  const fileHashB = String(row.b.source.fileHash || "").trim();
  const differentFileHashIfAvailable =
    fileHashA && fileHashB ? fileHashA !== fileHashB : true;

  if (!matchedState) {
    return {
      decision: "UNCERTAIN_NO_OFFSET",
      kpiEffect: "INCLUDED",
      sameFile,
      whySentence: "Candidate match, not confident enough; no offset applied.",
    };
  }

  if (
    oppositeSign &&
    amountMatch &&
    bothInsideBoundary &&
    differentFileHashIfAvailable
  ) {
    return {
      decision: "INTERNAL_OFFSET",
      kpiEffect: "EXCLUDED",
      sameFile,
      whySentence: "Matched internal transfer (both accounts inside boundary).",
    };
  }

  return {
    decision: "BOUNDARY_FLOW",
    kpiEffect: "INCLUDED",
    sameFile,
    whySentence: "Matched transfer crosses boundary (counts as boundary in/out).",
  };
}
