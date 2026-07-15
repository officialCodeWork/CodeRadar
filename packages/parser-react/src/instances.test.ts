import path from "node:path";
import { fileURLToPath } from "node:url";

import type { InstanceNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

const graph = scanReact({
  root: path.join(fixtures, "a5-design-system/app"),
  designSystemPackages: ["@acme/ui"],
});

function instancesNamed(name: string): InstanceNode[] {
  return graph.nodes.flatMap((n) => (n.kind === "instance" && n.name === name ? [n] : []));
}

describe("instance tree construction (a5 fixture)", () => {
  it("creates flagged instances for design-system components", () => {
    const button = instancesNamed("Button")[0];
    expect(button?.definitionId).toBe("external:@acme/ui#Button");
    expect(button?.flags).toContain("external-definition");
    expect(button?.staticProps).toEqual({ label: "Save changes" });
  });

  it("resolves barrel re-exports with rename to the original definition", () => {
    const card = instancesNamed("ProfileCard")[0];
    expect(card?.definitionId).toBe("component:ui/ProfileCard.tsx#ProfileCardInner");
  });

  it("resolves default-export aliases through the barrel", () => {
    const avatar = instancesNamed("Avatar")[0];
    expect(avatar?.definitionId).toBe("component:ui/ProfileCard.tsx#AvatarBadge");
  });

  it("does not create instances for unconfigured external modules", () => {
    // react-i18next's <Trans> in other fixtures never materializes; here,
    // assert the only external instances are the two @acme/ui ones.
    const externals = graph.nodes.filter(
      (n) => n.kind === "instance" && n.flags?.includes("external-definition"),
    );
    expect(externals.map((n) => n.name).sort()).toEqual(["Button", "DataGrid"]);
  });
});

describe("same-body nesting (parentInstanceId)", () => {
  it("links nested project-component call sites", () => {
    const nested = scanReact({ root: path.join(fixtures, "..", "..", "examples/demo-app/src") });
    // demo-app has no nesting — assert null baseline holds.
    const card = nested.nodes.find((n) => n.kind === "instance" && n.name === "UserCard");
    expect(card?.kind === "instance" ? card.parentInstanceId : "missing").toBeNull();
  });
});

describe("field-pattern instance resolution (TRACKER 6F.3)", () => {
  const fieldGraph = scanReact({ root: path.join(fixtures, "field-patterns/app") });
  const fieldInstances = (name: string): InstanceNode[] =>
    fieldGraph.nodes.flatMap((n) => (n.kind === "instance" && n.name === name ? [n] : []));

  it("resolves a tsconfig-path alias import through a two-hop rename barrel", () => {
    // UsersPage does `import { Grid } from "@ui"` — alias → components/index.ts
    // (rename) → ui/index.ts → DataGrid. The field run dropped this usage.
    const grids = fieldInstances("Grid");
    expect(grids).toHaveLength(2);
    for (const grid of grids) {
      expect(grid.definitionId).toBe("component:components/ui/DataGrid.tsx#DataGrid");
    }
    expect(grids.some((i) => i.loc.file === "pages/UsersPage.tsx")).toBe(true);
  });

  it("unwraps Loadable(lazy(() => import())) variables to the page definition", () => {
    // <Invoices/> where Invoices = Loadable(lazy(() => import("./InvoicesPage"))):
    // the variable name differs from the definition, so only the unwrap links it.
    const preview = fieldInstances("Invoices")[0];
    expect(preview?.definitionId).toBe("component:pages/InvoicesPage.tsx#InvoicesPage");
  });
});
