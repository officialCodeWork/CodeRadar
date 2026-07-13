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
  status: "ok" | "ambiguous" | "declined";
  /** Required top-1 component name when status is "ok". */
  top?: string;
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
  };
}

export type CheckStatus = "pass" | "fail" | "xfail" | "unexpected-pass";

export interface CheckResult {
  /** e.g. "components:DataTable", "attribution:DataTable@pages/UsersPage.tsx" */
  id: string;
  kind: "components" | "attributions" | "forbidden" | "queries";
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
