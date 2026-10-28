import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import React from "react";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installChromeShim } from "../../../demo/chrome-shim";

const { loadBookmarksMock } = vi.hoisted(() => ({
  loadBookmarksMock: vi.fn(async () => [
    { id: "b1", title: "Docs", url: "https://docs.example" },
  ]),
}));

vi.mock("@/sidepanel/lib/bookmarks", () => ({ loadBookmarks: loadBookmarksMock }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppShell bookmark permission entry", () => {
  type PermissionRemovedListener = (permissions: chrome.permissions.Permissions) => void;
  let container: HTMLDivElement;
  let root: Root;
  let onPermissionRemoved: PermissionRemovedListener | undefined;

  beforeEach(() => {
    loadBookmarksMock.mockClear();
    installChromeShim();
    onPermissionRemoved = undefined;
    chrome.permissions.onRemoved = {
      addListener: (listener: PermissionRemovedListener) => {
        onPermissionRemoved = listener;
      },
      removeListener: (listener: PermissionRemovedListener) => {
        if (onPermissionRemoved === listener) onPermissionRemoved = undefined;
      },
      hasListener: (listener: PermissionRemovedListener) => onPermissionRemoved === listener,
      hasListeners: () => onPermissionRemoved != null,
      addRules: () => undefined,
      getRules: () => undefined,
      removeRules: () => undefined,
    } as typeof chrome.permissions.onRemoved;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("does not read bookmarks on mount and continues the picker after an explicit grant", async () => {
    const request = vi.fn(async () => true);
    chrome.permissions.request = request;
    const { AppShell } = await import("@/sidepanel/shell/app-shell");
    const { ThemeProvider } = await import("@/sidepanel/shell/theme-provider");
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    useSettings.setState({ loaded: false });

    await act(async () => {
      root.render(React.createElement(ThemeProvider, null, React.createElement(AppShell)));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(loadBookmarksMock).not.toHaveBeenCalled();

    const mention = container.querySelector('button[aria-label="@ 引用 tab"]') as HTMLButtonElement;
    act(() => mention.click());
    const bookmarkTab = [...container.querySelectorAll('button[role="tab"]')].find((item) =>
      (item.textContent ?? "").includes("Bookmarks")
    ) as HTMLButtonElement;
    act(() => bookmarkTab.click());
    expect(container.textContent).toContain("仅用于在本机搜索并引用你的书签");
    expect(loadBookmarksMock).not.toHaveBeenCalled();

    const grant = container.querySelector('[data-testid="grant-bookmarks"]') as HTMLButtonElement;
    await act(async () => grant.click());

    expect(request).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
    expect(loadBookmarksMock).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Docs");

    act(() => onPermissionRemoved?.({ permissions: ["bookmarks"] }));

    expect(container.textContent).not.toContain("Docs");
    expect(container.textContent).toContain("允许访问书签");

    const grantAgain = container.querySelector('[data-testid="grant-bookmarks"]') as HTMLButtonElement;
    await act(async () => grantAgain.click());

    expect(request).toHaveBeenCalledTimes(2);
    expect(loadBookmarksMock).toHaveBeenCalledTimes(2);
  });
});
