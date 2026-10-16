import { describe, it, expect } from "vitest";
import { buildToolList, createToolState } from "../src/mcp-server";

/**
 * browser_runSteps adds one fixed orchestration schema (under 1.2k chars) to
 * every surface. These ceilings retain the prior headroom plus that bounded
 * addition; they still catch side-panel-style descriptions leaking back in.
 */
const CORE_MAX_CHARS = 19_000;
const FULL_MAX_CHARS = 28_000;
const ORCHESTRATION_MAX_CHARS = 1_200;

describe("tools/list size budget", () => {
  it("pre-pairing core stays far below the connected ceiling", () => {
    const json = JSON.stringify(buildToolList(undefined, createToolState("core")));
    expect(json.length, `pre-pair list is ${json.length} chars`).toBeLessThanOrEqual(4_700);
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
