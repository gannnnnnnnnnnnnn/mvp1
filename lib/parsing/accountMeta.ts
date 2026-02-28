export type StatementAccountMeta = {
  bankId: string;
  accountId: string;
  templateId: string;
  accountName?: string;
  bsb?: string;
  accountNumber?: string;
  accountKey?: string;
  metaWarnings?: string[];
};

function digitsOnly(value: string) {
  return (value || "").replace(/\D/g, "");
}

function splitLines(text: string) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());
}

function firstPageWindow(text: string) {
  const normalized = (text || "").replace(/\r\n/g, "\n");
  const page2Marker = /\bPage\s*2\s*of\b/i.exec(normalized);
  if (!page2Marker?.index) return normalized;
  return normalized.slice(0, page2Marker.index);
}

function isNoiseLabel(line: string) {
  return /^(BSB|Account number|Account type|Date opened|Date|Transaction|Page\b|Created\b)/i.test(
    line
  );
}

function extractLabeledValue(lines: string[], labelRe: RegExp) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = labelRe.exec(line);
    if (inline?.[1]) {
      return inline[1].trim();
    }
    if (labelRe.test(line)) {
      for (let j = i + 1; j <= i + 3 && j < lines.length; j += 1) {
        const candidate = (lines[j] || "").trim();
        if (!candidate || isNoiseLabel(candidate)) continue;
        return candidate;
      }
    }
  }
  return undefined;
}

function cleanAccountName(value?: string) {
  const candidate = String(value || "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!candidate) return undefined;
  if (/\bBSB\b/i.test(candidate)) return undefined;
  if (/^Account\b/i.test(candidate)) return undefined;
  if (/^[+\-]?\s*\$/.test(candidate)) return undefined;
  return candidate;
}

function extractCbaAccountNumberFromAccountNumberLine(text: string, knownBsb?: string) {
  const match = /\bAccount Number\b\s*([0-9][0-9 \-]{7,24})/i.exec(text);
  if (!match?.[1]) return undefined;
  const tokens = match[1]
    .trim()
    .split(/\s+/)
    .map((token) => digitsOnly(token))
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  if (tokens.length >= 2) {
    const first = normalizeBsb(tokens[0]);
    if (knownBsb && first === knownBsb) {
      return normalizeAccountNumber(tokens[1]);
    }
    if (!knownBsb && first) {
      return normalizeAccountNumber(tokens[1]);
    }
  }
  const merged = digitsOnly(match[1]);
  if (knownBsb && merged.startsWith(knownBsb) && merged.length > 6) {
    return normalizeAccountNumber(merged.slice(6));
  }
  return normalizeAccountNumber(merged);
}

function extractCbaHeaderIdentity(text: string) {
  const patterns = [
    /(?:^|\n)\s*Account Number\s+(\d{2}\s?\d{4}\s?\d{6,12})\b/im,
    /(?:^|\n)\s*Account Number\s+(\d{6}\s?\d{6,12})\b/im,
    /(?:^|\n)\s*Account Number\s+(\d{12,18})\b/im,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const digits = digitsOnly(match[1]);
    if (digits.length < 12) continue;
    return {
      bsb: normalizeBsb(digits.slice(0, 6)),
      accountNumber: normalizeAccountNumber(digits.slice(6)),
    };
  }

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^Account Number\b/i.test(lines[i] || "")) continue;
    for (let j = i; j <= i + 2 && j < lines.length; j += 1) {
      const digits = digitsOnly(lines[j] || "");
      if (digits.length < 12) continue;
      return {
        bsb: normalizeBsb(digits.slice(0, 6)),
        accountNumber: normalizeAccountNumber(digits.slice(6)),
      };
    }
  }

  return { bsb: undefined, accountNumber: undefined };
}

export function normalizeBsb(value?: string) {
  const digits = digitsOnly(value || "");
  if (digits.length < 6) return undefined;
  return digits.slice(0, 6);
}

export function normalizeAccountNumber(value?: string) {
  const digits = digitsOnly(value || "");
  if (digits.length < 6) return undefined;
  return digits;
}

export function sanitizeAccountNumber(bsb?: string, accountNumberRaw?: string) {
  const warnings: string[] = [];
  const normalizedBsb = normalizeBsb(bsb);
  const normalizedRaw = normalizeAccountNumber(accountNumberRaw);
  if (!normalizedRaw) {
    return { accountNumber: undefined, warnings };
  }
  if (!normalizedBsb || !normalizedRaw.startsWith(normalizedBsb)) {
    return { accountNumber: normalizedRaw, warnings };
  }

  const remainder = normalizedRaw.slice(6);
  if (remainder.length >= 6 && remainder.length <= 12) {
    warnings.push("ACCOUNT_NUMBER_HAS_BSB_PREFIX_STRIPPED");
    return { accountNumber: remainder, warnings };
  }
  return { accountNumber: normalizedRaw, warnings };
}

export function buildAccountKey(bsb?: string, accountNumber?: string) {
  const normalizedBsb = normalizeBsb(bsb);
  const normalizedAccount = normalizeAccountNumber(accountNumber);
  if (!normalizedBsb || !normalizedAccount) return undefined;
  return `${normalizedBsb}-${normalizedAccount}`;
}

export function normalizeAccountMeta(
  meta: Partial<StatementAccountMeta> & {
    bankId: string;
    accountId: string;
    templateId: string;
  }
): StatementAccountMeta {
  const rawAccountName = (meta.accountName || "").trim();
  const accountName =
    rawAccountName && !/\bBSB\b/i.test(rawAccountName) ? rawAccountName : undefined;
  let bsb = normalizeBsb(meta.bsb);
  let normalizedAccountRaw = normalizeAccountNumber(meta.accountNumber);
  if (!bsb && normalizedAccountRaw && normalizedAccountRaw.length >= 12) {
    bsb = normalizeBsb(normalizedAccountRaw.slice(0, 6));
    normalizedAccountRaw = normalizeAccountNumber(normalizedAccountRaw.slice(6));
  }
  const sanitized = sanitizeAccountNumber(bsb, normalizedAccountRaw);
  const accountNumber = sanitized.accountNumber;
  const accountKey = buildAccountKey(bsb, accountNumber);
  const metaWarnings = [
    ...(Array.isArray(meta.metaWarnings) ? meta.metaWarnings : []),
    ...sanitized.warnings,
  ];
  const uniqueWarnings = [...new Set(metaWarnings.map((item) => String(item).trim()).filter(Boolean))];

  return {
    bankId: meta.bankId,
    accountId: meta.accountId,
    templateId: meta.templateId,
    accountName,
    bsb,
    accountNumber,
    accountKey,
    metaWarnings: uniqueWarnings.length > 0 ? uniqueWarnings : undefined,
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 48);
}

export function resolveAccountIdFromMeta(params: {
  bankId: string;
  existingAccountId?: string;
  accountMeta?: Partial<StatementAccountMeta>;
}) {
  const existing = String(params.existingAccountId || "").trim();
  const accountKey = params.accountMeta?.accountKey?.trim();
  if (accountKey) return accountKey;

  const accountName = String(params.accountMeta?.accountName || "").trim();
  if (params.bankId === "cba" && accountName) {
    const slug = slugify(accountName);
    if (slug) return `cba-${slug}`;
  }

  if (existing && existing !== "default") return existing;
  return "default";
}

export function extractCbaAccountMeta(params: {
  text: string;
  accountId: string;
  templateId: string;
}): StatementAccountMeta {
  const { text, accountId, templateId } = params;
  const pageOneText = firstPageWindow(text);
  const windows = [pageOneText, text].filter(Boolean);

  let accountName: string | undefined;
  let bsb: string | undefined;
  let accountNumber: string | undefined;
  let accountNumberFromLine: string | undefined;
  let headerFallbackUsed = false;
  const metaWarnings: string[] = [];

  for (const windowText of windows) {
    const lines = splitLines(windowText);

    // Strong: explicit label rows in account summary table.
    if (!accountName) {
      const labelMatch =
        /(?:^|\n)\s*Account name\s+([A-Za-z][A-Za-z0-9 '&.-]{1,})\s*$/im.exec(windowText);
      accountName = cleanAccountName(labelMatch?.[1]);
    }
    if (!accountName) {
      const nameLabel = /(?:^|\n)\s*Name\s*:\s*([A-Za-z][A-Za-z0-9 '&.-]{1,})\s*$/im.exec(windowText);
      accountName = cleanAccountName(nameLabel?.[1]);
    }

    if (!bsb) {
      const labelMatch = /(?:^|\n)\s*BSB\s+([0-9][0-9 \-]{4,10})\s*$/im.exec(windowText);
      const value = labelMatch?.[1];
      bsb = normalizeBsb(value);
    }

    if (!accountNumber) {
      const labelMatch =
        /(?:^|\n)\s*Account number\s+([0-9][0-9 \-]{5,20})\s*$/im.exec(windowText);
      const value = labelMatch?.[1];
      accountNumber = normalizeAccountNumber(value);
    }

    // Medium: header split "Account Number <bsb> <account>".
    if (!bsb || !accountNumber) {
      const splitHeader =
        /(?:^|\n)\s*Account Number\s+(\d{3}\s?\d{3})\s+(\d{6,12})\b/im.exec(windowText);
      if (splitHeader) {
        bsb = bsb || normalizeBsb(splitHeader[1]);
        accountNumber = accountNumber || normalizeAccountNumber(splitHeader[2]);
      }
    }

    // Weak fallback: generic labeled extraction.
    if (!accountName) {
      const value = extractLabeledValue(lines, /Account name\s*[:\s]*([A-Za-z0-9 '&.-]{2,})/i);
      accountName = cleanAccountName(value);
    }
    if (!accountName) {
      const value = extractLabeledValue(lines, /Name\s*:\s*([A-Za-z0-9 '&.-]{2,})/i);
      accountName = cleanAccountName(value);
    }
    if (!bsb) {
      const value = extractLabeledValue(lines, /\bBSB\b\s*[:\s]*([0-9][0-9 \-]{4,10})/i);
      bsb = normalizeBsb(value);
    }
    if (!accountNumber) {
      const value = extractLabeledValue(
        lines,
        /Account number\s*[:\s]*([0-9][0-9 \-]{5,20})/i
      );
      accountNumber = normalizeAccountNumber(value);
    }

    if (!accountNumberFromLine) {
      accountNumberFromLine = extractCbaAccountNumberFromAccountNumberLine(windowText, bsb);
    }
  }

  if (!bsb || !accountNumber) {
    const headerIdentity = extractCbaHeaderIdentity(pageOneText);
    if (!bsb && headerIdentity.bsb) {
      bsb = headerIdentity.bsb;
      headerFallbackUsed = true;
    }
    if (!accountNumber && headerIdentity.accountNumber) {
      accountNumber = headerIdentity.accountNumber;
      headerFallbackUsed = true;
    }
  }

  if (!accountNumber && accountNumberFromLine) {
    accountNumber = accountNumberFromLine;
  }

  if ((!bsb || !accountNumber) && /^\d{6}-\d{6,}$/.test(accountId)) {
    const [idBsb, idAccount] = accountId.split("-");
    bsb = bsb || normalizeBsb(idBsb);
    accountNumber = accountNumber || normalizeAccountNumber(idAccount);
  }

  if (!accountNumber) {
    metaWarnings.push("IDENTITY_MISSING");
  } else if (headerFallbackUsed && !accountName) {
    metaWarnings.push("IDENTITY_HEADER_ONLY");
  }

  return normalizeAccountMeta({
    bankId: "cba",
    accountId,
    templateId,
    accountName,
    bsb,
    accountNumber,
    metaWarnings,
  });
}
