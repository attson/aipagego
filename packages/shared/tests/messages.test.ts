import { describe, expect, it } from "vitest";
import { ContentRequest, RpcRequest, ToolDraftSchema, ToolSchema } from "../src/messages";

const base = {
  id: "tool-1",
  name: "采集商品",
  urlPatterns: ["https://example.com/**"],
  description: "采集当前页面",
  createdAt: 1,
  updatedAt: 1,
  stats: { runs: 0 }
};

describe("tool schemas", () => {
  it("accepts prompt tool drafts", () => {
    const parsed = ToolDraftSchema.parse({
      kind: "prompt",
      name: "智能采集",
      urlPatterns: ["https://example.com/**"],
      description: "让 AI 根据当前页面采集",
      prompt: "请读取当前页面并返回 JSON"
    });
    expect(parsed.kind).toBe("prompt");
    if (parsed.kind !== "prompt") throw new Error("expected prompt draft");
    expect(parsed.prompt).toContain("JSON");
  });

  it("accepts steps tool drafts", () => {
    const parsed = ToolDraftSchema.parse({
      kind: "steps",
      name: "固定采集",
      urlPatterns: ["https://example.com/**"],
      description: "固定提取 h1",
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "h1" } }],
      outputSchema: {}
    });
    expect(parsed.kind).toBe("steps");
    if (parsed.kind !== "steps") throw new Error("expected steps draft");
    expect(parsed.steps).toHaveLength(1);
  });

  it("accepts a replayable structured collection step and rejects unknown tools", () => {
    const recipe = {
      version: 1,
      mode: "single",
      fields: [
        { id: "title", name: "标题", selector: "h1", valueMode: "text", required: true }
      ],
      pagination: { kind: "single" },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024
    };
    const draft = {
      kind: "steps",
      name: "固化采集",
      urlPatterns: ["https://example.com/**"],
      description: "无 LLM 重放",
      steps: [{
        kind: "tool",
        tool: "collectStructuredData",
        args: { recipe },
        timeoutMs: 600_000
      }],
      outputSchema: { type: "object" }
    };

    expect(ToolDraftSchema.safeParse(draft).success).toBe(true);
    expect(ToolDraftSchema.safeParse({
      ...draft,
      steps: [{ kind: "tool", tool: "unknownCollectionTool", args: { recipe } }]
    }).success).toBe(false);
  });

  it("rejects old drafts without kind", () => {
    expect(() =>
      ToolDraftSchema.parse({
        name: "旧工具",
        urlPatterns: ["https://example.com/**"],
        description: "old",
        steps: [{ kind: "tool", tool: "snapshotDOM", args: {} }],
        outputSchema: {}
      })
    ).toThrow();
  });

  it("accepts prompt and steps persisted tools", () => {
    expect(
      ToolSchema.parse({
        ...base,
        kind: "prompt",
        prompt: "请总结当前页",
        versions: [{ version: 1, kind: "prompt", prompt: "请总结当前页", createdAt: 1 }]
      }).kind
    ).toBe("prompt");

    expect(
      ToolSchema.parse({
        ...base,
        kind: "steps",
        steps: [{ kind: "js", source: "return { ok: true };" }],
        outputSchema: {},
        versions: [
          {
            version: 1,
            kind: "steps",
            steps: [{ kind: "js", source: "return { ok: true };" }],
            outputSchema: {},
            createdAt: 1
          }
        ]
      }).kind
    ).toBe("steps");
  });
});

describe("multi-tab RPC variants", () => {
  it("tabs.list with optional windowId", () => {
    expect(RpcRequest.safeParse({ type: "tabs.list" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "tabs.list", windowId: 1 }).success).toBe(true);
  });

  it("tabs.open requires url", () => {
    expect(RpcRequest.safeParse({ type: "tabs.open", url: "https://x.com" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "tabs.open" }).success).toBe(false);
    expect(RpcRequest.safeParse({ type: "tabs.open", url: "https://x", active: true }).success).toBe(true);
  });

  it("runs.runOneStep accepts attachedTabIds (defaults to [])", () => {
    const ok = RpcRequest.safeParse({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: {} },
      tabId: 1
    });
    expect(ok.success).toBe(true);
    if (!ok.success) throw new Error("expected success");
    if (ok.data.type !== "runs.runOneStep") throw new Error("expected runs.runOneStep");
    expect(ok.data.attachedTabIds).toEqual([]);
    const ok2 = RpcRequest.safeParse({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: {} },
      tabId: 1,
      attachedTabIds: [167]
    });
    expect(ok2.success).toBe(true);
  });

  it("runs.runOneStep accepts page context index tool steps", () => {
    for (const tool of [
      "createPageIndex",
      "searchPageIndex",
      "readPageBlock",
      "extractPageFields"
    ]) {
      expect(
        RpcRequest.safeParse({
          type: "runs.runOneStep",
          step: { kind: "tool", tool, args: {} },
          tabId: 1
        }).success
      ).toBe(true);
    }
  });

  it("elementCapture.start requires a tabId", () => {
    expect(RpcRequest.safeParse({ type: "elementCapture.start", tabId: 1 }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "elementCapture.start" }).success).toBe(false);
  });

  it("preserves pending optional-permission details in widget sidepanel handoff", () => {
    const parsed = RpcRequest.parse({
      type: "widget.openSidepanel",
      tabId: 42,
      pendingPermission: {
        toolUseId: "history-1",
        code: "permission_required",
        permission: "history",
        capability: "searchHistory",
        requestable: true,
      },
    });

    expect(parsed).toMatchObject({
      type: "widget.openSidepanel",
      tabId: 42,
      pendingPermission: {
        toolUseId: "history-1",
        permission: "history",
        capability: "searchHistory",
      },
    });
  });
});

describe("connector RPC variants", () => {
  it("accepts explicit write-only connector CRUD and test requests", () => {
    const draft = {
      name: "Orders",
      kind: "webhook" as const,
      credentialMode: "persistent" as const,
      secret: {
        action: "replace" as const,
        url: "https://hooks.example.com/private?token=hidden",
        headers: { Authorization: "Bearer hidden" },
      },
    };
    expect(RpcRequest.safeParse({ type: "connectors.save", draft }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "connectors.save", id: "c-1", draft: {
      ...draft, secret: { action: "keep" },
    } }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "connectors.list" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "connectors.get", id: "c-1" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "connectors.test", id: "c-1" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "connectors.delete", id: "c-1" }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "connectors.save",
      draft: {
        name: "CRM Base",
        kind: "feishu_base",
        credentialMode: "persistent",
        publicConfig: {
          region: "feishu",
          appToken: "app-token",
          tableId: "table-id",
          fieldMapping: { title: "标题" },
        },
        secret: { action: "replace", appId: "cli_123", appSecret: "hidden" },
      },
    }).success).toBe(true);
  });
});

describe("secure share RPC variants", () => {
  it("accepts a named non-empty unique tool selection", () => {
    expect(RpcRequest.safeParse({
      type: "tools.share.export",
      toolIds: ["tool-1", "tool-2"],
      name: "Research kit",
      description: "Portable tools",
    }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "tools.share.export",
      toolIds: [],
      name: "Empty",
    }).success).toBe(false);
    expect(RpcRequest.safeParse({
      type: "tools.share.export",
      toolIds: ["tool-1", "tool-1"],
      name: "Duplicate",
    }).success).toBe(false);
  });

  it("validates two-phase import preview and commit envelopes", () => {
    expect(RpcRequest.safeParse({
      type: "tools.import.preview",
      bundle: { schema: "aipagego.tools/v3", tools: [] },
    }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "tools.import.commit",
      bundle: { schema: "aipagego.tools/v3", tools: [] },
      digest: "a".repeat(64),
      decisions: [{ index: 0, action: "copy" }],
      approveDangerous: true,
    }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "tools.import.commit",
      bundle: {},
      digest: "not-a-digest",
      decisions: [{ index: 0, action: "replace" }],
    }).success).toBe(false);
  });
});

describe("workflow RPC variants", () => {
  it("validates version activation targets", () => {
    expect(RpcRequest.safeParse({
      type: "workflows.activate",
      id: "tool-1",
      version: 2,
    }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "workflows.activate",
      id: "tool-1",
      version: 0,
    }).success).toBe(false);
  });
});

describe("collection RPC variants", () => {
  const recipe = {
    version: 1,
    mode: "single",
    fields: [
      { id: "title", name: "标题", selector: "h1", valueMode: "text", required: true },
    ],
    pagination: { kind: "single" },
    dedupeBy: [],
    maxRows: 2_000,
    maxBytes: 5 * 1024 * 1024,
  };

  it("validates start, get, cancel and paged result reads", () => {
    expect(RpcRequest.safeParse({ type: "collections.start", tabId: 8, recipe }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "collections.runs.get", runId: "run-1" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "collections.cancel", runId: "run-1" }).success).toBe(true);
    expect(RpcRequest.safeParse({
      type: "collections.results.read",
      resultId: "result-1",
      offset: 0,
      limit: 100,
    }).success).toBe(true);
  });

  it("rejects invalid result page bounds", () => {
    expect(RpcRequest.safeParse({
      type: "collections.results.read",
      resultId: "result-1",
      offset: -1,
      limit: 100,
    }).success).toBe(false);
    expect(RpcRequest.safeParse({
      type: "collections.results.read",
      resultId: "result-1",
      offset: 0,
      limit: 501,
    }).success).toBe(false);
  });

  it("validates configured load-more and infinite-scroll content actions", () => {
    expect(ContentRequest.safeParse({
      type: "content.collectionAdvanceDynamic",
      action: { kind: "loadMore", selector: ".more" },
    }).success).toBe(true);
    expect(ContentRequest.safeParse({
      type: "content.collectionAdvanceDynamic",
      action: { kind: "infiniteScroll" },
    }).success).toBe(true);
    expect(ContentRequest.safeParse({
      type: "content.collectionAdvanceDynamic",
      action: { kind: "loadMore", selector: "" },
    }).success).toBe(false);
  });
});
