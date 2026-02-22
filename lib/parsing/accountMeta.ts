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

export function extractCbaAccountMeta(params: {
  text: string;
  accountId: string;
  templateId: string;
}): StatementAccountMeta {
  const { text, accountId, templateId } = params;
  const lines = (text || "").replace(/\r\n/g, "\n").split("\n");

  let accountName: string | undefined;
  let bsb: string | undefined;
  let accountNumber: string | undefined;

  const accountNameMatch = /Account name\s*\n\s*([^\n]+)/i.exec(text);
  if (accountNameMatch) {
    accountName = accountNameMatch[1]?.trim();
  } else {
    const byLine = lines.findIndex((line) => /Account name\b/i.test(line));
    if (byLine >= 0) {
      accountName = (lines[byLine + 1] || "").trim() || undefined;
    }
  }

  const bsbMatch = /\bBSB\b[\s:]*\n?\s*([0-9][0-9 \-]{4,10})/i.exec(text);
  if (bsbMatch) {
    bsb = normalizeBsb(bsbMatch[1]);
  } else {
    const byLine = lines.findIndex((line) => /^\s*BSB\b/i.test(line));
    if (byLine >= 0) {
      bsb = normalizeBsb(lines[byLine + 1] || "");
    }
  }

  const accountMatch = /Account number\s*\n?\s*([0-9][0-9 \-]{5,16})/i.exec(text);
  if (accountMatch) {
    accountNumber = normalizeAccountNumber(accountMatch[1]);
  } else {
    const byLine = lines.findIndex((line) => /^\s*Account number\b/i.test(line));
    if (byLine >= 0) {
      accountNumber = normalizeAccountNumber(lines[byLine + 1] || "");
    }
  }

  if (!bsb || !accountNumber) {
    const fused = /Account Number\s*([0-9]{14,})/i.exec(text);
    const digits = fused?.[1] ? digitsOnly(fused[1]) : "";
    if (digits.length >= 12) {
      bsb = bsb || digits.slice(0, 6);
      accountNumber = accountNumber || digits.slice(6);
    }
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
