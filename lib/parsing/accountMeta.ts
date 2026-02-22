export type StatementAccountMeta = {
  bankId: string;
  accountId: string;
  templateId: string;
  accountName?: string;
  bsb?: string;
  accountNumber?: string;
  accountKey?: string;
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
  const accountName = (meta.accountName || "").trim() || undefined;
  const bsb = normalizeBsb(meta.bsb);
  const accountNumber = normalizeAccountNumber(meta.accountNumber);
  const accountKey = buildAccountKey(bsb, accountNumber);

  return {
    bankId: meta.bankId,
    accountId: meta.accountId,
    templateId: meta.templateId,
    accountName,
    bsb,
    accountNumber,
    accountKey,
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

  for (const windowText of windows) {
    const lines = splitLines(windowText);

    if (!accountName) {
      const value = extractLabeledValue(lines, /Account name\s*[:\s]*([A-Za-z0-9 '&.-]{2,})/i);
      if (value) {
        accountName = value
          .replace(/\s{2,}/g, " ")
          .replace(/\bBSB\b.*$/i, "")
          .trim();
      }
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

  if (!accountNumber && accountNumberFromLine) {
    accountNumber = accountNumberFromLine;
  }

  if ((!bsb || !accountNumber) && /^\d{6}-\d{6,}$/.test(accountId)) {
    const [idBsb, idAccount] = accountId.split("-");
    bsb = bsb || normalizeBsb(idBsb);
    accountNumber = accountNumber || normalizeAccountNumber(idAccount);
  }

  return normalizeAccountMeta({
    bankId: "cba",
    accountId,
    templateId,
    accountName,
    bsb,
    accountNumber,
  });
}
