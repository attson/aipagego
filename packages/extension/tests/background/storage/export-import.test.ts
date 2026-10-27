import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";
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

  it("exportAll produces a canonical v3 bundle without top-level mirrors", async () => {
    const t = await saveDraft(stepsDraft("A"));
    const db = await getDB();
    await db.put("tools", {
      ...t,
      runtimeInputs: { secret: "sk-runtime-secret" },
      pageResult: { value: "sk-runtime-secret" },
      apiKey: "sk-runtime-secret",
    } as never);
    const bundle = await exportAll();
    expect(bundle.schema).toBe("aipagego.tools/v3");
    expect(bundle.tools).toHaveLength(1);
    expect(bundle.tools[0].id).toBe(t.id);
    expect(bundle.tools[0]).not.toHaveProperty("steps");
    expect(bundle.tools[0]).not.toHaveProperty("outputSchema");
  });

  it("never includes local Jobs, inputs, baselines, notifications or history in tools/v3", async () => {
    const tool = await saveDraft(stepsDraft("Export boundary"));
    const db = await getDB();
    await db.put("jobs", {
      id: "job-secret", name: "local-job-secret", toolId: tool.id, toolVersion: 1,
      toolVersionHash: "a".repeat(64), targetUrl: "https://example.com/?token=query-secret",
      inputs: { marker: "input-secret" }, trigger: { kind: "manual" }, status: "active",
      safety: { severity: "safe" }, retry: { maxAttempts: 1, backoffMinutes: [] },
      notifications: { onChange: true, onSuccess: false, onFailure: true },
      connectorBindings: [],
      changeBaseline: { hash: "b".repeat(64), capturedAt: 1 }, createdAt: 1, updatedAt: 1,
    });
    const serialized = JSON.stringify(await exportAll());
    expect(serialized).not.toContain("job-secret");
    expect(serialized).not.toContain("input-secret");
    expect(serialized).not.toContain("query-secret");
  });

  it("blocks a v3 backup containing a literal credential without echoing the value", async () => {
    await saveDraft({
      kind: "steps",
      name: "Unsafe request",
      urlPatterns: ["https://example.com/*"],
      description: "",
      steps: [{
        kind: "tool",
        tool: "httpRequest",
        args: {
          url: "https://api.example.com/data",
          headers: { Authorization: "Bearer backup-secret-value" },
        },
      }],
      outputSchema: {},
    });

    let message = "";
    try {
      await exportAll();
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }

    expect(message).toContain("package_secret_detected");
    expect(message).toContain("$.tools[0].versions[0].steps[0].args.headers.Authorization");
    expect(message).not.toContain("backup-secret-value");
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
    expect(bundle.schema).toBe("aipagego.tools/v3");
    expect(bundle.tools[0]).toMatchObject({ id: t.id, kind: "prompt", prompt: "请总结当前页面" });
  });

  it("round-trips a structured collection tool without adding runtime data", async () => {
    const recipe = {
      version: 1 as const,
      mode: "single" as const,
      fields: [
        { id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true },
      ],
      pagination: { kind: "single" as const },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    };
    const original = await saveDraft({
      kind: "steps",
      name: "采集工具",
      urlPatterns: ["https://example.com/products/**"],
      description: "本地采集",
      steps: [{ kind: "tool", tool: "collectStructuredData", args: { recipe }, timeoutMs: 600_000 }],
      outputSchema: { type: "object", properties: { resultId: { type: "string" } } },
    });
    const bundle = await exportAll();

    _resetDBForTests();
    indexedDB = new IDBFactory();
    expect(await importBundle(bundle, { onConflict: "skip" })).toEqual({ imported: 1, skipped: 0, errors: [] });
    expect(await listTools()).toEqual([original]);
    expect(JSON.stringify(bundle)).not.toContain('"tabId"');
    expect(JSON.stringify(bundle)).not.toContain('"rows"');
  });

  it("rejects an imported unknown tool instead of degrading it to runJS", async () => {
    const valid = await saveDraft(stepsDraft("Known"));
    const unknownStep = { kind: "tool" as const, tool: "futureUnknownTool", args: {} };
    const unknown = {
      ...valid,
      id: "unknown-tool",
      steps: [unknownStep],
      versions: valid.versions.map((version) => ({ ...version, steps: [unknownStep] })),
    };

    const result = await importBundle({
      schema: "aipagego.tools/v2",
      exportedAt: Date.now(),
      tools: [unknown as never],
    }, { onConflict: "skip" });

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(result.errors[0]).toMatchObject({ index: 0, code: "invalid_tool" });
    expect((await listTools()).find((tool) => tool.id === "unknown-tool")).toBeUndefined();
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

  it("imports a legacy v2 mirror bundle and persists canonical data", async () => {
    const saved = await saveDraft(stepsDraft("Legacy source"));
    if (saved.kind !== "steps") throw new Error("expected steps tool");
    const legacyV2 = {
      ...saved,
      steps: saved.versions[0].steps,
      outputSchema: saved.versions[0].outputSchema,
      activeVersion: undefined,
    };
    _resetDBForTests();
    indexedDB = new IDBFactory();

    const result = await importBundle({
      schema: "aipagego.tools/v2",
      exportedAt: Date.now(),
      tools: [legacyV2],
    }, { onConflict: "skip" });

    expect(result).toEqual({ imported: 1, skipped: 0, errors: [] });
    const imported = (await listTools())[0];
    expect(imported).toMatchObject({ id: saved.id, kind: "steps", activeVersion: 1 });
    expect("steps" in imported).toBe(false);
  });

  it.each([
    ["missing_active", (tool: Record<string, unknown>) => ({ ...tool, activeVersion: undefined })],
    ["invalid_active", (tool: Record<string, unknown>) => ({ ...tool, activeVersion: 99 })],
    ["duplicate_version", (tool: Record<string, unknown>) => ({
      ...tool,
      versions: [
        ...(tool.versions as Record<string, unknown>[]),
        { ...(tool.versions as Record<string, unknown>[])[0] },
      ],
    })],
    ["invalid_reference", (tool: Record<string, unknown>) => ({
      ...tool,
      versions: [{
        ...(tool.versions as Record<string, unknown>[])[0],
        steps: [{ kind: "tool", tool: "fillInput", args: { selector: "#q", value: "${future}" } }],
      }],
    })],
  ])("reports invalid v3 tools: %s", async (_label, mutate) => {
    const saved = await saveDraft(stepsDraft("Invalid v3"));
    const result = await importBundle({
      schema: "aipagego.tools/v3",
      exportedAt: Date.now(),
      tools: [mutate(saved as unknown as Record<string, unknown>)],
    }, { onConflict: "overwrite" });

    expect(result).toMatchObject({ imported: 0, skipped: 1 });
    expect(result.errors).toEqual([expect.objectContaining({ index: 0, code: "invalid_tool" })]);
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
    if (tool.kind !== "steps") throw new Error("expected steps tool");
    // Simulate a user edit — add a second version
    await appendVersion(tool.id, {
      steps: tool.versions.find((version) => version.version === tool.activeVersion)!.steps,
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
