/**
 * Galaxy visualizer (TRACKER 6F.8): turn a LineageGraph into a single,
 * self-contained HTML file — graph JSON plus all CSS/JS inlined, no network
 * dependencies — that renders every node and edge as a canvas force-directed
 * "galaxy". Components are the stars; their instances, hooks, state, and data
 * sources cluster around them; routes act as gravitational centers. Built for
 * field scale (~2.6k nodes / ~4.8k edges), where SVG would choke.
 *
 * The generator is pure (graph in, HTML string out) so it is trivially
 * testable; all interactivity lives in the inlined client script.
 */

import type { LineageGraph, LineageNode } from "@coderadar/core";

/** A trimmed node the client needs — the full graph would bloat the file. */
interface VizNode {
  id: string;
  kind: string;
  label: string;
  file: string;
  line: number;
  detail: string;
  flags: string[];
}

interface VizEdge {
  from: string;
  to: string;
  kind: string;
  condition?: string;
}

/** One short, human-readable line describing a node in the detail panel. */
function nodeDetail(node: LineageNode): string {
  switch (node.kind) {
    case "data-source":
      return `${node.method ?? "GET"} ${node.endpoint} (${node.sourceKind})`;
    case "state":
      return `${node.stateKind} state`;
    case "event":
      return node.handler !== undefined ? `${node.event} → ${node.handler}` : node.event;
    case "route":
      return `route ${node.path}${node.layout ? ` in ${node.layout}` : ""}`;
    case "external":
      return `external ${node.host}`;
    case "instance":
      return `instance of ${node.definitionId.split("#").pop() ?? "?"}`;
    case "component":
      return node.props.length > 0 ? `props: ${node.props.join(", ")}` : "component";
    case "hook":
      return "hook";
    case "test":
      return `${node.framework ?? "test"} file`;
    default:
      return (node as LineageNode).kind;
  }
}

function labelOf(node: LineageNode): string {
  if (node.kind === "route") return node.path;
  if (node.kind === "data-source") return node.endpoint;
  if (node.kind === "external") return node.host;
  if ("name" in node && typeof node.name === "string") return node.name;
  return node.id;
}

/** Build the compact view model the client renders. */
export function toViewModel(graph: LineageGraph): { nodes: VizNode[]; edges: VizEdge[] } {
  const nodes: VizNode[] = graph.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    label: labelOf(node),
    file: node.loc.file,
    line: node.loc.line,
    detail: nodeDetail(node),
    flags: "flags" in node && Array.isArray(node.flags) ? node.flags : [],
  }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: VizEdge[] = graph.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      ...(e.condition !== undefined ? { condition: `${e.condition.kind}:${e.condition.expression}` } : {}),
    }));
  return { nodes, edges };
}

/**
 * Embed a JSON value in an inline <script> safely: `<` is escaped so a string
 * containing "</script>" can never break out of the tag.
 */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Render the full self-contained HTML document for a graph. */
export function renderVisualization(graph: LineageGraph, title = "CodeRadar galaxy"): string {
  const model = toViewModel(graph);
  const counts = model.nodes.reduce<Record<string, number>>((acc, n) => {
    acc[n.kind] = (acc[n.kind] ?? 0) + 1;
    return acc;
  }, {});
  const summary =
    `${model.nodes.length} nodes · ${model.edges.length} edges` +
    (graph.generatedAt !== undefined ? ` · scanned ${graph.generatedAt}` : "");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div id="app">
  <aside id="sidebar">
    <h1>${escapeHtml(title)}</h1>
    <p class="summary">${escapeHtml(summary)}</p>
    <input id="search" type="search" placeholder="Search nodes… (Enter to fly)" autocomplete="off" />
    <section class="controls">
      <div class="control-head">Node kinds<button id="toggle-nodes" class="mini">all</button></div>
      <div id="kind-filters"></div>
      <div class="control-head">Edge kinds<button id="toggle-edges" class="mini">all</button></div>
      <div id="edge-filters"></div>
    </section>
    <section class="controls">
      <label class="row"><input type="checkbox" id="physics" checked /> Physics running</label>
      <label class="row"><input type="checkbox" id="labels" /> Always show labels</label>
      <button id="reset-view" class="wide">Reset view</button>
    </section>
    <section id="detail" class="detail empty">Click a node to inspect it.</section>
    <p class="hint">Scroll to zoom · drag to pan · drag a node to pin</p>
  </aside>
  <canvas id="galaxy"></canvas>
  <div id="legend"></div>
</div>
<script id="graph-data" type="application/json">${embedJson(model)}</script>
<script>${clientScript(counts)}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
}

/** Palette + physics constants shared between server (legend counts) and client. */
const KIND_COLORS: Record<string, string> = {
  component: "#4f9dff",
  instance: "#7ee0c8",
  hook: "#c58bff",
  "data-source": "#ff8f6b",
  state: "#ffd24d",
  event: "#ff6ba3",
  route: "#9be15d",
  external: "#9aa5b1",
  test: "#6bd0ff",
};

const STYLE = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0b0e14; color: #d7dce5; }
#app { display: flex; height: 100vh; }
#sidebar { width: 300px; flex: none; padding: 16px; overflow-y: auto; background: #11151f; border-right: 1px solid #1e2530; }
#sidebar h1 { font-size: 15px; margin: 0 0 2px; }
.summary { color: #7c8698; margin: 0 0 12px; font-size: 12px; }
#search { width: 100%; padding: 7px 9px; border-radius: 7px; border: 1px solid #2a3342; background: #0b0e14; color: inherit; margin-bottom: 14px; }
.controls { border-top: 1px solid #1e2530; padding: 12px 0; }
.control-head { display: flex; justify-content: space-between; align-items: center; font-weight: 600; color: #9aa5b1; margin: 6px 0; text-transform: uppercase; font-size: 10px; letter-spacing: .06em; }
.mini { background: none; border: 1px solid #2a3342; color: #9aa5b1; border-radius: 5px; padding: 1px 7px; cursor: pointer; font-size: 11px; }
.mini:hover { color: #fff; border-color: #3a4658; }
.filter { display: flex; align-items: center; gap: 7px; padding: 3px 0; cursor: pointer; user-select: none; }
.filter .swatch { width: 11px; height: 11px; border-radius: 3px; flex: none; }
.filter.off { opacity: .38; }
.filter .count { margin-left: auto; color: #6b7484; font-variant-numeric: tabular-nums; }
.row { display: flex; align-items: center; gap: 8px; padding: 4px 0; cursor: pointer; }
button.wide, button.reset { width: 100%; }
button.wide { margin-top: 8px; padding: 7px; border-radius: 7px; border: 1px solid #2a3342; background: #0b0e14; color: inherit; cursor: pointer; }
button.wide:hover { border-color: #3a4658; }
.detail { border-top: 1px solid #1e2530; padding-top: 12px; margin-top: 4px; }
.detail.empty { color: #6b7484; }
.detail .dname { font-size: 14px; font-weight: 600; margin-bottom: 2px; word-break: break-word; }
.detail .dkind { display: inline-block; padding: 1px 8px; border-radius: 20px; font-size: 11px; color: #0b0e14; font-weight: 600; margin-bottom: 8px; }
.detail .drow { color: #9aa5b1; margin: 3px 0; word-break: break-word; }
.detail .drow b { color: #d7dce5; font-weight: 600; }
.detail .dflag { display: inline-block; background: #3a2530; color: #ff8f6b; border-radius: 4px; padding: 0 6px; font-size: 11px; margin: 2px 4px 0 0; }
.hint { color: #5a6474; font-size: 11px; margin-top: 12px; }
#galaxy { flex: 1; display: block; cursor: grab; }
#galaxy:active { cursor: grabbing; }
#legend { position: fixed; bottom: 12px; right: 12px; background: rgba(17,21,31,.85); border: 1px solid #1e2530; border-radius: 8px; padding: 8px 10px; font-size: 11px; pointer-events: none; }
#legend div { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
#legend .swatch { width: 9px; height: 9px; border-radius: 2px; }
`;

/** The inlined client: force sim + canvas render + interactions. */
function clientScript(counts: Record<string, number>): string {
  return `
const KIND_COLORS = ${JSON.stringify(KIND_COLORS)};
const KIND_COUNTS = ${JSON.stringify(counts)};
const model = JSON.parse(document.getElementById("graph-data").textContent);
const canvas = document.getElementById("galaxy");
const ctx = canvas.getContext("2d");
const dpr = Math.min(window.devicePixelRatio || 1, 2);

// ---- state ----
const nodeById = new Map();
const nodes = model.nodes.map((n, i) => {
  const angle = i * 2.399963229728653; // golden angle → even initial spread
  const radius = 30 * Math.sqrt(i);
  const node = { ...n, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0, pinned: false, deg: 0 };
  nodeById.set(n.id, node);
  return node;
});
const edges = model.edges.filter((e) => nodeById.has(e.from) && nodeById.has(e.to));
for (const e of edges) { nodeById.get(e.from).deg++; nodeById.get(e.to).deg++; }
const adjacency = new Map(nodes.map((n) => [n.id, new Set()]));
for (const e of edges) { adjacency.get(e.from).add(e.to); adjacency.get(e.to).add(e.from); }

const kindsOn = new Set(Object.keys(KIND_COLORS));
const edgeKinds = [...new Set(edges.map((e) => e.kind))].sort();
const edgeKindsOn = new Set(edgeKinds);
let selected = null;
let physicsOn = true;
let alwaysLabels = false;
const view = { x: 0, y: 0, scale: 0.7 };

// ---- filters UI ----
const kindWrap = document.getElementById("kind-filters");
for (const kind of Object.keys(KIND_COLORS)) {
  if (!(kind in KIND_COUNTS)) continue;
  const el = document.createElement("div");
  el.className = "filter";
  el.innerHTML = '<span class="swatch" style="background:' + KIND_COLORS[kind] + '"></span>' + kind + '<span class="count">' + KIND_COUNTS[kind] + '</span>';
  el.onclick = () => { kindsOn.has(kind) ? kindsOn.delete(kind) : kindsOn.add(kind); el.classList.toggle("off"); };
  kindWrap.appendChild(el);
}
const edgeWrap = document.getElementById("edge-filters");
for (const kind of edgeKinds) {
  const el = document.createElement("div");
  el.className = "filter";
  el.innerHTML = '<span class="swatch" style="background:#3a4658"></span>' + kind;
  el.onclick = () => { edgeKindsOn.has(kind) ? edgeKindsOn.delete(kind) : edgeKindsOn.add(kind); el.classList.toggle("off"); };
  edgeWrap.appendChild(el);
}
const legend = document.getElementById("legend");
for (const kind of Object.keys(KIND_COLORS)) {
  if (!(kind in KIND_COUNTS)) continue;
  const d = document.createElement("div");
  d.innerHTML = '<span class="swatch" style="background:' + KIND_COLORS[kind] + '"></span>' + kind;
  legend.appendChild(d);
}
function toggleAll(set, all, btn, refresh) {
  return () => {
    const turnOn = set.size < all.length;
    set.clear();
    if (turnOn) for (const k of all) set.add(k);
    refresh();
  };
}
document.getElementById("toggle-nodes").onclick = toggleAll(kindsOn, Object.keys(KIND_COUNTS), null,
  () => [...kindWrap.children].forEach((el, i) => el.classList.toggle("off", !kindsOn.has(Object.keys(KIND_COUNTS)[i]))));
document.getElementById("toggle-edges").onclick = toggleAll(edgeKindsOn, edgeKinds, null,
  () => [...edgeWrap.children].forEach((el, i) => el.classList.toggle("off", !edgeKindsOn.has(edgeKinds[i]))));
document.getElementById("physics").onchange = (e) => { physicsOn = e.target.checked; };
document.getElementById("labels").onchange = (e) => { alwaysLabels = e.target.checked; };
document.getElementById("reset-view").onclick = () => { view.scale = 0.7; recenter(); };

// ---- force simulation (grid-approximated repulsion → scales to thousands) ----
const REPULSION = 1400, SPRING = 0.008, SPRING_LEN = 60, GRAVITY = 0.02, DAMPING = 0.9, CELL = 90;
function tick() {
  if (!physicsOn) return;
  const grid = new Map();
  const key = (x, y) => Math.floor(x / CELL) + "," + Math.floor(y / CELL);
  for (const n of nodes) { const k = key(n.x, n.y); (grid.get(k) || grid.set(k, []).get(k)).push(n); }
  for (const n of nodes) {
    if (n.pinned) continue;
    const cx = Math.floor(n.x / CELL), cy = Math.floor(n.y / CELL);
    for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gy = cy - 1; gy <= cy + 1; gy++) {
      for (const m of grid.get(gx + "," + gy) || []) {
        if (m === n) continue;
        let dx = n.x - m.x, dy = n.y - m.y, d2 = dx * dx + dy * dy || 0.01;
        if (d2 > CELL * CELL * 4) continue;
        const f = REPULSION / d2, d = Math.sqrt(d2);
        n.vx += (dx / d) * f; n.vy += (dy / d) * f;
      }
    }
    n.vx -= n.x * GRAVITY; n.vy -= n.y * GRAVITY;
  }
  for (const e of edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    let dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const f = (d - SPRING_LEN) * SPRING;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }
  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx *= DAMPING; n.vy *= DAMPING;
    n.x += Math.max(-8, Math.min(8, n.vx)); n.y += Math.max(-8, Math.min(8, n.vy));
  }
}

// ---- render ----
function nodeRadius(n) { return 3 + Math.min(7, Math.sqrt(n.deg)); }
function visible(n) { return kindsOn.has(n.kind); }
function draw() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.translate(canvas.width / (2 * dpr) + view.x, canvas.height / (2 * dpr) + view.y);
  ctx.scale(view.scale, view.scale);

  const hi = selected ? adjacency.get(selected.id) : null;
  ctx.lineWidth = 1 / view.scale;
  for (const e of edges) {
    if (!edgeKindsOn.has(e.kind)) continue;
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    if (!visible(a) || !visible(b)) continue;
    const near = selected && (e.from === selected.id || e.to === selected.id);
    if (selected && !near) { ctx.globalAlpha = 0.05; ctx.strokeStyle = "#2a3342"; }
    else { ctx.globalAlpha = selected ? 0.9 : 0.28; ctx.strokeStyle = near ? "#8fa3c0" : "#3a4658"; }
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const dim = selected && n !== selected && !(hi && hi.has(n.id));
    ctx.globalAlpha = dim ? 0.18 : 1;
    ctx.fillStyle = KIND_COLORS[n.kind] || "#888";
    ctx.beginPath(); ctx.arc(n.x, n.y, nodeRadius(n), 0, 6.283); ctx.fill();
    if (n === selected) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2 / view.scale; ctx.stroke(); }
    if ((alwaysLabels || n === selected || (hi && hi.has(n.id)) || (view.scale > 1.4 && n.deg > 2)) && !dim) {
      ctx.globalAlpha = 1; ctx.fillStyle = "#d7dce5"; ctx.font = (11 / view.scale) + "px sans-serif";
      ctx.fillText(n.label, n.x + nodeRadius(n) + 2 / view.scale, n.y + 3 / view.scale);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}
function frame() { tick(); draw(); requestAnimationFrame(frame); }

// ---- interaction ----
function resize() { canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr; }
function recenter() { view.x = 0; view.y = 0; }
window.addEventListener("resize", resize);
function toWorld(px, py) {
  return { x: (px - canvas.clientWidth / 2 - view.x) / view.scale, y: (py - canvas.clientHeight / 2 - view.y) / view.scale };
}
function hitTest(px, py) {
  const w = toWorld(px, py);
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (!visible(n)) continue;
    const dx = n.x - w.x, dy = n.y - w.y, d = dx * dx + dy * dy, r = nodeRadius(n) + 4;
    if (d < r * r && d < bestD) { best = n; bestD = d; }
  }
  return best;
}
let drag = null, dragMoved = false, panning = false, lastX = 0, lastY = 0;
canvas.addEventListener("mousedown", (e) => {
  const hit = hitTest(e.offsetX, e.offsetY);
  dragMoved = false;
  if (hit) { drag = hit; hit.pinned = true; } else { panning = true; }
  lastX = e.offsetX; lastY = e.offsetY;
});
window.addEventListener("mousemove", (e) => {
  if (drag) {
    const w = toWorld(e.offsetX, e.offsetY); drag.x = w.x; drag.y = w.y; drag.vx = drag.vy = 0; dragMoved = true;
  } else if (panning) {
    view.x += e.offsetX - lastX; view.y += e.offsetY - lastY; lastX = e.offsetX; lastY = e.offsetY;
  }
});
window.addEventListener("mouseup", (e) => {
  if (drag && !dragMoved) { drag.pinned = false; select(drag); }
  else if (panning && Math.abs(e.offsetX - lastX) < 3) { /* click empty → clear */ if (!drag) select(null); }
  drag = null; panning = false;
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  view.scale = Math.max(0.1, Math.min(6, view.scale * factor));
}, { passive: false });

function select(n) {
  selected = n;
  const panel = document.getElementById("detail");
  if (!n) { panel.className = "detail empty"; panel.textContent = "Click a node to inspect it."; return; }
  panel.className = "detail";
  const color = KIND_COLORS[n.kind] || "#888";
  const flags = n.flags.map((f) => '<span class="dflag">' + f + '</span>').join("");
  panel.innerHTML =
    '<div class="dname">' + esc(n.label) + '</div>' +
    '<span class="dkind" style="background:' + color + '">' + n.kind + '</span>' +
    '<div class="drow">' + esc(n.detail) + '</div>' +
    '<div class="drow"><b>' + esc(n.file) + ':' + n.line + '</b></div>' +
    '<div class="drow">' + n.deg + ' connection' + (n.deg === 1 ? '' : 's') + '</div>' +
    (flags ? '<div class="drow">' + flags + '</div>' : '');
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

// search → fly to first match
const search = document.getElementById("search");
search.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = search.value.trim().toLowerCase();
  if (!q) return;
  const hit = nodes.find((n) => n.label.toLowerCase().includes(q) || n.file.toLowerCase().includes(q));
  if (hit) { view.scale = 1.6; view.x = -hit.x * view.scale; view.y = -hit.y * view.scale; select(hit); }
});

resize();
frame();
`;
}
