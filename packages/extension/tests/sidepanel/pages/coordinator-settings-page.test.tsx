import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CoordinatorSettingsPage } from "@/sidepanel/pages/coordinator-settings-page";
import { loadAllowRemoteChat } from "@/background/coordinator-state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function fakeChromeStorage(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Set<
    (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void
  >();
  const local = {
    get: vi.fn(async (keys: string | string[] | null) => {
      const result: Record<string, unknown> = {};
      const requested = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : [...data.keys()];
      for (const k of requested) {
        if (data.has(k)) result[k] = data.get(k);
      }
      return result;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      for (const fn of listeners) fn(changes, "local");
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const ks = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of ks) {
        changes[k] = { oldValue: data.get(k), newValue: undefined };
        data.delete(k);
      }
      for (const fn of listeners) fn(changes, "local");
    })
  };
  const sendMessage = vi.fn(async (_message?: unknown): Promise<unknown> => ({ sessions: [] }));
  return {
    // Plan 33: the page polls the worker for connected sessions.
    runtime: { sendMessage, getManifest: () => ({ version: "0.0.75" }) },
    permissions: { contains: vi.fn(async () => false) },
    storage: {
      local,
      onChanged: {
        addListener: vi.fn((fn) => listeners.add(fn)),
        removeListener: vi.fn((fn) => listeners.delete(fn))
      }
    }
  };
}

describe("CoordinatorSettingsPage", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function flushAsync() {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("prefills default WS URL on mount and enables 连接 without token", async () => {
    vi.stubGlobal("chrome", fakeChromeStorage());
    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();
    const urlInput = container.querySelector(
      "input[placeholder*='localhost:8787']"
    ) as HTMLInputElement | null;
    expect(urlInput).not.toBeNull();
    expect(urlInput?.value).toBe("ws://localhost:8787/worker");

    const connectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("连接")
    ) as HTMLButtonElement | undefined;
    expect(connectBtn).toBeTruthy();
    expect(connectBtn?.disabled).toBe(false);
  });

  it("typing URL + token + clicking 连接 saves both to chrome.storage.local", async () => {
    const chromeMock = fakeChromeStorage();
    vi.stubGlobal("chrome", chromeMock);
    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const urlInput = container.querySelector(
      "input[placeholder*='localhost:8787']"
    ) as HTMLInputElement;
    const tokenInput = container.querySelector(
      "input[type='password']"
    ) as HTMLInputElement;

    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    await act(async () => {
      nativeInputValueSetter?.call(urlInput, "ws://localhost:7842/worker");
      urlInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      nativeInputValueSetter?.call(tokenInput, "wpk_xyz");
      tokenInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const connectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("连接")
    ) as HTMLButtonElement;
    expect(connectBtn).toBeTruthy();

    await act(async () => {
      connectBtn.click();
    });
    await flushAsync();

    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:7842/worker",
        enabled: true
      }
    });
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      "aipagego.coordinator.token": "wpk_xyz"
    });
  });

  it("断开 button writes enabled: false to config", async () => {
    const chromeMock = fakeChromeStorage({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:7842/worker",
        enabled: true
      },
      "aipagego.coordinator.token": "wpk_existing"
    });
    vi.stubGlobal("chrome", chromeMock);
    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const disconnectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "断开"
    ) as HTMLButtonElement;
    expect(disconnectBtn).toBeTruthy();

    await act(async () => {
      disconnectBtn.click();
    });
    await flushAsync();

    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:7842/worker",
        enabled: false
      }
    });
  });

  it("cleans MCP groups without closing tabs", async () => {
    const chromeMock = fakeChromeStorage();
    chromeMock.runtime.sendMessage.mockImplementation(async (message?: unknown) => {
      if ((message as { type?: string }).type === "pairing.cleanupGroups") {
        return { ok: true, cleanedTabs: 3 };
      }
      return { sessions: [] };
    });
    vi.stubGlobal("chrome", chromeMock);
    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const cleanupButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("取消所有 MCP 分组")
    ) as HTMLButtonElement;
    await act(async () => {
      cleanupButton.click();
    });
    await flushAsync();

    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: "pairing.cleanupGroups"
    });
    expect(container.textContent).toContain("已取消 3 个标签页的 MCP 分组，标签页保持打开");
  });

  it("shows each MCP version and warns about stale or legacy sessions", async () => {
    const chromeMock = fakeChromeStorage();
    chromeMock.runtime.sendMessage.mockResolvedValue({
      sessions: [
        {
          source: "mcp",
          endpoint: "ws://127.0.0.1:51234/worker",
          installId: "inst",
          sessionId: "current",
          label: "~/code/current",
          pid: 10,
          port: 51234,
          status: "connected",
          failures: 0,
          mcpVersion: "0.0.75"
        },
        {
          source: "mcp",
          endpoint: "ws://127.0.0.1:51235/worker",
          installId: "inst",
          sessionId: "stale",
          label: "~/code/stale",
          pid: 11,
          port: 51235,
          status: "connected",
          failures: 0,
          mcpVersion: "0.0.74"
        },
        {
          source: "mcp",
          endpoint: "ws://127.0.0.1:51236/worker",
          installId: "inst",
          sessionId: "legacy",
          label: "~/code/legacy",
          pid: 12,
          port: 51236,
          status: "dormant",
          failures: 10
        },
        {
          source: "manual",
          endpoint: "ws://localhost:8787/worker",
          installId: "legacy",
          sessionId: "manual",
          label: "手动配置",
          pid: 0,
          port: 0,
          status: "connected",
          failures: 0
        }
      ]
    });
    vi.stubGlobal("chrome", chromeMock);

    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    expect(container.textContent).toContain("MCP v0.0.75");
    expect(container.textContent).toContain("MCP v0.0.74");
    expect(container.textContent).toContain("MCP 版本未知");
    expect(container.textContent).toContain(
      "~/code/stale：MCP v0.0.74 低于扩展 v0.0.75，请更新 MCP"
    );
    expect(container.textContent).toContain(
      "~/code/legacy：MCP 版本未知，客户端可能过旧，请更新 MCP"
    );
    expect(container.textContent).not.toContain("手动配置：MCP 版本未知");
  });

  it("does not show a stale connected runtime status as live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
    vi.stubGlobal("chrome", fakeChromeStorage({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:8787/worker",
        enabled: true
      },
      "aipagego.coordinator.connection_status": {
        status: "connected",
        ws_url: "ws://localhost:8787/worker",
        updated_at: Date.now() - 60_000
      }
    }));

    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    expect(container.textContent).toContain("连接状态: 状态未知");
    expect(container.textContent).not.toContain("连接状态: 已连接");
  });

  it("recomputes connected status age while the page stays open", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
    vi.stubGlobal("chrome", fakeChromeStorage({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:8787/worker",
        enabled: true
      },
      "aipagego.coordinator.connection_status": {
        status: "connected",
        ws_url: "ws://localhost:8787/worker",
        updated_at: Date.now()
      }
    }));

    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();
    expect(container.textContent).toContain("连接状态: 已连接");

    await act(async () => {
      vi.setSystemTime(new Date("2026-06-07T12:00:46Z"));
      vi.advanceTimersByTime(5_000);
    });

    expect(container.textContent).toContain("连接状态: 状态未知");
  });

  it("clears the temporary connecting message after live status becomes connected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
    const chromeMock = fakeChromeStorage();
    vi.stubGlobal("chrome", chromeMock);

    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const connectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("连接")
    ) as HTMLButtonElement;
    await act(async () => {
      connectBtn.click();
    });
    await flushAsync();
    expect(container.textContent).toContain("已启用，正在连接");

    await act(async () => {
      await chromeMock.storage.local.set({
        "aipagego.coordinator.connection_status": {
          status: "connected",
          ws_url: "ws://localhost:8787/worker",
          updated_at: Date.now()
        }
      });
    });
    await flushAsync();

    expect(container.textContent).toContain("连接状态: 已连接");
    expect(container.textContent).not.toContain("已启用，正在连接");
  });

  it("clicking connect does not reuse a previous connected runtime status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-07T12:00:00Z"));
    vi.stubGlobal("chrome", fakeChromeStorage({
      "aipagego.coordinator.config": {
        ws_url: "ws://localhost:8787/worker",
        enabled: false
      },
      "aipagego.coordinator.connection_status": {
        status: "connected",
        ws_url: "ws://localhost:8787/worker",
        updated_at: Date.now()
      }
    }));

    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const connectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("连接")
    ) as HTMLButtonElement;
    await act(async () => {
      connectBtn.click();
    });
    await flushAsync();

    expect(container.textContent).toContain("连接状态: 连接中");
    expect(container.textContent).not.toContain("连接状态: 已连接");
  });

  it("toggles allow_remote_chat in storage when the checkbox flips", async () => {
    vi.stubGlobal("chrome", fakeChromeStorage());
    await act(async () => {
      root.render(<CoordinatorSettingsPage />);
    });
    await flushAsync();

    const checkbox = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']")
    ).find((input) => {
      const label = input.closest("label");
      return /允许 coordinator 远程驱动 chat/.test(label?.textContent ?? "");
    });
    expect(checkbox).toBeTruthy();
    expect(checkbox?.checked).toBe(false);

    await act(async () => {
      checkbox!.click();
    });
    await flushAsync();

    expect(checkbox?.checked).toBe(true);
    expect(await loadAllowRemoteChat()).toBe(true);
  });
});
