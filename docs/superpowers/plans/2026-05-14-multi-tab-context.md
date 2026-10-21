# 多 tab 上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个 AIPageGo 会话有受控地访问多个浏览器 tab：通过 `@` 选 / AI `openTab`（含被动新开）/ AI `attachTab` 申请三种入口把 tab 纳入会话信任集合；现有 19 工具按可选 `tabId` 行为，新增 4 个控制面工具。

**Architecture:**
- 会话维度新增 `attachedTabs: AttachedTab[]`，存在 `SessionData` 上、跟着 closed-sessions 一起 5 分钟回收。
- runOneStep RPC 扩字段 `attachedTabIds`：sidepanel 把当前白名单一起带上，BG 用它做权限闸。
- BG `tab-watcher` 新增 `tabs.spawned / urlChanged / removed` 事件推送，sidepanel `cross-tab-events.ts` 翻译为 store mutation + 系统行。

**Tech Stack:** TypeScript 5 strict, React 18, zustand 4, zod 3, Vite 5 + @crxjs MV3, vitest + happy-dom + fake-indexeddb。

**Spec:** [`docs/superpowers/specs/2026-05-14-multi-tab-context-design.md`](../specs/2026-05-14-multi-tab-context-design.md)

---

## File Map

**Create:**
- `src/sidepanel/chat/cross-tab-events.ts` — 监听 BG 推送，更新 store + 推系统行
- `src/sidepanel/components/tab-chips-bar.tsx` — 顶部 chips 行
- `src/sidepanel/components/tab-picker.tsx` — 添加 tab 的 picker（modal/popover 复用）
- `src/sidepanel/components/system-event-row.tsx` — 灰色系统消息行
- 各测试文件镜像 `tests/...`

**Modify:**
- `src/shared/types.ts` — `AttachedTab` / `AttachedTabSource` / 扩 `SessionData`
- `src/shared/messages.ts` — `tabs.list`、`tabs.open` RPC、`runs.runOneStep` 加 `attachedTabIds`、新增 `TabEventBroadcast` schema
- `src/sidepanel/chat/session-store.ts` — `attachTab` / `detachTab` / `markAttachedUrlChanged` / `removeAttached` / `makeEmptySession` 默认值
- `src/sidepanel/chat/severity.ts` — 4 个新工具的分类
- `src/sidepanel/chat/run-session.ts` — 控制面工具拦截、`attachTab` 审批通道、把 `attachedTabIds` 注入 toolRunner
- `src/sidepanel/chat/tool-runner.ts` — 接受 `attachedTabIds` 并向 RPC 传递
- `src/sidepanel/llm/tool-schema.ts` — 19 个现有工具加可选 `tabId`、追加 4 个控制面工具
- `src/sidepanel/llm/system-prompt.ts` — 接 `attachedTabs`，输出 `[Attached tabs]` + `[Cross-tab protocol]`
- `src/sidepanel/rpc.ts` — `listTabs` / `openTab` wrappers，`runOneStep` 扩签名，新增 `onTabEvents`
- `src/sidepanel/pages/chat-page.tsx` — 挂 chips bar、`@` 检测、cross-tab-events 启停
- `src/sidepanel/pages/settings-page.tsx` — `attachTab` 加入 dangerous 白名单可勾选项
- `src/sidepanel/components/step-card.tsx` — 渲染 `→ Tab #N` 标签
- `src/sidepanel/components/chat-view.tsx` — 渲染 system-event-row（基于 ChatMessage 上的内嵌标记）
- `src/sidepanel/app.tsx` — boot 时校验 attached tabs
- `src/background/rpc-handlers.ts` — 新增 `tabs.list` / `tabs.open` 派发；`runOneStep` 权限闸
- `src/background/tab-watcher.ts` — 推送 `tabs.spawned / urlChanged / removed`
- `docs/superpowers/specs/README.md` 与 `docs/superpowers/plans/README.md` 索引更新

---

## Task 1: 数据模型 — `AttachedTab` 类型 + `SessionData.attachedTabs`

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/sidepanel/chat/session-store.ts:67-88`（`makeEmptySession`）
- Test: `tests/sidepanel/chat/session-store.test.ts`

- [ ] **Step 1: 加测试 — `makeEmptySession` 默认含空 `attachedTabs`**

在 `tests/sidepanel/chat/session-store.test.ts` 顶部 `describe("session-store per-tab", ...)` 内插入：

```ts
it("makeEmptySession seeds an empty attachedTabs list", () => {
  ensureSession(7, "https://x.com");
  const s = getSessionFor(7);
  expect(s.attachedTabs).toEqual([]);
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm vitest run tests/sidepanel/chat/session-store.test.ts -t "attachedTabs"
```

Expected: FAIL — `expect(s.attachedTabs).toEqual([])` 的 `s.attachedTabs` 当前为 `undefined`。

- [ ] **Step 3: 在 `src/shared/types.ts` 末尾追加类型**

```ts
export type AttachedTabSource = "mention" | "ai-open" | "approval";

export type AttachedTab = {
  tabId: number;
  windowId: number;
  source: AttachedTabSource;
  addedAt: number;
  lastSeenUrl: string;
  lastSeenTitle: string;
  urlChanged?: boolean;
};
```

- [ ] **Step 4: 在 `src/sidepanel/chat/session-store.ts` 顶部 import 新类型；扩 `SessionData` 与 `makeEmptySession`**

```ts
import type { AttachedTab, ChatMessage, Json, Step, ToolUsePart } from "@/shared/types";
```

`SessionData` 末尾加 `attachedTabs: AttachedTab[];`（紧贴 `inputDraft` 之后）。

`makeEmptySession` 返回对象末尾加 `attachedTabs: []`。

- [ ] **Step 5: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/chat/session-store.test.ts -t "attachedTabs"
```

Expected: PASS。

- [ ] **Step 6: 类型检查**

```
pnpm typecheck
```

Expected: 无新错误。

- [ ] **Step 7: 提交**

```bash
git add src/shared/types.ts src/sidepanel/chat/session-store.ts tests/sidepanel/chat/session-store.test.ts
git commit -m "feat(types): add AttachedTab + extend SessionData.attachedTabs"
```

---

## Task 2: Session-store actions — attach / detach / urlChanged / removeAttached

**Files:**
- Modify: `src/sidepanel/chat/session-store.ts`
- Test: `tests/sidepanel/chat/session-store.test.ts`

- [ ] **Step 1: 加测试 — attachTab 基本写入 + 重复保留首次 source**

在 `tests/sidepanel/chat/session-store.test.ts` 内追加 `describe`：

```ts
import {
  attachTab,
  detachTab,
  markAttachedUrlChanged,
  removeAttachedTab
} from "@/sidepanel/chat/session-store";

describe("attachedTabs actions", () => {
  beforeEach(reset);

  it("attachTab adds a tab with given source and metadata", () => {
    ensureSession(7, "https://main");
    attachTab(7, {
      tabId: 167,
      windowId: 1,
      source: "mention",
      lastSeenUrl: "https://taobao",
      lastSeenTitle: "TB"
    });
    const a = getSessionFor(7).attachedTabs;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      tabId: 167,
      source: "mention",
      lastSeenUrl: "https://taobao",
      lastSeenTitle: "TB"
    });
    expect(typeof a[0].addedAt).toBe("number");
  });

  it("attachTab on same tabId keeps first source", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u1", lastSeenTitle: "t1" });
    attachTab(7, { tabId: 167, windowId: 1, source: "ai-open", lastSeenUrl: "u2", lastSeenTitle: "t2" });
    const a = getSessionFor(7).attachedTabs;
    expect(a).toHaveLength(1);
    expect(a[0].source).toBe("mention");
    expect(a[0].lastSeenUrl).toBe("u1");
  });

  it("detachTab removes by tabId", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    detachTab(7, 167);
    expect(getSessionFor(7).attachedTabs).toEqual([]);
  });

  it("markAttachedUrlChanged sets urlChanged and updates lastSeenUrl/Title", () => {
    ensureSession(7, "https://main");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u1", lastSeenTitle: "t1" });
    markAttachedUrlChanged(7, 167, "u2", "t2");
    const a = getSessionFor(7).attachedTabs[0];
    expect(a.urlChanged).toBe(true);
    expect(a.lastSeenUrl).toBe("u2");
    expect(a.lastSeenTitle).toBe("t2");
  });

  it("removeAttachedTab affects every session that holds it", () => {
    ensureSession(7, "https://a");
    ensureSession(8, "https://b");
    attachTab(7, { tabId: 167, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    attachTab(8, { tabId: 167, windowId: 1, source: "approval", lastSeenUrl: "u", lastSeenTitle: "t" });
    removeAttachedTab(167);
    expect(getSessionFor(7).attachedTabs).toEqual([]);
    expect(getSessionFor(8).attachedTabs).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm vitest run tests/sidepanel/chat/session-store.test.ts -t "attachedTabs actions"
```

Expected: 五条 it 全部 FAIL（函数未导出）。

- [ ] **Step 3: 实现四个 actions**

在 `src/sidepanel/chat/session-store.ts` 文件 `pruneClosed` 之后追加：

```ts
export function attachTab(
  tabId: number,
  attached: Omit<AttachedTab, "addedAt" | "urlChanged">
): void {
  patchSession(tabId, (s) => {
    if (s.attachedTabs.some((a) => a.tabId === attached.tabId)) return s;
    return {
      ...s,
      attachedTabs: [
        ...s.attachedTabs,
        { ...attached, addedAt: Date.now() }
      ]
    };
  });
}

export function detachTab(tabId: number, attachedTabId: number): void {
  patchSession(tabId, (s) => {
    const next = s.attachedTabs.filter((a) => a.tabId !== attachedTabId);
    if (next.length === s.attachedTabs.length) return s;
    return { ...s, attachedTabs: next };
  });
}

export function markAttachedUrlChanged(
  sessionTabId: number,
  attachedTabId: number,
  newUrl: string,
  newTitle: string
): void {
  patchSession(sessionTabId, (s) => {
    const idx = s.attachedTabs.findIndex((a) => a.tabId === attachedTabId);
    if (idx === -1) return s;
    const next = s.attachedTabs.slice();
    next[idx] = { ...next[idx], lastSeenUrl: newUrl, lastSeenTitle: newTitle, urlChanged: true };
    return { ...s, attachedTabs: next };
  });
}

export function removeAttachedTab(attachedTabId: number): void {
  useStore.setState((state) => {
    let mutated = false;
    const sessionsByTab: Record<number, SessionData> = { ...state.sessionsByTab };
    for (const [k, s] of Object.entries(state.sessionsByTab)) {
      const next = s.attachedTabs.filter((a) => a.tabId !== attachedTabId);
      if (next.length !== s.attachedTabs.length) {
        sessionsByTab[Number(k)] = { ...s, attachedTabs: next };
        mutated = true;
      }
    }
    return mutated ? { ...state, sessionsByTab } : state;
  });
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/chat/session-store.test.ts -t "attachedTabs actions"
```

Expected: 5/5 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/chat/session-store.ts tests/sidepanel/chat/session-store.test.ts
git commit -m "feat(session-store): attachTab/detachTab/markUrlChanged/removeAttachedTab"
```

---

## Task 3: Severity for 4 control-plane tools

**Files:**
- Modify: `src/sidepanel/chat/severity.ts`
- Test: `tests/sidepanel/chat/severity.test.ts`

- [ ] **Step 1: 加测试**

在 `tests/sidepanel/chat/severity.test.ts` 末尾追加：

```ts
describe("control-plane tools", () => {
  it("listTabs / openTab / attachTab are caution", () => {
    expect(classifyTool("listTabs", {})).toBe("caution");
    expect(classifyTool("openTab", { url: "https://x" })).toBe("caution");
    expect(classifyTool("attachTab", { tabId: 1 })).toBe("caution");
  });

  it("detachTab is safe", () => {
    expect(classifyTool("detachTab", { tabId: 1 })).toBe("safe");
  });
});
```

- [ ] **Step 2: 运行测试验证失败**

```
pnpm vitest run tests/sidepanel/chat/severity.test.ts -t "control-plane"
```

Expected: 两条 it FAIL（落入默认 `dangerous` 分支）。

- [ ] **Step 3: 在 `src/sidepanel/chat/severity.ts` 的 `SAFE`/`CAUTION` 集合中加入新工具**

```ts
const SAFE = new Set([
  "snapshotDOM",
  "querySelector",
  "querySelectorAll",
  "extractText",
  "extractImages",
  "scroll",
  "waitFor",
  "hover",
  "focus",
  "getValue",
  "extractFormState",
  "detachTab"
]);

const CAUTION = new Set([
  "click",
  "fillInput",
  "setCheckbox",
  "selectOption",
  "listTabs",
  "openTab",
  "attachTab"
]);
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/chat/severity.test.ts
```

Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/chat/severity.ts tests/sidepanel/chat/severity.test.ts
git commit -m "feat(severity): classify listTabs/openTab/attachTab/detachTab"
```

---

## Task 4: LLM tool-schema — 加 `tabId` + 4 个控制面工具

**Files:**
- Modify: `src/sidepanel/llm/tool-schema.ts`
- Test: `tests/sidepanel/llm/tool-schema.test.ts`（创建）

- [ ] **Step 1: 加测试 — 现有工具 schema 接受可选 `tabId`，新工具齐全**

创建 `tests/sidepanel/llm/tool-schema.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";

describe("TOOL_DEFS", () => {
  it("has every existing tool's input_schema.properties.tabId optional integer", () => {
    const namesNeeded = [
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractText",
      "extractImages",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage",
      "fillInput",
      "setCheckbox",
      "selectOption",
      "submitForm",
      "hover",
      "focus",
      "uploadFile",
      "getValue",
      "extractFormState",
      "runJS"
    ];
    for (const name of namesNeeded) {
      const def = TOOL_DEFS.find((d) => d.name === name);
      expect(def, `missing tool ${name}`).toBeDefined();
      const props = (def!.input_schema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props.tabId, `${name} missing tabId`).toBeDefined();
      expect((props.tabId as { type: string }).type).toBe("integer");
      // tabId never appears in required
      const required = (def!.input_schema as { required?: string[] }).required ?? [];
      expect(required.includes("tabId")).toBe(false);
    }
  });

  it("declares the 4 control-plane tools", () => {
    for (const n of ["listTabs", "openTab", "attachTab", "detachTab"]) {
      expect(TOOL_DEFS.some((d) => d.name === n), `missing ${n}`).toBe(true);
    }
  });

  it("openTab requires url; attachTab/detachTab require tabId", () => {
    const openTab = TOOL_DEFS.find((d) => d.name === "openTab")!;
    expect((openTab.input_schema as { required: string[] }).required).toEqual(["url"]);
    const attachTab = TOOL_DEFS.find((d) => d.name === "attachTab")!;
    expect((attachTab.input_schema as { required: string[] }).required).toEqual(["tabId"]);
    const detachTab = TOOL_DEFS.find((d) => d.name === "detachTab")!;
    expect((detachTab.input_schema as { required: string[] }).required).toEqual(["tabId"]);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/sidepanel/llm/tool-schema.test.ts
```

Expected: 三条 FAIL。

- [ ] **Step 3: 在 `src/sidepanel/llm/tool-schema.ts` 每个现有工具的 `input_schema.properties` 末尾加 `tabId`**

模板（对所有现有 19 个工具执行同样加法）：

```ts
{
  name: "snapshotDOM",
  description: "...",
  input_schema: {
    type: "object",
    properties: {
      maxDepth: { type: "integer", default: 3 },
      root: { type: "string", description: "..." },
      tabId: { type: "integer", description: "目标 tab；省略=会话焦点 tab；必须先在 attachedTabs 中" }
    }
  }
}
```

对所有工具（含 `runJS`）的 `properties` 同样加 `tabId`。`required` 数组不变。

- [ ] **Step 4: 在 `TOOL_DEFS` 末尾追加 4 个控制面工具**

```ts
{
  name: "listTabs",
  description: "列出所有窗口的可访问 tab；返回 [{tabId, windowId, url, title, attached, isCurrent}]。仅在你需要识别新 tab 时调用。",
  input_schema: {
    type: "object",
    properties: {
      windowId: { type: "integer", description: "仅返回此窗口的 tab；省略=全部窗口" }
    }
  }
},
{
  name: "openTab",
  description: "打开新 tab，成功后自动加入会话 attachedTabs（source=ai-open）。返回 {tabId, url, title}。",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string" },
      active: { type: "boolean", default: false, description: "true=切到该 tab" }
    },
    required: ["url"]
  }
},
{
  name: "attachTab",
  description: "请求把某个已打开的 tab 纳入会话 attachedTabs；未预批准时会向用户索取审批。",
  input_schema: {
    type: "object",
    properties: {
      tabId: { type: "integer" },
      reason: { type: "string", description: "向用户解释为何需要访问该 tab" }
    },
    required: ["tabId"]
  }
},
{
  name: "detachTab",
  description: "从会话 attachedTabs 移除一个 tab；不关闭该 tab。",
  input_schema: {
    type: "object",
    properties: { tabId: { type: "integer" } },
    required: ["tabId"]
  }
}
```

- [ ] **Step 5: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/llm/tool-schema.test.ts
```

Expected: 全 PASS。

- [ ] **Step 6: typecheck**

```
pnpm typecheck
```

- [ ] **Step 7: 提交**

```bash
git add src/sidepanel/llm/tool-schema.ts tests/sidepanel/llm/tool-schema.test.ts
git commit -m "feat(tool-schema): optional tabId on all tools + listTabs/openTab/attachTab/detachTab defs"
```

---

## Task 5: System prompt — `[Attached tabs]` + `[Cross-tab protocol]`

**Files:**
- Modify: `src/sidepanel/llm/system-prompt.ts`
- Test: `tests/sidepanel/llm/system-prompt.test.ts`（创建）

- [ ] **Step 1: 加测试**

创建 `tests/sidepanel/llm/system-prompt.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { AttachedTab } from "@/shared/types";
import { buildSystemPrompt } from "@/sidepanel/llm/system-prompt";

function tab(tabId: number, url: string, source: AttachedTab["source"] = "mention"): AttachedTab {
  return { tabId, windowId: 1, source, lastSeenUrl: url, lastSeenTitle: "t", addedAt: 0 };
}

describe("buildSystemPrompt cross-tab", () => {
  it("omits attached section when none", () => {
    const out = buildSystemPrompt({ url: "https://main", attachedTabs: [] });
    expect(out).not.toContain("[Attached tabs]");
    expect(out).toContain("[Cross-tab protocol]");
  });

  it("lists attached tabs with id, url, source", () => {
    const out = buildSystemPrompt({
      url: "https://main",
      attachedTabs: [tab(167, "https://taobao", "mention"), tab(189, "https://tmall", "ai-open")]
    });
    expect(out).toContain("[Attached tabs]");
    expect(out).toContain("#167");
    expect(out).toContain("https://taobao");
    expect(out).toContain("source: mention");
    expect(out).toContain("#189");
    expect(out).toContain("source: ai-open");
  });

  it("truncates after 8 with a hint", () => {
    const many: AttachedTab[] = [];
    for (let i = 0; i < 12; i++) many.push(tab(100 + i, `https://t/${i}`));
    const out = buildSystemPrompt({ url: "https://main", attachedTabs: many });
    expect(out).toContain("#107");      // 8th
    expect(out).not.toContain("#108");  // 9th truncated
    expect(out).toMatch(/\+4 more, call listTabs/);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/sidepanel/llm/system-prompt.test.ts
```

Expected: 三条 FAIL。

- [ ] **Step 3: 改 `src/sidepanel/llm/system-prompt.ts`**

把 `buildSystemPrompt` 改成：

```ts
import type { AttachedTab } from "@/shared/types";

type SavedToolHint = { name: string; description: string; version: number };

export function buildSystemPrompt(input: {
  url: string;
  title?: string;
  savedTools?: SavedToolHint[];
  attachedTabs?: AttachedTab[];
}): string {
  const savedToolsSection =
    input.savedTools && input.savedTools.length > 0
      ? [
          "",
          "## 此页面已有以下保存的工具（URL 命中），用户可一键重放；如果用户的需求与某个工具吻合，主动建议：",
          ...input.savedTools.map(
            (t) => `- "${t.name}" (v${t.version})：${t.description || "(无描述)"}`
          )
        ]
      : [];

  const attached = input.attachedTabs ?? [];
  const visible = attached.slice(0, 8);
  const overflow = attached.length - visible.length;
  const attachedSection =
    attached.length > 0
      ? [
          "",
          "[Attached tabs]",
          ...visible.map(
            (a) =>
              `#${a.tabId} ${a.lastSeenUrl}  (source: ${a.source}${a.urlChanged ? ", url-changed" : ""})`
          ),
          ...(overflow > 0 ? [`+${overflow} more, call listTabs() for the full list`] : [])
        ]
      : [];

  const crossTabProtocol = [
    "",
    "[Cross-tab protocol]",
    "- Pass `tabId` in any tool input to act on a non-focused tab.",
    "- Allowed tabIds: the focused tab + the attached list above.",
    "- Call listTabs() to discover other open tabs.",
    "- Call attachTab(tabId) to request access; user must approve.",
    "- Call openTab(url) to spawn a new tab; it auto-attaches."
  ];

  return [
    "你是 AIPageGo，一个嵌入到浏览器侧边面板的 AI 网页助手。",
    // ... (保留原内容)
    `当前页面 URL: ${input.url}`,
    input.title ? `页面标题: ${input.title}` : "",
    ...savedToolsSection,
    ...attachedSection,
    ...crossTabProtocol
  ]
    .filter(Boolean)
    .join("\n");
}
```

完整文件保留原中文文案区块，只在末尾追加 `attachedSection` 和 `crossTabProtocol` 两段；其它行不动。

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/llm/system-prompt.test.ts
```

Expected: 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/llm/system-prompt.ts tests/sidepanel/llm/system-prompt.test.ts
git commit -m "feat(system-prompt): emit [Attached tabs] + [Cross-tab protocol] sections"
```

---

## Task 6: RPC schemas — `tabs.list` / `tabs.open` + `runs.runOneStep.attachedTabIds`

**Files:**
- Modify: `src/shared/messages.ts`
- Test: `tests/shared/messages.test.ts`

- [ ] **Step 1: 加测试**

在 `tests/shared/messages.test.ts` 末尾追加：

```ts
describe("multi-tab RPC variants", () => {
  it("tabs.list with optional windowId", () => {
    expect(RpcRequest.safeParse({ type: "tabs.list" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "tabs.list", windowId: 1 }).success).toBe(true);
  });

  it("tabs.open requires url", () => {
    expect(RpcRequest.safeParse({ type: "tabs.open", url: "https://x.com" }).success).toBe(true);
    expect(RpcRequest.safeParse({ type: "tabs.open" }).success).toBe(false);
    expect(RpcRequest.safeParse({ type: "tabs.open", url: "https://x", active: true }).success).toBe(true);
  });

  it("runs.runOneStep accepts attachedTabIds (defaults to [])", () => {
    const ok = RpcRequest.safeParse({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: {} },
      tabId: 1
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.attachedTabIds).toEqual([]);
    const ok2 = RpcRequest.safeParse({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: {} },
      tabId: 1,
      attachedTabIds: [167]
    });
    expect(ok2.success).toBe(true);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/shared/messages.test.ts -t "multi-tab"
```

Expected: 三条 it FAIL。

- [ ] **Step 3: 在 `src/shared/messages.ts` 的 `RpcRequest` discriminated union 中插入两条**

在 `http.fetchBinary` 之前追加：

```ts
z.object({
  type: z.literal("tabs.list"),
  windowId: z.number().int().optional()
}),
z.object({
  type: z.literal("tabs.open"),
  url: z.string().url(),
  active: z.boolean().optional()
}),
```

并把现有的 `runs.runOneStep` 替换为：

```ts
z.object({
  type: z.literal("runs.runOneStep"),
  step: StepSchema,
  tabId: z.number(),
  attachedTabIds: z.array(z.number()).default([]),
  bindings: z.record(z.unknown()).default({})
}),
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/shared/messages.test.ts
```

Expected: 全 PASS。

- [ ] **Step 5: typecheck**

```
pnpm typecheck
```

Expected: 不引入新错误（rpc-handlers.ts 的 `req.attachedTabIds` 会在后面 Task 9 用到，此处暂未引用所以 typecheck 不报错）。

- [ ] **Step 6: 提交**

```bash
git add src/shared/messages.ts tests/shared/messages.test.ts
git commit -m "feat(rpc): tabs.list / tabs.open variants + attachedTabIds on runs.runOneStep"
```

---

## Task 7: 后台 RPC handler — `tabs.list`

**Files:**
- Modify: `src/background/rpc-handlers.ts`
- Test: `tests/background/rpc-handlers.test.ts`

- [ ] **Step 1: 加测试**

在 `tests/background/rpc-handlers.test.ts` 内（已存在）追加：

```ts
describe("tabs.list", () => {
  it("returns tabs across windows, excluding chrome:// and incognito", async () => {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      ...globalThis.chrome,
      tabs: {
        ...globalThis.chrome?.tabs,
        query: async () => [
          { id: 1, windowId: 10, url: "https://a.com/x", title: "A", incognito: false },
          { id: 2, windowId: 10, url: "chrome://flags", title: "F", incognito: false },
          { id: 3, windowId: 11, url: "https://b.com",  title: "B", incognito: true },
          { id: 4, windowId: 11, url: "about:blank",    title: "",  incognito: false },
          { id: 5, windowId: 11, url: "https://c.com",  title: "C", incognito: false }
        ]
      }
    } as unknown as typeof chrome & { tabs: unknown };

    const res = await handleRpc({ type: "tabs.list" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const ids = (res.data as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId);
      expect(ids.sort()).toEqual([1, 5]);
    }
  });

  it("filters by windowId when provided", async () => {
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      ...globalThis.chrome,
      tabs: {
        ...globalThis.chrome?.tabs,
        query: async (q: chrome.tabs.QueryInfo) => {
          const all = [
            { id: 1, windowId: 10, url: "https://a.com", title: "A", incognito: false },
            { id: 2, windowId: 11, url: "https://b.com", title: "B", incognito: false }
          ];
          return q.windowId == null ? all : all.filter((t) => t.windowId === q.windowId);
        }
      }
    } as unknown as typeof chrome & { tabs: unknown };

    const res = await handleRpc({ type: "tabs.list", windowId: 11 });
    if (res.ok) {
      expect((res.data as { tabs: Array<{ tabId: number }> }).tabs.map((t) => t.tabId)).toEqual([2]);
    }
  });
});
```

如有现成 chrome mock helper 复用之；否则就地 stub（参考既有 test 风格）。

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "tabs.list"
```

Expected: FAIL — 缺 `tabs.list` case。

- [ ] **Step 3: 实现 `tabs.list` 派发**

在 `src/background/rpc-handlers.ts` 的 `dispatch` switch 中追加：

```ts
case "tabs.list":
  return (await listTabsRpc(req.windowId)) as unknown as Json;
```

并在文件末尾加：

```ts
async function listTabsRpc(windowId?: number): Promise<{
  tabs: Array<{ tabId: number; windowId: number; url: string; title: string }>;
}> {
  const query: chrome.tabs.QueryInfo = windowId == null ? {} : { windowId };
  const all = await chrome.tabs.query(query);
  const tabs = all
    .filter((t) => t.id != null && !t.incognito && isAccessibleUrl(t.url ?? ""))
    .map((t) => ({
      tabId: t.id as number,
      windowId: t.windowId,
      url: t.url ?? "",
      title: t.title ?? ""
    }));
  return { tabs };
}

function isAccessibleUrl(url: string): boolean {
  if (!url) return false;
  return /^https?:|^file:|^ftp:/.test(url);
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "tabs.list"
```

Expected: 两条 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/background/rpc-handlers.ts tests/background/rpc-handlers.test.ts
git commit -m "feat(bg): handle tabs.list RPC (excludes chrome:// / incognito)"
```

---

## Task 8: 后台 RPC handler — `tabs.open`

**Files:**
- Modify: `src/background/rpc-handlers.ts`
- Test: `tests/background/rpc-handlers.test.ts`

- [ ] **Step 1: 加测试**

```ts
describe("tabs.open", () => {
  it("creates a tab via chrome.tabs.create and returns {tabId, url, title}", async () => {
    const created: unknown[] = [];
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      ...globalThis.chrome,
      tabs: {
        ...globalThis.chrome?.tabs,
        create: async (info: chrome.tabs.CreateProperties) => {
          created.push(info);
          return { id: 42, windowId: 1, url: info.url ?? "", title: "" };
        }
      }
    } as unknown as typeof chrome & { tabs: unknown };
    const res = await handleRpc({ type: "tabs.open", url: "https://x.com" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      const d = res.data as { tabId: number; url: string };
      expect(d.tabId).toBe(42);
      expect(d.url).toBe("https://x.com");
    }
    expect(created).toHaveLength(1);
  });

  it("rejects chrome:// / about: URLs", async () => {
    const res = await handleRpc({ type: "tabs.open", url: "chrome://flags" });
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "tabs.open"
```

Expected: FAIL（zod 实际会拒 `chrome://flags`，因为 `z.string().url()` 接受它——具体看实际行为。如果 zod 接受则第二条会断 ok=false 失败，落到下面的代码闸里）。

- [ ] **Step 3: 实现 `tabs.open` 派发**

`dispatch` switch 加：

```ts
case "tabs.open":
  return (await openTabRpc(req.url, req.active ?? false)) as unknown as Json;
```

末尾加：

```ts
async function openTabRpc(url: string, active: boolean): Promise<{
  tabId: number; url: string; title: string;
}> {
  if (!isAccessibleUrl(url)) throw new Error("openTab: URL scheme not allowed");
  const tab = await chrome.tabs.create({ url, active });
  if (tab.id == null) throw new Error("openTab: chrome did not return a tab id");
  return { tabId: tab.id, url: tab.url ?? url, title: tab.title ?? "" };
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "tabs.open"
```

Expected: 两条 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/background/rpc-handlers.ts tests/background/rpc-handlers.test.ts
git commit -m "feat(bg): handle tabs.open RPC; reject chrome:// scheme"
```

---

## Task 9: 后台 runOneStep — 权限闸

**Files:**
- Modify: `src/background/rpc-handlers.ts`
- Test: `tests/background/rpc-handlers.test.ts`

- [ ] **Step 1: 加测试**

```ts
describe("runs.runOneStep tabId gate", () => {
  it("rejects tabId not in attachedTabIds and not equal to RPC.tabId", async () => {
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: 999 } },
      tabId: 1,
      attachedTabIds: [2, 3]
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/tab 999 not attached/);
  });

  it("accepts args.tabId in attachedTabIds (dispatches to that tab)", async () => {
    const sends: Array<{ tabId: number }> = [];
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      ...globalThis.chrome,
      tabs: {
        ...globalThis.chrome?.tabs,
        sendMessage: async (tabId: number) => {
          sends.push({ tabId });
          return { ok: true, data: null };
        }
      }
    } as unknown as typeof chrome & { tabs: unknown };
    const res = await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "tool", tool: "snapshotDOM", args: { tabId: 2 } },
      tabId: 1,
      attachedTabIds: [2, 3]
    });
    expect(res.ok).toBe(true);
    expect(sends[0].tabId).toBe(2);
  });

  it("kind=js never uses args.tabId; always RPC.tabId", async () => {
    const sends: Array<{ tabId: number }> = [];
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      ...globalThis.chrome,
      tabs: {
        ...globalThis.chrome?.tabs,
        sendMessage: async (tabId: number) => { sends.push({ tabId }); return { ok: true, data: null }; }
      }
    } as unknown as typeof chrome & { tabs: unknown };
    await handleRpc({
      type: "runs.runOneStep",
      step: { kind: "js", source: "return 1" },
      tabId: 1,
      attachedTabIds: [2]
    });
    expect(sends[0].tabId).toBe(1);
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "runs.runOneStep tabId gate"
```

Expected: FAIL — 三条都没有目标 tab 解析逻辑。

- [ ] **Step 3: 改 `runs.runOneStep` 派发与 `runOneStep` 函数签名**

把 `dispatch` 里的 `runs.runOneStep` 替换为：

```ts
case "runs.runOneStep": {
  return (await runOneStep(
    req.step as Step,
    req.tabId,
    req.attachedTabIds,
    req.bindings as Record<string, Json>
  )) as unknown as Json;
}
```

然后把 `runOneStep` 函数改为：

```ts
async function runOneStep(
  step: Step,
  rpcTabId: number,
  attachedTabIds: number[],
  bindings: Record<string, Json>
): Promise<Json> {
  // 解析目标 tab
  let targetTabId = rpcTabId;
  if (step.kind === "tool") {
    const argsObj = (step.args ?? {}) as Record<string, Json>;
    const declared = argsObj.tabId;
    if (typeof declared === "number") targetTabId = declared;
  }
  if (targetTabId !== rpcTabId && !attachedTabIds.includes(targetTabId)) {
    throw new Error(`tab ${targetTabId} not attached; call attachTab first or omit tabId`);
  }

  const stepReq = ContentRequestSchema.parse({
    type: "content.runStep",
    step,
    bindings
  });
  let res: { ok: true; data: Json } | { ok: false; error: string };
  try {
    res = (await chrome.tabs.sendMessage(targetTabId, stepReq)) as typeof res;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!isReceiverMissing(msg)) throw e;
    const injected = await injectContentScript(targetTabId);
    if (!injected) {
      throw new Error(
        "Content script 无法注入到此页面（可能是 chrome:// 或受限页面）。请在普通网页上重试。"
      );
    }
    res = await retryUntilReady(targetTabId, stepReq);
  }
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/background/rpc-handlers.test.ts -t "runs.runOneStep"
```

Expected: 三条 PASS（注意已有的 runOneStep 测试也得继续通过，因为 attachedTabIds 默认 `[]` 且仅当 tabId 偏离 rpcTabId 时才校验）。

- [ ] **Step 5: typecheck**

```
pnpm typecheck
```

- [ ] **Step 6: 提交**

```bash
git add src/background/rpc-handlers.ts tests/background/rpc-handlers.test.ts
git commit -m "feat(bg): permission gate on runs.runOneStep via attachedTabIds"
```

---

## Task 10: sidepanel rpc.ts — `listTabs` / `openTab` + extend `runOneStep`

**Files:**
- Modify: `src/sidepanel/rpc.ts`
- Test:（可选）小整合在 task 13 覆盖

- [ ] **Step 1: 改 `src/sidepanel/rpc.ts`**

在 `rpc` 对象中追加：

```ts
listTabs: (windowId?: number) =>
  call<{ tabs: Array<{ tabId: number; windowId: number; url: string; title: string }> }>({
    type: "tabs.list",
    ...(windowId == null ? {} : { windowId })
  }),
openTab: (url: string, active?: boolean) =>
  call<{ tabId: number; url: string; title: string }>({
    type: "tabs.open",
    url,
    ...(active == null ? {} : { active })
  }),
```

并把 `runOneStep` 改为接受可选 `attachedTabIds`：

```ts
runOneStep: (input: {
  step: Step;
  tabId: number;
  attachedTabIds?: number[];
  bindings?: Record<string, Json>;
}) =>
  call<Json>({
    type: "runs.runOneStep",
    step: input.step,
    tabId: input.tabId,
    attachedTabIds: input.attachedTabIds ?? [],
    bindings: input.bindings ?? {}
  }),
```

- [ ] **Step 2: typecheck**

```
pnpm typecheck
```

Expected: 现有调用站点 `runOneStep({ step, tabId, bindings })` 仍合法（`attachedTabIds` 可选）。

- [ ] **Step 3: 提交**

```bash
git add src/sidepanel/rpc.ts
git commit -m "feat(sidepanel/rpc): listTabs/openTab + attachedTabIds on runOneStep"
```

---

## Task 11: tab-watcher 推送 `tabs.spawned` / `tabs.urlChanged` / `tabs.removed`

**Files:**
- Modify: `src/background/tab-watcher.ts`
- Test: `tests/background/tab-watcher.test.ts`

- [ ] **Step 1: 加测试**

参照 `tests/background/tab-watcher.test.ts` 现有 stub 风格，追加：

```ts
describe("tab-watcher new events", () => {
  it("broadcasts tabs.spawned on chrome.tabs.onCreated", async () => {
    const sent: unknown[] = [];
    let createdCb: ((tab: chrome.tabs.Tab) => void) | null = null;
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      runtime: { sendMessage: async (m: unknown) => { sent.push(m); } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: () => {} },
        onCreated: { addListener: (cb: (t: chrome.tabs.Tab) => void) => { createdCb = cb; } }
      },
      webNavigation: { onHistoryStateUpdated: { addListener: () => {} } }
    } as unknown as typeof chrome;
    installTabWatcher();
    createdCb!({
      id: 200, windowId: 1, url: "https://x", title: "X",
      openerTabId: 100, incognito: false
    } as chrome.tabs.Tab);
    expect(sent.find((m) => (m as { type?: string }).type === "tabs.spawned")).toMatchObject({
      type: "tabs.spawned",
      tabId: 200,
      openerTabId: 100,
      url: "https://x",
      windowId: 1
    });
  });

  it("broadcasts tabs.urlChanged on chrome.tabs.onUpdated with status=complete + url present", async () => {
    const sent: unknown[] = [];
    let updatedCb: ((tabId: number, change: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => void) | null = null;
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      runtime: { sendMessage: async (m: unknown) => { sent.push(m); } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {
        onUpdated: { addListener: (cb: typeof updatedCb) => { updatedCb = cb; } },
        onRemoved: { addListener: () => {} },
        onCreated: { addListener: () => {} }
      },
      webNavigation: { onHistoryStateUpdated: { addListener: () => {} } }
    } as unknown as typeof chrome;
    installTabWatcher();
    updatedCb!(167, { status: "complete", url: "https://new" }, {
      id: 167, url: "https://new", title: "NEW"
    } as chrome.tabs.Tab);
    expect(sent.find((m) => (m as { type?: string }).type === "tabs.urlChanged")).toMatchObject({
      type: "tabs.urlChanged",
      tabId: 167,
      newUrl: "https://new",
      newTitle: "NEW"
    });
  });

  it("broadcasts tabs.removed on chrome.tabs.onRemoved", async () => {
    const sent: unknown[] = [];
    let removedCb: ((tabId: number) => void) | null = null;
    (globalThis as unknown as { chrome: typeof chrome }).chrome = {
      runtime: { sendMessage: async (m: unknown) => { sent.push(m); } },
      action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      tabs: {
        onUpdated: { addListener: () => {} },
        onRemoved: { addListener: (cb: (id: number) => void) => { removedCb = cb; } },
        onCreated: { addListener: () => {} }
      },
      webNavigation: { onHistoryStateUpdated: { addListener: () => {} } }
    } as unknown as typeof chrome;
    installTabWatcher();
    removedCb!(167);
    expect(sent.find((m) => (m as { type?: string }).type === "tabs.removed")).toMatchObject({
      type: "tabs.removed",
      tabId: 167
    });
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/background/tab-watcher.test.ts -t "new events"
```

Expected: 三条 FAIL。

- [ ] **Step 3: 改 `src/background/tab-watcher.ts`**

```ts
import { matchingTools } from "./storage/tools";

export async function refreshRecommendations(tabId: number, url: string): Promise<void> {
  // ... (保留原实现)
}

export function installTabWatcher(): void {
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url) void refreshRecommendations(tabId, change.url);
    if (change.status === "complete" && (change.url || tab.url)) {
      void broadcast({
        type: "tabs.urlChanged",
        tabId,
        newUrl: change.url ?? tab.url ?? "",
        newTitle: tab.title ?? ""
      });
    }
  });
  chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, url }) => {
    void refreshRecommendations(tabId, url);
    void broadcast({ type: "tabs.urlChanged", tabId, newUrl: url, newTitle: "" });
  });
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id == null) return;
    void broadcast({
      type: "tabs.spawned",
      tabId: tab.id,
      openerTabId: tab.openerTabId ?? null,
      windowId: tab.windowId,
      url: tab.url ?? "",
      title: tab.title ?? ""
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    void broadcast({ type: "tabs.removed", tabId });
  });
}

async function broadcast(msg: unknown): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch {
    // sidepanel 不在听就 swallow
  }
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/background/tab-watcher.test.ts
```

Expected: 全 PASS（含原有 case）。

- [ ] **Step 5: 提交**

```bash
git add src/background/tab-watcher.ts tests/background/tab-watcher.test.ts
git commit -m "feat(bg/tab-watcher): broadcast tabs.spawned/urlChanged/removed"
```

---

## Task 12: sidepanel — `onTabEvents` + `cross-tab-events.ts`

**Files:**
- Modify: `src/sidepanel/rpc.ts`
- Create: `src/sidepanel/chat/cross-tab-events.ts`
- Test: `tests/sidepanel/chat/cross-tab-events.test.ts`

- [ ] **Step 1: 在 `src/sidepanel/rpc.ts` 加 `onTabEvents` listener**

文件末尾新增（紧贴 `onTabRecommendations` 之后）：

```ts
export type TabEvent =
  | { type: "tabs.spawned"; tabId: number; openerTabId: number | null; windowId: number; url: string; title: string }
  | { type: "tabs.urlChanged"; tabId: number; newUrl: string; newTitle: string }
  | { type: "tabs.removed"; tabId: number };

export function onTabEvents(cb: (ev: TabEvent) => void): () => void {
  const listener = (msg: unknown) => {
    if (typeof msg !== "object" || msg === null) return;
    const t = (msg as { type?: string }).type;
    if (t === "tabs.spawned" || t === "tabs.urlChanged" || t === "tabs.removed") {
      cb(msg as TabEvent);
    }
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
```

- [ ] **Step 2: 加测试**

创建 `tests/sidepanel/chat/cross-tab-events.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  attachTab,
  ensureSession,
  getSessionFor,
  setCurrentTab,
  useStore
} from "@/sidepanel/chat/session-store";
import { handleTabEvent } from "@/sidepanel/chat/cross-tab-events";

function reset() {
  useStore.setState({ sessionsByTab: {}, closedSessions: [], currentTabId: null });
}

describe("handleTabEvent", () => {
  beforeEach(reset);

  it("tabs.spawned auto-attaches to session whose main or attached tab is opener", () => {
    ensureSession(100, "https://main");
    setCurrentTab(100);
    handleTabEvent({
      type: "tabs.spawned",
      tabId: 200,
      openerTabId: 100,
      windowId: 1,
      url: "https://child",
      title: "Child"
    });
    const a = getSessionFor(100).attachedTabs;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ tabId: 200, source: "ai-open", lastSeenUrl: "https://child" });
    // system message appended
    const last = getSessionFor(100).messages.at(-1);
    expect(JSON.stringify(last)).toMatch(/AI 在 #200/);
  });

  it("tabs.spawned with non-matching opener is ignored", () => {
    ensureSession(100, "https://main");
    handleTabEvent({
      type: "tabs.spawned",
      tabId: 200,
      openerTabId: 999,
      windowId: 1,
      url: "https://child",
      title: "Child"
    });
    expect(getSessionFor(100).attachedTabs).toEqual([]);
  });

  it("tabs.urlChanged on an attached tab sets urlChanged", () => {
    ensureSession(100, "https://main");
    attachTab(100, {
      tabId: 200,
      windowId: 1,
      source: "mention",
      lastSeenUrl: "https://old",
      lastSeenTitle: "Old"
    });
    handleTabEvent({ type: "tabs.urlChanged", tabId: 200, newUrl: "https://new", newTitle: "New" });
    const a = getSessionFor(100).attachedTabs[0];
    expect(a.urlChanged).toBe(true);
    expect(a.lastSeenUrl).toBe("https://new");
  });

  it("tabs.removed detaches and emits system row", () => {
    ensureSession(100, "https://main");
    // seed a message so closed-tab system message is allowed (appendSystemNote ignores empty)
    useStore.setState((state) => ({
      ...state,
      sessionsByTab: {
        ...state.sessionsByTab,
        100: {
          ...state.sessionsByTab[100],
          messages: [{ role: "user", content: "hi" }]
        }
      }
    }));
    attachTab(100, {
      tabId: 200, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t"
    });
    handleTabEvent({ type: "tabs.removed", tabId: 200 });
    expect(getSessionFor(100).attachedTabs).toEqual([]);
    expect(JSON.stringify(getSessionFor(100).messages.at(-1))).toMatch(/Tab #200 已关闭/);
  });
});
```

- [ ] **Step 3: 运行验证失败**

```
pnpm vitest run tests/sidepanel/chat/cross-tab-events.test.ts
```

Expected: 四条 FAIL（文件未存在）。

- [ ] **Step 4: 实现 `src/sidepanel/chat/cross-tab-events.ts`**

```ts
import type { TabEvent } from "../rpc";
import {
  appendSystemNote,
  attachTab,
  detachTab,
  markAttachedUrlChanged,
  removeAttachedTab,
  useStore
} from "./session-store";

export function handleTabEvent(ev: TabEvent): void {
  switch (ev.type) {
    case "tabs.spawned": {
      if (ev.openerTabId == null) return;
      const sessions = useStore.getState().sessionsByTab;
      for (const [sidStr, s] of Object.entries(sessions)) {
        const sid = Number(sidStr);
        const owns =
          sid === ev.openerTabId ||
          s.attachedTabs.some((a) => a.tabId === ev.openerTabId);
        if (!owns) continue;
        attachTab(sid, {
          tabId: ev.tabId,
          windowId: ev.windowId,
          source: "ai-open",
          lastSeenUrl: ev.url,
          lastSeenTitle: ev.title
        });
        appendSystemNote(sid, `🆕 AI 在 #${ev.tabId} 打开了 ${truncate(ev.url, 80)}`);
      }
      return;
    }
    case "tabs.urlChanged": {
      const sessions = useStore.getState().sessionsByTab;
      for (const [sidStr, s] of Object.entries(sessions)) {
        const sid = Number(sidStr);
        if (s.attachedTabs.some((a) => a.tabId === ev.tabId)) {
          markAttachedUrlChanged(sid, ev.tabId, ev.newUrl, ev.newTitle);
        }
      }
      return;
    }
    case "tabs.removed": {
      const sessions = useStore.getState().sessionsByTab;
      for (const [sidStr, s] of Object.entries(sessions)) {
        const sid = Number(sidStr);
        if (s.attachedTabs.some((a) => a.tabId === ev.tabId)) {
          appendSystemNote(sid, `🗑 Tab #${ev.tabId} 已关闭`);
        }
      }
      removeAttachedTab(ev.tabId);
      // detachTab loops are subsumed by removeAttachedTab
      void detachTab;
      return;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
```

- [ ] **Step 5: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/chat/cross-tab-events.test.ts
```

Expected: 4/4 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/sidepanel/rpc.ts src/sidepanel/chat/cross-tab-events.ts tests/sidepanel/chat/cross-tab-events.test.ts
git commit -m "feat(sidepanel): onTabEvents + cross-tab-events handler"
```

---

## Task 13: tool-runner / run-session — 控制面工具拦截 + 注入 attachedTabIds

**Files:**
- Modify: `src/sidepanel/chat/tool-runner.ts`
- Modify: `src/sidepanel/chat/run-session.ts`
- Test: `tests/sidepanel/chat/run-session.test.ts`

- [ ] **Step 1: 检查 `src/sidepanel/chat/tool-runner.ts` 当前实现**

```
cat src/sidepanel/chat/tool-runner.ts
```

确认其当前签名为 `runStep(step: Step, tabId: number, bindings: Record<string, Json>)`。

- [ ] **Step 2: 改 `tool-runner.ts` 的 `RpcToolRunner.runStep` 增加 `attachedTabIds` 参数**

```ts
export type ToolRunner = {
  runStep: (
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ) => Promise<Json>;
};

export class RpcToolRunner implements ToolRunner {
  async runStep(
    step: Step,
    tabId: number,
    attachedTabIds: number[],
    bindings: Record<string, Json>
  ): Promise<Json> {
    return rpc.runOneStep({ step, tabId, attachedTabIds, bindings });
  }
}
```

- [ ] **Step 3: 加测试 — run-session 拦截 4 个控制面工具**

在 `tests/sidepanel/chat/run-session.test.ts` 内追加（**复用文件顶部既有的 `makeClient` / `makeRunner` / `Approver` / `vi` 引用**）：

```ts
describe("control-plane tools", () => {
  it("listTabs is handled by tabsRpc and does not go to runner", async () => {
    let runnerCalls = 0;
    let listTabsCalls = 0;

    const client = makeClient([
      [
        { type: "tool_use_start", id: "u1", name: "listTabs" },
        { type: "tool_use_input_delta", id: "u1", partial_json: "{}" },
        { type: "tool_use_end", id: "u1", input: {} },
        { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
      ],
      [
        { type: "text_delta", text: "done" },
        { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
      ]
    ]);
    const runner = makeRunner(async () => { runnerCalls++; return null; });
    const approver = new Approver();
    const rpc = {
      startSession: vi.fn().mockResolvedValue({ id: "run-1" }),
      appendStepLog: vi.fn().mockResolvedValue(null),
      finalizeSession: vi.fn().mockResolvedValue(null)
    };
    const tabsRpc = {
      listTabs: vi.fn(async () => {
        listTabsCalls++;
        return { tabs: [{ tabId: 1, windowId: 1, url: "u", title: "t" }] };
      }),
      openTab: vi.fn()
    };
    const result = await runChatSession({
      client,
      runner,
      approver,
      rpc,
      input: { userPrompt: "go", tabId: 7, url: "https://x/" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5, autoApproveDangerous: [] },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true,
      attachedTabIds: [],
      tabsRpc
    });

    expect(result.status).toBe("done");
    expect(runnerCalls).toBe(0);
    expect(listTabsCalls).toBe(1);
  });

  it("openTab calls tabsRpc.openTab and emits onCrossTabResult", async () => {
    const client = makeClient([
      [
        { type: "tool_use_start", id: "u2", name: "openTab" },
        { type: "tool_use_input_delta", id: "u2", partial_json: '{"url":"https://new"}' },
        { type: "tool_use_end", id: "u2", input: { url: "https://new" } },
        { type: "message_end" }
      ],
      [{ type: "text_delta", text: "ok" }, { type: "message_end" }]
    ]);
    const runner = makeRunner(async () => null);
    const approver = new Approver();
    const rpc = {
      startSession: vi.fn().mockResolvedValue({ id: "run-2" }),
      appendStepLog: vi.fn().mockResolvedValue(null),
      finalizeSession: vi.fn().mockResolvedValue(null)
    };
    const tabsRpc = {
      listTabs: vi.fn(),
      openTab: vi.fn(async () => ({ tabId: 99, url: "https://new", title: "" }))
    };
    const events: unknown[] = [];

    await runChatSession({
      client, runner, approver, rpc,
      input: { userPrompt: "go", tabId: 7, url: "https://x/" },
      settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5, autoApproveDangerous: ["openTab"] },
      systemPrompt: "sys",
      tools: [],
      approveAllSafe: true,
      attachedTabIds: [],
      tabsRpc,
      onCrossTabResult: (r) => events.push(r)
    });

    expect(tabsRpc.openTab).toHaveBeenCalledWith("https://new", undefined);
    expect(events).toContainEqual({ kind: "opened", tabId: 99, url: "https://new", title: "" });
  });
});
```

注：第二个 it 用 `autoApproveDangerous: ["openTab"]` 跳过人工审批；第一个 it 走 `approveAllSafe: true`，但 `listTabs` 是 caution，仍需要审批 → 这里我们让 caution 一并被 `approveAllSafe` 接受，等同既有 readStorage 测试模式。如果实现里 caution 不自动通过则需要把 `autoApproveDangerous: ["listTabs"]` 也加上（保险起见，可在两个 case 里都加 `["listTabs","openTab"]`）。

- [ ] **Step 4: 在 `src/sidepanel/chat/run-session.ts` 加 DI 字段 `tabsRpc`，并在 tool dispatch 处拦截 4 个控制面工具**

把 `RunSessionArgs` 加：

```ts
export type CrossTabRpc = {
  listTabs: (windowId?: number) => Promise<{ tabs: Array<{ tabId: number; windowId: number; url: string; title: string }> }>;
  openTab: (url: string, active?: boolean) => Promise<{ tabId: number; url: string; title: string }>;
};

export type RunSessionArgs = {
  // ... 现有字段
  tabsRpc: CrossTabRpc;
  attachedTabIds: number[];
  onCrossTabResult?: (result: { kind: "attached" | "detached" | "opened"; tabId: number; url?: string; title?: string; windowId?: number }) => void;
};
```

`tabsRpc` / `attachedTabIds` / `onCrossTabResult` 都新增；调用方（chat-page.tsx）后续在 Task 17 填。

在 `for (const tu of completedToolUses) { ... }` 内、`classifyTool` 之后但**在严重性/审批之前**，先拦截控制面工具（注意 `attachTab` 仍要先过审批，再拦截执行）：

```ts
// Decision flow per tu
const sev = classifyTool(tu.name, tu.input);
let decision: { kind: "run" | "skip" | "deny" };
if (autoApproves(sev, tu.name, args.approveAllSafe, args.settings.autoApproveDangerous)) {
  decision = { kind: "run" };
} else {
  decision = await args.approver.request(tu.id);
}

if (decision.kind === "deny") { /* same as before */ }
if (decision.kind === "skip") { /* same as before */ }

args.onEvent?.({ type: "tool_running", id: tu.id });

// Cross-tab control-plane fast path: handled by sidepanel, not by runner
if (tu.name === "listTabs" || tu.name === "openTab" || tu.name === "attachTab" || tu.name === "detachTab") {
  const start = Date.now();
  try {
    let out: Json;
    switch (tu.name) {
      case "listTabs": {
        const r = await args.tabsRpc.listTabs((tu.input as { windowId?: number }).windowId);
        out = r as unknown as Json;
        break;
      }
      case "openTab": {
        const r = await args.tabsRpc.openTab(
          (tu.input as { url: string }).url,
          (tu.input as { active?: boolean }).active
        );
        out = r as unknown as Json;
        args.onCrossTabResult?.({
          kind: "opened",
          tabId: r.tabId,
          url: r.url,
          title: r.title
        });
        break;
      }
      case "attachTab": {
        const tabId = (tu.input as { tabId: number }).tabId;
        out = { ok: true, tabId } as unknown as Json;
        args.onCrossTabResult?.({ kind: "attached", tabId });
        break;
      }
      case "detachTab": {
        const tabId = (tu.input as { tabId: number }).tabId;
        out = { ok: true, tabId } as unknown as Json;
        args.onCrossTabResult?.({ kind: "detached", tabId });
        break;
      }
    }
    const ms = Date.now() - start;
    await args.rpc.appendStepLog(runRecordId, {
      stepIndex: stepIndexGlobal++,
      input: tu.input,
      output: out,
      ms
    });
    results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
    lastOutput = out;
    args.onEvent?.({ type: "tool_done", id: tu.id, output: out, ms });
  } catch (e) {
    const ms = Date.now() - start;
    const errStr = e instanceof Error ? e.message : String(e);
    await args.rpc.appendStepLog(runRecordId, {
      stepIndex: stepIndexGlobal++,
      input: tu.input, output: null, ms, error: errStr
    });
    results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify({ error: errStr }), is_error: true });
    args.onEvent?.({ type: "tool_error", id: tu.id, error: errStr, ms });
  }
  continue;
}

// 现有 tool-runner 派发：把 attachedTabIds 传下去
const step: Step =
  tu.name === "runJS"
    ? { kind: "js", source: (tu.input as { source: string }).source }
    : { kind: "tool", tool: tu.name as BuiltinTool, args: tu.input };

const start = Date.now();
try {
  const out = await args.runner.runStep(step, args.input.tabId, args.attachedTabIds, {});
  // ... 其余逻辑不变
}
```

注：`attachTab` 在用户审批"允许"后才走到这里；attach 行为本身在 `onCrossTabResult` 回调里由 sidepanel 修改 store（Task 14 / 17 联动）。

- [ ] **Step 5: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/chat/run-session.test.ts -t "control-plane"
```

Expected: PASS。

同时跑全套确保未回归：

```
pnpm vitest run tests/sidepanel/chat/run-session.test.ts
```

- [ ] **Step 6: typecheck**

```
pnpm typecheck
```

- [ ] **Step 7: 提交**

```bash
git add src/sidepanel/chat/tool-runner.ts src/sidepanel/chat/run-session.ts tests/sidepanel/chat/run-session.test.ts
git commit -m "feat(run-session): intercept listTabs/openTab/attachTab/detachTab + propagate attachedTabIds"
```

---

## Task 14: chat-page wiring — 把 sessionStore 的 attachedTabs 喂给 run-session

**Files:**
- Modify: `src/sidepanel/pages/chat-page.tsx`
- Test:（手动验证 + 既有 e2e 测试通过即可，不新增单测）

- [ ] **Step 1: 在 `chat-page.tsx` 的 `send` 函数里，把 `attachedTabIds` 传给 `runChatSession`**

找到 `runChatSession({ ... })` 调用，扩参：

```ts
const session0 = getSessionFor(tabId);
const attachedTabIds = session0.attachedTabs.map((a) => a.tabId);
const attachedTabs = session0.attachedTabs;

await runChatSession({
  client: pickClient(settings.provider),
  runner: new RpcToolRunner(),
  approver,
  rpc,
  input: { userPrompt: prompt, tabId, url },
  settings,
  systemPrompt: buildSystemPrompt({ url, title: tab.title, savedTools, attachedTabs }),
  tools: TOOL_DEFS,
  approveAllSafe: session.approveAllSafe,
  abortSignal: ac.signal,
  onEvent: handleEvent,
  initialMessages: session.messages,
  attachedTabIds,
  tabsRpc: { listTabs: rpc.listTabs, openTab: rpc.openTab },
  onCrossTabResult: (r) => {
    if (r.kind === "opened") {
      attachTab(tabId, {
        tabId: r.tabId,
        windowId: r.windowId ?? -1,
        source: "ai-open",
        lastSeenUrl: r.url ?? "",
        lastSeenTitle: r.title ?? ""
      });
    } else if (r.kind === "attached") {
      // chrome.tabs.get to enrich; if fails, leave url empty
      chrome.tabs.get(r.tabId)
        .then((t) => attachTab(tabId, {
          tabId: r.tabId,
          windowId: t.windowId,
          source: "approval",
          lastSeenUrl: t.url ?? "",
          lastSeenTitle: t.title ?? ""
        }))
        .catch(() => {});
    } else if (r.kind === "detached") {
      detachTab(tabId, r.tabId);
    }
  }
});
```

记得 import：

```ts
import { attachTab, detachTab, getSessionFor } from "../chat/session-store";
```

- [ ] **Step 2: 在 `chat-page.tsx` 的初始化 effect 里订阅 cross-tab 事件**

在已有的 `onTabRecommendations` 订阅块附近加：

```ts
import { handleTabEvent } from "../chat/cross-tab-events";
import { onTabEvents } from "../rpc";

// in useEffect
const offEvents = onTabEvents(handleTabEvent);

// in cleanup
offEvents();
```

- [ ] **Step 3: typecheck + vitest 全跑**

```
pnpm typecheck
pnpm test
```

Expected: 现有测试不回归；类型对齐。

- [ ] **Step 4: 提交**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(chat-page): pass attachedTabIds + cross-tab callbacks; subscribe to tab events"
```

---

## Task 15: attachTab 审批 — 通过现有 Approver，UI 弹出 + "始终允许" 选项

**Files:**
- Modify: `src/sidepanel/chat/approval.ts`
- Modify: `src/sidepanel/components/danger-approval-popover.tsx`
- Modify: `src/sidepanel/pages/chat-page.tsx`
- Test: `tests/sidepanel/chat/approval.test.ts`（如已有则增加；否则创建）

- [ ] **Step 1: 扩 `Decision`**

`src/sidepanel/chat/approval.ts`：

```ts
export type Decision =
  | { kind: "run" }
  | { kind: "run-and-always-allow"; toolName: string }
  | { kind: "skip" }
  | { kind: "deny" };
```

注：`run-and-always-allow` 的语义是 "本次允许 + 把 `toolName` 加入 `autoApproveDangerous` 名单"，由调用方（chat-page.tsx）落地。

- [ ] **Step 2: 在 chat-page.tsx 的 `handleApprove` 里处理新分支**

```ts
const handleApprove = useCallback(
  (id: string, decision: "run" | "run-and-always-allow" | "skip" | "deny", toolName?: string) => {
    if (decision === "run-and-always-allow" && toolName) {
      void settings.save({
        autoApproveDangerous: Array.from(new Set([...settings.autoApproveDangerous, toolName]))
      });
      approver.resolve(id, { kind: "run-and-always-allow", toolName });
      session.setCardStatus(id, { status: "running" });
      return;
    }
    approver.resolve(id, { kind: decision } as Decision);
    session.setCardStatus(id, {
      status: decision === "run" ? "running" : decision === "skip" ? "skipped" : "denied"
    });
  },
  [session, approver, settings]
);
```

- [ ] **Step 3: 让 `run-session.ts` 在收到 `run-and-always-allow` 时同 `run` 行为继续**

把当前 `if (decision.kind === "deny") ... if (decision.kind === "skip") ... else 走 run` 的判断改成：

```ts
if (decision.kind === "deny") { /* same */ }
if (decision.kind === "skip") { /* same */ }
// run + run-and-always-allow 都走执行
```

不需要在 run-session 里做 settings 持久化，那个在 chat-page handleApprove 已经做了。

- [ ] **Step 4: 改 danger-approval-popover 渲染**

在 `src/sidepanel/components/danger-approval-popover.tsx` 里，针对 `toolName === "attachTab"` 的卡片，多渲染一个按钮 "允许并始终通过"：

```tsx
{toolName === "attachTab" && (
  <button
    onClick={() => onDecide("run-and-always-allow", "attachTab")}
    className="..."
  >
    允许并始终通过
  </button>
)}
```

回调签名扩展到 `(decision, toolName?)`。

- [ ] **Step 5: 加测试**

`tests/sidepanel/chat/approval.test.ts`（如不存在则创建）：

```ts
import { describe, expect, it } from "vitest";
import { Approver } from "@/sidepanel/chat/approval";

describe("Approver run-and-always-allow", () => {
  it("delivers run-and-always-allow decision", async () => {
    const a = new Approver();
    const p = a.request("u1");
    a.resolve("u1", { kind: "run-and-always-allow", toolName: "attachTab" });
    const d = await p;
    expect(d).toEqual({ kind: "run-and-always-allow", toolName: "attachTab" });
  });
});
```

- [ ] **Step 6: 重跑测试**

```
pnpm vitest run tests/sidepanel/chat/approval.test.ts
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/sidepanel/chat/approval.ts src/sidepanel/chat/run-session.ts src/sidepanel/components/danger-approval-popover.tsx src/sidepanel/pages/chat-page.tsx tests/sidepanel/chat/approval.test.ts
git commit -m "feat(approval): run-and-always-allow decision for attachTab persists into autoApproveDangerous"
```

---

## Task 16: UI — `TabChipsBar` 组件

**Files:**
- Create: `src/sidepanel/components/tab-chips-bar.tsx`
- Test: `tests/sidepanel/components/tab-chips-bar.test.tsx`

- [ ] **Step 1: 加测试**

```tsx
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AttachedTab } from "@/shared/types";
import { TabChipsBar } from "@/sidepanel/components/tab-chips-bar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: number, extras: Partial<AttachedTab> = {}): AttachedTab => ({
  tabId: id,
  windowId: 1,
  source: "mention",
  lastSeenUrl: `https://t${id}`,
  lastSeenTitle: `T${id}`,
  addedAt: 0,
  ...extras
});

function mount(node: React.ReactNode): { container: HTMLDivElement; cleanup: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

describe("TabChipsBar", () => {
  it("hides itself when empty", () => {
    const { container, cleanup } = mount(
      <TabChipsBar attachedTabs={[]} onDetach={() => {}} onPick={() => {}} />
    );
    expect(container.firstChild).toBeNull();
    cleanup();
  });

  it("renders a chip per attached tab and shows urlChanged warning", () => {
    const { container, cleanup } = mount(
      <TabChipsBar
        attachedTabs={[tab(1), tab(2, { urlChanged: true })]}
        onDetach={() => {}}
        onPick={() => {}}
      />
    );
    expect(container.textContent).toContain("T1");
    expect(container.textContent).toContain("T2");
    expect(container.querySelector('[data-testid="chip-2"]')?.getAttribute("data-url-changed")).toBe("true");
    cleanup();
  });

  it("calls onDetach when × is clicked", () => {
    const onDetach = vi.fn();
    const { container, cleanup } = mount(
      <TabChipsBar attachedTabs={[tab(7)]} onDetach={onDetach} onPick={() => {}} />
    );
    const btn = container.querySelector('button[aria-label="detach 7"]') as HTMLButtonElement;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onDetach).toHaveBeenCalledWith(7);
    cleanup();
  });

  it("collapses past 8 with +N indicator", () => {
    const many = Array.from({ length: 11 }, (_, i) => tab(100 + i));
    const { container, cleanup } = mount(
      <TabChipsBar attachedTabs={many} onDetach={() => {}} onPick={() => {}} />
    );
    expect(container.textContent).toContain("+3");
    cleanup();
  });

  it("calls onPick when + is clicked", () => {
    const onPick = vi.fn();
    const { container, cleanup } = mount(
      <TabChipsBar attachedTabs={[tab(1)]} onDetach={() => {}} onPick={onPick} />
    );
    const btn = container.querySelector('button[aria-label="add attached tab"]') as HTMLButtonElement;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onPick).toHaveBeenCalled();
    cleanup();
  });
});
```

测试风格匹配既有的 `tests/sidepanel/components/recommendations-banner.test.tsx`：用 `react-dom/client` + `act`，不依赖 `@testing-library/react`。

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/sidepanel/components/tab-chips-bar.test.tsx
```

Expected: 五条 FAIL（组件未存在）。

- [ ] **Step 3: 实现 `src/sidepanel/components/tab-chips-bar.tsx`**

```tsx
import { useState } from "react";
import type { AttachedTab } from "@/shared/types";

type Props = {
  attachedTabs: AttachedTab[];
  onDetach: (tabId: number) => void;
  onPick: () => void;
};

const MAX_VISIBLE = 8;

export function TabChipsBar({ attachedTabs, onDetach, onPick }: Props): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  if (attachedTabs.length === 0) return null;
  const showAll = expanded || attachedTabs.length <= MAX_VISIBLE;
  const visible = showAll ? attachedTabs : attachedTabs.slice(0, MAX_VISIBLE);
  const overflow = attachedTabs.length - visible.length;

  return (
    <div className="px-2 py-1 border-b border-zinc-900 bg-zinc-950 flex items-center gap-1 flex-wrap text-[11px]">
      <span className="text-zinc-600">附加:</span>
      {visible.map((a) => (
        <span
          key={a.tabId}
          data-testid={`chip-${a.tabId}`}
          data-url-changed={a.urlChanged ? "true" : "false"}
          title={`${a.lastSeenUrl}${a.urlChanged ? "\n(URL 已变化)" : ""}`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded ${
            a.urlChanged ? "bg-red-900/30 text-red-300" : "bg-zinc-800 text-zinc-200"
          }`}
        >
          {a.urlChanged && <span aria-hidden>⚠</span>}
          <span className="max-w-[120px] truncate">{a.lastSeenTitle || a.lastSeenUrl}</span>
          <button
            aria-label={`detach ${a.tabId}`}
            className="text-zinc-500 hover:text-red-400 text-[10px]"
            onClick={() => onDetach(a.tabId)}
          >
            ×
          </button>
        </span>
      ))}
      {overflow > 0 && !expanded && (
        <button
          className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
          onClick={() => setExpanded(true)}
        >
          +{overflow}
        </button>
      )}
      <button
        aria-label="add attached tab"
        className="ml-auto text-zinc-400 hover:text-zinc-100"
        onClick={onPick}
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/components/tab-chips-bar.test.tsx
```

Expected: 5/5 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/tab-chips-bar.tsx tests/sidepanel/components/tab-chips-bar.test.tsx
git commit -m "feat(ui): TabChipsBar component"
```

---

## Task 17: UI — `TabPicker` 组件

**Files:**
- Create: `src/sidepanel/components/tab-picker.tsx`
- Test: `tests/sidepanel/components/tab-picker.test.tsx`

- [ ] **Step 1: 加测试**

```tsx
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TabPicker } from "@/sidepanel/components/tab-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode): { container: HTMLDivElement; root: ReturnType<typeof createRoot>; cleanup: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    root,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    }
  };
}

async function flush(): Promise<void> {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("TabPicker", () => {
  it("loads tabs via injected rpc and groups by windowId", async () => {
    const listTabs = vi.fn(async () => ({
      tabs: [
        { tabId: 1, windowId: 10, url: "https://a", title: "A" },
        { tabId: 2, windowId: 11, url: "https://b", title: "B" }
      ]
    }));
    const { container, cleanup } = mount(
      <TabPicker listTabs={listTabs} attachedIds={[]} currentTabId={null} onSelect={() => {}} onClose={() => {}} />
    );
    await flush();
    expect(container.textContent).toContain("A");
    expect(container.textContent).toMatch(/窗口 10/);
    expect(container.textContent).toMatch(/窗口 11/);
    cleanup();
  });

  it("marks already-attached and current tabs and disables them", async () => {
    const listTabs = vi.fn(async () => ({ tabs: [
      { tabId: 1, windowId: 10, url: "u", title: "Already" },
      { tabId: 2, windowId: 10, url: "u", title: "Current" }
    ] }));
    const { container, cleanup } = mount(
      <TabPicker listTabs={listTabs} attachedIds={[1]} currentTabId={2} onSelect={() => {}} onClose={() => {}} />
    );
    await flush();
    expect(container.querySelector('[data-testid="picker-row-1"]')?.getAttribute("data-disabled")).toBe("true");
    expect(container.querySelector('[data-testid="picker-row-2"]')?.getAttribute("data-disabled")).toBe("true");
    cleanup();
  });

  it("calls onSelect with tab on click", async () => {
    const onSelect = vi.fn();
    const listTabs = vi.fn(async () => ({ tabs: [{ tabId: 3, windowId: 10, url: "u3", title: "T3" }] }));
    const { container, cleanup } = mount(
      <TabPicker listTabs={listTabs} attachedIds={[]} currentTabId={null} onSelect={onSelect} onClose={() => {}} />
    );
    await flush();
    const row = container.querySelector('[data-testid="picker-row-3"]') as HTMLButtonElement;
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onSelect).toHaveBeenCalledWith({ tabId: 3, windowId: 10, url: "u3", title: "T3" });
    cleanup();
  });
});
```

- [ ] **Step 2: 运行验证失败**

```
pnpm vitest run tests/sidepanel/components/tab-picker.test.tsx
```

Expected: 三条 FAIL。

- [ ] **Step 3: 实现 `src/sidepanel/components/tab-picker.tsx`**

```tsx
import { useEffect, useState } from "react";

type TabRow = { tabId: number; windowId: number; url: string; title: string };

type Props = {
  listTabs: (windowId?: number) => Promise<{ tabs: TabRow[] }>;
  attachedIds: number[];
  currentTabId: number | null;
  onSelect: (t: TabRow) => void;
  onClose: () => void;
};

export function TabPicker({ listTabs, attachedIds, currentTabId, onSelect, onClose }: Props): JSX.Element {
  const [rows, setRows] = useState<TabRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await listTabs();
        if (!active) return;
        setRows(r.tabs);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [listTabs]);

  const groups = rows.reduce<Record<number, TabRow[]>>((acc, r) => {
    (acc[r.windowId] ||= []).push(r);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" onClick={onClose}>
      <div
        className="w-[420px] max-h-[70vh] overflow-auto bg-zinc-900 border border-zinc-700 rounded text-zinc-100 text-[12px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-zinc-700 flex items-center justify-between">
          <span>选择要附加的 tab</span>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-100">×</button>
        </div>
        {loading && <div className="p-3 text-zinc-400">加载中…</div>}
        {err && <div className="p-3 text-red-400">{err}</div>}
        {!loading && !err && Object.entries(groups).map(([wid, list]) => (
          <div key={wid}>
            <div className="px-3 py-1 text-zinc-500 text-[11px] sticky top-0 bg-zinc-900">窗口 {wid}</div>
            {list.map((r) => {
              const disabled = attachedIds.includes(r.tabId) || r.tabId === currentTabId;
              return (
                <button
                  key={r.tabId}
                  data-testid={`picker-row-${r.tabId}`}
                  data-disabled={disabled ? "true" : "false"}
                  disabled={disabled}
                  className={`w-full text-left px-3 py-2 border-b border-zinc-800 ${
                    disabled ? "opacity-40 cursor-not-allowed" : "hover:bg-zinc-800"
                  }`}
                  onClick={() => onSelect(r)}
                >
                  <div className="truncate">{r.title || "(无标题)"}</div>
                  <div className="text-zinc-500 text-[10px] truncate">{r.url}</div>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 重跑测试确认通过**

```
pnpm vitest run tests/sidepanel/components/tab-picker.test.tsx
```

Expected: 3/3 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/components/tab-picker.tsx tests/sidepanel/components/tab-picker.test.tsx
git commit -m "feat(ui): TabPicker component (lists tabs grouped by windowId)"
```

---

## Task 18: chat-page — 挂 chips bar + `@` 输入触发 picker

**Files:**
- Modify: `src/sidepanel/pages/chat-page.tsx`
- Test:（不增单测；vitest 整套绿即可，手动 e2e 在 Task 23）

- [ ] **Step 1: 在 chat-page.tsx 顶部挂 TabChipsBar**

找到 `<TabInfoBar />` 渲染处，紧贴其后插入：

```tsx
<TabChipsBar
  attachedTabs={session.attachedTabs}
  onDetach={(id) => detachTab(currentTabId ?? -1, id)}
  onPick={() => setPickerOpen(true)}
/>
```

import：

```ts
import { TabChipsBar } from "../components/tab-chips-bar";
import { TabPicker } from "../components/tab-picker";
import { attachTab, detachTab } from "../chat/session-store";
```

State：

```ts
const [pickerOpen, setPickerOpen] = useState(false);
```

渲染 picker：

```tsx
{pickerOpen && (
  <TabPicker
    listTabs={(wid) => rpc.listTabs(wid)}
    attachedIds={session.attachedTabs.map((a) => a.tabId)}
    currentTabId={currentTabId}
    onSelect={(t) => {
      attachTab(currentTabId ?? -1, {
        tabId: t.tabId, windowId: t.windowId,
        source: "mention", lastSeenUrl: t.url, lastSeenTitle: t.title
      });
      setPickerOpen(false);
    }}
    onClose={() => setPickerOpen(false)}
  />
)}
```

- [ ] **Step 2: `@` 触发 picker**

找输入框 onChange 处（`<textarea>` 或 `<input>`），加：

```ts
const handleInputChange = (v: string) => {
  setInput(v);
  session.setInputDraft(v);
  // 检测末尾 `@`（用户刚键入）
  if (v.endsWith("@")) {
    setPickerOpen(true);
    // 选中后回调里移除最后一个 @
  }
};
```

并把 picker 的 `onSelect` 改成同时去除输入框尾随的 `@`：

```ts
onSelect={(t) => {
  attachTab(currentTabId ?? -1, { /* same */ });
  if (input.endsWith("@")) {
    const stripped = input.slice(0, -1);
    setInput(stripped);
    session.setInputDraft(stripped);
  }
  setPickerOpen(false);
}}
```

- [ ] **Step 3: typecheck + vitest 全跑**

```
pnpm typecheck
pnpm test
```

Expected: 全绿。

- [ ] **Step 4: 提交**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(chat-page): mount TabChipsBar + @-triggered TabPicker"
```

---

## Task 19: chat-view — 渲染 cross-tab 系统行

**Files:**
- Modify: `src/sidepanel/components/chat-view.tsx`

- [ ] **Step 1: 阅读现有 chat-view 渲染 ChatMessage 的逻辑**

```
cat src/sidepanel/components/chat-view.tsx
```

确认 `role: "user"` 且 `content: string` 的消息怎么渲染（普通气泡）。

我们用 `appendSystemNote` 已经写入 `{ role: "user", content: <string> }`，前缀含 emoji（`🆕` / `⚠` / `🗑`）。让 chat-view 识别"system 系列"字符串，渲染成更低调的样式。

- [ ] **Step 2: 在 chat-view.tsx 渲染 string-content 用户消息时检查前缀**

```tsx
const SYSTEM_PREFIXES = ["🆕", "🗑", "⚠", "[页面跳转]", "[已恢复]"];

function isSystemNote(content: string): boolean {
  return SYSTEM_PREFIXES.some((p) => content.startsWith(p));
}

// in render:
if (m.role === "user" && typeof m.content === "string" && isSystemNote(m.content)) {
  return (
    <div key={i} className="text-[11px] text-zinc-500 italic px-2 py-1">
      {m.content}
    </div>
  );
}
```

（`[页面跳转]` 和 `[已恢复]` 已是既有的系统行——这一步顺手把它们也按 system 样式渲染，体验更一致。）

- [ ] **Step 3: 手动跑一下 vitest 整套**

```
pnpm test
```

Expected: 全绿（chat-view 没有专门单测；旧有 e2e 不应受影响）。

- [ ] **Step 4: 提交**

```bash
git add src/sidepanel/components/chat-view.tsx
git commit -m "feat(ui): render system-note messages with subdued style"
```

---

## Task 20: step-card — 目标非主 tab 时显示 `→ Tab #N`

**Files:**
- Modify: `src/sidepanel/components/step-card.tsx`

- [ ] **Step 1: 在 step-card.tsx 标题区域读取 `card.input.tabId`，如果存在且 ≠ session.tabId 则渲染**

```tsx
import { useSession } from "../chat/session-store";
// ...
const session = useSession();
const argTab = (card.input as { tabId?: number } | null | undefined)?.tabId;
const showCrossTab = typeof argTab === "number" && argTab !== session.tabId;
```

在工具名旁加：

```tsx
{showCrossTab && (
  <span className="text-blue-400 text-[10px] ml-1">→ Tab #{argTab}</span>
)}
```

- [ ] **Step 2: vitest + typecheck**

```
pnpm typecheck
pnpm test
```

Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add src/sidepanel/components/step-card.tsx
git commit -m "feat(step-card): label cross-tab calls with → Tab #N"
```

---

## Task 21: settings-page — `attachTab` 加入 dangerous 白名单可勾选项

**Files:**
- Modify: `src/sidepanel/pages/settings-page.tsx`

- [ ] **Step 1: 找到现有 dangerous 白名单 UI（`readStorage / submitForm / uploadFile` 三个 checkbox 在哪渲染）**

```
grep -n "readStorage\|submitForm\|uploadFile" src/sidepanel/pages/settings-page.tsx
```

- [ ] **Step 2: 把 "attachTab" 加进可勾选名单**

在该数组 / JSX 列表里加：

```ts
{ name: "attachTab", label: "始终允许 AI 跨 tab 访问（attachTab）", hint: "AI 调用 attachTab 不再每次弹审批；@ 选中和 AI 自开新 tab 不受此项影响" }
```

样式照搬现有三个 checkbox 的渲染方式。

- [ ] **Step 3: 手动检查（dev server 略，仅 typecheck）**

```
pnpm typecheck
```

- [ ] **Step 4: 提交**

```bash
git add src/sidepanel/pages/settings-page.tsx
git commit -m "feat(settings): allow always-approving attachTab in dangerous list"
```

---

## Task 22: 启动校验 + closed-sessions 恢复路径

**Files:**
- Modify: `src/sidepanel/chat/session-store.ts`
- Modify: `src/sidepanel/app.tsx`
- Test: `tests/sidepanel/chat/session-store.test.ts`

- [ ] **Step 1: 加测试 — `validateAttachedTabs(known: Set<number>)` 把不在 known 中的 attached tab 移除**

```ts
describe("validateAttachedTabs", () => {
  beforeEach(reset);
  it("removes attached tabs not in known set", () => {
    ensureSession(7, "https://x");
    attachTab(7, { tabId: 100, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    attachTab(7, { tabId: 200, windowId: 1, source: "mention", lastSeenUrl: "u", lastSeenTitle: "t" });
    validateAttachedTabs(new Set([100]));
    expect(getSessionFor(7).attachedTabs.map((a) => a.tabId)).toEqual([100]);
  });
});
```

- [ ] **Step 2: 在 `session-store.ts` 实现**

```ts
export function validateAttachedTabs(knownTabIds: Set<number>): void {
  useStore.setState((state) => {
    let mutated = false;
    const sessionsByTab: Record<number, SessionData> = { ...state.sessionsByTab };
    for (const [k, s] of Object.entries(state.sessionsByTab)) {
      const next = s.attachedTabs.filter((a) => knownTabIds.has(a.tabId));
      if (next.length !== s.attachedTabs.length) {
        sessionsByTab[Number(k)] = { ...s, attachedTabs: next };
        mutated = true;
      }
    }
    return mutated ? { ...state, sessionsByTab } : state;
  });
}
```

- [ ] **Step 3: 在 `restoreClosed` 中保留 attachedTabs（不需额外改动，因为 spread 已带）；在 `app.tsx` boot 时调一次校验**

`src/sidepanel/app.tsx` 启动钩子内（找到 `installTabTracker()` 调用附近）：

```ts
useEffect(() => {
  void (async () => {
    const tabs = await chrome.tabs.query({});
    const known = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null));
    validateAttachedTabs(known);
  })();
}, []);
```

import：

```ts
import { validateAttachedTabs } from "./chat/session-store";
```

- [ ] **Step 4: 重跑测试**

```
pnpm vitest run tests/sidepanel/chat/session-store.test.ts -t "validateAttachedTabs"
pnpm typecheck
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/sidepanel/chat/session-store.ts src/sidepanel/app.tsx tests/sidepanel/chat/session-store.test.ts
git commit -m "feat(session-store): validateAttachedTabs + boot-time prune of gone tabs"
```

---

## Task 23: 手动 e2e + plan / spec 索引收尾

**Files:**
- Modify: `docs/superpowers/plans/README.md`（更新索引）
- Modify: `README.md`（如需要简述功能；可选）

- [ ] **Step 1: 跑全测**

```
pnpm test
pnpm typecheck
```

Expected: 全绿。

- [ ] **Step 2: 构建 dist + 在 Chrome 加载**

```
pnpm build
```

在 `chrome://extensions` 重新加载扩展（指向 `dist/`）。

- [ ] **Step 3: 手动 e2e 清单（依次跑、每项检查通过）**

1. 打开两个 tab（主 tab A、tab B）；在 A 上打开 sidepanel
2. 在输入框输入 `@`，picker 弹出，选择 B → A 的 chips 出现一个 chip
3. 在对话里让 AI "对比 A 和 B 的页面标题"，验证 AI 调 `extractText` 时带 `tabId=B`，结果合并；step-card 上有 `→ Tab #B`
4. 让 AI `openTab https://example.com` → 系统行 "🆕 AI 在 #N 打开了…"，chips 多一个
5. 手动 × 关掉一个 chip，验证从集合移除，下一轮工具调用拒
6. 让 AI 调 `attachTab` 选另一个未附加 tab → 审批行出现，点 "允许一次" → 成为附加
7. 点 "允许并始终通过" → 检查 settings 页 `attachTab` 已勾选
8. 在附加的 tab 里手动导航到别的 URL → 该 chip 出现红 ⚠
9. 关掉附加的 tab → chip 消失 + system 行 "🗑 Tab #N 已关闭"
10. SW 唤醒：关 sidepanel 等 30s（或在 `chrome://extensions` 的 Service Worker 调试里 Stop），重新打开 → 验证 chips 仍在（如该 tab 还存在）

把每一项打勾或记录失败。

- [ ] **Step 4: 更新 `docs/superpowers/plans/README.md` 索引**

```
cat docs/superpowers/plans/README.md
```

按现有风格追加一行：

```
| 7 | 多 tab 上下文 | [`2026-05-14-multi-tab-context.md`](./2026-05-14-multi-tab-context.md) | attachedTabs + 4 控制面工具；UI chips + @-picker + 审批；BG 权限闸 + 事件广播 |
```

- [ ] **Step 5: 提交收尾**

```bash
git add docs/superpowers/plans/README.md
git commit -m "docs: index multi-tab-context plan"
```

- [ ] **Step 6: （可选）写 PR 描述准备发版**

走 `superpowers:finishing-a-development-branch` 决定下一步（merge / PR）。

---

## Self-Review

- **Spec 第 1 节（数据模型）** → Task 1, 2, 22
- **Spec 第 2 节（产品决策）** → 全部任务体现
- **Spec 第 3 节（AttachedTab 类型）** → Task 1
- **Spec 第 4.1 节（现有工具加可选 tabId）** → Task 4
- **Spec 第 4.2 节（4 个控制面工具）** → Task 4, 7, 8, 13
- **Spec 第 4.3 节（过滤 chrome://、隐身、约束 openTab）** → Task 7, 8
- **Spec 第 5.1 节（tabs.list / tabs.open RPC）** → Task 6, 7, 8, 10
- **Spec 第 5.2 节（runOneStep 权限闸 + attachedTabIds）** → Task 6, 9, 10, 13, 14
- **Spec 第 5.3 节（tab-watcher 新事件）** → Task 11, 12
- **Spec 第 6.1 节（chips 栏）** → Task 16, 18
- **Spec 第 6.2 节（picker + @）** → Task 17, 18
- **Spec 第 6.3 节（attachTab 审批 UI + run-and-always）** → Task 15
- **Spec 第 6.4 节（AI 打开新 tab 系统行）** → Task 12, 19
- **Spec 第 6.5 节（step-card 标 tab）** → Task 20
- **Spec 第 7 节（system prompt）** → Task 5
- **Spec 第 8 节（severity 集成 + attachTab 设置项）** → Task 3, 21
- **Spec 第 9 节（错误与边界）** → Task 7, 8, 9, 11, 12, 22
- **Spec 第 10 节（持久化与会话恢复）** → Task 22
- **Spec 第 11 节（测试）** → 每个 Task 的 TDD step 已覆盖；手动 e2e 在 Task 23
- **Spec 第 12 节（YAGNI）** → 不实现，确认无任务越界
- **Spec 第 13 节（兼容性）** → Task 1（默认空 `attachedTabs`）、Task 6（`attachedTabIds` zod default `[]`）

无 TODO/TBD/占位符。所有 step 含具体代码或 diff 描述。

类型一致性：`AttachedTab` 字段在 Task 1 定义、在 Task 2/5/12/16/18 使用，命名一致（`tabId/windowId/source/addedAt/lastSeenUrl/lastSeenTitle/urlChanged`）。`Decision` 在 Task 15 扩展为 4 个 kind，run-session 和 chat-page 都按 `run` 处理 `run-and-always-allow` 的执行路径。
