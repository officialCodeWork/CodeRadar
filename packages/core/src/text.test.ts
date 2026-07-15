import { describe, expect, it } from "vitest";

import { hasMatchSignal, isLowSignal, normalizeText, textMatches } from "./text.js";

describe("normalizeText", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeText("  SHOPPING   CART! ")).toBe("shopping cart");
    expect(normalizeText("Total: $41.97")).toBe("total 41 97");
  });

  it("keeps accents and * wildcards", () => {
    expect(normalizeText("Membres de l'équipe")).toBe("membre de l équipe");
    expect(normalizeText("* items in cart")).toBe("* item in cart");
  });

  it("folds naive plurals", () => {
    expect(normalizeText("categories")).toBe("category");
    expect(normalizeText("items")).toBe("item");
    expect(normalizeText("class")).toBe("class");
    expect(normalizeText("gas")).toBe("gas");
  });
});

describe("textMatches", () => {
  it("matches containment in either direction", () => {
    expect(textMatches("recent order", "recent")).toBe(true);
    expect(textMatches("save", "save change")).toBe(true);
    expect(textMatches("billing", "invoice")).toBe(false);
  });

  it("treats * as a wildcard", () => {
    expect(textMatches("* item in cart", "3 item in cart")).toBe(true);
    expect(textMatches("total *", "total 41 97")).toBe(true);
    expect(textMatches("* item in cart", "empty cart")).toBe(false);
  });

  it("never matches targets that normalize to empty or near-empty (A14)", () => {
    // "|" / "/" / "-" normalize to "" — an empty haystack is a substring of
    // every query, which turned the matcher into a universal wildcard.
    expect(normalizeText("|")).toBe("");
    expect(textMatches(normalizeText("|"), "zzqwxnomatch12345")).toBe(false);
    expect(textMatches("", "calendar")).toBe(false);
    expect(textMatches("*", "anything")).toBe(false); // pure wildcard → /.*/
    expect(textMatches("x", "x ray")).toBe(false); // single char: below signal
  });
});

describe("hasMatchSignal", () => {
  it("rejects empty, punctuation-only, and pure-wildcard targets", () => {
    expect(hasMatchSignal("")).toBe(false);
    expect(hasMatchSignal(normalizeText("| / -"))).toBe(false);
    expect(hasMatchSignal("*")).toBe(false);
    expect(hasMatchSignal("* *")).toBe(false);
    expect(hasMatchSignal("x")).toBe(false);
  });

  it("accepts real text, including wildcard templates", () => {
    expect(hasMatchSignal("save")).toBe(true);
    expect(hasMatchSignal("* item in cart")).toBe(true);
    expect(hasMatchSignal("ok")).toBe(true);
  });
});

describe("isLowSignal (A15 — stopword/punctuation targets)", () => {
  it("flags empty, punctuation-only, and stopword-only strings", () => {
    expect(isLowSignal("")).toBe(true);
    expect(isLowSignal(normalizeText("|"))).toBe(true);
    expect(isLowSignal(normalizeText("BY"))).toBe(true); // rare literal → no signal
    expect(isLowSignal(normalizeText("The"))).toBe(true);
    expect(isLowSignal(normalizeText("of the"))).toBe(true);
    expect(isLowSignal(normalizeText("This"))).toBe(true); // folds to "thi"
  });

  it("keeps strings with at least one discriminating token", () => {
    expect(isLowSignal(normalizeText("silences"))).toBe(false);
    expect(isLowSignal(normalizeText("Find silences by matcher"))).toBe(false);
    expect(isLowSignal(normalizeText("the invoice"))).toBe(false);
  });
});
