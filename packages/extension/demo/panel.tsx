import React from "react";
import ReactDOM from "react-dom/client";
import { installChromeShim } from "./chrome-shim";
import { createBridgeClient } from "./bridge";
import { DEMO_PROMPT } from "./scenario";
import { startAutoplay } from "./autoplay";
import { parseDemoScene } from "./scene-mode";

/**
 * The demo's panel document: the real side panel, running as a plain web page.
 *
 * The shim must be installed before the app's first module evaluates, which is
 * why `AppShell` is imported dynamically below rather than at the top.
 */

const toHarness = createBridgeClient(window.parent);
const scene = parseDemoScene(location.search);

const onboardingSeed = {
  "aipagego.llm": {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    apiKey: "",
    apiKeyMode: "persistent",
    maxTokens: 4096,
    maxRounds: 20,
    defaultPermissionMode: "default",
  },
  "aipagego.firstRun.v1": undefined,
};

installChromeShim({
  // Steps that need the page go across the bridge; the harness runs them with
  // the product's own callTool against the mock page's document.
  onPageStep: (step, bindings) => toHarness(step, bindings),
  seed: scene === "onboarding" ? onboardingSeed : undefined,
});

async function main(): Promise<void> {
  const [{ AppShell }, { ThemeProvider }] = await Promise.all([
    import("@/sidepanel/shell/app-shell"),
    import("@/sidepanel/shell/theme-provider")
  ]);
  await import("@/sidepanel/index.css");

  const root = document.getElementById("root");
  if (!root) throw new Error("demo panel: #root missing");

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ThemeProvider>
        <AppShell />
      </ThemeProvider>
    </React.StrictMode>
  );

  if (scene !== "onboarding") startAutoplay(DEMO_PROMPT);
}

void main();
