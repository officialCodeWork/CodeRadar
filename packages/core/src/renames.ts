/**
 * Cross-version rename/move detection (TRACKER step 6.4, failure modes G3/A11).
 *
 * An agent often resolves a ticket against a *stored* graph -- the one that was
 * scanned from the commit currently in production -- while the code has moved on
 * (main). If `InvoiceCard` was renamed to `BillingCard`, or moved to another
 * file, a match in the old graph points at a definition that no longer exists
 * under that identity. `diffRenames` pairs those gone definitions with their
 * new identity by a body signature that survives a rename or move, so the
 * bundle can warn: "matched `InvoiceCard`; renamed `BillingCard` on main".
 */
import { normalizeText } from "./text.js";
import type { ComponentNode, LineageGraph } from "./types.js";

/** One definition whose identity changed between two graph versions. */
export interface RenamedDefinition {
  from: { name: string; file: string };
  to: { name: string; file: string };
}

/** A definition's identity within a graph: its name and file. */
function identity(c: ComponentNode): string {
  return `${c.name} ${c.loc.file}`;
}

/**
 * A signature of a component's body that is stable across a rename or file
 * move: its structural fingerprint plus its normalized rendered text, props,
 * and the components it renders -- none of which change when only the name or
 * path does. Returns null for a component with no discriminating body (no text
 * and an all-zero structure): such components are too generic to pair
 * confidently and would produce false renames.
 */
function bodySignature(c: ComponentNode): string | null {
  const text = (c.renderedText ?? [])
    .map((e) => normalizeText(e.text))
    .filter((t) => t.length > 0)
    .sort();
  const structure = c.structure ?? {};
  const structureTotal = Object.values(structure).reduce((a, b) => a + b, 0);
  const renders = c.rendersComponents ?? [];
  if (text.length === 0 && structureTotal === 0 && renders.length === 0) return null;
  return JSON.stringify({
    structure,
    text,
    props: [...(c.props ?? [])].sort(),
    renders: [...renders].sort(),
  });
}

/** Components in a graph, keyed by identity. */
function componentsByIdentity(graph: LineageGraph): Map<string, ComponentNode> {
  const map = new Map<string, ComponentNode>();
  for (const node of graph.nodes) {
    if (node.kind === "component") map.set(identity(node), node);
  }
  return map;
}

/**
 * Definitions present in `fromGraph` but gone (by name+file) in `toGraph`,
 * paired with a same-body definition that is new in `toGraph`. Only confident
 * 1:1 matches are reported: a signature that is unique among the gone
 * definitions and unique among the new definitions. Ambiguous or generic
 * bodies are skipped rather than guessed.
 */
export function diffRenames(fromGraph: LineageGraph, toGraph: LineageGraph): RenamedDefinition[] {
  const fromById = componentsByIdentity(fromGraph);
  const toById = componentsByIdentity(toGraph);

  const groupBySignature = (
    byId: Map<string, ComponentNode>,
    excludeIn: Map<string, ComponentNode>,
  ): Map<string, ComponentNode[]> => {
    const bySig = new Map<string, ComponentNode[]>();
    for (const [id, c] of byId) {
      if (excludeIn.has(id)) continue; // unchanged identity -- not gone / not new
      const sig = bodySignature(c);
      if (sig === null) continue;
      const bucket = bySig.get(sig);
      if (bucket === undefined) bySig.set(sig, [c]);
      else bucket.push(c);
    }
    return bySig;
  };
  // Signature -> components, for definitions gone-from / new-to the other graph.
  const goneBySig = groupBySignature(fromById, toById);
  const newBySig = groupBySignature(toById, fromById);

  const renames: RenamedDefinition[] = [];
  for (const [sig, gone] of goneBySig) {
    const arrived = newBySig.get(sig);
    // Confident only when exactly one gone def and exactly one new def share the
    // signature -- otherwise the pairing is ambiguous.
    if (gone.length !== 1 || arrived === undefined || arrived.length !== 1) continue;
    const before = gone[0];
    const after = arrived[0];
    if (before === undefined || after === undefined) continue;
    // A pure no-op (same name and file) can't reach here (identity would match),
    // so this is always a genuine rename, move, or both.
    renames.push({
      from: { name: before.name, file: before.loc.file },
      to: { name: after.name, file: after.loc.file },
    });
  }
  // Stable output order (6.3): by the old identity.
  renames.sort((a, b) =>
    `${a.from.name} ${a.from.file}` < `${b.from.name} ${b.from.file}` ? -1 : 1,
  );
  return renames;
}

/** The rename whose `from` matches this name+file, if any (for bundle warnings). */
export function findRename(
  renames: RenamedDefinition[],
  name: string,
  file: string,
): RenamedDefinition | undefined {
  return renames.find((r) => r.from.name === name && r.from.file === file);
}
