import { describe, it, expect } from "vitest";
import { buildToolList, createToolState } from "../src/mcp-server";

/**
 * browser_runSteps and browser_start add two fixed orchestration schemas to
 * every surface. These ceilings retain narrow headroom above those bounded
 * additions and still catch side-panel-style descriptions leaking back in.
 */
const PRE_PAIR_MAX_CHARS = 5_300;
const CORE_MAX_CHARS = 19_700;
const FULL_MAX_CHARS = 28_700;
const ORCHESTRATION_MAX_CHARS = 1_200;

describe("tools/list size budget", () => {
  it("pre-pairing core stays far below the connected ceiling", () => {
    const json = JSON.stringify(buildToolList(undefined, createToolState("core")));
    expect(json.length, `pre-pair list is ${json.length} chars`).toBeLessThanOrEqual(PRE_PAIR_MAX_CHARS);
  });
  it("connected full stays under the ceiling", () => {
    const state = createToolState("full");
    state.browserSurfaceVisible = true;
    const json = JSON.stringify(buildToolList(undefined, state));
    expect(json.length, `full list is ${json.length} chars`).toBeLessThanOrEqual(FULL_MAX_CHARS);
  });

  it("connected core stays under the ceiling", () => {
    const state = createToolState("core");
    state.browserSurfaceVisible = true;
    const json = JSON.stringify(buildToolList(undefined, state));
    expect(json.length, `core list is ${json.length} chars`).toBeLessThanOrEqual(CORE_MAX_CHARS);
  });

  it("keeps the orchestration schema compact", () => {
    const tool = buildToolList().find((entry) => entry.name === "browser_runSteps");
    const json = JSON.stringify(tool);
    expect(json.length, `browser_runSteps is ${json.length} chars`).toBeLessThanOrEqual(
      ORCHESTRATION_MAX_CHARS
    );
  });
});
