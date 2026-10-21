# Conversation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 ChatView 加"简洁 / 详细"模式切换。简洁模式下每个工具调用渲染为一行进展提示（图标 + 中文别名 + 耗时），点行展开为完整 StepCard；awaiting 强制展开、error 一行显摘要。Settings 存默认，Header 一键 session-scoped override。

**Architecture:** 五文件五组件：`tool-labels.ts`（中文别名表 + `labelFor`）、`StepRow`（一行紧凑组件）、`SessionData.chatMode` state、`Header` Eye/EyeOff toggle、`AssistantBubble` 双分支渲染。所有 hooks 在组件顶部无条件调用以避免 hooks-order changed。

**Tech Stack:** React 18 + Zustand（复用 `useSettings` / `useSession`）+ lucide-react（`Eye` / `EyeOff` / `Check` / `X` / `Loader2` / `Circle`）+ vitest + happy-dom + local `mount/cleanup`（**不**用 `@testing-library`）。

## Global Constraints

- **测试模式**：vitest + happy-dom + `react-dom/client` + 本地 `mount/cleanup` 辅助函数 + `IS_REACT_ACT_ENVIRONMENT=true`。**不**用 `@testing-library`。参考 `packages/extension/tests/sidepanel/chat/quick-actions.test.tsx`。
- **`type Props`** 定义在组件外；组件用 `export function` 命名导出。
- **图标统一 lucide-react**：不用 emoji、不用 SVG 路径字符串。
- **文案 UI 用「简洁 / 详细」，内部 enum 保留 `"compact"` / `"full"`**。
- **默认值 `"compact"`**。新用户 / `defaultChatMode` 为 undefined 的老用户都进简洁模式。
- **中文别名**：所有别名与工具语义一致；无别名时 UI 回退到英文工具原名（`font-mono text-zinc-400`）。
- **hooks 顺序稳定**：`AssistantBubble` 里所有 `useState` 无条件调用（`open`、`expanded`、`userOverride`），只按 chatMode 决定 render 哪个分支消费哪个 state。
- **审批例外**：`card.status === "awaiting" && needsApproval(card)` 时**强制显示完整 StepCard**，不管 chatMode。
- **B′ 三态 summary**（仅简洁模式）：`live || hasAwaiting` → 自动展开；否则折叠；`userOverride` 覆盖自动。
- **不持久化 chatMode**：`session.chatMode` 不进 IDB、不进 `PersistedSessionData`。Rehydrated session 恒定为 `makeEmptySession` 默认 `"compact"`；AppShell seed useEffect 只在会话为空时刷成 settings 默认。已知边界，接受。

---

### Task 1: Settings 基础 — LlmSettings.defaultChatMode 字段 + Appearance UI

**Files:**
- Modify: `packages/shared/src/types.ts` (LlmSettings 加字段)
- Modify: `packages/extension/src/sidepanel/chat/settings-store.ts` (DEFAULTS 加项)
- Modify: `packages/extension/src/sidepanel/drawers/settings/section-appearance.tsx` (加一行 select)

**Interfaces:**
- Consumes: 无
- Produces:
  - `LlmSettings.defaultChatMode?: "compact" | "full"`
  - DEFAULTS 里 `defaultChatMode: "compact"`
  - SectionAppearance 组件在主题选项下方新增一行"默认视图"select

**Rationale:** 独立小步；类型改动落地后，Task 4 消费该字段。

- [ ] **Step 1: 加类型字段**

Modify `packages/shared/src/types.ts`。找到 `export type LlmSettings = {`（用 `grep -n "export type LlmSettings" packages/shared/src/types.ts` 定位起点），在结束 `};` 之前**紧接** `optimizerModel?: string;` 之后插入：

```ts
  /**
   * 聊天视图默认模式。
   * - `"compact"`：简洁模式（一行进展提示，默认）
   * - `"full"`：详细模式（完整 StepCard 展开）
   * 每次新会话时从这里初始化 `session.chatMode`；Header 图标可 session-scoped 覆盖，不写回。
   */
  defaultChatMode?: "compact" | "full";
```

- [ ] **Step 2: DEFAULTS 加项**

Modify `packages/extension/src/sidepanel/chat/settings-store.ts`。找到 `const DEFAULTS: LlmSettings = {`（`grep -n "const DEFAULTS" packages/extension/src/sidepanel/chat/settings-store.ts`），在结束 `};` 之前紧接 `maxContinuationNudges: 1` 之后加 `,` 然后新行：

```ts
  defaultChatMode: "compact"
```

（保持仓库既有末尾无逗号风格；如果 `maxContinuationNudges: 1` 后本来就没逗号，加上逗号再加新行。）

- [ ] **Step 3: Appearance UI 加一行**

Modify `packages/extension/src/sidepanel/drawers/settings/section-appearance.tsx`。当前文件结构：顶部有 `OPTIONS` 数组（主题） + `SectionAppearance` 函数返回一个 `<section>`，里面渲染一组 radio。

在文件顶部 `type Theme = "light" | "dark" | "system";` 下方加：

```ts
type ChatMode = "compact" | "full";

const CHAT_MODE_OPTIONS: Array<{ value: ChatMode; label: string; hint: string }> = [
  { value: "compact", label: "简洁", hint: "一行进展 · 点展开看细节（推荐）" },
  { value: "full", label: "详细", hint: "每步显示完整参数/输出" },
];
```

在 `SectionAppearance` 函数里，`const theme = settings.theme ?? "dark";` 那行**下方**加：

```ts
  const chatMode: ChatMode = (settings.defaultChatMode ?? "compact") as ChatMode;
```

在返回的 `<section>` 内，把现有 `<div className="space-y-1.5">…</div>`（主题 radio 组）替换为**两个连续的 group**：先主题、再默认视图。完整 return 改为：

```tsx
  return (
    <section className="bg-zinc-900 rounded p-3 space-y-3 text-xs">
      <h3 className="text-zinc-300">外观</h3>

      <div>
        <div className="text-zinc-400 mb-1">主题</div>
        <div className="space-y-1.5">
          {OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="theme"
                value={opt.value}
                checked={theme === opt.value}
                onChange={() => pick(opt.value)}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <div className="text-zinc-100">{opt.label}</div>
                <div className="text-zinc-500 text-[10px]">{opt.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="text-zinc-400 mb-1">默认视图</div>
        <div className="space-y-1.5">
          {CHAT_MODE_OPTIONS.map((opt) => (
            <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
              <input
                type="radio"
                name="chatMode"
                value={opt.value}
                checked={chatMode === opt.value}
                onChange={() => void settings.save({ defaultChatMode: opt.value })}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <div className="text-zinc-100">{opt.label}</div>
                <div className="text-zinc-500 text-[10px]">{opt.hint}</div>
              </div>
            </label>
          ))}
        </div>
      </div>
    </section>
  );
```

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 全绿。（`defaultChatMode` 是可选字段，不影响任何现有 `LlmSettings` 消费者。）

- [ ] **Step 5: 全套测试确认无回归**

```bash
pnpm --filter @aipagego/extension test 2>&1 | tail -10
```

Expected: 全绿（无既存 SectionAppearance 测试；本 task 也不引入）。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/types.ts packages/extension/src/sidepanel/chat/settings-store.ts packages/extension/src/sidepanel/drawers/settings/section-appearance.tsx
git commit -m "$(cat <<'EOF'
feat(settings): 加 defaultChatMode 字段 + 外观里"默认视图"选项

简洁 / 详细两个 radio；默认简洁；后续 Task 4 会把 session.chatMode
从这里初始化。
EOF
)"
```

---

### Task 2: tool-labels.ts — 中文别名表 + labelFor + sanity 测

**Files:**
- Create: `packages/extension/src/sidepanel/lib/tool-labels.ts`
- Create: `packages/extension/tests/sidepanel/lib/tool-labels.test.ts`

**Interfaces:**
- Consumes: `TOOL_DEFS` from `@aipagego/shared/llm`（sanity 测用）
- Produces:
  - `TOOL_LABELS: Record<string, string>` — 常量表
  - `labelFor(toolName: string): string | null` — 有别名返回中文；没有返回 null

**Rationale:** 纯逻辑先落地；被 Task 3 的 StepRow 消费。TDD。

- [ ] **Step 1: 写失败测试**

Create `packages/extension/tests/sidepanel/lib/tool-labels.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@aipagego/shared/llm";
import { labelFor, TOOL_LABELS } from "@/sidepanel/lib/tool-labels";

describe("labelFor", () => {
  it("returns Chinese alias for known tools", () => {
    expect(labelFor("takeSnapshot")).toBe("抓页面快照");
    expect(labelFor("getPageInfo")).toBe("获取页面信息");
    expect(labelFor("clickByUid")).toBe("点击元素");
    expect(labelFor("httpRequest")).toBe("发请求");
  });

  it("returns null for unknown tools", () => {
    expect(labelFor("unknownTool")).toBeNull();
    expect(labelFor("")).toBeNull();
  });
});

describe("TOOL_LABELS", () => {
  it("every key is a known tool in TOOL_DEFS (guards against renames/typos)", () => {
    const known = new Set(TOOL_DEFS.map((t) => t.name));
    const stale = Object.keys(TOOL_LABELS).filter((k) => !known.has(k));
    expect(stale).toEqual([]);
  });

  it("has non-empty Chinese alias for every entry", () => {
    for (const [name, alias] of Object.entries(TOOL_LABELS)) {
      expect(alias, `label for ${name}`).toBeTruthy();
      expect(alias.length, `label for ${name}`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aipagego/extension test tool-labels.test.ts 2>&1 | tail -15
```

Expected: 4 tests failed with "Cannot find module '@/sidepanel/lib/tool-labels'".

- [ ] **Step 3: 写实现**

Create `packages/extension/src/sidepanel/lib/tool-labels.ts`：

```ts
/**
 * 中文别名表：工具名 → 一句话中文描述。
 * StepRow（简洁模式）优先显示中文别名；无别名的工具回退到英文原名。
 * 单测保证 key 都在 TOOL_DEFS 里（防止 rename 后残留）。
 */
export const TOOL_LABELS: Record<string, string> = {
  // Snapshot / query
  snapshotDOM: "抓 DOM 结构",
  takeSnapshot: "抓页面快照",
  querySelector: "找单个元素",
  querySelectorAll: "找匹配元素",
  extractText: "提取文本",
  extractImages: "提取图片",
  getPageInfo: "获取页面信息",
  getValue: "读取输入值",
  extractFormState: "读表单状态",

  // Flow
  scroll: "滚动页面",
  waitFor: "等待",
  navigate: "页面导航",

  // Actions
  click: "点击元素",
  clickByUid: "点击元素",
  fillInput: "填入值",
  fillByUid: "填入值",
  fillForm: "批量填表",
  setCheckbox: "勾选/取消",
  selectOption: "下拉选项",
  submitForm: "提交表单",
  hover: "悬停",
  focus: "聚焦",
  pressKey: "按键",
  uploadFile: "上传文件",

  // Storage / danger
  readStorage: "读 storage",
  writeStorage: "写 storage",
  httpRequest: "发请求",
  runJS: "执行脚本",

  // Cross-tab
  listTabs: "列出 tab",
  openTab: "开新 tab",
  attachTab: "挂载 tab",
  detachTab: "取消挂载",
  closeTab: "关闭 tab",
  switchToTab: "切换 tab",

  // Meta
  screenshot: "截图",
  askUser: "征求确认",
  searchBookmarks: "搜书签",
  searchHistory: "搜历史",
  downloadImage: "下载图片",

  // Visual
  highlightElement: "高亮元素",
  highlightText: "高亮文字",
};

export function labelFor(toolName: string): string | null {
  return TOOL_LABELS[toolName] ?? null;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @aipagego/extension test tool-labels.test.ts 2>&1 | tail -15
```

Expected: 4 tests passed。

- [ ] **Step 5: 全套 typecheck + test**

```bash
pnpm typecheck 2>&1 | tail -5 && pnpm --filter @aipagego/extension test 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/sidepanel/lib/tool-labels.ts packages/extension/tests/sidepanel/lib/tool-labels.test.ts
git commit -m "$(cat <<'EOF'
feat(sidepanel): 加 tool-labels 中文别名表 + labelFor

简洁模式 StepRow 用来把 takeSnapshot / clickByUid 之类的英文名
显示为"抓页面快照"、"点击元素"。有 sanity 测保证所有 key 都
在 TOOL_DEFS 里，防止 rename 后残留。
EOF
)"
```

---

### Task 3: StepRow 组件 + 5 单测

**Files:**
- Create: `packages/extension/src/sidepanel/components/step-row.tsx`
- Create: `packages/extension/tests/sidepanel/components/step-row.test.tsx`

**Interfaces:**
- Consumes:
  - `StepCardState` from `@/sidepanel/chat/session-store`
  - `labelFor` from `@/sidepanel/lib/tool-labels` (Task 2)
- Produces:
  - `type StepRowProps = { card: StepCardState; onExpand: () => void }`
  - `StepRow` 组件：一行紧凑显示 status icon + 中文别名（或英文回退）+ 耗时；error 状态显 error message。整行 clickable → `onExpand()`。

**Rationale:** 纯组件；被 Task 5 的 AssistantBubble compact 分支消费。TDD。

- [ ] **Step 1: 写失败测试**

Create `packages/extension/tests/sidepanel/components/step-row.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { StepRow } from "@/sidepanel/components/step-row";
import type { StepCardState } from "@/sidepanel/chat/session-store";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return {
    c,
    cleanup: () => {
      act(() => r.unmount());
      c.remove();
    },
  };
}

function makeCard(overrides: Partial<StepCardState>): StepCardState {
  return {
    toolUseId: "t1",
    name: "takeSnapshot",
    input: {},
    partialJson: "",
    inputReady: true,
    status: "ok",
    ms: 42,
    ...overrides,
  };
}

describe("StepRow", () => {
  it("ok + known alias: shows Chinese alias + ms; no English tool name visible", () => {
    const { c, cleanup } = mount(<StepRow card={makeCard({ name: "takeSnapshot" })} onExpand={() => {}} />);
    expect(c.textContent).toContain("抓页面快照");
    expect(c.textContent).toContain("42ms");
    expect(c.textContent).not.toContain("takeSnapshot");
    cleanup();
  });

  it("ok + unknown alias: falls back to English tool name (font-mono)", () => {
    const { c, cleanup } = mount(
      <StepRow card={makeCard({ name: "someUnknownTool", ms: 7 })} onExpand={() => {}} />
    );
    expect(c.textContent).toContain("someUnknownTool");
    expect(c.textContent).toContain("7ms");
    cleanup();
  });

  it("error: shows alias + error text, no ms", () => {
    const { c, cleanup } = mount(
      <StepRow
        card={makeCard({
          name: "clickByUid",
          status: "error",
          error: "uid el_102 not found",
          ms: 150,
        })}
        onExpand={() => {}}
      />
    );
    expect(c.textContent).toContain("点击元素");
    expect(c.textContent).toContain("uid el_102 not found");
    expect(c.textContent).not.toContain("150ms");
    cleanup();
  });

  it("running: shows spinner icon, no ms", () => {
    const { c, cleanup } = mount(
      <StepRow card={makeCard({ status: "running", ms: undefined })} onExpand={() => {}} />
    );
    // Loader2 icon renders as an SVG; assert its presence via lucide's data-attribute-agnostic class.
    expect(c.querySelector("svg.animate-spin")).toBeTruthy();
    expect(c.textContent ?? "").not.toMatch(/\dms/);
    cleanup();
  });

  it("clicking the row fires onExpand", () => {
    const onExpand = vi.fn();
    const { c, cleanup } = mount(<StepRow card={makeCard({})} onExpand={onExpand} />);
    const btn = c.querySelector("button") as HTMLButtonElement;
    act(() => btn.click());
    expect(onExpand).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aipagego/extension test step-row.test.tsx 2>&1 | tail -15
```

Expected: 5 tests failed with "Cannot find module '@/sidepanel/components/step-row'"。

- [ ] **Step 3: 写实现**

Create `packages/extension/src/sidepanel/components/step-row.tsx`：

```tsx
import { Check, X, Loader2, Circle } from "lucide-react";
import type { StepCardState } from "../chat/session-store";
import { labelFor } from "../lib/tool-labels";

type Props = {
  card: StepCardState;
  onExpand: () => void;
};

function StatusIcon({ status }: { status: StepCardState["status"] }) {
  if (status === "ok") return <Check size={12} className="text-emerald-500 shrink-0" />;
  if (status === "error") return <X size={12} className="text-red-500 shrink-0" />;
  if (status === "skipped" || status === "denied")
    return <Circle size={12} className="text-zinc-500 shrink-0" />;
  return <Loader2 size={12} className="text-zinc-400 animate-spin shrink-0" />;
}

export function StepRow({ card, onExpand }: Props) {
  const alias = labelFor(card.name);
  const isError = card.status === "error";
  const isDone = card.status === "ok";
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full flex items-center gap-2 px-2 py-1 rounded text-[11px] hover:bg-zinc-800/60 text-left"
    >
      <StatusIcon status={card.status} />
      {alias ? (
        <span className="text-zinc-200 shrink-0">{alias}</span>
      ) : (
        <span className="font-mono text-zinc-400 shrink-0">{card.name}</span>
      )}
      {isError && (
        <span className="text-red-400 truncate min-w-0">
          {card.error ?? "执行失败"}
        </span>
      )}
      {isDone && typeof card.ms === "number" && (
        <span className="ml-auto text-zinc-500 shrink-0">{card.ms}ms</span>
      )}
    </button>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @aipagego/extension test step-row.test.tsx 2>&1 | tail -15
```

Expected: 5 tests passed。

- [ ] **Step 5: 全套 typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/sidepanel/components/step-row.tsx packages/extension/tests/sidepanel/components/step-row.test.tsx
git commit -m "$(cat <<'EOF'
feat(sidepanel): 加 StepRow 组件 — 简洁模式一行进展显示

lucide-react 图标（Check / X / Loader2 / Circle）+ 中文别名（无
别名回退英文原名）+ 耗时。error 状态显 error message、无 ms。整行
clickable 触发 onExpand。
EOF
)"
```

---

### Task 4: SessionData.chatMode + Header toggle + AppShell 接线

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts` (加 chatMode 字段 + setChatMode action + useSession hook)
- Modify: `packages/extension/src/sidepanel/shell/header.tsx` (加 2 props + Eye/EyeOff toggle)
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx` (seed useEffect + 传 Header props)

**Interfaces:**
- Consumes:
  - `LlmSettings.defaultChatMode` (Task 1)
- Produces:
  - `SessionData.chatMode: "compact" | "full"`
  - `setChatMode(tabId: number, mode: "compact" | "full"): void` — exported action
  - `useSession()` 返回的对象里追加 `setChatMode(m): void`
  - `Header` 新 props：`chatMode: "compact" | "full"; onToggleChatMode: () => void`
  - AppShell 里 useEffect 会在会话为空时把 `session.chatMode` seed 成 `settings.defaultChatMode`

**Rationale:** 会话状态 + toggle UI 一起落地；不改渲染，只是把控制路径打通。Task 5 会消费。

- [ ] **Step 1: session-store 加 chatMode 字段与 action**

Modify `packages/extension/src/sidepanel/chat/session-store.ts`。

改动 A：`SessionData` type 末尾追加字段。找到 `debugBadge: DebugBadge;`（`grep -n "debugBadge: DebugBadge" packages/extension/src/sidepanel/chat/session-store.ts`），在其之后紧接：

```ts
  /** 聊天视图模式（session-scoped；不持久化）。默认 "compact"。 */
  chatMode: "compact" | "full";
```

改动 B：`makeEmptySession` 里加初始值。找到 `debugBadge: null` 那行，在其之后加 `,` 然后：

```ts
    chatMode: "compact"
```

（如原 `debugBadge: null` 之后没有逗号，加上。）

改动 C：新增 action 函数。在文件末尾（`export function setDebugBadge(...)` 附近）加：

```ts
export function setChatMode(tabId: number, mode: "compact" | "full"): void {
  patchSession(tabId, (s) => (s.chatMode === mode ? s : { ...s, chatMode: mode }));
}
```

改动 D：`useSession` legacy hook 追加方法。找到 `setDebugBadge: (b) => setDebugBadge(tabId, b)`（`grep -n "setDebugBadge:" packages/extension/src/sidepanel/chat/session-store.ts`），在其后加 `,` 然后新行：

```ts
    setChatMode: (m: "compact" | "full") => setChatMode(tabId, m)
```

改动 E：`LegacySession` type 也要追加同签名。找到 `setDebugBadge: (badge: DebugBadge) => void;`，在其后加：

```ts
  setChatMode: (m: "compact" | "full") => void;
```

- [ ] **Step 2: Header 加 props + Eye/EyeOff 按钮**

Modify `packages/extension/src/sidepanel/shell/header.tsx`。

改动 A：顶部 import 从 `lucide-react` 追加 `Eye`, `EyeOff`：

```ts
import { Plus, History, Wrench, Settings, Bug, Eye, EyeOff } from "lucide-react";
```

改动 B：Props type 追加字段：

```ts
type Props = {
  debugBadge: DebugBadge;
  onNewChat: () => void;
  chatMode: "compact" | "full";
  onToggleChatMode: () => void;
};
```

改动 C：`Header` 函数签名接住新 props：

```ts
export function Header({ debugBadge, onNewChat, chatMode, onToggleChatMode }: Props) {
```

改动 D：在 `<div className="flex gap-0.5">` 里、**第一个** `<IconBtn label="新会话" …>` 之前插入 toggle：

```tsx
          <IconBtn
            label={chatMode === "compact" ? "当前简洁模式，点切换详细" : "当前详细模式，点切换简洁"}
            onClick={onToggleChatMode}
          >
            {chatMode === "compact" ? <EyeOff size={14} /> : <Eye size={14} />}
          </IconBtn>
```

（放在最左边是因为 toggle 意图是"读性 vs 调试性"，与右侧的操作按钮语义不同，稍隔开。EyeOff = 隐藏细节 = compact；Eye = 显示细节 = full。）

- [ ] **Step 3: AppShell 传参 + seed useEffect**

Modify `packages/extension/src/sidepanel/shell/app-shell.tsx`。

改动 A：顶部 import 追加 `setChatMode`（找到 `setPermissionMode,` 那行，紧邻加）：

```ts
import {
  ...
  setPermissionMode,
  setChatMode,     // 新增
  ...
} from "@/sidepanel/chat/session-store";
```

改动 B：在现有"seed permissionMode from defaultPermissionMode"的 useEffect 之后（`grep -n "seed it from defaultPermissionMode" packages/extension/src/sidepanel/shell/app-shell.tsx` 找到该块，然后在整个 useEffect 结束的 `}, [settings.loaded, settings.defaultPermissionMode, currentTabId, session]);` 之后）加：

```tsx
  // 新会话（无 message、无 card）时，chatMode 跟随 settings.defaultChatMode
  useEffect(() => {
    if (!settings.loaded || currentTabId == null) return;
    if (session.messages.length === 0 && session.cards.length === 0) {
      const target: "compact" | "full" = settings.defaultChatMode ?? "compact";
      if (session.chatMode !== target) {
        setChatMode(currentTabId, target);
      }
    }
  }, [settings.loaded, settings.defaultChatMode, currentTabId, session]);
```

改动 C：`<Header …/>` 传新 props。找到 `<Header debugBadge={session.debugBadge} onNewChat={onNewChat} />` 那行（`grep -n "<Header" packages/extension/src/sidepanel/shell/app-shell.tsx`），改为：

```tsx
      <Header
        debugBadge={session.debugBadge}
        onNewChat={onNewChat}
        chatMode={session.chatMode}
        onToggleChatMode={() => {
          if (currentTabId != null) {
            setChatMode(currentTabId, session.chatMode === "compact" ? "full" : "compact");
          }
        }}
      />
```

- [ ] **Step 4: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Step 5: 全套 test（无 Header/AppShell/session-store 单测；仅确保 Task 1-3 没被回归）**

```bash
pnpm --filter @aipagego/extension test 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts packages/extension/src/sidepanel/shell/header.tsx packages/extension/src/sidepanel/shell/app-shell.tsx
git commit -m "$(cat <<'EOF'
feat(sidepanel): SessionData.chatMode + Header EyeOff/Eye toggle + AppShell seed

新会话时 session.chatMode = settings.defaultChatMode；Header 图标可
一键切换（只影响当前会话，不写回 settings）。渲染分支还在下一步接。
EOF
)"
```

---

### Task 5: AssistantBubble 双分支渲染 + B′ summary 三态 + build + 手工 QA

**Files:**
- Modify: `packages/extension/src/sidepanel/components/assistant-bubble.tsx`（整个 return 重构；hooks 顺序保持稳定）

**Interfaces:**
- Consumes:
  - `session.chatMode` from `useSession()` (Task 4)
  - `StepRow` from `@/sidepanel/components/step-row` (Task 3)
  - 现有 `StepCard` 不变
- Produces:
  - AssistantBubble 内部按 chatMode 走 compact 或 full 分支；hooks 顺序稳定；awaiting 强制展开 StepCard；B′ 三态 summary（`userOverride`）

**Rationale:** 端到端拼装；这一步 ship 后功能可用。含 build + 手工 QA。

- [ ] **Step 1: 改造 AssistantBubble**

Modify `packages/extension/src/sidepanel/components/assistant-bubble.tsx`。**整体替换**为下面这份（保留同样的 Props 类型；仅重构 return + 内部 state）：

```tsx
import { useState } from "react";
import type { ToolUsePart } from "@aipagego/shared/types";
import { useSession, type StepCardState } from "../chat/session-store";
import { StepCard } from "./step-card";
import { StepRow } from "./step-row";

type Props = {
  text: string;
  toolUses: ToolUsePart[];         // finalized 的（来自 messages）
  pendingCards?: StepCardState[];  // 流式中尚未 finalize 的 cards
  cardsById: Map<string, StepCardState>;
  onApprove: (
    id: string,
    decision: "run" | "run-and-always-allow" | "skip" | "deny",
    toolName?: string
  ) => void;
  needsApproval: (card: StepCardState) => boolean;
  isLive: boolean;
  /** True if this is the final assistant message and the session is idle.
   *  Enables the "复制 / 重生成" per-message actions row. */
  isLastIdle?: boolean;
  onRegenerate?: () => void;
};

export function AssistantBubble({
  text,
  toolUses,
  pendingCards = [],
  cardsById,
  onApprove,
  needsApproval,
  isLive,
  isLastIdle,
  onRegenerate
}: Props) {
  const chatMode = useSession().chatMode;

  const allCards: StepCardState[] = [];
  for (const tu of toolUses) {
    const c = cardsById.get(tu.id);
    if (c) allCards.push(c);
  }
  for (const c of pendingCards) allCards.push(c);

  const hasAwaiting = allCards.some(
    (c) => (c.status === "awaiting" && needsApproval(c)) || c.status === "running"
  );

  // ── 所有 hooks 都无条件调用，保持 hooks 顺序稳定 ──
  const [open, setOpen] = useState<boolean>(isLive || hasAwaiting);              // full 分支消费
  const [expanded, setExpanded] = useState<Set<string>>(new Set());              // compact 分支消费（单行→StepCard）
  const [userOverride, setUserOverride] = useState<boolean | undefined>(undefined); // compact 分支消费（summary 三态）

  const done = allCards.filter((c) => c.status === "ok").length;
  const errs = allCards.filter((c) => c.status === "error").length;

  const actions =
    !isLive && (text || allCards.length > 0) ? (
      <div
        data-testid="message-actions"
        className="self-end flex gap-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity"
      >
        {text && (
          <button
            type="button"
            aria-label="复制"
            className="px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-700"
            onClick={() => {
              navigator.clipboard?.writeText(text).catch(() => undefined);
            }}
          >
            复制
          </button>
        )}
        {isLastIdle && onRegenerate && (
          <button
            type="button"
            aria-label="重生成"
            className="px-1.5 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-100 rounded hover:bg-zinc-700"
            onClick={onRegenerate}
          >
            重生成
          </button>
        )}
      </div>
    ) : null;

  // ─────────────── compact 分支 ───────────────
  if (chatMode === "compact") {
    const autoOpen = isLive || hasAwaiting;
    const summaryOpen = userOverride !== undefined ? userOverride : autoOpen;
    const summaryText = errs > 0 ? `✓${done} · ✗${errs}` : `${allCards.length} 步`;

    const toggleCard = (id: string) => {
      setExpanded((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };

    return (
      <div className="bg-zinc-800/60 rounded p-2 text-xs flex flex-col gap-1.5">
        {allCards.length > 0 && (
          <>
            <button
              onClick={() => setUserOverride(!summaryOpen)}
              className="self-start text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
            >
              <span>{summaryOpen ? "▾" : "▸"}</span>
              <span>{summaryText}</span>
            </button>
            {summaryOpen && (
              <div className="flex flex-col gap-0.5">
                {allCards.map((card) => {
                  const mustExpand =
                    (card.status === "awaiting" && needsApproval(card)) ||
                    expanded.has(card.toolUseId);
                  return mustExpand ? (
                    <StepCard
                      key={card.toolUseId}
                      card={card}
                      onApprove={onApprove}
                      needsManualApproval={needsApproval(card)}
                    />
                  ) : (
                    <StepRow
                      key={card.toolUseId}
                      card={card}
                      onExpand={() => toggleCard(card.toolUseId)}
                    />
                  );
                })}
              </div>
            )}
          </>
        )}
        {text && <div className="whitespace-pre-wrap">{text}</div>}
        {actions}
      </div>
    );
  }

  // ─────────────── full 分支（现有实现原样保留） ───────────────
  const summary =
    allCards.length === 0
      ? null
      : (() => {
          const wait = allCards.filter(
            (c) => c.status === "awaiting" && needsApproval(c)
          ).length;
          const pieces = [`${allCards.length} 次工具调用`];
          if (done) pieces.push(`✓${done}`);
          if (errs) pieces.push(`✗${errs}`);
          if (wait) pieces.push(`待审 ${wait}`);
          return pieces.join(" · ");
        })();

  const effectiveOpen = open || hasAwaiting || isLive;

  return (
    <div className="bg-zinc-800/60 rounded p-2 text-xs flex flex-col gap-2">
      {allCards.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setOpen(!open)}
            className="self-start text-[11px] text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
          >
            <span>{effectiveOpen ? "▾" : "▸"}</span>
            <span>{summary}</span>
          </button>
          {effectiveOpen && (
            <div className="flex flex-col gap-1 pl-3 border-l-2 border-zinc-700">
              {allCards.map((card) => (
                <StepCard
                  key={card.toolUseId}
                  card={card}
                  onApprove={onApprove}
                  needsManualApproval={needsApproval(card)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {text && <div className="whitespace-pre-wrap">{text}</div>}
      {actions}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Step 3: 全套 test（AssistantBubble 无既有单测；仅确保 Task 1-3 的 tool-labels / step-row 无回归 + 主套 487 tests 仍绿）**

```bash
pnpm --filter @aipagego/extension test 2>&1 | tail -10
```

Expected: 全绿；`tool-labels.test.ts` (4) + `step-row.test.tsx` (5) 皆 pass。

- [ ] **Step 4: 生产 build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: `✓ built in ...s`，无 warning / error。

- [ ] **Step 5: 手工 QA 清单**

`chrome://extensions` reload 扩展，在真实网页上验证：

- [ ] 首次装（默认简洁）：发一个多步任务 → 每步渲染成一行
- [ ] Live 中：summary 自动展开、逐条追加
- [ ] 任务完成：summary 自动折叠回 `N 步` 或 `✓X · ✗Y`
- [ ] 点 summary：手动展开／折叠，覆盖自动
- [ ] 点单行：展开为完整 StepCard；再点整个 StepCard 上任意位置：不收回（现有 StepCard 无收回按钮，接受）
- [ ] 简洁模式下危险工具（如 `httpRequest withCredentials`）：awaiting 时自动完整卡 + 审批按钮
- [ ] 审批通过后：卡片状态变 running/ok，自动收回一行
- [ ] 工具报错：一行显示 error message；点开看完整
- [ ] Header EyeOff 图标（简洁态）→ 点击变 Eye（详细态）
- [ ] 详细态：等同现在的完整卡片列表（回归验证）
- [ ] Settings → 外观 → 默认视图 = 详细 → 新开会话默认详细
- [ ] Settings 里改默认不影响当前会话；Header 图标改也不影响 Settings
- [ ] 无中文别名的工具（如自定义工具库里的 tool）：一行显示英文原名
- [ ] 复制 / 重生成 actions 在两种模式下都正常

- [ ] **Step 6: 提交（含 plan doc）**

先把 plan 文件加进去（本任务的最后一步 ship 时一并提交，参考 prompt-optimize 的做法）：

```bash
git add docs/superpowers/plans/2026-07-02-conversation-mode.md packages/extension/src/sidepanel/components/assistant-bubble.tsx
git commit -m "$(cat <<'EOF'
feat(sidepanel): AssistantBubble 双分支 — 简洁/详细模式切换

简洁模式下工具调用渲染为一行 StepRow（图标+中文别名+耗时）+ B′ 三态
summary（live 展开 / done 折叠 / 用户 override）；awaiting 强制展开
完整 StepCard；error 一行显摘要。详细模式保持现有实现不变。
所有 useState 无条件调用以保持 hooks 顺序稳定。

含 5-task 实施计划文档。
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec 节 | 覆盖 task |
|---|---|
| §3.1 命名 | Task 1（UI 文案）+ 全程内部 enum `compact/full` |
| §3.2 一行进展形态 | Task 3 |
| §3.3 审批 / 报错例外 | Task 5 Step 1（`mustExpand` 分支）+ Task 3（error 行渲染） |
| §3.4 B′ 三态 summary | Task 5 Step 1（`userOverride` 状态） |
| §3.5 开关位置与作用域 | Task 1（Settings UI）+ Task 4（Header toggle + AppShell seed） |
| §4.3 tool-labels | Task 2 |
| §4.4 StepRow | Task 3 |
| §4.5 Settings 字段 | Task 1 |
| §4.6 Session state | Task 4 Step 1 |
| §4.7 AppShell 初始化 | Task 4 Step 3 |
| §4.8 Header 按钮 | Task 4 Step 2 |
| §4.9 AssistantBubble 分模式 | Task 5 |
| §5 数据流 | Task 4 + Task 5 端到端拼装 |
| §6 测试 | Task 2 (labels) + Task 3 (StepRow) + Task 5 Step 5（手工 QA） |

**Placeholder scan:** 已通读，无 TBD / TODO / 「implement later」；所有代码块可运行；所有 grep 用 anchor（如 `export type LlmSettings`、`const DEFAULTS`、`<Header`、`setDebugBadge:`）而非行号。

**Type consistency:**
- `LlmSettings.defaultChatMode?: "compact" | "full"` 在 Task 1 定义 → Task 4 Step 3 (`settings.defaultChatMode`) 消费 ✓
- `SessionData.chatMode: "compact" | "full"` 在 Task 4 Step 1 定义 → Task 5 Step 1 (`useSession().chatMode`) 消费 ✓
- `setChatMode(tabId, mode)` 在 Task 4 Step 1 定义 → Task 4 Step 3 (AppShell useEffect + Header handler) 消费 ✓
- `labelFor(name): string | null` 在 Task 2 定义 → Task 3 Step 3 消费 ✓
- `StepRowProps = {card, onExpand}` 在 Task 3 定义 → Task 5 Step 1 消费 ✓
- Header 新增 props `chatMode` / `onToggleChatMode` 在 Task 4 Step 2 定义 → Task 4 Step 3 传入 ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-conversation-mode.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — 每 task 派 fresh subagent，主会话 review 后再进下一个。5 个 task 都比较独立、TDD 友好。

**2. Inline Execution** — 用 executing-plans，当前会话跑，checkpoint 处停一下。

**Which approach?**
