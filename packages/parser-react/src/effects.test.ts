import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LineageGraph, LineageNode } from "@coderadar/core";
import { describe, expect, it } from "vitest";

import { resolveHookEdges, scanReact } from "./scan.js";

const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../eval/fixtures");

const b3 = resolveHookEdges(scanReact({ root: path.join(fixtures, "b3-programmatic-nav/app") }));

/** The effect target reachable from a `handler`-named event by an edge of `kind`. */
function effectTargets(graph: LineageGraph, handler: string, kind: string): LineageNode[] {
  const event = graph.nodes.find((n) => n.kind === "event" && n.handler === handler);
  const inline = graph.nodes.filter((n) => n.kind === "event" && n.handler === null);
  const events = event !== undefined ? [event] : inline;
  const ids = new Set(events.map((e) => e.id));
  return graph.edges
    .filter((e) => e.kind === kind && ids.has(e.from))
    .map((e) => graph.nodes.find((n) => n.id === e.to))
    .filter((n): n is LineageNode => n !== undefined);
}

describe("action effects (b3 fixture, TRACKER 3.2)", () => {
  it("navigate() in a handler → navigates-to the matching route (exact path)", () => {
    const targets = effectTargets(b3, "goBack", "navigates-to");
    expect(targets.map((t) => (t.kind === "route" ? t.path : t.id))).toEqual(["/cart"]);
  });

  it("navigate(`/users/${id}`) joins the route by param-agnostic shape", () => {
    // Handler is an inline arrow (handler === null); match the /users/:userId route.
    const routes = b3.edges
      .filter((e) => e.kind === "navigates-to")
      .map((e) => b3.nodes.find((n) => n.id === e.to))
      .filter((n) => n?.kind === "route");
    expect(routes.some((r) => r?.kind === "route" && r.path === "/users/:userId")).toBe(true);
  });

  it("a navigate to a path with no declared route is flagged, never silently dropped", () => {
    const broken = b3.nodes.find((n) => n.kind === "event" && n.handler === "goBroken");
    expect(broken?.flags).toContain("unresolved-nav");
    expect(b3.edges.some((e) => e.kind === "navigates-to" && e.from === broken?.id)).toBe(false);
  });

  it("fetch() in a handler → triggers a data source", () => {
    const targets = effectTargets(b3, "exportUsers", "triggers");
    const endpoints = targets.map((t) => (t.kind === "data-source" ? t.endpoint : t.id));
    expect(endpoints).toContain("/api/users/export");
  });

  it("dispatch(thunk()) → writes-state on the slice the thunk populates", () => {
    const targets = effectTargets(b3, "refreshUsers", "writes-state");
    const names = targets.map((t) => t.name);
    expect(names).toContain("users");
  });

  it("dispatch(action()) of a plain reducer → writes-state on that slice", () => {
    // Inline arrow onClick={() => dispatch(clearCart())}.
    const writes = b3.edges
      .filter((e) => e.kind === "writes-state")
      .map((e) => b3.nodes.find((n) => n.id === e.to))
      .filter((n) => n?.kind === "state");
    const fromEvent = b3.edges.some((e) => {
      if (e.kind !== "writes-state") return false;
      const from = b3.nodes.find((n) => n.id === e.from);
      const to = b3.nodes.find((n) => n.id === e.to);
      return from?.kind === "event" && to?.kind === "state" && to.name === "cart";
    });
    expect(writes.some((n) => n?.name === "cart")).toBe(true);
    expect(fromEvent).toBe(true);
  });

  it("a local setState setter → writes-state on the local slot", () => {
    const targets = effectTargets(b3, "showDetails", "writes-state");
    const names = targets.map((t) => t.name);
    expect(names).toContain("open");
    const slot = targets.find((t) => t.name === "open");
    expect(slot?.kind === "state" ? slot.stateKind : undefined).toBe("useState");
  });
});

describe("form & non-JSX events (TRACKER 3.4, B7/B8)", () => {
  const b8 = resolveHookEdges(scanReact({ root: path.join(fixtures, "b8-react-hook-form/app") }));
  const b7 = resolveHookEdges(scanReact({ root: path.join(fixtures, "b7-effect-listeners/app") }));

  const eventNamed = (graph: LineageGraph, event: string): LineageNode | undefined =>
    graph.nodes.find((n) => n.kind === "event" && n.event === event);

  it("react-hook-form: handleSubmit(onValid) unwraps to the real submit handler", () => {
    const submit = eventNamed(b8, "onSubmit");
    expect(submit?.kind === "event" ? submit.source : undefined).toBe("form");
    expect(submit?.kind === "event" ? submit.handler : undefined).toBe("onValid");
    const triggers = b8.edges.filter((e) => e.kind === "triggers" && e.from === submit?.id);
    const ds = b8.nodes.find((n) => n.id === triggers[0]?.to);
    expect(ds?.kind === "data-source" ? ds.endpoint : undefined).toBe("/api/signup");
  });

  it("addEventListener in an effect becomes an event sourced 'effect'", () => {
    const key = eventNamed(b7, "keydown");
    expect(key?.kind === "event" ? key.source : undefined).toBe("effect");
    const triggers = b7.edges.some(
      (e) => e.kind === "triggers" && e.from === key?.id && b7.nodes.find((n) => n.id === e.to)?.kind === "data-source",
    );
    expect(triggers).toBe(true);
  });

  it("a hotkey registration becomes an event keyed by its shortcut", () => {
    const hotkey = eventNamed(b7, "ctrl+s");
    expect(hotkey?.kind === "event" ? hotkey.source : undefined).toBe("hotkey");
    const target = b7.edges
      .filter((e) => e.kind === "triggers" && e.from === hotkey?.id)
      .map((e) => b7.nodes.find((n) => n.id === e.to))
      .find((n) => n?.kind === "data-source");
    expect(target?.kind === "data-source" ? target.endpoint : undefined).toBe("/api/save");
  });
});

describe("prop-drilled handlers still ground effects (b1 fixture, no regression)", () => {
  const b1 = resolveHookEdges(scanReact({ root: path.join(fixtures, "b1-prop-drilled-handler/app") }));

  it("a 4-level drilled handler still emits its triggers edge", () => {
    const event = b1.nodes.find((n) => n.kind === "event" && n.handler === "onSave");
    const triggers = b1.edges.filter((e) => e.kind === "triggers" && e.from === event?.id);
    const target = b1.nodes.find((n) => n.id === triggers[0]?.to);
    expect(target?.kind === "data-source" ? target.endpoint : undefined).toBe("/api/drafts");
  });
});
