import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { PermissionRequestCard } from "@/sidepanel/components/permission-request-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("PermissionRequestCard", () => {
  it("explains bookmark access and resolves only from explicit buttons", () => {
    const onGrant = vi.fn();
    const onDeny = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        <PermissionRequestCard
          permission="bookmarks"
          capability="searchBookmarks"
          busy={false}
          onGrant={onGrant}
          onDeny={onDeny}
        />,
      );
    });

    expect(container.textContent).toContain("AI 想搜索你的书签");
    expect(onGrant).not.toHaveBeenCalled();
    const grant = container.querySelector('[data-testid="permission-grant"]') as HTMLButtonElement;
    act(() => grant.click());
    expect(onGrant).toHaveBeenCalledOnce();

    const deny = container.querySelector('[data-testid="permission-deny"]') as HTMLButtonElement;
    act(() => deny.click());
    expect(onDeny).toHaveBeenCalledOnce();
    act(() => root.unmount());
  });
});
