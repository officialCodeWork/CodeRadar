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

/**
 * Does `needle` (normalized) match `haystack` (normalized), where `haystack`
 * may contain `*` wildcards from template text ("* item in cart" matches
 * "3 items in cart")?
 */
export function textMatches(haystack: string, needle: string): boolean {
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
