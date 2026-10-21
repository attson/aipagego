import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests } from "@/background/storage/db";
import { exportAll, importBundle } from "@/background/storage/export-import";
import { listTools, materializePreset, saveDraft } from "@/background/storage/tools";
import { PRESETS } from "@aipagego/shared/presets";

function stepsDraft(name: string) {
  return {
    kind: "steps" as const,
    name,
    urlPatterns: ["https://example.com/*"],
    description: "",
    steps: [{ kind: "tool" as const, tool: "snapshotDOM" as const, args: {} }],
    outputSchema: {}
  };
}

describe("export-import", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => _resetDBForTests());

  it("exportAll produces a valid v2 bundle", async () => {
    const t = await saveDraft(stepsDraft("A"));
    const bundle = await exportAll();
    expect(bundle.schema).toBe("aipagego.tools/v2");
    expect(bundle.tools).toHaveLength(1);
    expect(bundle.tools[0].id).toBe(t.id);
  });

  it("exports prompt tools in v2 bundles", async () => {
    const t = await saveDraft({
      kind: "prompt",
      name: "Prompt",
      urlPatterns: ["https://example.com/*"],
      description: "",
      prompt: "请总结当前页面"
    });
    const bundle = await exportAll();
    expect(bundle.schema).toBe("aipagego.tools/v2");
    expect(bundle.tools[0]).toMatchObject({ id: t.id, kind: "prompt", prompt: "请总结当前页面" });
  });

  it("importBundle merges tools by id (default skip)", async () => {
    const t = await saveDraft(stepsDraft("A"));
    const bundle = {
      schema: "aipagego.tools/v2" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "skip" });
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    const list = await listTools();
    expect(list[0].name).toBe("A");
  });

  it("importBundle overwrite replaces existing", async () => {
    const t = await saveDraft(stepsDraft("A"));
    const bundle = {
      schema: "aipagego.tools/v2" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "overwrite" });
    expect(result.imported).toBe(1);
    const list = await listTools();
    expect(list[0].name).toBe("A-modified");
  });

  it("importBundle copy creates a new id", async () => {
    const t = await saveDraft(stepsDraft("A"));
    const bundle = {
      schema: "aipagego.tools/v2" as const,
      exportedAt: Date.now(),
      tools: [{ ...t, name: "A-modified" }]
    };
    const result = await importBundle(bundle, { onConflict: "copy" });
    expect(result.imported).toBe(1);
    const list = await listTools();
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.name === "A-modified")?.id).not.toBe(t.id);
  });

  it("importBundle rejects invalid schema", async () => {
    await expect(
      importBundle(
        { schema: "aipagego.tools/v1", exportedAt: Date.now(), tools: [] } as never,
        { onConflict: "skip" }
      )
    ).rejects.toThrow("schema mismatch");
  });

  // Gap Fix T8.5: origin handling
  it("exportAll excludes unmodified preset copies (1 version, origin.kind === preset)", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    await materializePreset(preset.id);
    const bundle = await exportAll();
    // The materialized preset tool has only 1 version and origin.kind === "preset" → excluded
    expect(bundle.tools.find((t) => t.origin?.kind === "preset" && t.origin.presetId === preset.id)).toBeUndefined();
  });

  it("exportAll includes preset-origin tools that have been modified (2+ versions)", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    const { appendVersion } = await import("@/background/storage/tools");
    const tool = await materializePreset(preset.id);
    // Simulate a user edit — add a second version
    await appendVersion(tool.id, {
      steps: tool.kind === "steps" ? tool.steps : [],
      outputSchema: {},
      note: "user edit"
    });
    const bundle = await exportAll();
    expect(bundle.tools.find((t) => t.id === tool.id)).toBeDefined();
  });

  it("importBundle strips origin when preset id is unknown", async () => {
    const t = await saveDraft(stepsDraft("B"));
    const toolWithUnknownOrigin = {
      ...t,
      origin: { kind: "preset" as const, presetId: "unknown-preset-xyz", presetVersion: 1 }
    };
    const bundle = {
      schema: "aipagego.tools/v2" as const,
      exportedAt: Date.now(),
      tools: [toolWithUnknownOrigin]
    };
    await importBundle(bundle, { onConflict: "overwrite" });
    const list = await listTools();
    const imported = list.find((x) => x.id === t.id);
    expect(imported?.origin).toBeUndefined();
  });

  it("importBundle preserves origin when preset id is known", async () => {
    const preset = PRESETS.find((p) => p.kind === "tool")!;
    const t = await saveDraft(stepsDraft("C"));
    const toolWithKnownOrigin = {
      ...t,
      origin: { kind: "preset" as const, presetId: preset.id, presetVersion: preset.version }
    };
    const bundle = {
      schema: "aipagego.tools/v2" as const,
      exportedAt: Date.now(),
      tools: [toolWithKnownOrigin]
    };
    await importBundle(bundle, { onConflict: "overwrite" });
    const list = await listTools();
    const imported = list.find((x) => x.id === t.id);
    expect(imported?.origin).toEqual({ kind: "preset", presetId: preset.id, presetVersion: preset.version });
  });
});
