import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import { materializePreset, listTools, deleteTool } from "@/background/storage/tools";
import { PRESETS } from "@aipagego/shared/presets";

describe("materializePreset", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(async () => {
    for (const t of await listTools()) {
      await deleteTool(t.id);
    }
    _resetDBForTests();
  });

  it("copies a tool-form preset into IDB with origin metadata", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    expect(preset).toBeDefined();
    const tool = await materializePreset(preset.id);
    expect(tool.origin).toEqual({
      kind: "preset",
      presetId: preset.id,
      presetVersion: preset.version
    });
    expect(tool.kind).toBe("steps");
    const listed = await listTools();
    expect(listed.some((t) => t.id === tool.id)).toBe(true);
  });

  it("returns existing tool when preset already materialized (idempotent)", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    const t1 = await materializePreset(preset.id);
    const t2 = await materializePreset(preset.id);
    expect(t1.id).toBe(t2.id);
    // Only one entry in IDB
    const listed = await listTools();
    expect(listed.filter((t) => t.origin?.kind === "preset" && t.origin.presetId === preset.id)).toHaveLength(1);
  });

  it("throws for unknown presetId", async () => {
    await expect(materializePreset("does-not-exist")).rejects.toThrow();
  });

  it("throws for prompt-form preset", async () => {
    const preset = PRESETS.find((p) => p.kind === "prompt")!;
    expect(preset).toBeDefined();
    await expect(materializePreset(preset.id)).rejects.toThrow(/prompt/);
  });
});
