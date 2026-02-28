export type WarningCatalogEntry = {
  title: string;
  explain: string;
  suggestion: string;
};

const WARNING_CATALOG: Record<string, WarningCatalogEntry> = {
  CBA_IDENTITY_HEADER_ONLY: {
    title: "Header-only account identity",
    explain: "We found the account number from the first-page header, but could not confirm the account name.",
    suggestion: "Check Boundary setup and add an alias if the account label is unclear.",
  },
  ACCOUNT_IDENTITY_MISSING: {
    title: "Account identity missing",
    explain: "The parser could not extract a stable account identity from this statement.",
    suggestion: "Review the file in Boundary setup or remove it if it is not a supported statement.",
  },
  AMOUNT_SIGN_UNCERTAIN: {
    title: "Amount sign uncertain",
    explain: "The parser could not deterministically confirm whether a row is credit or debit.",
    suggestion: "Review transactions and compare balance continuity before trusting totals.",
  },
  AUTO_AMOUNT_NOT_FOUND: {
    title: "Amount not found",
    explain: "A transaction row did not expose a reliable amount token.",
    suggestion: "Inspect the source PDF formatting or re-upload a cleaner text-based statement.",
  },
  AUTO_BALANCE_NOT_FOUND: {
    title: "Balance not found",
    explain: "A transaction row did not expose a reliable running balance.",
    suggestion: "Use the warning details to inspect the affected file and parser quality.",
  },
  BALANCE_CONTINUITY_LOW: {
    title: "Low balance continuity",
    explain: "Parsed balances do not line up cleanly across rows, which usually means parsing drift.",
    suggestion: "Open the file in dev tooling or remove the PDF if it is malformed.",
  },
  IDENTITY_HEADER_ONLY: {
    title: "Header-only account identity",
    explain: "We found a usable account number from the statement header, but not a reliable account name.",
    suggestion: "Usually safe. Add an alias in Boundary setup if you want a cleaner label.",
  },
  IDENTITY_MISSING: {
    title: "Account identity missing",
    explain: "We could not extract a stable account number for this statement.",
    suggestion: "Check the statement format, or remove the PDF if the account details cannot be trusted.",
  },
  AMOUNT_OUTLIER: {
    title: "Amount outlier",
    explain: "A parsed amount looked unusual compared with nearby rows.",
    suggestion: "Usually safe to ignore unless totals look wrong. Check the transaction if needed.",
  },
  OUTLIER_GLUE_NUMBER: {
    title: "Possible glued number",
    explain: "The PDF text likely merged two numbers together, which can confuse amount parsing.",
    suggestion: "Check this transaction if the amount looks suspicious.",
  },
  ANNOTATION_LINE_SKIPPED: {
    title: "Annotation line skipped",
    explain: "A note-only line was ignored because it did not look like a real transaction row.",
    suggestion: "Usually safe to ignore.",
  },
};

export function getWarningCatalogEntry(code: string): WarningCatalogEntry {
  const key = String(code || "").trim();
  return (
    WARNING_CATALOG[key] || {
      title: key || "Unknown warning",
      explain: "This warning code does not have a specific catalog entry yet.",
      suggestion: "Use the raw warning code and file context to decide whether to keep or delete the PDF.",
    }
  );
}
