export type NameFingerprint = {
  normalized: string;
  tokens: string[];
  tokenSet: Set<string>;
  last?: string;
  firstInitial?: string;
  initials: string;
};

export function normalizeName(value?: string) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function initialsFromTokens(tokens: string[]) {
  return tokens.map((token) => token[0]).join("");
}

function sharedSetSize<T>(a: Set<T>, b: Set<T>) {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count += 1;
  }
  return count;
}

export function buildNameFingerprint(value?: string): NameFingerprint {
  const normalized = normalizeName(value);
  const tokens = normalized.split(" ").filter(Boolean);
  const tokenSet = new Set(tokens);
  const last = tokens.length >= 2 ? tokens[tokens.length - 1] : undefined;
  const firstInitial = tokens.length > 0 ? tokens[0][0] : undefined;
  const initials = initialsFromTokens(tokens);
  return { normalized, tokens, tokenSet, last, firstInitial, initials };
}

export function nameMatchStrong(aName?: string, bName?: string) {
  const a = buildNameFingerprint(aName);
  const b = buildNameFingerprint(bName);
  if (!a.normalized || !b.normalized) return false;
  if (a.normalized === b.normalized) return true;
  if (!a.last || !b.last) return false;
  if (a.last !== b.last) return false;

  const aFirstToken = a.tokens[0] || "";
  const bFirstToken = b.tokens[0] || "";
  const condSingleLetterFirst =
    (aFirstToken.length === 1 && Boolean(b.firstInitial) && aFirstToken === b.firstInitial) ||
    (bFirstToken.length === 1 && Boolean(a.firstInitial) && bFirstToken === a.firstInitial);

  const condTokenIntersection = sharedSetSize(a.tokenSet, b.tokenSet) >= 2;

  const aInitialSet = new Set(a.initials.split("").filter(Boolean));
  const bInitialSet = new Set(b.initials.split("").filter(Boolean));
  const sharedInitials = sharedSetSize(aInitialSet, bInitialSet);
  const lastInitial = a.last[0];
  const condInitials =
    sharedInitials >= 2 && aInitialSet.has(lastInitial) && bInitialSet.has(lastInitial);

  return condSingleLetterFirst || condTokenIntersection || condInitials;
}

