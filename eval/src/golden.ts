/** The golden.json contract every fixture follows. */

/**
 * xfail semantics, available on any individual check via `expectedFail`:
 * a failing check reports xfail (does not gate); a PASSING check still marked
 * expectedFail reports unexpected-pass and DOES gate, so stale markers are
 * removed the moment the capability lands.
 */
export interface GoldenComponent {
  name: string;
  /** Expected number of InstanceNodes for this definition. */
  instances: number;
  expectedFail?: string;
}

export interface GoldenAttribution {
  component: string;
  /**
   * When set: trace the *instance* of `component` located in this file.
   * When absent: trace the definition.
   */
  instanceAt?: string;
  /** Exact set of endpoints the trace must yield. */
  endpoints: string[];
  expectedFail?: string;
}

export interface GoldenForbidden {
  component: string;
  instanceAt?: string;
  /** This endpoint must NOT appear in the trace — it is the poison answer. */
  endpoint: string;
  note?: string;
}

export interface GoldenQuery {
  terms: string[];
  /** Optional structural descriptor (Phase 4.2), e.g. { table: true, columns: 4 }. */
  structure?: import("@coderadar/core").StructureDescriptor;
  status: "ok" | "ambiguous" | "declined";
  /** Required top-1 component name when status is "ok". */
  top?: string;
  /** Ancestor names the top match must list as `context` (step 4.3). */
  context?: string[];
  /**
   * When set, `top` need only appear within the first `topK` candidates rather
   * than at rank 1 — the honest bar for OCR-noisy input (failure mode A10).
   */
  topK?: number;
  expectedFail?: string;
}

export interface GoldenRoute {
  /** Route pattern in :param form, e.g. "/users/:id". */
  path: string;
  /** Component name the route's routes-to edge must land on. */
  component: string;
  /** When set, the RouteNode's layout must equal this exactly (null = bare). */
  layout?: string | null;
  /** When set, the RouteNode's guards must equal this exactly. */
  guards?: string[];
  expectedFail?: string;
}

export interface GoldenEffect {
  /** Component that owns the event (a `handles` edge from it reaches the event). */
  component: string;
  /** Event name the effect hangs off, e.g. "onClick", "onSubmit". */
  event: string;
  /** The effect edge kind asserted from the event node. */
  effect: "navigates-to" | "triggers" | "writes-state";
  /**
   * Expected target, matched against the edge's destination node:
   * a route path (navigates-to), a data-source endpoint (triggers), or a
   * state/slice name (writes-state).
   */
  to: string;
  expectedFail?: string;
}

export interface GoldenJourney {
  /** Entry point: a route path ("/users") or a component name. */
  start: string;
  depth?: number;
  /**
   * Journey paths that must appear, identified by the ordered page labels
   * (route paths) they visit. `end` asserts how the path terminates —
   * "cycle" is the B6 guarantee that a list ↔ detail loop stays finite.
   */
  expect: Array<{ pages: string[]; end?: "terminal" | "cycle" | "depth-limit" }>;
  expectedFail?: string;
}

export interface GoldenCondition {
  /** Component the gated edge originates from. */
  component: string;
  /** Which edge kind carries the condition. */
  edge: "handles" | "renders";
  kind: "flag" | "role";
  /** Substring the condition expression must contain (e.g. "new-billing"). */
  expression: string;
  expectedFail?: string;
}

export interface Golden {
  failureMode: string;
  note?: string;
  /** App directory relative to the fixture dir. Default "./app". */
  app?: string;
  /** Extra scan options this fixture needs (passed through to scanReact). */
  scan?: {
    baseUrls?: string[];
    apiWrappers?: string[];
    i18n?: { localeGlobs: string[]; defaultLocale: string };
  };
  expect: {
    components?: GoldenComponent[];
    attributions?: GoldenAttribution[];
    forbidden?: GoldenForbidden[];
    queries?: GoldenQuery[];
    routes?: GoldenRoute[];
    /** Paths that must NOT exist as routes (api handlers, _app…). Never xfails. */
    forbiddenRoutes?: string[];
    /** Action effects (step 3.2): event → navigates-to / triggers / writes-state. */
    effects?: GoldenEffect[];
    /** Journey paths (step 3.3): page → event → effect → page, lazily expanded. */
    journeys?: GoldenJourney[];
    /** Flag/role conditions on renders/handles edges (step 3.5). */
    conditions?: GoldenCondition[];
  };
}

export type CheckStatus = "pass" | "fail" | "xfail" | "unexpected-pass";

export interface CheckResult {
  /** e.g. "components:DataTable", "attribution:DataTable@pages/UsersPage.tsx" */
  id: string;
  kind:
    | "components"
    | "attributions"
    | "forbidden"
    | "queries"
    | "routes"
    | "effects"
    | "journeys"
    | "conditions";
  status: CheckStatus;
  detail?: string;
}

export interface FixtureResult {
  fixture: string;
  failureMode: string;
  checks: CheckResult[];
  /** Attribution tallies for lineage precision/recall. */
  attribution: { truePositives: number; falsePositives: number; falseNegatives: number };
}

export interface Scorecard {
  generatedAt: string;
  commitSha: string | null;
  fixtures: FixtureResult[];
  summary: {
    pass: number;
    fail: number;
    xfail: number;
    unexpectedPass: number;
    lineagePrecision: number | null;
    lineageRecall: number | null;
    matchAccuracy: number | null;
  };
}

export interface Thresholds {
  maxFail: number;
  maxUnexpectedPass: number;
  /** Optional metric floors; null-valued metrics are not gated. */
  minLineagePrecision?: number;
  minLineageRecall?: number;
  minMatchAccuracy?: number;
}
