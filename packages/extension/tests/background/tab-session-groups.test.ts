import { describe, expect, it, vi } from "vitest";
import { TabSessionGroupManager } from "@/background/tab-session-groups";

function harness(seed: Array<{ id: number; windowId: number; index: number; groupId?: number }>) {
  const tabs = new Map(seed.map((tab) => [tab.id, { ...tab, groupId: tab.groupId ?? -1 }]));
  const groups = new Map<number, { id: number; windowId: number; title?: string; color?: string }>();
  let nextGroup = 100;
  let stored: any;
  const deps = {
    getTab: vi.fn(async (tabId: number) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("tab missing");
      return tab as chrome.tabs.Tab;
    }),
    groupTabs: vi.fn(async (options: chrome.tabs.GroupOptions) => {
      const ids = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
      const firstId = ids[0];
      if (firstId == null) throw new Error("tab id missing");
      const first = tabs.get(firstId);
      if (!first) throw new Error("tab missing");
      const groupId = options.groupId ?? nextGroup++;
      groups.set(groupId, groups.get(groupId) ?? { id: groupId, windowId: first.windowId });
      for (const id of ids) {
        if (id != null) tabs.get(id)!.groupId = groupId;
      }
      return groupId;
    }),
    ungroupTabs: vi.fn(async (tabIds: number | number[]) => {
      for (const id of Array.isArray(tabIds) ? tabIds : [tabIds]) tabs.get(id)!.groupId = -1;
    }),
    moveTab: vi.fn(async (tabId: number, move: chrome.tabs.MoveProperties) => {
      tabs.get(tabId)!.index = move.index;
      return tabs.get(tabId) as chrome.tabs.Tab;
    }),
    getGroup: vi.fn(async (groupId: number) => {
      const group = groups.get(groupId);
      if (!group) throw new Error("group missing");
      return group as chrome.tabGroups.TabGroup;
    }),
    queryGroups: vi.fn(async () => [...groups.values()] as chrome.tabGroups.TabGroup[]),
    queryTabs: vi.fn(async (query: chrome.tabs.QueryInfo) =>
      [...tabs.values()].filter((tab) => query.groupId == null || tab.groupId === query.groupId) as chrome.tabs.Tab[]
    ),
    updateGroup: vi.fn(async (groupId: number, update: chrome.tabGroups.UpdateProperties) => {
      const group = groups.get(groupId);
      if (!group) throw new Error("group missing");
      Object.assign(group, update);
      return group as chrome.tabGroups.TabGroup;
    }),
    load: vi.fn(async () => stored),
    save: vi.fn(async (state: unknown) => { stored = structuredClone(state); })
  };
  return { tabs, groups, deps, manager: new TabSessionGroupManager(deps), stored: () => stored };
}

describe("TabSessionGroupManager", () => {
  it("reuses one native group for one session in a window", async () => {
    const h = harness([
      { id: 1, windowId: 7, index: 0 },
      { id: 2, windowId: 7, index: 4 }
    ]);
    await h.manager.claim({ sessionId: "session-abcdef", tabId: 1, source: "mcp" });
    await h.manager.claim({ sessionId: "session-abcdef", tabId: 2, source: "mcp" });

    expect(h.tabs.get(1)?.groupId).toBe(h.tabs.get(2)?.groupId);
    expect(h.groups.size).toBe(1);
    expect([...h.groups.values()][0]).toMatchObject({
      title: "AIPageGo · MCP · abcdef",
      color: "green"
    });
  });

  it("creates one group per window for a cross-window session", async () => {
    const h = harness([
      { id: 1, windowId: 7, index: 0 },
      { id: 2, windowId: 8, index: 0 }
    ]);
    await h.manager.claim({ sessionId: "s1", tabId: 1, source: "local" });
    await h.manager.claim({ sessionId: "s1", tabId: 2, source: "local" });
    expect(h.tabs.get(1)?.groupId).not.toBe(h.tabs.get(2)?.groupId);
    expect(h.groups.size).toBe(2);
  });

  it("restores original groups and tab positions when a session ends", async () => {
    const h = harness([{ id: 1, windowId: 7, index: 5, groupId: 20 }]);
    h.groups.set(20, { id: 20, windowId: 7, title: "用户分组" });
    await h.manager.claim({ sessionId: "s1", tabId: 1, source: "remote" });
    expect(h.tabs.get(1)?.groupId).not.toBe(20);

    await h.manager.releaseSession("s1");
    expect(h.tabs.get(1)).toMatchObject({ groupId: 20, index: 5 });
  });

  it("does not pull back or restore a tab the user manually moved", async () => {
    const h = harness([{ id: 1, windowId: 7, index: 2 }]);
    await h.manager.claim({ sessionId: "s1", tabId: 1, source: "local" });
    h.tabs.get(1)!.groupId = -1;
    await h.manager.handleGroupChanged(1, -1);
    await h.manager.claim({ sessionId: "s1", tabId: 1, source: "local" });
    expect(h.tabs.get(1)?.groupId).toBe(-1);
    h.deps.ungroupTabs.mockClear();
    h.deps.moveTab.mockClear();

    await h.manager.releaseSession("s1");
    expect(h.deps.ungroupTabs).not.toHaveBeenCalled();
    expect(h.deps.moveTab).not.toHaveBeenCalled();
  });

  it("marks an awaiting session in the native group title", async () => {
    const h = harness([{ id: 1, windowId: 7, index: 0 }]);
    await h.manager.claim({ sessionId: "s1", tabId: 1, source: "local" });
    await h.manager.setStatus("s1", "awaiting");
    expect([...h.groups.values()][0].title).toContain("等待确认");
  });

  it("releases only claims from the requested source", async () => {
    const h = harness([
      { id: 1, windowId: 7, index: 0 },
      { id: 2, windowId: 7, index: 1 }
    ]);
    await h.manager.claim({ sessionId: "mcp-s1", tabId: 1, source: "mcp" });
    await h.manager.claim({ sessionId: "local-s1", tabId: 2, source: "local" });

    await h.manager.releaseBySource("mcp");

    expect(h.tabs.get(1)?.groupId).toBe(-1);
    expect(h.tabs.get(2)?.groupId).not.toBe(-1);
    expect(h.manager.snapshot().claims).toEqual([
      expect.objectContaining({ sessionId: "local-s1", tabId: 2 })
    ]);
  });

  it("explicit cleanup ungroups branded orphan groups without closing tabs", async () => {
    const h = harness([{ id: 1, windowId: 7, index: 0, groupId: 55 }]);
    h.groups.set(55, {
      id: 55,
      windowId: 7,
      title: "AIPageGo · MCP · stale1",
      color: "green"
    });

    const cleanedTabs = await h.manager.cleanupBySource("mcp");

    expect(cleanedTabs).toBe(1);
    expect(h.tabs.has(1)).toBe(true);
    expect(h.tabs.get(1)?.groupId).toBe(-1);
  });

  it("serializes a session release behind an in-flight claim", async () => {
    const h = harness([{ id: 1, windowId: 7, index: 3 }]);

    const claim = h.manager.claim({ sessionId: "s1", tabId: 1, source: "mcp" });
    const release = h.manager.releaseSession("s1");
    await Promise.all([claim, release]);

    expect(h.tabs.get(1)).toMatchObject({ groupId: -1, index: 3 });
    expect(h.stored()).toMatchObject({ claims: [], groups: [], detached: [] });
  });
});
