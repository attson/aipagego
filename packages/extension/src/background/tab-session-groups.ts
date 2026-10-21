export type TabSessionSource = "local" | "mcp" | "remote";
export type TabSessionStatus = "running" | "awaiting";

type TabClaim = {
  tabId: number;
  sessionId: string;
  windowId: number;
  groupId: number;
  originalGroupId: number;
  originalIndex: number;
  source: TabSessionSource;
};

type GroupRecord = {
  sessionId: string;
  windowId: number;
  groupId: number;
  source: TabSessionSource;
  status: TabSessionStatus;
};

type PersistedState = { claims: TabClaim[]; groups: GroupRecord[]; detached?: string[] };

type Deps = {
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  groupTabs(options: chrome.tabs.GroupOptions): Promise<number>;
  ungroupTabs(tabIds: number | number[]): Promise<void>;
  moveTab(tabId: number, move: chrome.tabs.MoveProperties): Promise<chrome.tabs.Tab | chrome.tabs.Tab[]>;
  getGroup(groupId: number): Promise<chrome.tabGroups.TabGroup>;
  queryGroups(query: chrome.tabGroups.QueryInfo): Promise<chrome.tabGroups.TabGroup[]>;
  queryTabs(query: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  updateGroup(groupId: number, update: chrome.tabGroups.UpdateProperties): Promise<chrome.tabGroups.TabGroup>;
  load(): Promise<PersistedState | undefined>;
  save(state: PersistedState): Promise<void>;
};

const STORAGE_KEY = "aipagego.tabSessionGroups";
const NO_GROUP = -1;

export class TabSessionGroupManager {
  private claims = new Map<number, TabClaim>();
  private groups = new Map<string, GroupRecord>();
  private detached = new Set<string>();
  private ready: Promise<void>;
  private operations: Promise<void> = Promise.resolve();

  constructor(private deps: Deps = chromeDeps()) {
    this.ready = this.hydrate();
  }

  claim(input: {
    sessionId: string;
    tabId: number;
    source: TabSessionSource;
    status?: TabSessionStatus;
  }): Promise<void> {
    return this.enqueue(() => this.claimNow(input));
  }

  private async claimNow(input: {
    sessionId: string;
    tabId: number;
    source: TabSessionSource;
    status?: TabSessionStatus;
  }): Promise<void> {
    if (this.detached.has(detachedKey(input.sessionId, input.tabId))) return;
    const existing = this.claims.get(input.tabId);
    if (existing?.sessionId === input.sessionId) {
      await this.setStatusNow(input.sessionId, input.status ?? "running");
      return;
    }
    if (existing) await this.releaseTabNow(input.tabId, true);

    const tab = await this.deps.getTab(input.tabId);
    if (tab.id == null) return;
    const originalGroupId = tab.groupId ?? NO_GROUP;
    const originalIndex = tab.index;
    const key = groupKey(input.sessionId, tab.windowId);
    let group = this.groups.get(key);
    let groupId: number;
    if (group) {
      try {
        await this.deps.getGroup(group.groupId);
        groupId = await this.deps.groupTabs({ groupId: group.groupId, tabIds: input.tabId });
      } catch {
        this.groups.delete(key);
        group = undefined;
        groupId = await this.deps.groupTabs({ tabIds: input.tabId });
      }
    } else {
      groupId = await this.deps.groupTabs({ tabIds: input.tabId });
    }

    const status = input.status ?? "running";
    const record: GroupRecord = {
      sessionId: input.sessionId,
      windowId: tab.windowId,
      groupId,
      source: input.source,
      status
    };
    this.groups.set(key, record);
    this.claims.set(input.tabId, {
      tabId: input.tabId,
      sessionId: input.sessionId,
      windowId: tab.windowId,
      groupId,
      originalGroupId,
      originalIndex,
      source: input.source
    });
    await this.decorate(record);
    await this.persist();
  }

  setStatus(sessionId: string, status: TabSessionStatus): Promise<void> {
    return this.enqueue(() => this.setStatusNow(sessionId, status));
  }

  private async setStatusNow(sessionId: string, status: TabSessionStatus): Promise<void> {
    const changed = [...this.groups.values()].filter((group) => group.sessionId === sessionId);
    for (const group of changed) {
      group.status = status;
      await this.decorate(group).catch(() => undefined);
    }
    if (changed.length) await this.persist();
  }

  releaseSession(sessionId: string): Promise<void> {
    return this.enqueue(() => this.releaseSessionNow(sessionId));
  }

  releaseBySource(source: TabSessionSource): Promise<void> {
    return this.enqueue(async () => {
      const sessionIds = new Set(
        [...this.claims.values()]
          .filter((claim) => claim.source === source)
          .map((claim) => claim.sessionId)
      );
      for (const sessionId of sessionIds) await this.releaseSessionNow(sessionId);
    });
  }

  /** Explicit user cleanup, including branded groups whose persisted claim was lost. */
  cleanupBySource(source: TabSessionSource): Promise<number> {
    return this.enqueue(async () => {
      const trackedTabIds = [...this.claims.values()]
        .filter((claim) => claim.source === source)
        .map((claim) => claim.tabId);
      const sessionIds = new Set(
        [...this.claims.values()]
          .filter((claim) => claim.source === source)
          .map((claim) => claim.sessionId)
      );
      for (const sessionId of sessionIds) await this.releaseSessionNow(sessionId);

      const cleaned = new Set(trackedTabIds);
      const prefix = `AIPageGo · ${sourceLabel(source)} ·`;
      const groups = await this.deps.queryGroups({});
      for (const group of groups) {
        if (!group.title?.startsWith(prefix)) continue;
        const tabs = await this.deps.queryTabs({ groupId: group.id });
        const tabIds = tabs.flatMap((tab) => tab.id == null ? [] : [tab.id]);
        if (tabIds.length === 0) continue;
        await this.deps.ungroupTabs(tabIds);
        for (const tabId of tabIds) cleaned.add(tabId);
      }
      return cleaned.size;
    });
  }

  private async releaseSessionNow(sessionId: string): Promise<void> {
    const tabIds = [...this.claims.values()]
      .filter((claim) => claim.sessionId === sessionId)
      .map((claim) => claim.tabId);
    for (const tabId of tabIds) await this.releaseTabNow(tabId, true);
    for (const [key, group] of this.groups) {
      if (group.sessionId === sessionId) this.groups.delete(key);
    }
    for (const key of this.detached) {
      if (key.startsWith(`${sessionId}:`)) this.detached.delete(key);
    }
    await this.persist();
  }

  releaseTab(tabId: number, restore: boolean): Promise<void> {
    return this.enqueue(() => this.releaseTabNow(tabId, restore));
  }

  private async releaseTabNow(tabId: number, restore: boolean): Promise<void> {
    const claim = this.claims.get(tabId);
    if (!claim) return;
    this.claims.delete(tabId);
    if (restore) await this.restore(claim);
    if (![...this.claims.values()].some((item) =>
      item.sessionId === claim.sessionId && item.windowId === claim.windowId
    )) {
      this.groups.delete(groupKey(claim.sessionId, claim.windowId));
    }
    await this.persist();
  }

  handleGroupChanged(tabId: number, groupId: number): Promise<void> {
    return this.enqueue(() => this.handleGroupChangedNow(tabId, groupId));
  }

  private async handleGroupChangedNow(tabId: number, groupId: number): Promise<void> {
    const claim = this.claims.get(tabId);
    if (!claim || claim.groupId === groupId) return;
    this.detached.add(detachedKey(claim.sessionId, tabId));
    await this.releaseTabNow(tabId, false);
  }

  snapshot(): PersistedState {
    return {
      claims: [...this.claims.values()],
      groups: [...this.groups.values()],
      detached: [...this.detached]
    };
  }

  private async hydrate(): Promise<void> {
    const stored = await this.deps.load().catch(() => undefined);
    for (const claim of stored?.claims ?? []) this.claims.set(claim.tabId, claim);
    for (const group of stored?.groups ?? []) this.groups.set(groupKey(group.sessionId, group.windowId), group);
    for (const key of stored?.detached ?? []) this.detached.add(key);

    for (const claim of [...this.claims.values()]) {
      try {
        const [tab] = await Promise.all([
          this.deps.getTab(claim.tabId),
          this.deps.getGroup(claim.groupId)
        ]);
        if (tab.groupId !== claim.groupId) this.claims.delete(claim.tabId);
      } catch {
        this.claims.delete(claim.tabId);
      }
    }
    for (const [key, group] of this.groups) {
      if (![...this.claims.values()].some((claim) =>
        claim.sessionId === group.sessionId && claim.windowId === group.windowId
      )) this.groups.delete(key);
    }
    await this.persist();
  }

  private async decorate(group: GroupRecord): Promise<void> {
    const status = group.status === "awaiting" ? " · 等待确认" : "";
    await this.deps.updateGroup(group.groupId, {
      title: `AIPageGo · ${sourceLabel(group.source)} · ${shortId(group.sessionId)}${status}`,
      color: sourceColor(group.source),
      collapsed: false
    });
  }

  private async restore(claim: TabClaim): Promise<void> {
    try {
      await this.deps.getTab(claim.tabId);
    } catch {
      return;
    }
    if (claim.originalGroupId !== NO_GROUP) {
      try {
        await this.deps.getGroup(claim.originalGroupId);
        await this.deps.groupTabs({ groupId: claim.originalGroupId, tabIds: claim.tabId });
      } catch {
        await this.deps.ungroupTabs(claim.tabId).catch(() => undefined);
      }
    } else {
      await this.deps.ungroupTabs(claim.tabId).catch(() => undefined);
    }
    await this.deps.moveTab(claim.tabId, { index: claim.originalIndex }).catch(() => undefined);
  }

  private persist(): Promise<void> {
    return this.deps.save(this.snapshot());
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operations.then(
      async () => {
        await this.ready;
        return operation();
      },
      async () => {
        await this.ready;
        return operation();
      }
    );
    this.operations = run.then(() => undefined, () => undefined);
    return run;
  }
}

function groupKey(sessionId: string, windowId: number): string {
  return `${sessionId}:${windowId}`;
}

function detachedKey(sessionId: string, tabId: number): string {
  return `${sessionId}:${tabId}`;
}

function shortId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "local";
}

function sourceLabel(source: TabSessionSource): string {
  return source === "local" ? "侧栏" : source === "mcp" ? "MCP" : "远程";
}

function sourceColor(source: TabSessionSource): chrome.tabGroups.ColorEnum {
  return source === "local" ? "blue" : source === "mcp" ? "green" : "purple";
}

function chromeDeps(): Deps {
  return {
    getTab: (tabId) => chrome.tabs.get(tabId),
    groupTabs: (options) => chrome.tabs.group(options),
    ungroupTabs: (tabIds) => chrome.tabs.ungroup(tabIds),
    moveTab: (tabId, move) => chrome.tabs.move(tabId, move),
    getGroup: (groupId) => chrome.tabGroups.get(groupId),
    queryGroups: (query) => chrome.tabGroups.query(query),
    queryTabs: (query) => chrome.tabs.query(query),
    updateGroup: (groupId, update) => chrome.tabGroups.update(groupId, update),
    load: async () => (await chrome.storage.session.get([STORAGE_KEY]))[STORAGE_KEY] as PersistedState | undefined,
    save: (state) => chrome.storage.session.set({ [STORAGE_KEY]: state })
  };
}
