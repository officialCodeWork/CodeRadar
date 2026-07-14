import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponents } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const a1 = resolveHookEdges(
  scanReact({
    root: path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../eval/fixtures/a1-no-static-text/app",
    ),
  }),
);

const structureOf = (name: string) =>
  a1.nodes.find((n) => n.kind === "component" && n.name === name)?.kind === "component"
    ? (a1.nodes.find((n) => n.kind === "component" && n.name === name) as { structure: unknown }).structure
    : undefined;

describe("structural signatures (a1 fixture, TRACKER 4.2)", () => {
  it("counts a table's columns and repeated items", () => {
    expect(structureOf("StatsDashboard")).toMatchObject({ table: 1, columns: 4, repeated: 2 });
  });

  it("counts form inputs and buttons, folding raw DOM tags", () => {
    expect(structureOf("LoginForm")).toMatchObject({ form: 1, input: 2, button: 1 });
  });

  it("these components carry no static text at all", () => {
    for (const name of ["StatsDashboard", "LoginForm", "ImageGallery", "SettingsList"]) {
      const c = a1.nodes.find((n) => n.kind === "component" && n.name === name);
      expect(c?.kind === "component" ? c.renderedText.length : -1).toBe(0);
    }
  });

  it("matches a text-free dashboard by structure descriptor alone", () => {
    const result = matchComponents(a1, { structure: { table: true, columns: 4, cards: 2 } });
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("StatsDashboard");
  });

  it("matches a form by its shape, not its (absent) text", () => {
    const result = matchComponents(a1, { structure: { form: true, inputs: 2, buttons: 1 } });
    expect(result.candidates[0]?.value.component.name).toBe("LoginForm");
  });
});
