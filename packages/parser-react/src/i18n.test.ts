import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponentsByText } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/a2-i18n-keys/app",
);

const graph = scanReact({
  root: fixture,
  i18n: { localeGlobs: ["locales/*.json"], defaultLocale: "en" },
});

const teamHeader = graph.nodes.find((n) => n.kind === "component" && n.name === "TeamHeader");
const billingHeader = graph.nodes.find(
  (n) => n.kind === "component" && n.name === "BillingHeader",
);

describe("i18n adapter (a2 fixture)", () => {
  it("expands t() keys into one entry per locale with provenance", () => {
    if (teamHeader?.kind !== "component") throw new Error("TeamHeader not found");
    const titles = teamHeader.renderedText.filter((e) => e.key === "team.title");
    expect(titles).toHaveLength(2);
    expect(titles.map((e) => `${e.locale}:${e.text}`).sort()).toEqual([
      "en:Team Members",
      "fr:Membres de l'équipe",
    ]);
    expect(titles.every((e) => e.source === "i18n")).toBe(true);
  });

  it("resolves <Trans i18nKey> attributes", () => {
    if (billingHeader?.kind !== "component") throw new Error("BillingHeader not found");
    const texts = billingHeader.renderedText.map((e) => e.text);
    expect(texts).toContain("Billing overview");
    expect(texts).toContain("Aperçu de la facturation");
  });

  it("matches screenshot text in any locale to the same component", () => {
    for (const term of ["Team Members", "Membres de l'équipe"]) {
      const result = matchComponentsByText(graph, [term]);
      expect(result.status).toBe("ok");
      expect(result.candidates[0]?.value.component.name).toBe("TeamHeader");
    }
  });

  it("records the i18n key in the match evidence", () => {
    const result = matchComponentsByText(graph, ["Membres de l'équipe"]);
    expect(result.candidates[0]?.evidence[0]?.detail).toContain("team.title");
    expect(result.candidates[0]?.evidence[0]?.detail).toContain("locale fr");
  });

  it("skips i18n expansion entirely when unconfigured", () => {
    const bare = scanReact({ root: fixture });
    const header = bare.nodes.find((n) => n.kind === "component" && n.name === "TeamHeader");
    if (header?.kind !== "component") throw new Error("TeamHeader not found");
    expect(header.renderedText.some((e) => e.source === "i18n")).toBe(false);
  });
});
