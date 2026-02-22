import {
  buildAccountKey,
  normalizeAccountNumber,
  normalizeBsb,
} from "@/lib/parsing/accountMeta";

export type TransferEvidence = {
  transferType?:
    | "TRANSFER_TO"
    | "TRANSFER_FROM"
    | "PAYMENT_TO"
    | "PAYMENT_FROM"
    | "OSKO"
    | "NPP";
  refId?: string;
  counterpartyAccountKey?: string;
  counterpartyName?: string;
  payId?: string;
  hints: string[];
};

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const AU_MOBILE_RE = /\b04\d{2}\s?\d{3}\s?\d{3}\b/;
const REF_ID_RE = /#([A-Za-z0-9]+)/;
const INLINE_ACCOUNT_KEY_RE = /\b(\d{6})-(\d{6,12})\b/;
const BSB_RE = /\b(\d{3})[- ]?(\d{3})\b/;
const ACCOUNT_RE = /\b(\d{6,12})\b/;

function unique(values: string[]) {
  return [...new Set(values)];
}

function normalizeName(value?: string) {
  if (!value) return undefined;
  const cleaned = value
    .replace(/\(PAYID\)/gi, " ")
    .replace(REF_ID_RE, " ")
    .replace(INLINE_ACCOUNT_KEY_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function extractTransferType(textUpper: string): TransferEvidence["transferType"] {
  if (/\bTRANSFER TO\b/.test(textUpper)) return "TRANSFER_TO";
  if (/\bTRANSFER FROM\b/.test(textUpper)) return "TRANSFER_FROM";
  if (/\bPAYMENT TO\b/.test(textUpper)) return "PAYMENT_TO";
  if (/\bPAYMENT FROM\b/.test(textUpper)) return "PAYMENT_FROM";
  if (/\bOSKO\b/.test(textUpper)) return "OSKO";
  if (/\bNPP\b/.test(textUpper)) return "NPP";
  return undefined;
}

function extractCounterpartyAccountKey(text: string) {
  const inline = INLINE_ACCOUNT_KEY_RE.exec(text);
  if (inline) {
    const key = buildAccountKey(inline[1], inline[2]);
    if (key) return key;
  }

  const bsbMatch = BSB_RE.exec(text);
  if (!bsbMatch) return undefined;
  const bsb = normalizeBsb(`${bsbMatch[1]}${bsbMatch[2]}`);
  if (!bsb) return undefined;

  const trailing = text.slice(bsbMatch.index + bsbMatch[0].length);
  const accountMatch = ACCOUNT_RE.exec(trailing);
  const accountNumber = normalizeAccountNumber(accountMatch?.[1]);
  return buildAccountKey(bsb, accountNumber);
}

function extractCounterpartyName(text: string) {
  const paymentOrTransfer = /\b(?:PAYMENT|TRANSFER)\s+(?:TO|FROM)\s+(.+)$/i.exec(text);
  if (paymentOrTransfer) {
    const name = normalizeName(paymentOrTransfer[1]);
    if (name) return name;
  }

  const payIdName = /\b([A-Z][A-Z\s.'&-]{2,})\s*\(PAYID\)/i.exec(text);
  if (payIdName) {
    const name = normalizeName(payIdName[1]);
    if (name) return name;
  }

  return undefined;
}

export function extractTransferEvidence(descriptionRaw: string, merchantNorm?: string): TransferEvidence {
  const text = `${descriptionRaw || ""} ${merchantNorm || ""}`.trim();
  const textUpper = text.toUpperCase();
  const hints: string[] = [];

  if (/\bTRANSFER\b/.test(textUpper)) hints.push("TRANSFER");
  if (/\bOSKO\b/.test(textUpper)) hints.push("OSKO");
  if (/\bNPP\b/.test(textUpper)) hints.push("NPP");
  if (/\bPAYID\b/.test(textUpper)) hints.push("PAYID");
  if (/\bTO\b/.test(textUpper)) hints.push("TO");
  if (/\bFROM\b/.test(textUpper)) hints.push("FROM");

  const refMatch = REF_ID_RE.exec(text);
  const email = EMAIL_RE.exec(text)?.[0];
  const mobile = AU_MOBILE_RE.exec(text)?.[0];
  const payId = email || mobile?.replace(/\s+/g, "");

  return {
    transferType: extractTransferType(textUpper),
    refId: refMatch?.[1]?.toUpperCase(),
    counterpartyAccountKey: extractCounterpartyAccountKey(text),
    counterpartyName: extractCounterpartyName(text),
    payId,
    hints: unique(hints),
  };
}
