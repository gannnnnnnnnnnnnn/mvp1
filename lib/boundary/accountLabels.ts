type AccountLabelInput = {
  bankId?: string;
  accountId?: string;
  accountName?: string;
  accountKey?: string;
  accountNumber?: string;
  bsb?: string;
  alias?: string;
  sampleFileName?: string;
};

function last4(value?: string) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 4) return undefined;
  return digits.slice(-4);
}

export function sanitizeAccountName(name?: string) {
  const raw = String(name || "")
    .replace(/^[+\-]?\s*\$\s*[\d,]+(?:\.\d{2})?\s*/g, "")
    .replace(/^[^A-Za-z0-9]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!raw) return undefined;
  if (/^(ACCOUNT|STATEMENT|PAGE|DATE|BSB)\b/i.test(raw)) return undefined;
  if (/^[\d\s.$+\-]+$/.test(raw)) return undefined;
  return raw;
}

export function isUnknownAccountIdentity(input: AccountLabelInput) {
  const accountId = String(input.accountId || "").trim();
  if (!accountId || accountId === "default") return true;
  return (
    !sanitizeAccountName(input.accountName) &&
    !input.accountKey &&
    !input.bsb &&
    !input.accountNumber
  );
}

export function formatAccountLabel(input: AccountLabelInput) {
  const alias = String(input.alias || "").trim();
  if (alias) return alias;

  const sanitizedName = sanitizeAccountName(input.accountName);
  if (sanitizedName) return sanitizedName;

  if (input.accountKey) return input.accountKey;
  if (input.bsb) {
    const tail = last4(input.accountNumber) || last4(input.accountId);
    return tail ? `${input.bsb}-••••${tail}` : input.bsb;
  }

  const fallbackLast4 = last4(input.accountNumber) || last4(input.accountId);
  if (fallbackLast4) return `Acct ••••${fallbackLast4}`;
  return "Unknown account";
}

export function formatAccountSupportText(input: AccountLabelInput) {
  const parts: string[] = [];
  if (input.accountKey) {
    parts.push(input.accountKey);
  } else if (input.bsb) {
    const tail = last4(input.accountNumber) || last4(input.accountId);
    parts.push(tail ? `${input.bsb}-••••${tail}` : input.bsb);
  } else if (input.accountId && input.accountId !== "default") {
    parts.push(input.accountId);
  }
  if (isUnknownAccountIdentity(input) && input.sampleFileName) {
    parts.push(`source: ${input.sampleFileName}`);
  }
  return parts.join(" · ");
}
