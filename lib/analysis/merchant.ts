const NOISE_TOKENS = new Set([
  "CARD",
  "POS",
  "EFTPOS",
  "DEBIT",
  "CREDIT",
  "VALUE",
  "DATE",
  "COMM BANK",
  "COMMBANK",
]);

function collapseSpaces(input: string) {
  return input.replace(/\s+/g, " ").trim();
}

export function normalizeDescription(text: string) {
  const upper = (text || "").toUpperCase();
  // Keep letters/numbers/basic separators so traceability stays readable.
  const cleaned = upper.replace(/[^A-Z0-9|/&\-\s]/g, " ");
  return collapseSpaces(cleaned);
}

function stripTrailingIds(text: string) {
  // Remove trailing long reference fragments, but keep short meaningful numbers.
  return collapseSpaces(text.replace(/(?:\s+[A-Z]*\d{6,})+\s*$/g, " "));
}

function removeNoiseTokens(text: string) {
  const tokens = text.split(" ").filter(Boolean);
  const filtered = tokens.filter((token) => !NOISE_TOKENS.has(token));
  return collapseSpaces(filtered.join(" "));
}

export function extractMerchantNorm(descriptionNorm: string) {
  const primaryPart = (descriptionNorm.split("|")[0] || descriptionNorm).trim();
  let normalized = stripTrailingIds(primaryPart);

  // Common transfer forms should collapse into a stable merchant key.
  if (/\bTRANSFER\s+TO\b/.test(normalized)) return "TRANSFER_TO";
  if (/\bTRANSFER\s+FROM\b/.test(normalized)) return "TRANSFER_FROM";
  if (/\bFAST\s+TRANSFER\s+FROM\b/.test(normalized)) return "FAST_TRANSFER_FROM";
  if (/\bDIRECT\s+DEBIT\b/.test(normalized)) return "DIRECT_DEBIT";

  normalized = removeNoiseTokens(normalized);

  // Keep key stable but compact for mapping.
  const merchant = normalized
    .replace(/\b(?:XX\d+|\d{6,})\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return merchant || "UNKNOWN_MERCHANT";
}

export function normalizeMerchantFromRaw(descriptionRaw: string) {
  const descriptionNorm = normalizeDescription(descriptionRaw);
  const merchantNorm = extractMerchantNorm(descriptionNorm);
  return { descriptionNorm, merchantNorm };
}
