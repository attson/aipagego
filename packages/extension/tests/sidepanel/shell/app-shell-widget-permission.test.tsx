import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installChromeShim } from "../../../demo/chrome-shim";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppShell widget optional-permission handoff", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    installChromeShim();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("shows a widget request and broadcasts the result after a sidepanel user gesture", async () => {
    const pending = {
      tabId: 1,
      toolUseId: "history-1",
      code: "permission_required" as const,
      permission: "history" as const,
      capability: "searchHistory" as const,
      requestable: true as const,
      ts: Date.now(),
    };
    chrome.storage.session.get = vi.fn(async () => ({
      "aipagego.pendingPermission.1.history-1": pending,
    }));
    chrome.storage.session.remove = vi.fn(async () => undefined);
    chrome.permissions.request = vi.fn(async () => true);
    const sendMessage = vi.spyOn(chrome.runtime, "sendMessage");

    const { AppShell } = await import("@/sidepanel/shell/app-shell");
    const { ThemeProvider } = await import("@/sidepanel/shell/theme-provider");
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    useSettings.setState({ loaded: false });

    await act(async () => {
      root.render(React.createElement(ThemeProvider, null, React.createElement(AppShell)));
      await new Promise((resolve) => setTimeout(resolve, 75));
    });

    expect(container.textContent).toContain("AI 想搜索你的浏览历史");
    const grant = container.querySelector('[data-testid="permission-grant"]') as HTMLButtonElement;
    await act(async () => grant.click());

    expect(chrome.permissions.request).toHaveBeenCalledWith({ permissions: ["history"] });
    expect(sendMessage).toHaveBeenCalledWith({
      type: "permission.decision",
      tabId: 1,
      toolUseId: "history-1",
      result: { granted: true },
    });
    expect(container.querySelector('[data-testid="permission-grant"]')).toBeNull();
  });
});
