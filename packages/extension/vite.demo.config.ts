import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

/**
 * Builds the docs-site demo: the real side panel and the real content tools as
 * a plain web app, with no @crxjs and no extension runtime.
 *
 * `sidepanel/llm/client.ts` is aliased to a demo client that replays the
 * scripted rounds, so the panel itself needs no demo-only branches.
 */
export default defineConfig({
  root: path.resolve(__dirname, "demo"),
  base: "/aipagego/demo/",
  resolve: {
    alias: [
      {
        find: /^@\/sidepanel\/llm\/client$/,
        replacement: path.resolve(__dirname, "demo/llm-client.ts")
      },
      { find: "@", replacement: path.resolve(__dirname, "src") }
    ]
  },
  define: {
    __APP_VERSION__: JSON.stringify("demo")
  },
  build: {
    outDir: path.resolve(__dirname, "../../docs-site/public/demo"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "demo/index.html"),
        panel: path.resolve(__dirname, "demo/panel.html")
      }
    }
  }
});
