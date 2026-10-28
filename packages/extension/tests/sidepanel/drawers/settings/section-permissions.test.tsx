import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSettings } from "@/sidepanel/chat/settings-store";
import { SectionPermissions } from "@/sidepanel/drawers/settings/section-permissions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SectionPermissions optional browser permissions", () => {
  let container: HTMLDivElement;
  let root: Root;
  const contains = vi.fn(async ({ permissions }: chrome.permissions.Permissions) =>
    permissions?.[0] === "history"
  );
  const remove = vi.fn(async () => true);

  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as unknown as { chrome: unknown }).chrome = {
      permissions: { contains, remove },
    };
    useSettings.setState({
      loaded: true,
      trustedDangerTools: [],
      defaultPermissionMode: "default",
      save: vi.fn(async (patch) => useSettings.setState(patch)),
    } as Partial<ReturnType<typeof useSettings.getState>>);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows current states and revokes an already-granted permission without requesting another", async () => {
    await act(async () => {
      root.render(<SectionPermissions />);
      await Promise.resolve();
    });

    expect(contains).toHaveBeenCalledTimes(4);
    expect(container.querySelector('[data-testid="permission-state-bookmarks"]')?.textContent)
      .toContain("使用时询问");
    expect(container.querySelector('[data-testid="permission-state-history"]')?.textContent)
      .toContain("已授权");
    expect(container.querySelector('[data-testid="permission-state-downloads"]')?.textContent)
      .toContain("使用时询问");
    expect(container.querySelector('[data-testid="permission-state-notifications"]')?.textContent)
      .toContain("使用时询问");

    const revoke = container.querySelector(
      '[data-testid="permission-revoke-history"]'
    ) as HTMLButtonElement;
    expect(revoke).toBeTruthy();
    await act(async () => revoke.click());

    expect(remove).toHaveBeenCalledWith({ permissions: ["history"] });
    expect(container.querySelector('[data-testid="permission-state-history"]')?.textContent)
      .toContain("使用时询问");
    expect((chrome.permissions as { request?: unknown }).request).toBeUndefined();
  });
});
