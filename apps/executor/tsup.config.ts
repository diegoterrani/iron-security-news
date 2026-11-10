import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/healthcheck.ts", "src/test-sources.ts", "src/regen-derivatives.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  // @ironnews/shared e @ironnews/templates são TS-fonte no monorepo: vão embutidos no bundle.
  noExternal: ["@ironnews/shared", "@ironnews/templates"],
});
