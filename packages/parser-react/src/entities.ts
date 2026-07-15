/**
 * HTML-entity decoding for extracted rendered text (failure mode A16).
 *
 * JSX text and quoted attribute values are HTML-decoded by React at render
 * time — `<span>&nbsp;</span>` renders a non-breaking space, `<td>&gt;</td>` a
 * `>`, `&#34;` a double quote — but ts-morph hands us the raw source, so
 * without decoding the entity survives into `renderedText` and normalizes to a
 * junk token: `&nbsp;`→"nbsp", `&gt;`→"gt", `&#34;`→"34". Those spurious tokens
 * create false matches; a numeric entity like `&#34;` even lets a gibberish
 * query that happens to share its digits ("zzqwxnomatch12345") match. Decoding
 * restores the character React actually renders, which then normalizes away as
 * punctuation/whitespace (or becomes real letters for accented entities), so
 * entity-only text stops acting as a match target (self-found on Grafana's
 * frontend, 0.4.0 — 26 `&nbsp;`, 4 `&quot;`, plus `&#34;`/`&gt;`/`&lt;`/
 * `&middot;`/`&rsaquo;`).
 *
 * Only the entities React decodes are handled. Unknown names are left verbatim
 * (React renders `&foobar;` literally), which is also the safe choice — we
 * never guess.
 */

const SPACE = " ";

/**
 * Named HTML entities React decodes, mapped to their character. Markup,
 * whitespace, punctuation, symbols and currency all decode to characters the
 * normalizer strips (so entity-only text yields no target); accented Latin-1
 * letters decode to real letters, which is faithful rendered signal.
 */
const NAMED: Record<string, string> = {
  // Markup + whitespace. Spaces collapse to a plain ASCII space (what OCR reads
  // off a screenshot); the invisible soft hyphen decodes to nothing.
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: SPACE, ensp: SPACE, emsp: SPACE, thinsp: SPACE, shy: "",
  // Punctuation
  hellip: "…", mdash: "—", ndash: "–", minus: "−",
  lsquo: "‘", rsquo: "’", sbquo: "‚",
  ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›",
  middot: "·", bull: "•", dagger: "†", Dagger: "‡",
  sect: "§", para: "¶", prime: "′", Prime: "″",
  // Symbols + currency + fractions
  copy: "©", reg: "®", trade: "™", deg: "°",
  plusmn: "±", times: "×", divide: "÷",
  frac12: "½", frac14: "¼", frac34: "¾",
  euro: "€", pound: "£", cent: "¢", yen: "¥",
  // Common accented Latin-1 letters (decode to real match signal)
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã",
  auml: "ä", aring: "å", aelig: "æ", ccedil: "ç",
  egrave: "è", eacute: "é", ecirc: "ê", euml: "ë",
  igrave: "ì", iacute: "í", icirc: "î", iuml: "ï",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô",
  otilde: "õ", ouml: "ö", oslash: "ø", ugrave: "ù",
  uacute: "ú", ucirc: "û", uuml: "ü", yuml: "ÿ", szlig: "ß",
};

const ENTITY = /&(#[Xx][0-9A-Fa-f]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g;

/** A code point safe to materialize: in range and not a lone surrogate. */
function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * Decode the HTML entities React resolves at render time. Numeric entities
 * (decimal `&#34;`, hex `&#x22;`) decode generically; named entities decode
 * from {@link NAMED}. Unrecognized names and out-of-range code points are left
 * untouched, matching React's literal rendering.
 */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(ENTITY, (whole, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const isHex = body.charCodeAt(1) === 88 || body.charCodeAt(1) === 120; /* X | x */
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      return fromCodePoint(code) ?? whole;
    }
    return NAMED[body] ?? whole;
  });
}
