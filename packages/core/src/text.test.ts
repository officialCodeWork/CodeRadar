import { describe, expect, it } from "vitest";

import { normalizeText, textMatches } from "./text.js";

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
});
