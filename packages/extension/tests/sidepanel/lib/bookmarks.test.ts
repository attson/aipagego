import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePermissionRequired } from "@aipagego/shared/optional-permissions";

import { loadBookmarks } from "@/sidepanel/lib/bookmarks";

const realChrome = globalThis.chrome;

afterEach(() => {
  globalThis.chrome = realChrome;
});

describe("loadBookmarks", () => {
  it("does not read the tree without bookmark permission", async () => {
    const getTree = vi.fn();
    globalThis.chrome = {
      permissions: { contains: vi.fn(async () => false) },
      bookmarks: { getTree },
    } as unknown as typeof chrome;

    const error = await loadBookmarks().catch((cause) => cause);

    expect(parsePermissionRequired(error)).toMatchObject({
      permission: "bookmarks",
      capability: "bookmarkMention",
    });
    expect(getTree).not.toHaveBeenCalled();
  });

  it("returns bookmark leaves after permission is granted", async () => {
    globalThis.chrome = {
      permissions: { contains: vi.fn(async () => true) },
      bookmarks: {
        getTree: vi.fn(async () => [
          {
            id: "root",
            title: "",
            children: [
              { id: "folder", title: "Folder", children: [] },
              { id: "b1", title: "Docs", url: "https://docs.example" },
            ],
          },
        ]),
      },
    } as unknown as typeof chrome;

    await expect(loadBookmarks()).resolves.toEqual([
      { id: "b1", title: "Docs", url: "https://docs.example" },
    ]);
  });
});
