import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMetaTools } from "@/sidepanel/lib/meta-tools";
import { parsePermissionRequired } from "@aipagego/shared/optional-permissions";

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
});

function setChrome(stub: unknown) {
  (globalThis as { chrome?: unknown }).chrome = stub;
}

describe("buildMetaTools", () => {
  it("exposes the expected tools", () => {
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });
    expect(Object.keys(m).sort()).toEqual(
      ["closeTab", "downloadImage", "downloadSpreadsheet", "searchBookmarks", "searchHistory", "switchToTab"].sort()
    );
  });

  it("closeTab rejects when tab is not attached", async () => {
    setChrome({ tabs: { remove: vi.fn() } });
    const m = buildMetaTools({ attachedTabIds: () => [99], mainTabId: 1 });
    await expect(m.closeTab({ tabId: 7 })).rejects.toThrow(/not in attachedTabs/);
  });

  it("closeTab calls chrome.tabs.remove when allowed", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    setChrome({ tabs: { remove } });
    const m = buildMetaTools({ attachedTabIds: () => [7], mainTabId: 1 });
    const out = await m.closeTab({ tabId: 7 });
    expect(remove).toHaveBeenCalledWith(7);
    expect(out).toEqual({ ok: true, tabId: 7 });
  });

  it("switchToTab accepts the main session tab too", async () => {
    const update = vi.fn().mockResolvedValue({ url: "https://x", windowId: 1 });
    setChrome({
      tabs: { update },
      windows: { update: vi.fn().mockResolvedValue(undefined) }
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 5 });
    const out = await m.switchToTab({ tabId: 5 });
    expect(update).toHaveBeenCalledWith(5, { active: true });
    expect((out as { ok: boolean }).ok).toBe(true);
  });

  it("searchBookmarks rejects empty query", async () => {
    setChrome({ bookmarks: { search: vi.fn() } });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });
    await expect(m.searchBookmarks({ query: "" })).rejects.toThrow(/query required/);
  });

  it("searchBookmarks returns a machine-readable requirement before reading bookmarks", async () => {
    const search = vi.fn();
    setChrome({
      permissions: { contains: vi.fn(async () => false) },
      bookmarks: { search },
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });

    const error = await m.searchBookmarks({ query: "docs" }).catch((cause) => cause);

    expect(parsePermissionRequired(error)).toMatchObject({
      permission: "bookmarks",
      capability: "searchBookmarks",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("searchBookmarks filters folder nodes and respects limit", async () => {
    const search = vi.fn().mockResolvedValue([
      { id: "1", title: "a", url: "https://a.com" },
      { id: "2", title: "folder" }, // no url
      { id: "3", title: "b", url: "https://b.com" },
      { id: "4", title: "c", url: "https://c.com" },
    ]);
    setChrome({
      permissions: { contains: vi.fn(async () => true) },
      bookmarks: { search },
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });
    const out = (await m.searchBookmarks({ query: "x", limit: 2 })) as unknown[];
    expect(out).toHaveLength(2);
    expect(search).toHaveBeenCalledWith("x");
  });

  it("downloadImage requires url + uses chrome.downloads", async () => {
    const download = vi.fn().mockResolvedValue(42);
    setChrome({
      permissions: { contains: vi.fn(async () => true) },
      downloads: { download },
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });
    const out = await m.downloadImage({ url: "https://x/y.png", filename: "y.png" });
    expect(download).toHaveBeenCalledWith({ url: "https://x/y.png", filename: "y.png", saveAs: false });
    expect(out).toEqual({ downloadId: 42, filename: "y.png" });
  });

  it("downloadSpreadsheet writes xlsx through a data URL", async () => {
    // A service worker has no URL.createObjectURL, so the shared
    // implementation hands chrome.downloads a data: URL instead of a blob:.
    const download = vi.fn().mockResolvedValue(99);
    setChrome({
      permissions: { contains: vi.fn(async () => true) },
      downloads: { download },
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });

    const out = await m.downloadSpreadsheet({
      filename: "reports/products",
      sheets: [{ name: "Products", rows: [["Title", "Price"], ["A", 12]] }]
    });

    const call = download.mock.calls[0][0] as { url: string; filename: string; saveAs: boolean };
    expect(call.url.startsWith("data:")).toBe(true);
    expect(call.url).toContain("spreadsheetml");
    expect(call.filename).toBe("reports_products.xlsx");
    expect(call.saveAs).toBe(false);
    expect(out).toMatchObject({
      downloadId: 99,
      filename: "reports_products.xlsx",
      sheets: 1,
      rows: 2
    });
  });

  it("searchHistory passes daysBack into startTime", async () => {
    const search = vi.fn().mockResolvedValue([]);
    setChrome({
      permissions: { contains: vi.fn(async () => true) },
      history: { search },
    });
    const m = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });
    await m.searchHistory({ query: "github", daysBack: 14 });
    const call = search.mock.calls[0][0] as { text: string; startTime: number; maxResults: number };
    expect(call.text).toBe("github");
    expect(call.startTime).toBeLessThan(Date.now());
    expect(call.maxResults).toBe(50);
  });

  it.each([
    ["searchHistory", "history", "searchHistory", { query: "github" }],
    ["downloadImage", "downloads", "downloadImage", { url: "https://x/y.png" }],
    ["downloadSpreadsheet", "downloads", "downloadSpreadsheet", { sheets: [{ name: "S", rows: [] }] }],
  ] as const)("%s reports a structured %s requirement before using the API", async (
    tool,
    permission,
    capability,
    input,
  ) => {
    const historySearch = vi.fn();
    const download = vi.fn();
    setChrome({
      permissions: { contains: vi.fn(async () => false) },
      history: { search: historySearch },
      downloads: { download },
    });
    const tools = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });

    const error = await tools[tool](input).catch((cause) => cause);

    expect(parsePermissionRequired(error)).toMatchObject({ permission, capability });
    expect(historySearch).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it.each([
    ["searchHistory", { query: "github" }],
    ["downloadImage", { url: "https://x/y.png" }],
    ["downloadSpreadsheet", { sheets: [{ name: "S", rows: [] }] }],
  ] as const)("%s surfaces the Chrome API failure after permission is present", async (tool, input) => {
    const failure = new Error("chrome api failed");
    setChrome({
      permissions: { contains: vi.fn(async () => true) },
      history: { search: vi.fn(async () => { throw failure; }) },
      downloads: { download: vi.fn(async () => { throw failure; }) },
    });
    const tools = buildMetaTools({ attachedTabIds: () => [], mainTabId: 1 });

    await expect(tools[tool](input)).rejects.toThrow("chrome api failed");
  });
});
