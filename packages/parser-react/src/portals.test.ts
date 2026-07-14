import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponentsByText } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixture = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures/a9-modal-portal/app",
);

const graph = scanReact({ root: fixture });

describe("portals & toasts (a9 fixture)", () => {
  it("flags createPortal components", () => {
    const dialog = graph.nodes.find((n) => n.kind === "component" && n.name === "ConfirmDialog");
    expect(dialog?.flags).toContain("portal");
  });

  it("matching modal text surfaces the component AND its trigger site", () => {
    const result = matchComponentsByText(graph, ["Delete this order?"]);
    expect(result.status).toBe("ok");
    const match = result.candidates[0]?.value;
    expect(match?.component.name).toBe("ConfirmDialog");
    expect(match?.instances.map((i) => i.loc.file)).toEqual(["OrdersToolbar.tsx"]);
  });

  it("attributes toast text to the calling component with portal provenance", () => {
    const toolbar = graph.nodes.find(
      (n) => n.kind === "component" && n.name === "OrdersToolbar",
    );
    if (toolbar?.kind !== "component") throw new Error("OrdersToolbar not found");
    const entry = toolbar.renderedText.find((e) => e.text === "Order deleted");
    expect(entry?.source).toBe("portal");
    const result = matchComponentsByText(graph, ["Order deleted"]);
    expect(result.candidates[0]?.value.component.name).toBe("OrdersToolbar");
  });
});
