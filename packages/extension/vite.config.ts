import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { crx } from "@crxjs/vite-plugin";
import path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import manifest from "./src/manifest";
import { stripBootstrapCss } from "./build/strip-bootstrap-css";

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"));

export default defineConfig({
  // Content scripts execute in the host page, so root-relative chunk URLs
  // would resolve against the website instead of the extension origin.
  base: "./",
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") }
  },
  plugins: [
    react(),
    crx({ manifest }),
    {
      name: "strip-bootstrap-page-css",
      enforce: "post",
      apply: "build",
      writeBundle(options) {
        const outputDir = options.dir ?? path.resolve(__dirname, "dist");
        const manifestPath = path.resolve(outputDir, "manifest.json");
        const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as Parameters<typeof stripBootstrapCss>[0];
        const bootstrap = parsed.content_scripts?.find((entry) =>
          entry.matches?.includes("<all_urls>") &&
          entry.js?.some((file) => file.includes("bootstrap.ts-loader"))
        );
        if (!bootstrap) throw new Error("built bootstrap content-script entry not found");
        writeFileSync(manifestPath, JSON.stringify(stripBootstrapCss(parsed), null, 2) + "\n");
      }
    }
  ],
  server: { port: 5173, strictPort: true, hmr: { port: 5174 } },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
