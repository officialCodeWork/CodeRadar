/**
 * ui-lineage — public library API.
 *
 * One import gives you the whole toolkit: the React/TSX scanner plus the graph
 * query layer (match, per-instance lineage, journeys). The internal monorepo
 * packages are bundled in at build time, so consumers depend only on `ui-lineage`.
 *
 *   import { scanReact, resolveHookEdges, journeys, traceLineage } from "ui-lineage";
 */
export * from "@coderadar/core";
export { resolveHookEdges, scanReact, type ScanOptions } from "@coderadar/parser-react";
export {
  classifyTicket,
  type ContextResult,
  type EntryPoint,
  resolveContext,
  type Ticket,
} from "@coderadar/agent-sdk";
