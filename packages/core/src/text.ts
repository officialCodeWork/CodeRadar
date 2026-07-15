/**
 * Text normalization shared by extraction (parser) and matching (query layer,
 * Phase 4 matcher). Screenshot text never equals source text exactly — CSS
 * uppercasing, punctuation, pluralization, OCR whitespace — so both sides of
 * every comparison go through the same normalization (failure mode A7).
 */

/**
 * Lowercase, strip punctuation (unicode-aware — accents survive), collapse
 * whitespace, and fold naive plurals ("items" → "item", "categories" →
 * "category"). `*` survives because template entries use it as a wildcard.
 */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}*\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map(foldPlural)
    .join(" ");
}

/** Minimum alphanumeric characters a match target must carry (failure mode A14). */
const MIN_TARGET_SIGNAL = 2;

/**
 * True when a normalized string carries enough alphanumeric signal to act as a
 * match target. Punctuation-only rendered text ("|", "/", "·") normalizes to
 * "" — and an empty haystack is a substring of every query, so without this
 * guard such targets match anything and the matcher degenerates into a
 * universal wildcard (failure mode A14, field-found in v0.3.0). Pure-wildcard
 * templates ("*" from a fully-dynamic expression) collapse to a match-everything
 * regex the same way.
 */
export function hasMatchSignal(normalized: string): boolean {
  let signal = 0;
  for (const ch of normalized) {
    if (ch === " " || ch === "*") continue;
    signal += 1;
    if (signal >= MIN_TARGET_SIGNAL) return true;
  }
  return false;
}

/**
 * Does `needle` (normalized) match `haystack` (normalized), where `haystack`
 * may contain `*` wildcards from template text ("* item in cart" matches
 * "3 items in cart")? Targets below the minimum alphanumeric signal never
 * match (A14).
 */
export function textMatches(haystack: string, needle: string): boolean {
  if (!hasMatchSignal(haystack)) return false;
  if (haystack.includes("*")) {
    const pattern = haystack
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(pattern).test(needle);
  }
  return haystack.includes(needle) || needle.includes(haystack);
}

function foldPlural(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Normalized significant tokens of a string (drops empties). */
export function tokenize(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((t) => t.length > 0);
}

/**
 * Levenshtein distance between `a` and `b`, abandoned once it exceeds `max`
 * (returns `max + 1`). Bounding keeps the matcher's fuzzy comparisons cheap.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? max + 1;
}

/**
 * OCR-tolerant token equality: exact after normalization, or within a small
 * edit distance that scales with length — short tokens ("save") must match
 * exactly so they don't collide ("safe"), longer distinctive words tolerate the
 * 1–2 character slips OCR introduces ("reconcilliation" ≈ "reconciliation").
 */
export function fuzzyTokenMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const len = Math.max(a.length, b.length);
  if (len < 5) return false;
  const budget = len <= 7 ? 1 : 2;
  return editDistance(a, b, budget) <= budget;
}
