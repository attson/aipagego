import { describe, expect, it } from "vitest";
import { CanonicalToolSchema, RpcRequest, ToolSchema } from "../src/messages";
import {
  WorkflowBindingError,
  WorkflowInputError,
  analyzeWorkflow,
  diffWorkflowDefinitions,
  getActiveStepsVersion,
  prepareWorkflowInputs,
  resolveWorkflowValue,
} from "../src/workflow";
import type { StepsTool } from "../src/types";

const legacyStepsTool = {
  id: "tool-1",
  kind: "steps" as const,
  name: "Legacy workflow",
  urlPatterns: ["https://example.com/**"],
  description: "",
  steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" } }],
  outputSchema: {},
  createdAt: 1,
  updatedAt: 2,
  versions: [
    {
      version: 1,
      kind: "steps" as const,
      steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" } }],
      outputSchema: {},
      createdAt: 1,
    },
    {
      version: 2,
      kind: "steps" as const,
      steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
      outputSchema: { type: "string" },
      createdAt: 2,
    },
  ],
  stats: { runs: 0 },
};

describe("workflow contracts", () => {
  it("accepts optional run inputs without breaking legacy starts", () => {
    expect(RpcRequest.safeParse({
      type: "runs.start",
      target: { kind: "tool", id: "tool-1" },
      tabId: 7,
    }).success).toBe(true);
    const parsed = RpcRequest.parse({
      type: "runs.start",
      target: { kind: "tool", id: "tool-1" },
      tabId: 7,
      inputs: { keyword: "耳机", limit: 20 },
    });
    expect(parsed).toMatchObject({ inputs: { keyword: "耳机", limit: 20 } });
  });

  it("normalizes a legacy steps tool to its highest active version", () => {
    const parsed = ToolSchema.parse(legacyStepsTool);
    expect(parsed.kind).toBe("steps");
    if (parsed.kind !== "steps") throw new Error("expected steps tool");

    expect(parsed.activeVersion).toBe(2);
    expect(parsed.versions.map((version) => version.parameters)).toEqual([[], []]);
    expect("steps" in parsed).toBe(false);
    expect("outputSchema" in parsed).toBe(false);
  });

  it("builds a canonical v1 snapshot from a top-level-only legacy tool", () => {
    const { versions: _versions, ...topLevelOnly } = legacyStepsTool;
    const parsed = ToolSchema.parse(topLevelOnly);
    expect(parsed).toMatchObject({ kind: "steps", activeVersion: 1 });
    if (parsed.kind !== "steps") throw new Error("expected steps tool");
    expect(parsed.versions).toEqual([expect.objectContaining({
      version: 1,
      kind: "steps",
      parameters: [],
      steps: legacyStepsTool.steps,
      outputSchema: {},
    })]);
  });

  it("requires an explicit valid active pointer and no top-level mirrors for canonical tools", () => {
    const normalized = ToolSchema.parse(legacyStepsTool);
    if (normalized.kind !== "steps") throw new Error("expected steps tool");
    expect(CanonicalToolSchema.safeParse(normalized).success).toBe(true);
    expect(CanonicalToolSchema.safeParse({ ...normalized, activeVersion: undefined }).success).toBe(false);
    expect(CanonicalToolSchema.safeParse({
      ...normalized,
      steps: legacyStepsTool.steps,
      outputSchema: {},
    }).success).toBe(false);
    expect(CanonicalToolSchema.safeParse({ ...normalized, activeVersion: 99 }).success).toBe(false);
    expect(CanonicalToolSchema.safeParse({
      ...normalized,
      versions: normalized.versions.map(({ parameters: _parameters, ...version }) => version),
    }).success).toBe(false);
  });

  it("rejects canonical versions with unresolved bindings", () => {
    const normalized = ToolSchema.parse(legacyStepsTool);
    expect(CanonicalToolSchema.safeParse({
      ...normalized,
      versions: [{
        ...normalized.versions[0],
        steps: [{
          kind: "tool",
          tool: "fillInput",
          args: { selector: "#q", value: "${future}" },
        }],
      }],
      activeVersion: 1,
    }).success).toBe(false);
  });

  it("validates parameters and the active version pointer", () => {
    const parameter = {
      key: "keyword",
      label: "关键词",
      type: "string" as const,
      required: true,
      description: "用于搜索商品",
    };
    const valid = {
      ...legacyStepsTool,
      activeVersion: 1,
      versions: [{ ...legacyStepsTool.versions[0], parameters: [parameter] }],
    };
    const parsed = ToolSchema.parse(valid);
    expect(parsed.kind).toBe("steps");
    if (parsed.kind !== "steps") throw new Error("expected steps tool");
    expect(parsed.versions[0].parameters).toEqual([parameter]);

    expect(ToolSchema.safeParse({
      ...valid,
      versions: [{
        ...valid.versions[0],
        parameters: [{ ...parameter, sensitive: true, defaultValue: "secret" }],
      }],
    }).success).toBe(false);
    expect(ToolSchema.safeParse({ ...valid, activeVersion: 99 }).success).toBe(false);
    expect(ToolSchema.safeParse({
      ...valid,
      versions: [valid.versions[0], { ...valid.versions[0] }],
    }).success).toBe(false);
  });

  it("reads the explicit active snapshot and falls back to the highest legacy version", () => {
    const explicit = ToolSchema.parse({
      ...legacyStepsTool,
      activeVersion: 1,
      versions: [legacyStepsTool.versions[1], legacyStepsTool.versions[0]],
    });
    expect(explicit.kind).toBe("steps");
    if (explicit.kind !== "steps") throw new Error("expected steps tool");
    expect(getActiveStepsVersion(explicit as unknown as StepsTool).version).toBe(1);

    const legacy = legacyStepsTool as unknown as StepsTool;
    const active = getActiveStepsVersion(legacy);
    expect(active.version).toBe(2);
    expect(active.parameters).toEqual([]);
  });

  it("enforces parameter types and workflow resource limits", () => {
    const baseVersion = legacyStepsTool.versions[0];
    const makeTool = (version: unknown) => ({
      ...legacyStepsTool,
      versions: [version],
      activeVersion: 1,
    });
    const parameter = {
      key: "limit",
      label: "上限",
      type: "number" as const,
      required: false,
    };

    expect(ToolSchema.safeParse(makeTool({
      ...baseVersion,
      parameters: [{ ...parameter, defaultValue: "20" }],
    })).success).toBe(false);
    expect(ToolSchema.safeParse(makeTool({
      ...baseVersion,
      parameters: Array.from({ length: 51 }, (_, index) => ({
        ...parameter,
        key: `limit_${index}`,
      })),
    })).success).toBe(false);
    expect(ToolSchema.safeParse(makeTool({
      ...baseVersion,
      steps: Array.from({ length: 201 }, () => baseVersion.steps[0]),
    })).success).toBe(false);
    expect(ToolSchema.safeParse(makeTool({
      ...baseVersion,
      steps: [{ kind: "js", source: "x".repeat(65_536) }],
    })).success).toBe(false);
    expect(ToolSchema.safeParse(makeTool({
      ...baseVersion,
      steps: Array.from({ length: 180 }, (_, index) => ({
        kind: "tool",
        tool: "extractText",
        args: { selector: `#item-${index}`, payload: "x".repeat(6_000) },
      })),
    })).success).toBe(false);
  });
});

describe("workflow bindings", () => {
  it("resolves typed values, nested paths and interpolation", () => {
    const bindings = {
      page: { rows: [{ title: "耳机", price: 699 }] },
      limit: 20,
    };

    expect(resolveWorkflowValue("${page.rows}", bindings)).toEqual([
      { title: "耳机", price: 699 },
    ]);
    expect(resolveWorkflowValue("${page.rows.0.price}", bindings)).toBe(699);
    expect(resolveWorkflowValue("商品=${page.rows.0.title};limit=${limit}", bindings)).toBe(
      "商品=耳机;limit=20",
    );
    expect(resolveWorkflowValue({ items: ["${page.rows.0}"] }, bindings)).toEqual({
      items: [{ title: "耳机", price: 699 }],
    });
  });

  it("rejects missing and unsafe binding paths", () => {
    expect(() => resolveWorkflowValue("${page.missing}", { page: {} })).toThrowError(
      expect.objectContaining<Partial<WorkflowBindingError>>({ code: "binding_path_not_found" }),
    );
    expect(() => resolveWorkflowValue("${page.__proto__.polluted}", { page: {} })).toThrowError(
      expect.objectContaining<Partial<WorkflowBindingError>>({ code: "unsafe_binding_path" }),
    );
  });

  it("does not execute accessors while walking input objects", () => {
    let getterRan = false;
    const input = {} as Record<string, unknown>;
    Object.defineProperty(input, "secret", {
      enumerable: true,
      get() {
        getterRan = true;
        return "leaked";
      },
    });

    expect(() => resolveWorkflowValue(input as never, {})).toThrowError(
      expect.objectContaining<Partial<WorkflowBindingError>>({ code: "unsafe_binding_path" }),
    );
    expect(getterRan).toBe(false);
  });
});

describe("workflow analysis", () => {
  it("tracks dependencies and propagates sensitive taint", () => {
    const analysis = analyzeWorkflow({
      parameters: [
        { key: "keyword", label: "关键词", type: "string", required: true },
        { key: "secret", label: "令牌", type: "string", required: true, sensitive: true },
      ],
      steps: [
        {
          kind: "tool",
          tool: "extractText",
          args: { selector: "${keyword}" },
          bindResultTo: "page",
        },
        {
          kind: "tool",
          tool: "httpRequest",
          args: { url: "https://example.com/${page}", token: "${secret}" },
          bindResultTo: "rows",
        },
        {
          kind: "tool",
          tool: "extractText",
          args: { selector: "${rows.0.title}" },
          bindResultTo: "final",
        },
      ],
      outputBinding: "final",
    });

    expect(analysis.issues).toEqual([]);
    expect(analysis.taintedStepIndexes).toEqual([1, 2]);
    expect(analysis.taintedBindings).toEqual(["secret", "rows", "final"]);
  });

  it("reports future, duplicate and missing-output bindings", () => {
    const analysis = analyzeWorkflow({
      parameters: [],
      steps: [
        {
          kind: "tool",
          tool: "extractText",
          args: { selector: "${later}" },
          bindResultTo: "first",
        },
        { kind: "tool", tool: "extractText", args: { selector: "h1" }, bindResultTo: "later" },
        { kind: "tool", tool: "extractText", args: { selector: "h2" }, bindResultTo: "later" },
      ],
      outputBinding: "missing",
    });

    expect(analysis.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "unknown_binding", stepIndex: 0, binding: "later" }),
      expect.objectContaining({ code: "duplicate_binding", stepIndex: 2, binding: "later" }),
      expect.objectContaining({ code: "output_binding_not_found", binding: "missing" }),
    ]));
  });
});

describe("workflow inputs", () => {
  const parameters = [
    { key: "keyword", label: "关键词", type: "string" as const, required: true },
    { key: "limit", label: "上限", type: "number" as const, required: false, defaultValue: 20 },
    { key: "token", label: "令牌", type: "string" as const, required: true, sensitive: true },
  ];

  it("applies defaults and identifies sensitive bindings", () => {
    expect(prepareWorkflowInputs(parameters, { keyword: "耳机", token: "secret" })).toEqual({
      bindings: { keyword: "耳机", limit: 20, token: "secret" },
      sensitiveBindings: ["token"],
    });
  });

  it("rejects unknown, missing and wrongly typed inputs", () => {
    expect(() => prepareWorkflowInputs(parameters, {
      keyword: "耳机",
      token: "secret",
      extra: true,
    })).toThrowError(expect.objectContaining<Partial<WorkflowInputError>>({ code: "unknown_input" }));
    expect(() => prepareWorkflowInputs(parameters, { keyword: "耳机" })).toThrowError(
      expect.objectContaining<Partial<WorkflowInputError>>({ code: "missing_required_input", key: "token" }),
    );
    expect(() => prepareWorkflowInputs(parameters, { keyword: 42, token: "secret" })).toThrowError(
      expect.objectContaining<Partial<WorkflowInputError>>({ code: "input_type_mismatch", key: "keyword" }),
    );
  });
});

describe("workflow structural diff", () => {
  it("reports parameter, semantic step, move, and output changes", () => {
    const before: Parameters<typeof diffWorkflowDefinitions>[0] = {
      parameters: [
        { key: "query", label: "Query", type: "string" as const, required: true },
        { key: "legacy", label: "Legacy", type: "boolean" as const, required: false },
      ],
      steps: [
        { kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" }, bindResultTo: "title" },
        { kind: "tool" as const, tool: "click" as const, args: { selector: "#next" }, bindResultTo: "clicked" },
        { kind: "tool" as const, tool: "scroll" as const, args: { to: "bottom" } },
      ],
      outputBinding: "title",
      outputSchema: { type: "string" },
    };
    const after: Parameters<typeof diffWorkflowDefinitions>[1] = {
      parameters: [
        { key: "query", label: "Search query", type: "string" as const, required: true },
        { key: "limit", label: "Limit", type: "number" as const, required: false },
      ],
      steps: [
        before.steps[1],
        { kind: "tool", tool: "extractText", args: { selector: "h2" }, bindResultTo: "title" },
        { kind: "tool" as const, tool: "getPageInfo" as const, args: {} },
      ],
      outputBinding: undefined,
      outputSchema: { type: "object", properties: { title: { type: "string" } } },
    };

    const diff = diffWorkflowDefinitions(before, after);

    expect(diff.parameters.map((change) => [change.kind, change.key])).toEqual([
      ["modified", "query"],
      ["removed", "legacy"],
      ["added", "limit"],
    ]);
    expect(diff.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "moved", fromIndex: 1, toIndex: 0 }),
      expect.objectContaining({ kind: "modified", fromIndex: 0, toIndex: 1 }),
      expect.objectContaining({ kind: "removed", fromIndex: 2 }),
      expect.objectContaining({ kind: "added", toIndex: 2 }),
    ]));
    expect(diff.output).toMatchObject({ kind: "modified" });
  });

  it("degrades duplicate-step reordering to removed plus added", () => {
    const duplicate = { kind: "tool" as const, tool: "click" as const, args: { selector: ".item" } };
    const marker = { kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" } };
    const diff = diffWorkflowDefinitions(
      { parameters: [], steps: [duplicate, duplicate, marker], outputSchema: {} },
      { parameters: [], steps: [duplicate, marker, duplicate], outputSchema: {} },
    );

    const duplicateChanges = diff.steps.filter((change) =>
      JSON.stringify(change.before ?? change.after).includes(".item")
    );
    expect(duplicateChanges.filter((change) => change.kind === "removed")).toHaveLength(2);
    expect(duplicateChanges.filter((change) => change.kind === "added")).toHaveLength(2);
    expect(duplicateChanges.some((change) => change.kind === "moved")).toBe(false);
  });
});
