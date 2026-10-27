import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connector, ConnectorDelivery } from "@aipagego/shared/connectors";
import { ConnectorsDrawer } from "@/sidepanel/drawers/connectors-drawer";
import { useUi } from "@/sidepanel/chat/ui-store";

const rpcMocks = vi.hoisted(() => ({
  listConnectors: vi.fn(), saveConnector: vi.fn(), deleteConnector: vi.fn(), testConnector: vi.fn(),
  listDeliveries: vi.fn(), createDelivery: vi.fn(), retryDelivery: vi.fn(),
  listTools: vi.fn(), exportToolSharePackage: vi.fn(),
}));
vi.mock("@/sidepanel/rpc", () => ({ rpc: rpcMocks }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function connector(id = "c-1"): Connector {
  return {
    id, name: `Connector ${id}`, kind: "webhook",
    publicConfig: { kind: "webhook", method: "POST", endpointOrigin: "https://hooks.example.com", headerCount: 1 },
    credentialMode: "persistent", credentialConfigured: true, status: "ready",
    configHash: "a".repeat(64), createdAt: 1, updatedAt: 2,
  };
}

function baseConnector(id = "base-1"): Connector {
  return {
    id, name: "CRM Base", kind: "feishu_base",
    publicConfig: {
      kind: "feishu_base", region: "lark", appToken: "app-token", tableId: "table-id",
      fieldMapping: { title: "Name" },
    },
    credentialMode: "persistent", credentialConfigured: true, status: "ready",
    configHash: "b".repeat(64), createdAt: 1, updatedAt: 2,
  };
}

function delivery(
  id: string,
  status: ConnectorDelivery["status"],
): ConnectorDelivery {
  return {
    id,
    connectorId: "c-1",
    connectorConfigHash: "a".repeat(64),
    source: { kind: "run", runId: "run-safe-reference" },
    status,
    attempt: 2,
    nextOffset: 25,
    rowCount: 40,
    sentCount: 25,
    errorCode: status === "ok" ? undefined : "connector_network_failed",
    createdAt: 1_800_000_000_000,
  };
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeSelect(element: HTMLSelectElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ConnectorsDrawer", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useUi.setState({ openedDrawer: "connectors", drawerSubPath: null });
    rpcMocks.listDeliveries.mockResolvedValue([]);
    rpcMocks.listTools.mockResolvedValue([]);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    useUi.setState({ openedDrawer: null, drawerSubPath: null });
  });

  it("renders loading, empty, error, forbidden, default and large states", async () => {
    let resolveRows!: (rows: Connector[]) => void;
    rpcMocks.listConnectors.mockReturnValue(new Promise<Connector[]>((resolve) => { resolveRows = resolve; }));
    act(() => root.render(<ConnectorsDrawer />));
    expect(container.querySelector('[data-state="loading"]')).toBeTruthy();
    await act(async () => resolveRows([]));
    expect(container.querySelector('[data-state="empty"]')).toBeTruthy();

    await act(async () => root.render(<ConnectorsDrawer key="forbidden" access="forbidden" />));
    expect(container.querySelector('[data-state="forbidden"]')).toBeTruthy();

    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    await act(async () => root.render(<ConnectorsDrawer key="default" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="default"]')).toBeTruthy());

    rpcMocks.listConnectors.mockResolvedValue(Array.from({ length: 201 }, (_, i) => connector(`c-${i}`)));
    await act(async () => root.render(<ConnectorsDrawer key="large" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="large"]')).toBeTruthy());

    rpcMocks.listConnectors.mockRejectedValue(new Error("offline"));
    await act(async () => root.render(<ConnectorsDrawer key="error" />));
    await vi.waitFor(() => expect(container.querySelector('[data-state="error"]')).toBeTruthy());
  });

  it("opens the secure tool package workflow from the second tab", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("Connector c-1"));

    const packagesTab = [...container.querySelectorAll("button")].find((button) => button.textContent === "安全工具包");
    expect(packagesTab?.disabled).toBe(false);
    await act(async () => packagesTab?.click());

    await vi.waitFor(() => expect(container.textContent).toContain("安全分享"));
    expect(container.textContent).toContain("还没有可分享的工具");
    expect(container.textContent).not.toContain("发送历史");
  });

  it("creates a webhook with replacement credentials", async () => {
    rpcMocks.listConnectors.mockResolvedValue([]);
    rpcMocks.saveConnector.mockResolvedValue(connector());
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有连接器"));
    const create = [...container.querySelectorAll("button")].find((button) => button.textContent === "新建 Webhook");
    await act(async () => create?.click());
    const input = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
      changeValue(input("连接器名称"), "Orders");
      changeValue(input("Webhook URL"), "https://hooks.example.com/private?token=hidden");
      const headers = container.querySelector<HTMLTextAreaElement>('[aria-label="Webhook Headers"]')!;
      changeValue(headers, '{"Authorization":"Bearer hidden"}');
    });
    const save = [...container.querySelectorAll("button")].find((button) => button.textContent === "保存");
    await act(async () => save?.click());
    expect(rpcMocks.saveConnector).toHaveBeenCalledWith(expect.objectContaining({
      name: "Orders",
      secret: expect.objectContaining({ action: "replace", url: expect.stringContaining("private") }),
    }), undefined);
  });

  it("rejects non-string header values instead of silently coercing them", async () => {
    rpcMocks.listConnectors.mockResolvedValue([]);
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有连接器"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "新建 Webhook")?.click());
    const headers = container.querySelector<HTMLTextAreaElement>('[aria-label="Webhook Headers"]')!;
    await act(async () => changeValue(headers, '{"X-Retry":3}'));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存")?.click());
    expect(rpcMocks.saveConnector).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Header 名称和值必须是字符串");
  });

  it("edits without reflecting credentials and supports test/delete", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    rpcMocks.saveConnector.mockResolvedValue(connector());
    rpcMocks.testConnector.mockResolvedValue({ ok: true, status: 204 });
    rpcMocks.deleteConnector.mockResolvedValue(null);
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("Connector c-1"));
    expect(container.textContent).not.toContain("Bearer");
    const edit = [...container.querySelectorAll("button")].find((button) => button.textContent === "编辑");
    await act(async () => edit?.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="Webhook URL"]')?.value).toBe("");
    expect(container.textContent).toContain("保持现有凭据");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "取消")?.click());
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "测试")?.click());
    expect(rpcMocks.testConnector).toHaveBeenCalledWith("c-1");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "删除")?.click());
    expect(rpcMocks.deleteConnector).toHaveBeenCalledWith("c-1");
  });

  it("creates and edits a Feishu/Lark Base connector without reflecting app credentials", async () => {
    rpcMocks.listConnectors.mockResolvedValue([]);
    rpcMocks.saveConnector.mockResolvedValue(baseConnector());
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("还没有连接器"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "新建飞书/Lark Base")?.click());
    const input = (label: string) => container.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
    await act(async () => {
      changeValue(input("连接器名称"), "CRM Base");
      changeValue(input("App Token"), "app-token");
      changeValue(input("Table ID"), "table-id");
      changeValue(input("App ID"), "cli_123");
      changeValue(input("App Secret"), "app-secret-hidden");
      changeValue(container.querySelector<HTMLTextAreaElement>('[aria-label="字段映射"]')!, '{"title":"Name"}');
    });
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "保存")?.click());
    expect(rpcMocks.saveConnector).toHaveBeenCalledWith(expect.objectContaining({
      kind: "feishu_base",
      publicConfig: expect.objectContaining({ appToken: "app-token", tableId: "table-id" }),
      secret: { action: "replace", appId: "cli_123", appSecret: "app-secret-hidden" },
    }), undefined);

    rpcMocks.listConnectors.mockResolvedValue([baseConnector()]);
    await act(async () => root.render(<ConnectorsDrawer key="base-edit" />));
    await vi.waitFor(() => expect(container.textContent).toContain("CRM Base"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "编辑")?.click());
    expect(input("App ID").value).toBe("");
    expect(input("App Secret").value).toBe("");
    expect(container.textContent).not.toContain("app-secret-hidden");
  });

  it("shows filterable redacted delivery history", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    rpcMocks.listDeliveries.mockResolvedValue([
      delivery("delivery-ok", "ok"),
      delivery("delivery-error", "error"),
    ]);

    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("run · ok"));
    expect(container.textContent).toContain("run · error");
    expect(container.textContent).toContain("attempt 2 · sent 25 · offset 25");
    expect(container.textContent).not.toContain("private?token=hidden");
    expect(container.textContent).not.toContain("Bearer hidden");
    expect(container.textContent).not.toContain("payload-secret-value");

    await act(async () => changeSelect(
      container.querySelector<HTMLSelectElement>('[aria-label="发送状态筛选"]')!,
      "error",
    ));
    expect(container.textContent).not.toContain("run · ok");
    expect(container.textContent).toContain("run · error");
  });

  it("requires explicit confirmation before sending an existing source", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("发送已有结果"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "发送已有结果")?.click());
    await act(async () => {
      changeSelect(container.querySelector<HTMLSelectElement>('[aria-label="来源类型"]')!, "job_run");
      changeValue(container.querySelector<HTMLInputElement>('[aria-label="来源 ID"]')!, "job-run-9");
    });
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认发送")?.click());
    expect(rpcMocks.createDelivery).not.toHaveBeenCalled();
    expect(container.textContent).toContain("请先确认数据将离开浏览器");
  });

  it("sends only the selected source reference after confirmation", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    rpcMocks.createDelivery.mockResolvedValue(delivery("delivery-new", "ok"));
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("发送已有结果"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "发送已有结果")?.click());
    await act(async () => {
      changeSelect(container.querySelector<HTMLSelectElement>('[aria-label="来源类型"]')!, "collection_result");
      changeValue(container.querySelector<HTMLInputElement>('[aria-label="来源 ID"]')!, "result-7");
      container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    });
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认发送")?.click());
    expect(rpcMocks.createDelivery).toHaveBeenCalledWith("c-1", {
      kind: "collection_result",
      resultId: "result-7",
    });
  });

  it("invalidates external-sharing confirmation when the source changes", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("发送已有结果"));
    await act(async () => [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "发送已有结果")?.click());
    const sourceId = container.querySelector<HTMLInputElement>('[aria-label="来源 ID"]')!;
    const confirmation = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => {
      changeValue(sourceId, "run-1");
      confirmation.click();
    });
    expect(confirmation.checked).toBe(true);
    await act(async () => changeValue(sourceId, "run-2"));
    expect(confirmation.checked).toBe(false);
  });

  it("retries errors directly but requires a second confirmation for unknown commits", async () => {
    rpcMocks.listConnectors.mockResolvedValue([connector()]);
    rpcMocks.listDeliveries.mockResolvedValue([
      delivery("delivery-error", "error"),
      delivery("delivery-unknown", "unknown_commit"),
    ]);
    rpcMocks.retryDelivery.mockResolvedValue(delivery("delivery-error", "ok"));
    await act(async () => root.render(<ConnectorsDrawer />));
    await vi.waitFor(() => expect(container.textContent).toContain("unknown_commit"));

    const retryButtons = [...container.querySelectorAll("button")]
      .filter((button) => button.textContent === "仅重试发送");
    await act(async () => retryButtons[0]?.click());
    expect(rpcMocks.retryDelivery).toHaveBeenCalledWith("delivery-error", false);

    rpcMocks.retryDelivery.mockClear();
    await act(async () => retryButtons[1]?.click());
    expect(rpcMocks.retryDelivery).not.toHaveBeenCalled();
    const confirm = [...container.querySelectorAll("button")]
      .find((button) => button.textContent === "确认可能重复并重试");
    expect(confirm).toBeTruthy();
    await act(async () => confirm?.click());
    expect(rpcMocks.retryDelivery).toHaveBeenCalledWith("delivery-unknown", true);
  });
});
