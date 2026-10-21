import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  noExternal: ["@aipagego/shared", "@aipagego/coordinator"],
  external: ["ws", "@modelcontextprotocol/sdk", "zod"],
  sourcemap: false,
  dts: false,
  splitting: false
});
