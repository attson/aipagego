import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "@/sidepanel/chat/ui-store";
import { CollectStudioDrawer } from "@/sidepanel/drawers/collect-studio-drawer";

const rpcMocks = vi.hoisted(() => ({
  previewCollection: vi.fn(),
  startCollection: vi.fn(),
  getCollectionRun: vi.fn(),
  cancelCollection: vi.fn(async () => null),
  readCollectionResult: vi.fn(),
  runOneStep: vi.fn(),
  saveTool: vi.fn(),
  startElementCapture: vi.fn(async () => null),
  listConnectors: vi.fn(),
  createDelivery: vi.fn(),
}));
const recommendationMocks = vi.hoisted(() => ({
  recommendCollectionRecipe: vi.fn(),
}));
const permissionMocks = vi.hoisted(() => ({
  requestOptionalPermission: vi.fn(),
}));
const downloadMock = vi.hoisted(() => vi.fn(async () => 77));

vi.mock("@/sidepanel/rpc", () => ({ rpc: rpcMocks }));
vi.mock("@/sidepanel/llm/collection-recipe-generator", () => recommendationMocks);
vi.mock("@/permissions/optional-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/permissions/optional-permissions")>(),
  requestOptionalPermission: permissionMocks.requestOptionalPermission,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("CollectStudioDrawer", () => {
  let root: Root;
  let container: HTMLDivElement;
  let listeners: Array<(message: unknown) => void>;

  beforeEach(() => {
    listeners = [];
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => listeners.push(listener)),
          removeListener: vi.fn((listener: (message: unknown) => void) => {
            listeners = listeners.filter((candidate) => candidate !== listener);
          }),
        },
      },
      downloads: { download: downloadMock },
    });
    permissionMocks.requestOptionalPermission.mockResolvedValue({ granted: true });
    useUi.setState({ openedDrawer: "collect", drawerSubPath: null } as never);
    rpcMocks.previewCollection.mockResolvedValue({
      rows: [{ values: { field_1: "示例标题" }, missingRequired: [], duplicate: false }],
      matchedCount: 1,
      returnedCount: 1,
      uniqueCount: 1,
      duplicateCount: 0,
      missingRequiredCount: 0,
      truncated: false,
    });
    rpcMocks.startCollection.mockResolvedValue({ runId: "run-1" });
    rpcMocks.getCollectionRun.mockResolvedValue({
      runId: "run-1",
      resultId: "result-1",
      tabId: 41,
      sourceUrl: "https://one.example/item",
      recipe: {
        version: 1,
        mode: "single",
        fields: [{ id: "field_1", name: "字段 1", selector: "h1", valueMode: "text", required: true }],
        pagination: { kind: "single" },
        dedupeBy: [],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
      status: "completed",
      phase: "completed",
      rowCount: 2,
      byteSize: 48,
      pageCount: 1,
      duplicateCount: 0,
      missingRequiredCount: 0,
      startedAt: 1,
      finishedAt: 2,
      stopReason: "completed",
      summary: {
        runId: "run-1",
        resultId: "result-1",
        sourceUrl: "https://one.example/item",
        status: "completed",
        stopReason: "completed",
        rowCount: 2,
        byteSize: 48,
        pageCount: 1,
        duplicateCount: 0,
        missingRequiredCount: 0,
        preview: [{ field_1: "商品 A" }, { field_1: "商品 B" }],
        startedAt: 1,
        finishedAt: 2,
      },
    });
    rpcMocks.readCollectionResult.mockResolvedValue({
      rows: [{ field_1: "商品 A" }, { field_1: "商品 B" }],
      hasMore: false,
      nextOffset: null,
    });
    rpcMocks.saveTool.mockResolvedValue({ id: "saved-collection-tool", name: "商品列表采集" });
    rpcMocks.listConnectors.mockResolvedValue([{
      id: "connector-1",
      name: "Orders webhook",
      kind: "webhook",
      publicConfig: {
        kind: "webhook",
        method: "POST",
        endpointOrigin: "https://hooks.example.com",
        headerCount: 1,
      },
      credentialMode: "persistent",
      credentialConfigured: true,
      status: "ready",
      configHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 2,
    }]);
    rpcMocks.createDelivery.mockResolvedValue({
      id: "delivery-1",
      connectorId: "connector-1",
      connectorConfigHash: "a".repeat(64),
      source: { kind: "collection_result", resultId: "result-1" },
      status: "ok",
      attempt: 1,
      nextOffset: 2,
      rowCount: 2,
      sentCount: 2,
      byteSize: 48,
      createdAt: 3,
      startedAt: 4,
      finishedAt: 5,
    });
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
  });

  it("previews the tab captured when the drawer opened", async () => {
    await act(async () => root.render(<CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />));
    await act(async () => root.render(<CollectStudioDrawer currentTabId={99} currentUrl="https://two.example/item" />));

    const previewButton = container.querySelector('button[aria-label="刷新预览"]') as HTMLButtonElement;
    await act(async () => {
      previewButton.click();
      await Promise.resolve();
    });

    expect(rpcMocks.previewCollection).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 41,
      recipe: expect.objectContaining({ mode: "single", version: 1 }),
    }));
    expect(container.textContent).toContain("示例标题");
    expect(container.textContent).toContain("1 条样例");
  });

  it("applies an edited recipe back to a workflow draft without saving a tool", async () => {
    const onApply = vi.fn();
    const onCancel = vi.fn();
    await act(async () => root.render(
      <CollectStudioDrawer
        currentTabId={41}
        currentUrl="https://one.example/item"
        workflowEdit={{
          recipe: {
            version: 1,
            mode: "list",
            itemSelector: ".product",
            fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text", required: true }],
            pagination: { kind: "single" },
            dedupeBy: ["title"],
            maxRows: 100,
            maxBytes: 5 * 1024 * 1024
          },
          onApply,
          onCancel
        }}
      />
    ));

    expect((container.querySelector('input[aria-label="列表项选择器"]') as HTMLInputElement).value)
      .toBe(".product");
    const apply = container.querySelector('button[aria-label="应用到工作流草稿"]') as HTMLButtonElement;
    expect(apply).toBeTruthy();
    await act(async () => apply.click());

    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({
      mode: "list",
      itemSelector: ".product",
      fields: [expect.objectContaining({ id: "title", selector: ".title" })]
    }));
    expect(rpcMocks.saveTool).not.toHaveBeenCalled();
  });

  it("edits list fields and routes capture results into the selected selector", async () => {
    await act(async () => root.render(<CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />));

    const listMode = container.querySelector('button[aria-label="列表模式"]') as HTMLButtonElement;
    await act(async () => listMode.click());
    expect(container.querySelector('input[aria-label="列表项选择器"]')).toBeTruthy();

    const add = container.querySelector('button[aria-label="添加字段"]') as HTMLButtonElement;
    await act(async () => add.click());
    expect(container.querySelectorAll('input[aria-label^="字段名称"]')).toHaveLength(2);

    const capture = container.querySelector('button[aria-label="圈选字段 字段 1"]') as HTMLButtonElement;
    await act(async () => {
      capture.click();
      await Promise.resolve();
    });
    expect(rpcMocks.startElementCapture).toHaveBeenCalledWith(41);

    await act(async () => listeners.forEach((listener) => listener({
      type: "aipagego.captureResult",
      selector: ".captured-title",
    })));

    expect((container.querySelector('input[aria-label="字段选择器 字段 1"]') as HTMLInputElement).value)
      .toBe(".captured-title");
  });

  it("does not show an obsolete preview after the recipe changes", async () => {
    let resolvePreview!: (value: unknown) => void;
    rpcMocks.previewCollection.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePreview = resolve;
    }));
    await act(async () => root.render(<CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />));

    const previewButton = container.querySelector('button[aria-label="刷新预览"]') as HTMLButtonElement;
    await act(async () => previewButton.click());
    const capture = container.querySelector('button[aria-label="圈选字段 字段 1"]') as HTMLButtonElement;
    await act(async () => {
      capture.click();
      await Promise.resolve();
      listeners.forEach((listener) => listener({
        type: "aipagego.captureResult",
        selector: ".new-title",
      }));
    });

    await act(async () => resolvePreview({
      rows: [{ values: { field_1: "旧配方结果" }, missingRequired: [], duplicate: false }],
      matchedCount: 1,
      returnedCount: 1,
      uniqueCount: 1,
      duplicateCount: 0,
      missingRequiredCount: 0,
      truncated: false,
    }));

    expect(container.textContent).not.toContain("旧配方结果");
    expect(container.textContent).toContain("配置字段后刷新预览");
  });

  it("clears an existing preview when a field is added", async () => {
    await act(async () => root.render(<CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />));
    const previewButton = container.querySelector('button[aria-label="刷新预览"]') as HTMLButtonElement;
    await act(async () => {
      previewButton.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("示例标题");

    const add = container.querySelector('button[aria-label="添加字段"]') as HTMLButtonElement;
    await act(async () => add.click());

    expect(container.textContent).not.toContain("示例标题");
    expect(container.textContent).toContain("配置字段后刷新预览");
  });

  it("stops adding fields at the twenty-field UI hard limit", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));

    const add = container.querySelector('button[aria-label="添加字段"]') as HTMLButtonElement;
    await act(async () => {
      for (let index = 1; index < 20; index++) add.click();
    });

    expect(container.querySelectorAll('input[aria-label^="字段名称"]')).toHaveLength(20);
    expect(add.disabled).toBe(true);

    await act(async () => add.click());
    expect(container.querySelectorAll('input[aria-label^="字段名称"]')).toHaveLength(20);
  });

  it("fills an editable recipe from AI on the tab and URL captured at open time", async () => {
    recommendationMocks.recommendCollectionRecipe.mockResolvedValueOnce({
      version: 1,
      mode: "list",
      itemSelector: ".product",
      fields: [
        { id: "field_2", name: "标题", selector: ".title", valueMode: "text", required: true },
      ],
      pagination: { kind: "single" },
      dedupeBy: ["field_2"],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    });
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/list" />
    ));
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={99} currentUrl="https://two.example/list" />
    ));

    const recommend = container.querySelector('button[aria-label="AI 识别当前页"]') as HTMLButtonElement;
    await act(async () => {
      recommend.click();
      await Promise.resolve();
    });

    expect(recommendationMocks.recommendCollectionRecipe).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 41, url: "https://one.example/list" })
    );
    expect((container.querySelector('input[aria-label="列表项选择器"]') as HTMLInputElement).value)
      .toBe(".product");
    expect(container.querySelector('input[aria-label="字段名称 标题"]')).not.toBeNull();
    expect(rpcMocks.previewCollection).not.toHaveBeenCalled();

    const add = container.querySelector('button[aria-label="添加字段"]') as HTMLButtonElement;
    const preview = container.querySelector('button[aria-label="刷新预览"]') as HTMLButtonElement;
    await act(async () => add.click());
    await act(async () => {
      preview.click();
      await Promise.resolve();
    });
    const previewRecipe = rpcMocks.previewCollection.mock.calls[0][0].recipe;
    expect(new Set(previewRecipe.fields.map((field: { id: string }) => field.id)).size)
      .toBe(previewRecipe.fields.length);
  });

  it("surfaces an invalid AI recipe without changing or previewing the draft", async () => {
    recommendationMocks.recommendCollectionRecipe.mockRejectedValueOnce(new Error("AI 配方无效：fields"));
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));

    const recommend = container.querySelector('button[aria-label="AI 识别当前页"]') as HTMLButtonElement;
    await act(async () => {
      recommend.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("AI 配方无效：fields");
    expect((container.querySelector('input[aria-label^="字段选择器"]') as HTMLInputElement).value)
      .toBe("h1");
    expect(rpcMocks.previewCollection).not.toHaveBeenCalled();
  });

  it("applies a chat handoff without deriving selectors from its sample", async () => {
    const onHandoffConsumed = vi.fn();
    recommendationMocks.recommendCollectionRecipe.mockResolvedValueOnce({
      version: 1,
      mode: "single",
      fields: [
        { id: "title", name: "标题", selector: "h1", valueMode: "text", required: true },
      ],
      pagination: { kind: "single" },
      dedupeBy: [],
      maxRows: 2_000,
      maxBytes: 5 * 1024 * 1024,
    });
    await act(async () => root.render(
      <CollectStudioDrawer
        currentTabId={99}
        currentUrl="https://two.example/item"
        handoff={{
          id: "handoff-1",
          source: "chat",
          tabId: 41,
          url: "https://one.example/list",
          sample: { rows: [{ title: "已有标题" }] },
        }}
        onHandoffConsumed={onHandoffConsumed}
      />
    ));

    expect(container.textContent).toContain("目标 tab #41");
    expect(container.textContent).toContain("https://one.example/list");
    expect(container.textContent).toContain("已有标题");
    expect((container.querySelector('input[aria-label^="字段选择器"]') as HTMLInputElement).value)
      .toBe("h1");
    expect(onHandoffConsumed).toHaveBeenCalledWith("handoff-1");

    const recommend = container.querySelector('button[aria-label="AI 识别当前页"]') as HTMLButtonElement;
    await act(async () => {
      recommend.click();
      await Promise.resolve();
    });
    expect(recommendationMocks.recommendCollectionRecipe).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: 41,
        url: "https://one.example/list",
        sample: { rows: [{ title: "已有标题" }] },
      })
    );
  });

  it("runs on the captured tab, reads rows by resultId and restores by runId after reopening", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));

    const run = container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement;
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpcMocks.startCollection).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 41,
      recipe: expect.objectContaining({ pagination: { kind: "single" } }),
    }));
    expect(rpcMocks.readCollectionResult).toHaveBeenCalledWith({
      resultId: "result-1",
      offset: 0,
      limit: 50,
    });
    expect(container.textContent).toContain("已完成");
    expect(container.textContent).toContain("商品 A");

    const callsBeforeReopen = rpcMocks.getCollectionRun.mock.calls.length;
    await act(async () => useUi.getState().close());
    await act(async () => useUi.getState().open("collect"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpcMocks.getCollectionRun.mock.calls.length).toBeGreaterThan(callsBeforeReopen);
    expect(rpcMocks.getCollectionRun).toHaveBeenLastCalledWith("run-1");
  });

  it("ignores progress events for a different runId", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    const run = container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement;
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const callsBeforeEvent = rpcMocks.getCollectionRun.mock.calls.length;

    await act(async () => listeners.forEach((listener) => listener({
      type: "collection.progress",
      runId: "another-run",
      phase: "completed",
      pageCount: 9,
      rowCount: 999,
      byteSize: 999,
    })));

    expect(rpcMocks.getCollectionRun.mock.calls.length).toBe(callsBeforeEvent);
    expect(container.textContent).not.toContain("999 行");
  });

  it("does not let an older running snapshot overwrite a newer completed snapshot", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    const run = container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement;
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    let resolveOlder!: (value: unknown) => void;
    let resolveNewer!: (value: unknown) => void;
    rpcMocks.getCollectionRun
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve; }));

    await act(async () => {
      listeners.forEach((listener) => listener({ type: "collection.progress", runId: "run-1" }));
      listeners.forEach((listener) => listener({ type: "collection.progress", runId: "run-1" }));
    });
    await act(async () => {
      resolveNewer({
        runId: "run-1",
        resultId: "result-1",
        tabId: 41,
        sourceUrl: "https://one.example/item",
        status: "completed",
        phase: "completed",
        rowCount: 2,
        byteSize: 48,
        pageCount: 1,
        duplicateCount: 0,
        missingRequiredCount: 0,
        startedAt: 1,
        finishedAt: 2,
        stopReason: "completed",
      });
      await Promise.resolve();
    });
    await act(async () => {
      resolveOlder({
        runId: "run-1",
        resultId: "result-1",
        tabId: 41,
        sourceUrl: "https://one.example/item",
        status: "running",
        phase: "extracting",
        rowCount: 0,
        byteSize: 0,
        pageCount: 0,
        duplicateCount: 0,
        missingRequiredCount: 0,
        startedAt: 1,
      });
      await Promise.resolve();
    });

    expect(container.textContent).toContain("已完成");
    expect(container.textContent).toContain("2 行");
    expect(container.textContent).not.toContain("运行中");
  });

  it("builds an editable next-page recipe and still runs on the captured tab", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    const pagination = container.querySelector('select[aria-label="分页方式"]') as HTMLSelectElement;
    await act(async () => {
      pagination.value = "next";
      pagination.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const selector = container.querySelector('input[aria-label="下一页选择器"]') as HTMLInputElement;
    const maxPages = container.querySelector('input[aria-label="最多页数"]') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(selector, "a.next-page");
      selector.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(maxPages, "3");
      maxPages.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const run = container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement;
    await act(async () => {
      run.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpcMocks.startCollection).toHaveBeenCalledWith({
      tabId: 41,
      recipe: expect.objectContaining({
        pagination: { kind: "next", selector: "a.next-page", maxPages: 3 },
      }),
    });
  });

  it.each([
    ["loadMore", { kind: "loadMore", selector: "button.more", maxPages: 4 }],
    ["infiniteScroll", { kind: "infiniteScroll", maxPages: 4 }],
  ] as const)("builds a %s recipe from the pagination controls", async (kind, expected) => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    const pagination = container.querySelector('select[aria-label="分页方式"]') as HTMLSelectElement;
    await act(async () => {
      pagination.value = kind;
      pagination.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const maxPages = container.querySelector('input[aria-label="最多页数"]') as HTMLInputElement;
    const maxRows = container.querySelector('input[aria-label="最多行数"]') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(maxPages, "4");
      maxPages.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(maxRows, "17");
      maxRows.dispatchEvent(new Event("input", { bubbles: true }));
      const selector = container.querySelector('input[aria-label="翻页选择器"]') as HTMLInputElement | null;
      if (selector) {
        setValue.call(selector, "button.more");
        selector.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    await act(async () => {
      (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(rpcMocks.startCollection).toHaveBeenCalledWith({
      tabId: 41,
      recipe: expect.objectContaining({ pagination: expected }),
    });
    expect(rpcMocks.startCollection).toHaveBeenCalledWith(expect.objectContaining({
      recipe: expect.objectContaining({ maxRows: 17 }),
    }));
  });

  it("shows the large-result state with retained metrics and an actionable next step", async () => {
    rpcMocks.getCollectionRun.mockResolvedValue({
      runId: "run-1",
      resultId: "result-1",
      tabId: 41,
      sourceUrl: "https://one.example/item",
      status: "partial",
      phase: "completed",
      rowCount: 2_000,
      byteSize: 4_900_000,
      pageCount: 31,
      duplicateCount: 88,
      missingRequiredCount: 0,
      startedAt: 1,
      finishedAt: 2,
      stopReason: "max_rows",
      summary: {
        runId: "run-1",
        resultId: "result-1",
        sourceUrl: "https://one.example/item",
        status: "partial",
        stopReason: "max_rows",
        rowCount: 2_000,
        byteSize: 4_900_000,
        pageCount: 31,
        duplicateCount: 88,
        missingRequiredCount: 0,
        preview: [],
        startedAt: 1,
        finishedAt: 2,
      },
    });
    rpcMocks.readCollectionResult.mockResolvedValue({ rows: [], hasMore: false, nextOffset: null });
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    await act(async () => {
      (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("已达到硬上限，部分结果已保留");
    expect(container.textContent).toContain("2000 行");
    expect(container.textContent).toContain("31 页");
    expect(container.textContent).toContain("可以继续导出或调整配方后重试");
  });

  it("keeps the result after download permission denial and retries export in place", async () => {
    permissionMocks.requestOptionalPermission
      .mockResolvedValueOnce({ granted: false, reason: "user_denied" })
      .mockResolvedValueOnce({ granted: true });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:collection-export");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    await act(async () => {
      (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const readsBeforeExport = rpcMocks.readCollectionResult.mock.calls.length;
    const exportCsv = container.querySelector('button[aria-label="导出 CSV"]') as HTMLButtonElement;
    await act(async () => {
      exportCsv.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain("AI 想下载这份表格");
    expect(rpcMocks.readCollectionResult).toHaveBeenCalledTimes(readsBeforeExport);
    expect(downloadMock).not.toHaveBeenCalled();

    await act(async () => {
      (container.querySelector('[data-testid="permission-grant"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(permissionMocks.requestOptionalPermission).toHaveBeenCalledTimes(2);
    expect(rpcMocks.startCollection).toHaveBeenCalledTimes(1);
    expect(rpcMocks.readCollectionResult).toHaveBeenCalledTimes(readsBeforeExport + 1);
    expect(downloadMock).toHaveBeenCalledWith(expect.objectContaining({
      url: "blob:collection-export",
      filename: expect.stringMatching(/\.csv$/),
      saveAs: false,
    }));
    expect(container.textContent).toContain("CSV 已导出 2 行");
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:collection-export");
  });

  it("solidifies the editable recipe as a URL-matched steps tool without runtime or secret data", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer
        currentTabId={41}
        currentUrl="https://shop.example.com/products/2"
      />
    ));

    const name = container.querySelector('input[aria-label="工具名称"]') as HTMLInputElement;
    const pattern = container.querySelector('input[aria-label="URL 匹配规则"]') as HTMLInputElement;
    expect(pattern.value).toBe("https://shop.example.com/**");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(name, "商品列表采集");
      name.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(pattern, "https://shop.example.com/products/**");
      pattern.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      (container.querySelector('button[aria-label="保存为工具"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.saveTool).toHaveBeenCalledOnce();
    const draft = rpcMocks.saveTool.mock.calls[0][0];
    expect(draft).toMatchObject({
      kind: "steps",
      name: "商品列表采集",
      urlPatterns: ["https://shop.example.com/products/**"],
      steps: [{
        kind: "tool",
        tool: "collectStructuredData",
        args: { recipe: expect.objectContaining({ version: 1, pagination: { kind: "single" } }) },
        timeoutMs: 600_000,
      }],
      outputSchema: {
        type: "object",
        properties: expect.objectContaining({ resultId: { type: "string" }, rowCount: { type: "integer" } }),
      },
    });
    const serialized = JSON.stringify(draft);
    expect(serialized).not.toContain('"tabId"');
    expect(serialized).not.toContain('"rows"');
    expect(serialized).not.toContain("must-not-be-used");
    expect(serialized.toLowerCase()).not.toContain("cookie");
    expect(container.textContent).toContain("已保存到工具库");
  });

  it("sends a completed result by reference only after explicit external-sharing confirmation", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    await act(async () => {
      (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const readsBeforeSend = rpcMocks.readCollectionResult.mock.calls.length;
    expect(container.textContent).not.toContain("数据将离开浏览器");
    await act(async () => {
      (container.querySelector('button[aria-label="发送采集结果"]') as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("Orders webhook");
    expect(container.textContent).toContain("https://hooks.example.com");
    expect(container.textContent).toContain("2 行 · 48 bytes");
    expect(container.textContent).toContain("数据将离开浏览器");

    await act(async () => {
      (container.querySelector('input[aria-label="确认外发采集结果"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (container.querySelector('button[aria-label="确认发送采集结果"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(rpcMocks.createDelivery).toHaveBeenCalledWith("connector-1", {
      kind: "collection_result",
      resultId: "result-1",
    });
    expect(rpcMocks.readCollectionResult).toHaveBeenCalledTimes(readsBeforeSend);
    expect(container.textContent).toContain("发送完成");
  });

  it("surfaces connector loading failures instead of silently hiding the send action", async () => {
    rpcMocks.listConnectors.mockRejectedValue(new Error("connector storage unavailable"));
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    await act(async () => {
      (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(container.textContent).toContain("连接器加载失败"));
    expect(container.textContent).toContain("connector storage unavailable");
    expect(container.querySelector('button[aria-label="重试加载连接器"]')).toBeTruthy();
  });

  it("requires a fresh external-sharing confirmation after a new collection run", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer currentTabId={41} currentUrl="https://one.example/item" />
    ));
    const run = () => (container.querySelector('button[aria-label="运行采集"]') as HTMLButtonElement).click();
    await act(async () => { run(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      (container.querySelector('button[aria-label="发送采集结果"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (container.querySelector('input[aria-label="确认外发采集结果"]') as HTMLInputElement).click();
    });
    expect((container.querySelector('input[aria-label="确认外发采集结果"]') as HTMLInputElement).checked).toBe(true);

    await act(async () => { run(); await Promise.resolve(); await Promise.resolve(); });

    expect(container.querySelector('input[aria-label="确认外发采集结果"]')).toBeNull();
    expect(rpcMocks.createDelivery).not.toHaveBeenCalled();
  });

  it("does not broaden a multi-label public suffix into an unrelated domain wildcard", async () => {
    await act(async () => root.render(
      <CollectStudioDrawer
        currentTabId={41}
        currentUrl="https://shop.example.co.uk/products/2"
      />
    ));

    expect((container.querySelector('input[aria-label="URL 匹配规则"]') as HTMLInputElement).value)
      .toBe("https://shop.example.co.uk/**");
  });
});
