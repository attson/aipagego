import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePermissionRequired } from "@aipagego/shared/optional-permissions";

import {
  hasOptionalPermission,
  removeOptionalPermission,
  requestOptionalPermission,
  requireOptionalPermission,
} from "@/permissions/optional-permissions";

const realChrome = globalThis.chrome;

afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

function installPermissions(result: { contains?: boolean; request?: boolean }) {
  const contains = vi.fn(async () => result.contains ?? false);
  const request = vi.fn(async () => result.request ?? false);
  const remove = vi.fn(async () => true);
  globalThis.chrome = {
    permissions: { contains, request, remove },
  } as unknown as typeof chrome;
  return { contains, request, remove };
}

describe("optional capability permissions", () => {
  it("reports a structured request without opening a Chrome prompt", async () => {
    const api = installPermissions({ contains: false });

    const error = await requireOptionalPermission("bookmarks", "searchBookmarks").catch(
      (cause) => cause,
    );

    expect(parsePermissionRequired(error)).toEqual({
      code: "permission_required",
      permission: "bookmarks",
      capability: "searchBookmarks",
      requestable: true,
    });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("requests only from the explicit user-gesture API and reports denial", async () => {
    const api = installPermissions({ request: false });

    await expect(requestOptionalPermission("bookmarks")).resolves.toEqual({
      granted: false,
      reason: "user_denied",
    });
    expect(api.request).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
  });

  it("checks and removes a granted permission", async () => {
    const api = installPermissions({ contains: true });

    await expect(hasOptionalPermission("bookmarks")).resolves.toBe(true);
    await expect(removeOptionalPermission("bookmarks")).resolves.toBe(true);
    expect(api.remove).toHaveBeenCalledWith({ permissions: ["bookmarks"] });
  });
});
