import { defineConfig } from "tsup";

// ui-lineage ships as a single self-contained package: the internal @coderadar/*
// workspace packages are bundled into the output, while the heavy third-party
// deps (ts-morph, yaml, commander) stay external and install normally.
export default defineConfig({
  entry: {
    index: "src/index.ts", // CLI bin (keeps its #!/usr/bin/env node shebang)
    mcp: "src/mcp.ts", // ui-lineage-mcp bin (MCP stdio server)
    lib: "src/lib.ts", // library entry
    vision: "src/vision.ts", // ui-lineage/vision subpath
  },
  format: ["esm"],
  target: "node20",
  // Inline the workspace packages' TYPES too, so the published .d.ts has no
  // dangling references to the unpublished @coderadar/* internals.
  dts: { resolve: true },
  clean: true,
  sourcemap: true,
  noExternal: [/^@coderadar\//],
  // @anthropic-ai/sdk is a lazy, optional runtime dep of the vision adapter.
  external: ["ts-morph", "yaml", "commander", "@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"],
});
