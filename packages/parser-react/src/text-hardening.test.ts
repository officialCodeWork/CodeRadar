import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchComponentsByText } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { scanReact } from "./scan.js";

const fixtures = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../eval/fixtures",
);

function componentText(fixture: string, name: string) {
  const graph = scanReact({ root: path.join(fixtures, fixture, "app") });
  const node = graph.nodes.find((n) => n.kind === "component" && n.name === name);
  if (node?.kind !== "component") throw new Error(`${name} not found`);
  return { graph, renderedText: node.renderedText };
}

describe("template text (a7 fixture)", () => {
  const { graph, renderedText } = componentText("a7-transformed-text", "CartSummary");

  it("extracts template literals with * wildcards and a template flag", () => {
    const items = renderedText.find((e) => e.text === "* items in cart");
    expect(items?.template).toBe(true);
    expect(renderedText.some((e) => e.text === "Total: *")).toBe(true);
  });

  it("matches concrete screenshot text against the wildcard", () => {
    const result = matchComponentsByText(graph, ["3 items in cart"]);
    expect(result.status).toBe("ok");
    expect(result.candidates[0]?.value.component.name).toBe("CartSummary");
  });

  it("matches case-transformed and singular/plural variants", () => {
    for (const term of ["SHOPPING CART", "1 item in cart"]) {
      expect(matchComponentsByText(graph, [term]).status).toBe("ok");
    }
  });
});

describe("branch tagging (a8 fixture)", () => {
  const { graph, renderedText } = componentText("a8-conditional-text", "OrdersPanel");

  it("tags early-return branches with their condition", () => {
    expect(renderedText.find((e) => e.text === "Could not load orders")?.branch).toBe("error");
    expect(renderedText.find((e) => e.text === "No orders yet")?.branch).toBe(
      "orders.length === 0",
    );
  });

  it("tags && gates and ternary branches (negated on the else side)", () => {
    expect(renderedText.find((e) => e.text === "Export orders")?.branch).toBe("isAdmin");
    expect(renderedText.find((e) => e.text === "Large order book")?.branch).toBe(
      "orders.length > 10",
    );
    expect(renderedText.find((e) => e.text === "Small order book")?.branch).toBe(
      "!(orders.length > 10)",
    );
  });

  it("leaves unconditional text untagged and surfaces the branch in evidence", () => {
    expect(renderedText.find((e) => e.text === "Recent orders")?.branch).toBeUndefined();
    const result = matchComponentsByText(graph, ["Export orders"]);
    expect(result.candidates[0]?.evidence[0]?.detail).toContain("renders only when isAdmin");
  });
});
