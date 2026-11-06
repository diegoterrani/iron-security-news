import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts", "src/healthcheck.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  sourcemap: true,
  // @ironnews/shared é TS-fonte no monorepo: vai embutido no bundle.
  noExternal: ["@ironnews/shared"],
});
