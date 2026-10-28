import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "@/sidepanel/chat/ui-store";
import { WorkflowStudioDrawer } from "@/sidepanel/drawers/workflow-studio-drawer";
import { makeEmptySession, useStore } from "@/sidepanel/chat/session-store";
import { useSettings } from "@/sidepanel/chat/settings-store";
import type { Json } from "@aipagego/shared/types";

const rpcMocks = vi.hoisted(() => ({
  getTool: vi.fn(),
  publishWorkflow: vi.fn(),
  activateWorkflow: vi.fn(),
  runDraft: vi.fn(),
  runOneStep: vi.fn(),
  startElementCapture: vi.fn(),
}));
vi.mock("@/sidepanel/rpc", () => ({ rpc: rpcMocks }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stepsTool = {
  kind: "steps" as const,
  id: "tool-1",
  name: "Workflow",
  description: "",
  urlPatterns: ["https://example.com/**"],
  steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "${query}" } }],
  outputSchema: { type: "string" },
  activeVersion: 1,
  createdAt: 1,
  updatedAt: 1,
  versions: [{
    version: 1,
    kind: "steps" as const,
    parameters: [{ key: "query", label: "Query", type: "string" as const, required: true }],
    steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "${query}" } }],
    outputSchema: { type: "string" },
    createdAt: 1
  }],
  stats: { runs: 0 }
};

describe("WorkflowStudioDrawer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let sessionRows: Record<string, unknown>;

  beforeEach(() => {
    for (const mock of Object.values(rpcMocks)) mock.mockReset();
    sessionRows = {};
    vi.stubGlobal("chrome", {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
        session: {
          get: vi.fn(async () => ({ ...sessionRows })),
          set: vi.fn(async (patch: Record<string, unknown>) => Object.assign(sessionRows, patch)),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete sessionRows[key];
          })
        }
      }
    });
    rpcMocks.getTool.mockResolvedValue(stepsTool);
    rpcMocks.publishWorkflow.mockImplementation(async (input) => ({
      ...stepsTool,
      activeVersion: 2,
      versions: [
        ...stepsTool.versions,
        {
          version: 2,
          kind: "steps",
          parameters: input.parameters,
          steps: input.steps,
          outputSchema: input.outputSchema,
          createdAt: 2,
          basedOnVersion: 1
        }
      ]
    }));
    rpcMocks.activateWorkflow.mockImplementation(async (_id, version) => ({
      ...stepsTool,
      activeVersion: version,
    }));
    rpcMocks.runDraft.mockResolvedValue({
      id: "run-1",
      toolId: null,
      toolVersion: null,
      url: "https://example.com/",
      startedAt: 1,
      finishedAt: 2,
      status: "ok",
      stepLog: [],
      output: { title: "preview", rows: Array.from({ length: 200 }, (_, index) => index) },
      source: "user"
    });
    rpcMocks.runOneStep.mockResolvedValue("single-step-output");
    rpcMocks.startElementCapture.mockResolvedValue(null);
    useStore.setState({
      currentTabId: 41,
      sessionsByTab: { 41: makeEmptySession(41, "https://example.com/") },
    });
    useSettings.setState({ loaded: true, trustedDangerTools: [], defaultPermissionMode: "default" });
    useUi.setState({ openedDrawer: "workflow", drawerSubPath: "tool-1" });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    useUi.setState({ openedDrawer: null, drawerSubPath: null });
    useStore.setState({ currentTabId: null, sessionsByTab: {} });
  });

  it("loads the active snapshot, edits only a draft, and publishes a new version", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer />));

    expect(container.textContent).toContain("Workflow Studio · Workflow");
    expect(container.textContent).toContain("当前启用 v1");
    expect((container.querySelector('input[aria-label="参数 key 1"]') as HTMLInputElement).value)
      .toBe("query");

    const duplicate = container.querySelector('button[aria-label="复制步骤 1"]') as HTMLButtonElement;
    act(() => duplicate.click());
    expect(container.querySelectorAll('[data-testid="workflow-step-row"]')).toHaveLength(2);

    const publish = container.querySelector('button[aria-label="发布工作流"]') as HTMLButtonElement;
    await act(async () => {
      publish.click();
      await Promise.resolve();
    });

    expect(rpcMocks.publishWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      id: "tool-1",
      basedOnVersion: 1,
      parameters: [expect.objectContaining({ key: "query" })],
      steps: expect.arrayContaining([expect.objectContaining({ tool: "extractText" })])
    }));
    expect(container.textContent).toContain("已发布 v2");
    expect(Object.keys(sessionRows)).toHaveLength(0);
  });

  it("removes a default immediately when a parameter becomes sensitive", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer />));
    const defaultInput = container.querySelector('input[aria-label="参数默认值 1"]') as HTMLInputElement;
    const sensitive = container.querySelector('input[aria-label="参数敏感 1"]') as HTMLInputElement;

    await act(async () => {
      setInputValue(defaultInput, "private-default");
      sensitive.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(defaultInput.disabled).toBe(true);
    expect(defaultInput.value).toBe("");
    expect(JSON.stringify(sessionRows)).not.toContain("private-default");
  });

  it("renders schema fields for ordinary tools and static-scan findings for runJS", async () => {
    const withJs = {
      ...stepsTool,
      steps: [
        { kind: "tool" as const, tool: "fillInput" as const, args: { selector: "#q", value: "hello" } },
        { kind: "js" as const, source: "return eval('1 + 1')" }
      ],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [],
        steps: [
          { kind: "tool" as const, tool: "fillInput" as const, args: { selector: "#q", value: "hello" } },
          { kind: "js" as const, source: "return eval('1 + 1')" }
        ]
      }]
    };
    rpcMocks.getTool.mockResolvedValue(withJs);
    await act(async () => root.render(<WorkflowStudioDrawer />));

    expect(container.querySelector('input[aria-label="步骤参数 selector"]')).toBeTruthy();
    expect(container.querySelector('textarea[aria-label="步骤 args JSON"]')).toBeTruthy();
    const secondRow = container.querySelectorAll('[data-testid="workflow-step-row"]')[1];
    const second = secondRow.querySelector("button") as HTMLButtonElement;
    act(() => second.click());
    expect(container.textContent).toContain("静态扫描");
    expect(container.textContent).toContain("uses-eval");
    expect(container.querySelector('textarea[aria-label="runJS source"]')).toBeTruthy();
  });

  it("tests the draft on the tab captured at open and keeps run values out of session storage", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    const runInput = container.querySelector('input[aria-label="试运行参数 query"]') as HTMLInputElement;
    act(() => setInputValue(runInput, "private-run-value"));
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={99} />));

    const run = container.querySelector('button[aria-label="测试完整工作流"]') as HTMLButtonElement;
    await act(async () => {
      run.click();
      await Promise.resolve();
    });

    expect(rpcMocks.runDraft).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "steps", parameters: [expect.objectContaining({ key: "query" })] }),
      41,
      { query: "private-run-value" }
    );
    expect(container.textContent).toContain("preview");
    expect(JSON.stringify(sessionRows)).not.toContain("private-run-value");
    expect(JSON.stringify(sessionRows)).not.toContain("preview");
  });

  it("tests one safe step on the tab captured when Studio opened without creating a run", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    const runInput = container.querySelector('input[aria-label="试运行参数 query"]') as HTMLInputElement;
    act(() => setInputValue(runInput, "h1"));
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={99} />));

    const testStep = container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement;
    expect(testStep).toBeTruthy();
    await act(async () => {
      testStep.click();
      await Promise.resolve();
    });

    expect(rpcMocks.runOneStep).toHaveBeenCalledWith({
      step: expect.objectContaining({
        kind: "tool",
        tool: "extractText",
        args: { selector: "h1" },
      }),
      tabId: 41,
      bindings: { query: "h1" },
    });
    expect(rpcMocks.runDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("single-step-output");
  });

  it("captures the new tab when the same workflow is closed and reopened", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    await act(async () => useUi.getState().close());
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={99} />));
    await act(async () => useUi.getState().open("workflow", "tool-1"));

    const runInput = container.querySelector('input[aria-label="试运行参数 query"]') as HTMLInputElement;
    act(() => setInputValue(runInput, "h1"));
    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.runOneStep).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 99,
    }));
  });

  it("reloads the same tool on reopen and surfaces an active-version conflict", async () => {
    const activeV2 = {
      ...stepsTool,
      activeVersion: 2,
      versions: [
        stepsTool.versions[0],
        {
          ...stepsTool.versions[0],
          version: 2,
          steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
          createdAt: 2,
          basedOnVersion: 1,
        },
      ],
    };
    rpcMocks.getTool
      .mockResolvedValueOnce(stepsTool)
      .mockResolvedValueOnce(activeV2);
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    await act(async () => useUi.getState().close());
    await act(async () => useUi.getState().open("workflow", "tool-1"));

    expect(rpcMocks.getTool).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("冲突草稿已保留");
    expect(container.textContent).toContain("草稿基于 v1，当前启用 v2");
  });

  it("lists missing upstream bindings and only runs predecessors after explicit testing", async () => {
    const chainedTool = {
      ...stepsTool,
      steps: [
        { kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" }, bindResultTo: "page" },
        { kind: "tool" as const, tool: "getPageInfo" as const, args: {}, bindResultTo: "meta" },
        { kind: "tool" as const, tool: "extractText" as const, args: { selector: "${page.selector}", root: "${meta.root}" }, bindResultTo: "result" },
      ],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [],
        steps: [
          { kind: "tool" as const, tool: "extractText" as const, args: { selector: "h1" }, bindResultTo: "page" },
          { kind: "tool" as const, tool: "getPageInfo" as const, args: {}, bindResultTo: "meta" },
          { kind: "tool" as const, tool: "extractText" as const, args: { selector: "${page.selector}", root: "${meta.root}" }, bindResultTo: "result" },
        ],
      }],
    };
    rpcMocks.getTool.mockResolvedValue(chainedTool);
    rpcMocks.runOneStep
      .mockResolvedValueOnce({ selector: ".article" })
      .mockResolvedValueOnce({ root: "#content" })
      .mockResolvedValueOnce("article text");
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));

    const third = container.querySelector('button[aria-label="测试步骤 3"]') as HTMLButtonElement;
    await act(async () => third.click());

    expect(rpcMocks.runOneStep).not.toHaveBeenCalled();
    expect(container.textContent).toContain("缺少上游 binding: page.selector");
    expect(container.textContent).toContain("meta.root");
    expect(container.textContent).toContain("最早需要测试步骤 1");

    const first = container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement;
    await act(async () => {
      first.click();
      await Promise.resolve();
    });
    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 2"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      third.click();
      await Promise.resolve();
    });

    expect(rpcMocks.runOneStep).toHaveBeenNthCalledWith(3, expect.objectContaining({
      step: expect.objectContaining({ args: { selector: ".article", root: "#content" } }),
      bindings: expect.objectContaining({
        page: { selector: ".article" },
        meta: { root: "#content" },
      }),
    }));
    expect(container.textContent).toContain("article text");
  });

  it("classifies resolved dangerous args and supports deny, skip, approve, and always allow", async () => {
    const dangerousTool = {
      ...stepsTool,
      steps: [{
        kind: "tool" as const,
        tool: "httpRequest" as const,
        args: { url: "https://example.com/api", withCredentials: "${credentialed}" },
      }],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [{ key: "credentialed", label: "Credentialed", type: "boolean" as const, required: true }],
        steps: [{
          kind: "tool" as const,
          tool: "httpRequest" as const,
          args: { url: "https://example.com/api", withCredentials: "${credentialed}" },
        }],
      }],
    };
    rpcMocks.getTool.mockResolvedValue(dangerousTool);
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    const credentialed = container.querySelector('select[aria-label="试运行参数 credentialed"]') as HTMLSelectElement;
    act(() => setSelectValue(credentialed, "true"));

    const testStep = container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement;
    await act(async () => testStep.click());
    expect(container.textContent).toContain("危险操作需要确认");
    expect(container.textContent).toContain("dangerous");
    expect(rpcMocks.runOneStep).not.toHaveBeenCalled();

    const deny = container.querySelector('button[aria-label="拒绝步骤 1"]') as HTMLButtonElement;
    await act(async () => deny.click());
    expect(container.textContent).toContain("已拒绝");
    expect(rpcMocks.runOneStep).not.toHaveBeenCalled();

    await act(async () => testStep.click());
    const skip = container.querySelector('button[aria-label="跳过步骤 1"]') as HTMLButtonElement;
    await act(async () => skip.click());
    expect(container.textContent).toContain("已跳过");
    expect(rpcMocks.runOneStep).not.toHaveBeenCalled();

    await act(async () => testStep.click());
    const approve = container.querySelector('button[aria-label="批准步骤 1"]') as HTMLButtonElement;
    await act(async () => {
      approve.click();
      await Promise.resolve();
    });
    expect(rpcMocks.runOneStep).toHaveBeenCalledTimes(1);

    await act(async () => testStep.click());
    const alwaysAllow = container.querySelector('button[aria-label="始终允许步骤 1"]') as HTMLButtonElement;
    await act(async () => {
      alwaysAllow.click();
      await Promise.resolve();
    });
    expect(rpcMocks.runOneStep).toHaveBeenCalledTimes(2);
    expect(useSettings.getState().trustedDangerTools).toContain("httpRequest");
  });

  it("requires explicit approval before testing a full workflow with dangerous steps", async () => {
    const dangerousWorkflow = {
      ...stepsTool,
      activeVersion: 1,
      versions: [{
        ...stepsTool.versions[0],
        parameters: [],
        steps: [
          { kind: "tool" as const, tool: "getPageInfo" as const, args: {}, bindResultTo: "page" },
          {
            kind: "tool" as const,
            tool: "httpRequest" as const,
            args: { url: "https://example.com/private", withCredentials: "${page.credentialed}" },
          },
        ],
      }],
    };
    rpcMocks.getTool.mockResolvedValue(dangerousWorkflow);
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));

    await act(async () => {
      (container.querySelector('button[aria-label="测试完整工作流"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.runDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("完整工作流包含危险操作");

    await act(async () => {
      (container.querySelector('button[aria-label="批准完整工作流"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.runDraft).toHaveBeenCalledOnce();
  });

  it("requires approval for caution in read mode and surfaces dangerous runJS findings", async () => {
    useStore.setState({
      currentTabId: 99,
      sessionsByTab: {
        41: { ...makeEmptySession(41, "https://example.com/"), permissionMode: "read" },
        99: { ...makeEmptySession(99, "https://other.example/"), permissionMode: "yolo" },
      },
    });
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      steps: [
        { kind: "tool", tool: "click", args: { selector: "#submit" } },
        { kind: "js", source: "return eval('document.cookie')" },
      ],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [],
        steps: [
          { kind: "tool", tool: "click", args: { selector: "#submit" } },
          { kind: "js", source: "return eval('document.cookie')" },
        ],
      }],
    });
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));

    await act(async () => (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("caution");
    expect(rpcMocks.runOneStep).not.toHaveBeenCalled();
    await act(async () => {
      (container.querySelector('button[aria-label="批准步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    const secondRow = container.querySelectorAll('[data-testid="workflow-step-row"]')[1];
    act(() => (secondRow.querySelector("button") as HTMLButtonElement).click());
    await act(async () => (container.querySelector('button[aria-label="测试步骤 2"]') as HTMLButtonElement).click());
    expect(container.textContent).toContain("dangerous");
    expect(container.textContent).toContain("uses-eval");
    expect(rpcMocks.runOneStep).toHaveBeenCalledTimes(1);
  });

  it("uses sensitive values in memory but redacts single-step input, output, and errors", async () => {
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "${token}" } }],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [{ key: "token", label: "Token", type: "string", required: true, sensitive: true }],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: "${token}" } }],
      }],
    });
    rpcMocks.runOneStep.mockResolvedValue({ echoed: "s3cr3t" });
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    act(() => setInputValue(
      container.querySelector('input[aria-label="试运行参数 token"]') as HTMLInputElement,
      "s3cr3t",
    ));

    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.runOneStep).toHaveBeenCalledWith(expect.objectContaining({
      step: expect.objectContaining({ args: { selector: "s3cr3t" } }),
      bindings: { token: "s3cr3t" },
    }));
    expect(container.textContent).toContain("输入：[已脱敏]");
    expect(container.textContent).toContain("输出：[已脱敏]");
    expect(container.textContent).not.toContain("s3cr3t");

    rpcMocks.runOneStep.mockRejectedValueOnce(new Error("request failed with s3cr3t"));
    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("错误：[已脱敏]");
    expect(container.textContent).not.toContain("request failed with s3cr3t");
  });

  it("does not capture page DOM for an AI repair handoff from a sensitive step", async () => {
    const onFixWithAi = vi.fn();
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      versions: [{
        ...stepsTool.versions[0],
        parameters: [{ key: "token", label: "Token", type: "string", required: true, sensitive: true }],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: "${token}" } }],
      }],
    });
    rpcMocks.runOneStep
      .mockRejectedValueOnce(new Error("request failed with s3cr3t"))
      .mockResolvedValueOnce({ html: "page contains s3cr3t" });
    await act(async () => root.render(
      <WorkflowStudioDrawer currentTabId={41} onFixWithAi={onFixWithAi} />
    ));
    act(() => setInputValue(
      container.querySelector('input[aria-label="试运行参数 token"]') as HTMLInputElement,
      "s3cr3t",
    ));

    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    await act(async () => {
      (container.querySelector('button[aria-label="让 AI 修复步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.runOneStep).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onFixWithAi.mock.calls[0]?.[0])).not.toContain("s3cr3t");
    expect(onFixWithAi.mock.calls[0]?.[0]?.initialContext).toContain("已脱敏");
  });

  it("clears test inputs, bindings, and page results when the Studio session closes", async () => {
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      steps: [{ kind: "tool", tool: "extractText", args: { selector: "${token}" }, bindResultTo: "page" }],
      versions: [{
        ...stepsTool.versions[0],
        parameters: [{ key: "token", label: "Token", type: "string", required: true, sensitive: true }],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: "${token}" }, bindResultTo: "page" }],
      }],
    });
    rpcMocks.runOneStep.mockResolvedValue({ echoed: "session-secret" });
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    const input = container.querySelector('input[aria-label="试运行参数 token"]') as HTMLInputElement;
    act(() => setInputValue(input, "session-secret"));
    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    await act(async () => useUi.getState().close());
    await act(async () => useUi.getState().open("workflow", "tool-1"));

    const reopened = container.querySelector('input[aria-label="试运行参数 token"]') as HTMLInputElement;
    expect(reopened.value).toBe("");
    expect(container.textContent).not.toContain("测试成功");
    expect(container.textContent).not.toContain("session-secret");
  });

  it("shows a forbidden state and offers fixed-tab reselect and bounded AI repair handoff", async () => {
    const onFixWithAi = vi.fn();
    rpcMocks.runOneStep
      .mockRejectedValueOnce(new Error("Content script 无法注入到此页面（可能是 chrome:// 或受限页面）"))
      .mockResolvedValueOnce({ html: "x".repeat(12_000) });
    await act(async () => root.render(
      <WorkflowStudioDrawer currentTabId={41} onFixWithAi={onFixWithAi} />
    ));

    await act(async () => {
      (container.querySelector('button[aria-label="测试步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("页面受限");

    await act(async () => {
      (container.querySelector('button[aria-label="重新圈选步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(rpcMocks.startElementCapture).toHaveBeenCalledWith(41);

    await act(async () => {
      (container.querySelector('button[aria-label="让 AI 修复步骤 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(onFixWithAi).toHaveBeenCalledWith(expect.objectContaining({ tabId: 41 }));
    const handoff = onFixWithAi.mock.calls[0][0] as { initialPrompt: string; initialContext: string };
    expect(handoff.initialPrompt).toContain("修复草稿工作流的第 1 步");
    expect(handoff.initialContext.length).toBeLessThan(10_000);
  });

  it("compares draft/base or arbitrary published versions and activates by pointer", async () => {
    const versioned = {
      ...stepsTool,
      activeVersion: 2,
      steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
      versions: [
        stepsTool.versions[0],
        {
          version: 2,
          kind: "steps" as const,
          parameters: [{ key: "query", label: "Search query", type: "string" as const, required: true }],
          steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
          outputSchema: { type: "object" },
          createdAt: 2,
          basedOnVersion: 1,
        },
      ],
    };
    rpcMocks.getTool.mockResolvedValue(versioned);
    rpcMocks.activateWorkflow.mockResolvedValue({ ...versioned, activeVersion: 1 });
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));

    expect((container.querySelector('select[aria-label="差异左侧版本"]') as HTMLSelectElement).value).toBe("2");
    expect((container.querySelector('select[aria-label="差异右侧版本"]') as HTMLSelectElement).value).toBe("draft");
    expect(container.textContent).toContain("无结构变化");

    await act(async () => setSelectValue(
      container.querySelector('select[aria-label="差异左侧版本"]') as HTMLSelectElement,
      "1",
    ));
    await act(async () => setSelectValue(
      container.querySelector('select[aria-label="差异右侧版本"]') as HTMLSelectElement,
      "2",
    ));
    expect(container.textContent).toContain("参数 modified: query");
    expect(container.textContent).toContain("步骤 modified: #1 → #1");
    expect(container.textContent).toContain("输出 modified");

    await act(async () => {
      (container.querySelector('button[aria-label="启用版本 1"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(rpcMocks.activateWorkflow).toHaveBeenCalledWith("tool-1", 1);
    expect(container.textContent).toContain("当前启用 v1");
    expect(versioned.versions).toHaveLength(2);
  });

  it("preserves a conflicting draft, offers a diff, and rebases only after explicit confirmation", async () => {
    sessionRows["aipagego.workflowDraft:tool-1:1"] = {
      toolId: "tool-1",
      basedOnVersion: 1,
      parameters: [],
      steps: [{ kind: "tool", tool: "extractText", args: { selector: ".draft-copy" } }],
      outputSchema: { type: "string" },
    };
    const activeV2 = {
      ...stepsTool,
      activeVersion: 2,
      steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
      versions: [
        stepsTool.versions[0],
        {
          version: 2,
          kind: "steps" as const,
          parameters: [],
          steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
          outputSchema: { type: "string" },
          createdAt: 2,
          basedOnVersion: 1,
        },
      ],
    };
    rpcMocks.getTool.mockResolvedValue(activeV2);
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));

    expect(container.textContent).toContain("冲突草稿已保留");
    expect(container.textContent).toContain(".draft-copy");
    expect(rpcMocks.publishWorkflow).not.toHaveBeenCalled();

    const rebase = container.querySelector('button[aria-label="以当前启用版本为新基线"]') as HTMLButtonElement;
    await act(async () => {
      rebase.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("草稿已改以 v2 为发布基线");
    expect(sessionRows["aipagego.workflowDraft:tool-1:1"]).toBeUndefined();
    expect(sessionRows["aipagego.workflowDraft:tool-1:2"]).toMatchObject({
      basedOnVersion: 2,
      steps: [expect.objectContaining({ args: { selector: ".draft-copy" } })],
    });
  });

  it("refreshes the active history after a publish conflict while keeping the draft", async () => {
    const activeV2 = {
      ...stepsTool,
      activeVersion: 2,
      versions: [
        stepsTool.versions[0],
        {
          version: 2,
          kind: "steps" as const,
          parameters: [],
          steps: [{ kind: "tool" as const, tool: "extractText" as const, args: { selector: "h2" } }],
          outputSchema: { type: "string" },
          createdAt: 2,
          basedOnVersion: 1,
        },
      ],
    };
    rpcMocks.getTool
      .mockResolvedValueOnce(stepsTool)
      .mockResolvedValueOnce(activeV2);
    rpcMocks.publishWorkflow.mockRejectedValueOnce(
      new Error("workflow_version_conflict: expected 1, active 2"),
    );
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    act(() => setInputValue(
      container.querySelector('input[aria-label="步骤参数 selector"]') as HTMLInputElement,
      ".draft-selector",
    ));

    await act(async () => {
      (container.querySelector('button[aria-label="发布工作流"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.getTool).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("草稿基于 v1，当前启用 v2");
    expect(container.textContent).toContain(".draft-selector");
  });

  it("explains loading and load-error states", async () => {
    let rejectLoad!: (reason: unknown) => void;
    rpcMocks.getTool.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectLoad = reject;
    }));
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    expect(container.textContent).toContain("正在加载工作流");

    await act(async () => rejectLoad(new Error("storage unavailable")));
    expect(container.textContent).toContain("无法打开 Workflow Studio");
    expect(container.textContent).toContain("storage unavailable");
  });

  it("shows actionable empty and large workflow states", async () => {
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    await act(async () => {
      (container.querySelector('button[aria-label="删除步骤 1"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("这个工具还没有工作流步骤");
    expect(container.textContent).toContain("＋ Tool");

    await act(async () => root.unmount());
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      steps: Array.from({ length: 51 }, (_, index) => ({
        kind: "tool" as const,
        tool: "extractText" as const,
        args: { selector: `#item-${index}` },
      })),
      versions: [{
        ...stepsTool.versions[0],
        parameters: [],
        steps: Array.from({ length: 51 }, (_, index) => ({
          kind: "tool" as const,
          tool: "extractText" as const,
          args: { selector: `#item-${index}` },
        })),
      }],
    });
    await act(async () => root.render(<WorkflowStudioDrawer currentTabId={41} />));
    expect(container.textContent).toContain("大型工作流");
    expect(container.textContent).toContain("51 steps");
  });

  it("keeps a Collect Studio recipe update in the current draft until publish", async () => {
    const recipe = {
      version: 1 as const,
      mode: "single" as const,
      fields: [{ id: "title", name: "标题", selector: "h1", valueMode: "text" as const, required: true }],
      pagination: { kind: "single" as const },
      dedupeBy: [],
      maxRows: 100,
      maxBytes: 5 * 1024 * 1024
    };
    rpcMocks.getTool.mockResolvedValue({
      ...stepsTool,
      steps: [{ kind: "tool", tool: "collectStructuredData", args: { recipe } }],
      versions: [{ ...stepsTool.versions[0], parameters: [], steps: [{ kind: "tool", tool: "collectStructuredData", args: { recipe } }] }]
    });
    let edit: { recipe: Json; apply: (recipe: Json) => void } | undefined;
    await act(async () => root.render(
      <WorkflowStudioDrawer onEditCollection={(input) => { edit = input; }} />
    ));

    const openCollect = [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("在 Collect Studio 编辑")) as HTMLButtonElement;
    act(() => openCollect.click());
    expect(edit?.recipe).toMatchObject({ mode: "single" });

    const updatedRecipe = {
      ...recipe,
      fields: [{ ...recipe.fields[0], selector: ".updated-title" }]
    };
    await act(async () => {
      useUi.getState().open("collect");
      edit?.apply(updatedRecipe);
      useUi.getState().open("workflow", "tool-1");
      await Promise.resolve();
    });
    const publish = container.querySelector('button[aria-label="发布工作流"]') as HTMLButtonElement;
    await act(async () => {
      publish.click();
      await Promise.resolve();
    });

    expect(rpcMocks.getTool).toHaveBeenCalledTimes(1);
    expect(rpcMocks.publishWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({
        tool: "collectStructuredData",
        args: { recipe: expect.objectContaining({
          fields: [expect.objectContaining({ selector: ".updated-title" })]
        }) }
      })]
    }));
  });
});

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
