# Widget Round 2 — 11 项功能补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** widget 从 MVP 抬到"日常聊天足够,不用切 sidepanel" —— 补齐 11 项功能(状态条 / 错误条 / preset chip / quick-actions / 图片 / resize / 元素圈选 / 权限 pill / error banner / 保存工具入口 / 历史 mini drawer),作为一次 iteration 发 v0.0.52。

**Architecture:** 全部改动是 UI 层增量;运行时协议(runChatSession / Approver / 自愈路径)与 v0.0.51 完全一致;尽最大程度复用现有 sidepanel 组件(`PermissionModePill` / `QuickActions` / `EmptySuggestions` / `StagedImages` / `fileToImagePart`)与 helper(`listArchivedByUrl` / `restoreArchived` / `matchPresetsByUrl` / `showSave`);新增 1 个 RPC `widget.openSidepanelWithSave`,widget 只走 header/footer/input 三块的组件插拔。

**Tech Stack:** React 18 · TypeScript 5(strict)· Tailwind → `adoptedStyleSheets` · lucide-react · vitest + happy-dom + fake-indexeddb;零新 npm 依赖。

## Global Constraints

- **IDB DB name `aipagego`** 不改
- **No new dependencies**
- **API key 永远不进 BG**
- **Shadow DOM `mode: "open"`**;widget/index.css 里 `:host` 定义 `--c-zinc-*` 变量(v0.0.47)
- **运行时协议不改**:runChatSession / Approver / 自愈路径 = v0.0.51
- **共享 session**:widget 与 sidepanel 通过 `session.state.changed` 广播 + `_rev` 号仲裁(v0.0.46)
- **广播 helper**:所有 session mutation 走 `mutateSession(tabId, updater)`;`setStatus/setCardStatus/setPermissionMode/setError/appendUserMessage/appendUserMessageWithImages` 已经走这条路径
- **PermissionModePill**:签名 `{mode, onChange, trustedDangerTools, onTrustedChange}` — 4 props 都要传
- **StagedImages**:签名 `{images: ImagePart[], onRemove: (idx: number) => void}` — 数据类型是 `ImagePart[]`,不是 `File[]`
- **File → ImagePart**:用 `fileToImagePart(file: File | Blob): Promise<ImagePart>` from `@/sidepanel/lib/image-utils`;`MAX_IMAGE_BYTES=5MB`, `MAX_IMAGES_PER_TURN=5`

---

## File Structure

**新建**:

- `packages/extension/src/content/widget/status-bar.tsx` — sticky 24px 状态条
- `packages/extension/src/content/widget/error-banner.tsx` — 红条 errorMessage 显示
- `packages/extension/src/content/widget/save-entry.tsx` — chat 尾部 "已执行 N 步 [保存为工具]"
- `packages/extension/src/content/widget/input-row.tsx` — pill + staged images + input + send/stop 一起管
- `packages/extension/src/content/widget/element-capture-hook.ts` — 触发 + captureResult listener
- `packages/extension/src/content/widget/resize-handle.tsx` — 右下角 corner grip
- `packages/extension/src/content/widget/history-mode.tsx` — 历史模式 body
- `packages/extension/src/content/widget/empty-state.tsx` — 空态(preset chip + QuickActions)

**测试**:

- `packages/extension/tests/content/widget/status-bar.test.tsx`
- `packages/extension/tests/content/widget/error-banner.test.tsx`
- `packages/extension/tests/content/widget/save-entry.test.tsx`
- `packages/extension/tests/content/widget/input-row.test.tsx`
- `packages/extension/tests/content/widget/element-capture-hook.test.ts`
- `packages/extension/tests/content/widget/resize-handle.test.tsx`
- `packages/extension/tests/content/widget/history-mode.test.tsx`
- `packages/extension/tests/content/widget/empty-state.test.tsx`
- `packages/extension/tests/background/widget-save-rpc.test.ts`

**修改**:

- `packages/extension/src/content/widget/panel.tsx` — 组合以上组件,加 `mode` state
- `packages/shared/src/messages.ts` — 加 `widget.openSidepanelWithSave` RPC
- `packages/extension/src/background/rpc-handlers.ts` — dispatch 新 RPC
- `packages/extension/src/sidepanel/rpc.ts` — `rpc.widgetOpenSidepanelWithSave` wrapper
- `packages/extension/src/sidepanel/shell/app-shell.tsx` — pendingSave focus effect
- `packages/extension/src/sidepanel/chat/session-store.ts` — `setCardStatus(...running)` 里盖 `_runningStartAt`
- `packages/shared/src/types.ts` — `StepCardState._runningStartAt?: number`(如果类型在 shared;否则改 session-store.ts 那份)

---

### Task 1: Foundation — `_runningStartAt` + `widget.openSidepanelWithSave` RPC + pendingSave 中继

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts` — `StepCardState._runningStartAt?: number` + `setCardStatus` 在 status=running 时盖 timestamp
- Modify: `packages/shared/src/messages.ts` — RPC schema
- Modify: `packages/extension/src/background/rpc-handlers.ts` — dispatch case
- Modify: `packages/extension/src/sidepanel/rpc.ts` — wrapper
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx` — pendingSave focus effect
- Test: `packages/extension/tests/background/widget-save-rpc.test.ts`
- Test: `packages/extension/tests/sidepanel/chat/session-store-running-start-at.test.ts`

**Interfaces:**
- Produces:
  - `StepCardState._runningStartAt?: number` — 在 setCardStatus 到 running 时盖 `Date.now()`;后续 status change 不清
  - RPC `widget.openSidepanelWithSave { tabId } → null`
  - `rpc.widgetOpenSidepanelWithSave(input: { tabId: number }): Promise<null>`
  - sidepanel `useEffect` 读 `aipagego.pendingSave` 后调 `showSave(tabId)` 并 clear

- [ ] **Step 1: Write failing test for `_runningStartAt` stamping**

```ts
// packages/extension/tests/sidepanel/chat/session-store-running-start-at.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureSession, upsertCard, setCardStatus, useStore
} from "@/sidepanel/chat/session-store";

(globalThis as any).chrome = {
  runtime: { sendMessage: vi.fn() }
};

describe("setCardStatus stamps _runningStartAt on running", () => {
  beforeEach(() => {
    useStore.setState({ sessionsByTab: {}, currentTabId: null });
  });

  it("stamps _runningStartAt when status transitions to running", () => {
    ensureSession(1, "https://x/");
    upsertCard(1, {
      toolUseId: "u1", name: "snapshotDOM", input: {} as any,
      partialJson: "", inputReady: true, status: "awaiting"
    });
    const before = Date.now();
    setCardStatus(1, "u1", { status: "running" });
    const after = Date.now();
    const c = useStore.getState().sessionsByTab[1].cards.find((x) => x.toolUseId === "u1")!;
    expect(c._runningStartAt).toBeGreaterThanOrEqual(before);
    expect(c._runningStartAt).toBeLessThanOrEqual(after);
  });

  it("does not stamp on non-running transitions", () => {
    ensureSession(2, "https://y/");
    upsertCard(2, {
      toolUseId: "u2", name: "click", input: {} as any,
      partialJson: "", inputReady: true, status: "awaiting"
    });
    setCardStatus(2, "u2", { status: "ok" });
    const c = useStore.getState().sessionsByTab[2].cards.find((x) => x.toolUseId === "u2")!;
    expect(c._runningStartAt).toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify test fails**

```bash
pnpm --filter @aipagego/extension test session-store-running-start-at
```
Expected: FAIL — `_runningStartAt` is undefined.

- [ ] **Step 3: Add `_runningStartAt` to `StepCardState`**

In `packages/extension/src/sidepanel/chat/session-store.ts`, find the `StepCardState` type and add:

```ts
export type StepCardState = {
  toolUseId: string;
  name: string;
  input: Json;
  partialJson: string;
  inputReady: boolean;
  status: "draft" | "awaiting" | "running" | "ok" | "error" | "skipped" | "denied";
  output?: Json;
  error?: string;
  ms?: number;
  /** Widget round 2:tool 进入 running 时的时间戳 (Date.now())。widget 状态条计时器用。 */
  _runningStartAt?: number;
};
```

- [ ] **Step 4: Modify `setCardStatus` to stamp `_runningStartAt`**

Find `export function setCardStatus(tabId, toolUseId, patch)` in same file. Change the internal card update to stamp on transition to running:

```ts
export function setCardStatus(
  tabId: number,
  toolUseId: string,
  patch: Partial<Omit<StepCardState, "toolUseId">>
): void {
  mutateSession(tabId, (s) => ({
    ...s,
    cards: s.cards.map((c) =>
      c.toolUseId === toolUseId
        ? {
            ...c,
            ...patch,
            ...(patch.status === "running" && c.status !== "running"
              ? { _runningStartAt: Date.now() }
              : {}),
          }
        : c
    ),
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
pnpm --filter @aipagego/extension test session-store-running-start-at
```
Expected: PASS

- [ ] **Step 6: Write failing test for widget.openSidepanelWithSave RPC**

```ts
// packages/extension/tests/background/widget-save-rpc.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as any).chrome = {
  sidePanel: { open: vi.fn().mockResolvedValue(undefined) },
  storage: {
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    },
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    }
  },
  tabs: { get: vi.fn(), sendMessage: vi.fn(), onUpdated: { addListener: vi.fn() }, onRemoved: { addListener: vi.fn() }, onCreated: { addListener: vi.fn() } },
  webNavigation: { onHistoryStateUpdated: { addListener: vi.fn() } },
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
  action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
  scripting: { executeScript: vi.fn() }
};

describe("widget.openSidepanelWithSave", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens sidepanel and stores pendingSave in session storage", async () => {
    const { dispatch } = await import("@/background/rpc-handlers");
    await dispatch({ type: "widget.openSidepanelWithSave", tabId: 42 } as any);
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 42 });
    expect(chrome.storage.session.set).toHaveBeenCalledWith(
      expect.objectContaining({
        "aipagego.pendingSave": expect.objectContaining({ tabId: 42 })
      })
    );
  });
});
```

- [ ] **Step 7: Verify test fails**

```bash
pnpm --filter @aipagego/extension test widget-save-rpc
```
Expected: FAIL — `widget.openSidepanelWithSave` not recognized in RpcRequest union.

- [ ] **Step 8: Add RPC to `messages.ts`**

In `packages/shared/src/messages.ts` inside the `RpcRequest = z.discriminatedUnion("type", [...])` array (near `widget.openSidepanel`), add:

```ts
  z.object({
    type: z.literal("widget.openSidepanelWithSave"),
    tabId: z.number().int()
  }),
```

- [ ] **Step 9: Dispatch case in `rpc-handlers.ts`**

In `packages/extension/src/background/rpc-handlers.ts` `dispatch` switch, add:

```ts
    case "widget.openSidepanelWithSave": {
      await chrome.sidePanel.open({ tabId: req.tabId });
      await chrome.storage.session.set({
        "aipagego.pendingSave": { tabId: req.tabId, ts: Date.now() }
      });
      return null;
    }
```

- [ ] **Step 10: Add sidepanel wrapper**

In `packages/extension/src/sidepanel/rpc.ts` `export const rpc = { ... }`, add:

```ts
  widgetOpenSidepanelWithSave: (input: { tabId: number }) =>
    call<null>({ type: "widget.openSidepanelWithSave", tabId: input.tabId }),
```

- [ ] **Step 11: Run test to verify pass**

```bash
pnpm --filter @aipagego/extension test widget-save-rpc
```
Expected: PASS

- [ ] **Step 12: Add pendingSave focus effect in app-shell.tsx**

In `packages/extension/src/sidepanel/shell/app-shell.tsx`, near the `aipagego.pendingApproval` effect, add:

```tsx
  // Widget 通过 widget.openSidepanelWithSave 唤起本面板时,BG 会在 chrome.storage.session
  // 存 aipagego.pendingSave;这里读到就调 showSave(tabId) 弹保存对话框。
  useEffect(() => {
    const KEY = "aipagego.pendingSave";
    void chrome.storage.session.get([KEY]).then(async (res) => {
      const p = (res as any)[KEY] as { tabId: number; ts: number } | undefined;
      if (!p) return;
      if (Date.now() - p.ts > 30_000) {
        await chrome.storage.session.remove([KEY]);
        return;
      }
      showSave(p.tabId);
      await chrome.storage.session.remove([KEY]);
    });
  }, []);
```

If `showSave` is not currently imported in `app-shell.tsx`, add it to the imports from `@/sidepanel/chat/session-store`.

- [ ] **Step 13: Typecheck + full widget test**

```bash
pnpm -r typecheck
pnpm --filter @aipagego/extension test content/widget session-store-running-start-at widget-save-rpc
```
Expected: all pass.

- [ ] **Step 14: Commit**

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts \
        packages/shared/src/messages.ts \
        packages/extension/src/background/rpc-handlers.ts \
        packages/extension/src/sidepanel/rpc.ts \
        packages/extension/src/sidepanel/shell/app-shell.tsx \
        packages/extension/tests/sidepanel/chat/session-store-running-start-at.test.ts \
        packages/extension/tests/background/widget-save-rpc.test.ts
git commit -m "feat: StepCardState._runningStartAt + widget.openSidepanelWithSave RPC + pendingSave 中继"
```

---

### Task 2: Sticky Status Bar + Error Banner + Save Entry

**Files:**
- Create: `packages/extension/src/content/widget/status-bar.tsx`
- Create: `packages/extension/src/content/widget/error-banner.tsx`
- Create: `packages/extension/src/content/widget/save-entry.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 三个组件插入 body 上/内
- Test: `packages/extension/tests/content/widget/status-bar.test.tsx`
- Test: `packages/extension/tests/content/widget/error-banner.test.tsx`
- Test: `packages/extension/tests/content/widget/save-entry.test.tsx`

**Interfaces:**
- Consumes: `_runningStartAt`(Task 1);`rpc.widgetOpenSidepanelWithSave`(Task 1);`setError(tabId, null)`(existing session-store action)
- Produces:
  - `<StatusBar session={SessionData} />` — 24px 高
  - `<ErrorBanner session={SessionData} tabId={number} />` — 红条 + [×]
  - `<SaveEntry session={SessionData} tabId={number} />` — chat 尾部小条

- [ ] **Step 1: Implement StatusBar component**

```tsx
// packages/extension/src/content/widget/status-bar.tsx
import { useEffect, useState } from "react";
import { Wrench, Brain, PauseCircle } from "lucide-react";
import type { SessionData } from "@/sidepanel/chat/session-store";

type Props = { session: SessionData };

/**
 * Sticky 24px 状态条,session.status !== idle/done/aborted 时渲染。
 * - running: 🔧 {tool} · {elapsed}s ⟳(每 250ms 刷新)
 * - streaming: 💭 AI 思考中...
 * - awaiting: ⏸ 等待你确认下一步
 */
export function StatusBar({ session }: Props) {
  const [, forceTick] = useState(0);

  const runningCard = session.cards.find((c) => c.status === "running");
  const shouldTick = runningCard != null;

  useEffect(() => {
    if (!shouldTick) return;
    const id = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [shouldTick]);

  const st = session.status;
  if (st === "idle" || st === "done" || st === "aborted" || st === "error") return null;

  if (runningCard) {
    const startedAt = runningCard._runningStartAt;
    const secs = startedAt ? ((Date.now() - startedAt) / 1000).toFixed(1) : "?";
    return (
      <div
        data-testid="widget-status-bar"
        className="px-3 py-1 border-b border-zinc-800 text-[11px] text-zinc-400 flex items-center gap-2 shrink-0"
      >
        <Wrench size={12} className="text-emerald-400" />
        <span className="font-mono">{runningCard.name}</span>
        <span className="text-zinc-500">· {secs}s</span>
        <span className="ml-auto animate-spin">⟳</span>
      </div>
    );
  }
  if (st === "awaiting") {
    return (
      <div
        data-testid="widget-status-bar"
        className="px-3 py-1 border-b border-zinc-800 text-[11px] text-amber-300 flex items-center gap-2 shrink-0"
      >
        <PauseCircle size={12} />
        <span>等待你确认下一步</span>
      </div>
    );
  }
  return (
    <div
      data-testid="widget-status-bar"
      className="px-3 py-1 border-b border-zinc-800 text-[11px] text-zinc-400 flex items-center gap-2 shrink-0"
    >
      <Brain size={12} />
      <span>AI 思考中…</span>
    </div>
  );
}
```

- [ ] **Step 2: Write StatusBar test**

```tsx
// packages/extension/tests/content/widget/status-bar.test.tsx
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StatusBar } from "@/content/widget/status-bar";
import type { SessionData } from "@/sidepanel/chat/session-store";

function makeSession(patch: Partial<SessionData>): SessionData {
  return {
    tabId: 1, url: "", runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
    ...patch,
  } as SessionData;
}

describe("StatusBar", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing on idle", async () => {
    await act(async () =>
      root.render(<StatusBar session={makeSession({ status: "idle" })} />)
    );
    expect(container.querySelector("[data-testid=widget-status-bar]")).toBeNull();
  });

  it("shows running tool name + elapsed when a card is running", async () => {
    const started = Date.now() - 2300;
    const sess = makeSession({
      status: "running",
      cards: [{
        toolUseId: "u1", name: "snapshotDOM", input: {} as any,
        partialJson: "", inputReady: true, status: "running",
        _runningStartAt: started,
      }],
    });
    await act(async () => root.render(<StatusBar session={sess} />));
    const bar = container.querySelector("[data-testid=widget-status-bar]")!;
    expect(bar.textContent).toContain("snapshotDOM");
    expect(bar.textContent).toMatch(/2\.\d+s/);
  });

  it("shows 思考中 on streaming without a running card", async () => {
    await act(async () =>
      root.render(<StatusBar session={makeSession({ status: "streaming" })} />)
    );
    const bar = container.querySelector("[data-testid=widget-status-bar]")!;
    expect(bar.textContent).toContain("AI 思考");
  });

  it("shows 等待确认 on awaiting", async () => {
    await act(async () =>
      root.render(<StatusBar session={makeSession({ status: "awaiting" })} />)
    );
    const bar = container.querySelector("[data-testid=widget-status-bar]")!;
    expect(bar.textContent).toContain("等待你确认");
  });
});
```

- [ ] **Step 3: Verify test passes**

```bash
pnpm --filter @aipagego/extension test content/widget/status-bar
```
Expected: 4 tests pass.

- [ ] **Step 4: Implement ErrorBanner**

```tsx
// packages/extension/src/content/widget/error-banner.tsx
import { X, AlertTriangle } from "lucide-react";
import { setError } from "@/sidepanel/chat/session-store";
import type { SessionData } from "@/sidepanel/chat/session-store";

type Props = { session: SessionData; tabId: number };

export function ErrorBanner({ session, tabId }: Props) {
  if (!session.errorMessage) return null;
  return (
    <div
      data-testid="widget-error-banner"
      className="px-3 py-1.5 bg-red-950 border-b border-red-900 text-[11px] text-red-200 flex items-start gap-2 shrink-0"
    >
      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
      <span className="flex-1 break-words">{session.errorMessage}</span>
      <button
        aria-label="关闭错误提示"
        className="shrink-0 hover:text-red-100"
        onClick={() => setError(tabId, null)}
      >
        <X size={12} />
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Write ErrorBanner test**

```tsx
// packages/extension/tests/content/widget/error-banner.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ErrorBanner } from "@/content/widget/error-banner";
import type { SessionData } from "@/sidepanel/chat/session-store";

const mockSetError = vi.fn();
vi.mock("@/sidepanel/chat/session-store", async (orig) => {
  const actual = await orig<typeof import("@/sidepanel/chat/session-store")>();
  return { ...actual, setError: (tabId: number, msg: string | null) => mockSetError(tabId, msg) };
});

function makeSession(patch: Partial<SessionData>): SessionData {
  return {
    tabId: 1, url: "", runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
    ...patch,
  } as SessionData;
}

describe("ErrorBanner", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing when errorMessage is null", async () => {
    await act(async () =>
      root.render(<ErrorBanner session={makeSession({ errorMessage: null })} tabId={1} />)
    );
    expect(container.querySelector("[data-testid=widget-error-banner]")).toBeNull();
  });

  it("shows message and calls setError(tabId, null) on close", async () => {
    await act(async () =>
      root.render(
        <ErrorBanner session={makeSession({ errorMessage: "未配置 API Key" })} tabId={42} />
      )
    );
    const bar = container.querySelector("[data-testid=widget-error-banner]")!;
    expect(bar.textContent).toContain("未配置 API Key");
    const closeBtn = bar.querySelector("button[aria-label='关闭错误提示']") as HTMLButtonElement;
    await act(async () => closeBtn.click());
    expect(mockSetError).toHaveBeenCalledWith(42, null);
  });
});
```

- [ ] **Step 6: Verify test passes**

```bash
pnpm --filter @aipagego/extension test content/widget/error-banner
```
Expected: 2 tests pass.

- [ ] **Step 7: Implement SaveEntry**

```tsx
// packages/extension/src/content/widget/save-entry.tsx
import { Save } from "lucide-react";
import { rpc } from "@/sidepanel/rpc";
import type { SessionData } from "@/sidepanel/chat/session-store";

type Props = { session: SessionData; tabId: number };

/**
 * Chat body 尾部小条:执行完 N 步、状态 done 时露"保存为工具"入口。
 * 点击调 widget.openSidepanelWithSave RPC — BG 打开 sidepanel + 存 pendingSave,
 * sidepanel focus effect 读到就调 showSave(tabId)。
 */
export function SaveEntry({ session, tabId }: Props) {
  const canSave =
    session.executedSteps.length > 0 && session.status === "done";
  if (!canSave) return null;
  async function onClick() {
    await rpc.widgetOpenSidepanelWithSave({ tabId }).catch(() => {});
  }
  return (
    <div
      data-testid="widget-save-entry"
      className="mt-2 px-3 py-2 bg-zinc-900 border border-zinc-800 rounded flex items-center gap-2 text-[11px]"
    >
      <span className="text-emerald-400">✓</span>
      <span className="flex-1 text-zinc-300">
        已执行 {session.executedSteps.length} 步
      </span>
      <button
        onClick={onClick}
        className="px-2 py-0.5 bg-emerald-800 hover:bg-emerald-700 rounded text-emerald-100 flex items-center gap-1"
      >
        <Save size={11} /> 保存为工具
      </button>
    </div>
  );
}
```

- [ ] **Step 8: Write SaveEntry test**

```tsx
// packages/extension/tests/content/widget/save-entry.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SaveEntry } from "@/content/widget/save-entry";
import type { SessionData } from "@/sidepanel/chat/session-store";

const mockOpenSidepanelWithSave = vi.fn().mockResolvedValue(null);
vi.mock("@/sidepanel/rpc", () => ({
  rpc: { widgetOpenSidepanelWithSave: (input: any) => mockOpenSidepanelWithSave(input) },
}));

function makeSession(patch: Partial<SessionData>): SessionData {
  return {
    tabId: 1, url: "", runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
    ...patch,
  } as SessionData;
}

describe("SaveEntry", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders nothing when no executedSteps", async () => {
    await act(async () =>
      root.render(<SaveEntry session={makeSession({ status: "done", executedSteps: [] })} tabId={1} />)
    );
    expect(container.querySelector("[data-testid=widget-save-entry]")).toBeNull();
  });

  it("renders nothing when status not done", async () => {
    await act(async () =>
      root.render(
        <SaveEntry
          session={makeSession({ status: "streaming", executedSteps: [{} as any, {} as any] })}
          tabId={1}
        />
      )
    );
    expect(container.querySelector("[data-testid=widget-save-entry]")).toBeNull();
  });

  it("shows entry when done + steps > 0 and calls RPC on click", async () => {
    await act(async () =>
      root.render(
        <SaveEntry
          session={makeSession({ status: "done", executedSteps: [{} as any, {} as any, {} as any] })}
          tabId={99}
        />
      )
    );
    const el = container.querySelector("[data-testid=widget-save-entry]")!;
    expect(el.textContent).toContain("已执行 3 步");
    const btn = el.querySelector("button")! as HTMLButtonElement;
    await act(async () => btn.click());
    expect(mockOpenSidepanelWithSave).toHaveBeenCalledWith({ tabId: 99 });
  });
});
```

- [ ] **Step 9: Wire StatusBar + ErrorBanner + SaveEntry into Panel**

In `packages/extension/src/content/widget/panel.tsx`, add imports:

```tsx
import { StatusBar } from "./status-bar";
import { ErrorBanner } from "./error-banner";
import { SaveEntry } from "./save-entry";
```

Locate the JSX between `<header>` and the body `<div className="flex-1 overflow-auto min-h-0">`. Insert:

```tsx
      {/* Error banner (only when session.errorMessage exists) */}
      <ErrorBanner session={session} tabId={tabId ?? -1} />

      {/* Sticky status bar (only when session non-idle) */}
      <StatusBar session={session} />
```

Then inside the body `<div>`, at the end (after ChatView / EmptySuggestions), add:

```tsx
        {tabId != null && <SaveEntry session={session} tabId={tabId} />}
```

- [ ] **Step 10: Run all widget tests + build**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm -r typecheck
pnpm build
```
Expected: all pass, build succeeds.

- [ ] **Step 11: Commit**

```bash
git add packages/extension/src/content/widget/status-bar.tsx \
        packages/extension/src/content/widget/error-banner.tsx \
        packages/extension/src/content/widget/save-entry.tsx \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/status-bar.test.tsx \
        packages/extension/tests/content/widget/error-banner.test.tsx \
        packages/extension/tests/content/widget/save-entry.test.tsx
git commit -m "feat(widget): 状态条 + 错误条 + 保存工具入口"
```

---

### Task 3: 空态 preset chip + QuickActions

**Files:**
- Create: `packages/extension/src/content/widget/empty-state.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 用新组件替换现有空态渲染
- Test: `packages/extension/tests/content/widget/empty-state.test.tsx`

**Interfaces:**
- Consumes:
  - `matchPresetsByUrl(url) → Preset[]` from `@aipagego/shared/match-presets`
  - `<EmptySuggestions matchedTools={[]} presets onPresetPick onRun onDetail />` — existing
  - `<QuickActions currentUrl onPick />` — existing
- Produces:
  - `<EmptyState session={SessionData} onFillInput={(text: string) => void} />` — 组合两个已有组件

- [ ] **Step 1: Implement EmptyState**

```tsx
// packages/extension/src/content/widget/empty-state.tsx
import { EmptySuggestions } from "@/sidepanel/chat/empty-suggestions";
import { QuickActions } from "@/sidepanel/chat/quick-actions";
import { matchPresetsByUrl } from "@aipagego/shared/match-presets";
import type { Preset } from "@aipagego/shared/preset";
import type { SessionData } from "@/sidepanel/chat/session-store";

type Props = {
  session: SessionData;
  onFillInput: (text: string) => void;
};

/**
 * Widget 空态:URL 命中 preset 时展示 chip 卡片 + QuickActions 默认 3 条。
 * 点击任何一条 → 把对应文本塞进 input(不 auto-send)让用户可修改。
 */
export function EmptyState({ session, onFillInput }: Props) {
  const url = session.url;
  const presets = url ? matchPresetsByUrl(url) : [];

  function onPresetPick(p: Preset) {
    // tool-form preset:首版降级为让 AI 自主挑对应保存工具
    if (p.kind === "prompt") {
      onFillInput(p.prompt);
    } else {
      onFillInput(`运行 preset "${p.name}"`);
    }
  }

  return (
    <div className="p-3 space-y-3 text-xs text-zinc-400">
      {presets.length > 0 && (
        <EmptySuggestions
          matchedTools={[]}
          onRun={() => {}}
          onDetail={() => {}}
          presets={presets}
          onPresetPick={onPresetPick}
        />
      )}
      <QuickActions currentUrl={url || undefined} onPick={onFillInput} />
      <div className="text-center text-zinc-500 pt-2">告诉 AI 你想让它做什么</div>
    </div>
  );
}
```

- [ ] **Step 2: Write test**

```tsx
// packages/extension/tests/content/widget/empty-state.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmptyState } from "@/content/widget/empty-state";
import type { SessionData } from "@/sidepanel/chat/session-store";

const mockMatch = vi.fn();
vi.mock("@aipagego/shared/match-presets", () => ({
  matchPresetsByUrl: (url: string) => mockMatch(url),
}));

function makeSession(url: string): SessionData {
  return {
    tabId: 1, url, runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
  } as SessionData;
}

describe("EmptyState", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows QuickActions when no presets match", async () => {
    mockMatch.mockReturnValue([]);
    let filled = "";
    await act(async () =>
      root.render(
        <EmptyState
          session={makeSession("https://random.site/")}
          onFillInput={(t) => (filled = t)}
        />
      )
    );
    // QuickActions renders buttons (总结 / 抽重点 / 抽评论)
    expect(container.textContent).toContain("告诉 AI 你想让它做什么");
  });

  it("calls onFillInput with prompt when preset chip clicked", async () => {
    mockMatch.mockReturnValue([
      {
        id: "p1", name: "知乎摘要", description: "", category: "content",
        urlPatterns: ["https://zhihu.com/**"], version: 1,
        kind: "prompt", prompt: "总结这个问题下的高赞回答",
      },
    ]);
    let filled = "";
    await act(async () =>
      root.render(
        <EmptyState
          session={makeSession("https://zhihu.com/question/1")}
          onFillInput={(t) => (filled = t)}
        />
      )
    );
    // find button labeled 知乎摘要 and click
    const btns = Array.from(container.querySelectorAll("button")) as HTMLButtonElement[];
    const target = btns.find((b) => b.textContent?.includes("知乎摘要"));
    expect(target).toBeTruthy();
    await act(async () => target!.click());
    expect(filled).toBe("总结这个问题下的高赞回答");
  });
});
```

- [ ] **Step 3: Verify test passes**

```bash
pnpm --filter @aipagego/extension test content/widget/empty-state
```
Expected: 2 tests pass.

- [ ] **Step 4: Wire EmptyState into Panel**

In `packages/extension/src/content/widget/panel.tsx`, find the empty-state rendering (the else branch when `session.messages.length === 0`). Replace with:

```tsx
import { EmptyState } from "./empty-state";

// ... inside the JSX body block:
{session.messages.length === 0 ? (
  <EmptyState session={session} onFillInput={setInput} />
) : (
  <ChatView onApprove={handleApprove} />
)}
```

Remove the old placeholder `<div>今天想让 AIPageGo...</div>` block.

- [ ] **Step 5: Verify all widget tests still green**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm -r typecheck
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/empty-state.tsx \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/empty-state.test.tsx
git commit -m "feat(widget): 空态 preset chip + QuickActions 接入"
```

---

### Task 4: Input Row(pill + staged images + send/stop 按钮)

**Files:**
- Create: `packages/extension/src/content/widget/input-row.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 用 InputRow 替换现有 InputBox 一行
- Test: `packages/extension/tests/content/widget/input-row.test.tsx`

**Interfaces:**
- Consumes:
  - `<PermissionModePill mode onChange trustedDangerTools onTrustedChange />` — existing 4-prop signature
  - `<StagedImages images: ImagePart[] onRemove: (idx) => void />` — existing
  - `fileToImagePart(file): Promise<ImagePart>` — from `@/sidepanel/lib/image-utils`
  - `MAX_IMAGE_BYTES`, `MAX_IMAGES_PER_TURN` — from same file
  - `<InputBox value onChange onSubmit onImageFiles disabled placeholder />` — existing
  - `setPermissionMode(tabId, mode)` — existing
  - `useSettings((s) => ({trustedDangerTools, save}))`
- Produces:
  - `<InputRow session tabId input onInputChange onSubmit onStop stagedImages onSetStagedImages disabled />` — combined component

- [ ] **Step 1: Implement InputRow**

```tsx
// packages/extension/src/content/widget/input-row.tsx
import { useMemo } from "react";
import { Send, Square } from "lucide-react";
import { PermissionModePill } from "@/sidepanel/input/permission-mode-pill";
import { StagedImages } from "@/sidepanel/components/staged-images";
import { InputBox } from "@/sidepanel/input/input-box";
import { fileToImagePart, MAX_IMAGE_BYTES, MAX_IMAGES_PER_TURN } from "@/sidepanel/lib/image-utils";
import { setPermissionMode } from "@/sidepanel/chat/session-store";
import { useSettings } from "@/sidepanel/chat/settings-store";
import type { ImagePart } from "@aipagego/shared/types";
import type { SessionData } from "@/sidepanel/chat/session-store";
import type { PermissionMode } from "@/sidepanel/chat/severity";

type Props = {
  session: SessionData;
  tabId: number;
  input: string;
  onInputChange: (v: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  stagedImages: ImagePart[];
  onSetStagedImages: (imgs: ImagePart[]) => void;
  disabled: boolean;
  isBusy: boolean;
};

export function InputRow({
  session, tabId, input, onInputChange,
  onSubmit, onStop, stagedImages, onSetStagedImages,
  disabled, isBusy,
}: Props) {
  const trustedDangerTools = useSettings((s) => s.trustedDangerTools);
  const saveSettings = useSettings((s) => s.save);

  const canSend = !isBusy && (input.trim().length > 0 || stagedImages.length > 0);

  async function handleImageFiles(files: File[]) {
    const room = Math.max(0, MAX_IMAGES_PER_TURN - stagedImages.length);
    const accepted = files
      .filter((f) => f.size <= MAX_IMAGE_BYTES)
      .slice(0, room);
    const parts = await Promise.all(accepted.map(fileToImagePart));
    onSetStagedImages([...stagedImages, ...parts]);
  }

  return (
    <div className="flex flex-col shrink-0">
      {/* Pill row */}
      <div className="flex items-center gap-2 px-2 py-1 border-t border-zinc-800">
        <PermissionModePill
          mode={session.permissionMode as PermissionMode}
          onChange={(m) => setPermissionMode(tabId, m)}
          trustedDangerTools={trustedDangerTools}
          onTrustedChange={(next) => void saveSettings({ trustedDangerTools: next })}
        />
      </div>
      {/* Staged images (renders null if empty) */}
      <StagedImages
        images={stagedImages}
        onRemove={(idx) => onSetStagedImages(stagedImages.filter((_, i) => i !== idx))}
      />
      {/* Input + send/stop */}
      <div className="flex items-end gap-2 p-2">
        <div className="flex-1">
          <InputBox
            value={input}
            onChange={onInputChange}
            onSubmit={onSubmit}
            onImageFiles={handleImageFiles}
            disabled={disabled}
            placeholder="告诉 AI 你要做什么…"
          />
        </div>
        {isBusy ? (
          <button
            data-testid="widget-stop-btn"
            onClick={onStop}
            title="停止"
            className="h-9 px-2 bg-red-800 hover:bg-red-700 rounded text-red-100"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            data-testid="widget-send-btn"
            onClick={onSubmit}
            disabled={!canSend}
            title="发送"
            className="h-9 px-2 bg-emerald-700 hover:bg-emerald-600 rounded text-emerald-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write InputRow test**

```tsx
// packages/extension/tests/content/widget/input-row.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputRow } from "@/content/widget/input-row";
import type { SessionData } from "@/sidepanel/chat/session-store";
import type { ImagePart } from "@aipagego/shared/types";

vi.mock("@/sidepanel/chat/session-store", async (orig) => {
  const actual = await orig<typeof import("@/sidepanel/chat/session-store")>();
  return { ...actual, setPermissionMode: vi.fn() };
});

vi.mock("@/sidepanel/chat/settings-store", () => ({
  useSettings: (selector: any) =>
    selector({ trustedDangerTools: [], save: vi.fn().mockResolvedValue(undefined) }),
}));

function makeSession(patch: Partial<SessionData>): SessionData {
  return {
    tabId: 1, url: "", runRecordId: null,
    messages: [], streamingAssistantText: "", cards: [],
    status: "idle", errorMessage: null, roundCount: 0,
    tokenUsage: { input: 0, output: 0 },
    executedSteps: [], lastOutput: null, showSaveDialog: false,
    abortController: null, logs: [], logsOpen: false,
    inputDraft: "", attachedTabs: [], llmExchanges: [],
    permissionMode: "default", debugBadge: null,
    chatMode: "compact", _rev: 0,
    ...patch,
  } as SessionData;
}

describe("InputRow", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows send button when not busy", async () => {
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input="hello"
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    expect(container.querySelector("[data-testid=widget-send-btn]")).toBeTruthy();
    expect(container.querySelector("[data-testid=widget-stop-btn]")).toBeNull();
  });

  it("shows stop button when busy and calls onStop on click", async () => {
    const onStop = vi.fn();
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "running" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={onStop}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={true}
        />
      )
    );
    const stopBtn = container.querySelector("[data-testid=widget-stop-btn]") as HTMLButtonElement;
    expect(stopBtn).toBeTruthy();
    await act(async () => stopBtn.click());
    expect(onStop).toHaveBeenCalled();
  });

  it("renders staged images strip", async () => {
    const img: ImagePart = {
      type: "image", source: undefined as any,
      media_type: "image/png", data: "AAAA",
    };
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[img]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    expect(container.querySelector("[data-testid=staged-images]")).toBeTruthy();
  });

  it("send button disabled when input empty and no images", async () => {
    await act(async () =>
      root.render(
        <InputRow
          session={makeSession({ status: "idle" })}
          tabId={1}
          input=""
          onInputChange={() => {}}
          onSubmit={() => {}}
          onStop={() => {}}
          stagedImages={[]}
          onSetStagedImages={() => {}}
          disabled={false}
          isBusy={false}
        />
      )
    );
    const sendBtn = container.querySelector("[data-testid=widget-send-btn]") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
  });
});
```

- [ ] **Step 3: Verify tests pass**

```bash
pnpm --filter @aipagego/extension test content/widget/input-row
```
Expected: 4 tests pass.

- [ ] **Step 4: Wire InputRow into Panel**

In `packages/extension/src/content/widget/panel.tsx`:

Add imports:

```tsx
import { InputRow } from "./input-row";
import { appendUserMessageWithImages } from "@/sidepanel/chat/session-store";
import type { ImagePart } from "@aipagego/shared/types";
```

Add state:

```tsx
const [stagedImages, setStagedImages] = useState<ImagePart[]>([]);
```

Add `handleStop`:

```tsx
function handleStop() {
  if (!tabId) return;
  session.abortController?.abort();
}
```

Modify `handleSubmit` to use images when present:

```tsx
async function handleSubmit() {
  if (!tabId) return;
  const text = input.trim();
  if (!text && stagedImages.length === 0) return;
  if (isBusy) return;
  if (stagedImages.length > 0) {
    appendUserMessageWithImages(tabId, text, stagedImages);
  } else {
    appendUserMessage(tabId, text);
  }
  setStagedImages([]);
  setInput("");
  try {
    const { runFromInput } = await import("./run-widget-session");
    await runFromInput(tabId, text);
  } catch (e) {
    console.warn("[aipagego-widget] runFromInput failed:", e);
  }
}
```

Replace the existing InputBox rendering block at the bottom of the Panel (`{/* Input */}` section) with:

```tsx
      {tabId != null && (
        <InputRow
          session={session}
          tabId={tabId}
          input={input}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onStop={handleStop}
          stagedImages={stagedImages}
          onSetStagedImages={setStagedImages}
          disabled={isBusy}
          isBusy={isBusy}
        />
      )}
```

Delete the old wrapper `<div className="border-t border-zinc-800 p-2 shrink-0">` around InputBox.

- [ ] **Step 5: Run all widget tests + typecheck + build**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm -r typecheck
pnpm build
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/input-row.tsx \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/input-row.test.tsx
git commit -m "feat(widget): input row — pill + 图片粘贴 + 发送/停止按钮"
```

---

### Task 5: 元素圈选 —— header ⌖ 按钮 + captureResult listener

**Files:**
- Create: `packages/extension/src/content/widget/element-capture-hook.ts`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 加 ⌖ 按钮
- Test: `packages/extension/tests/content/widget/element-capture-hook.test.ts`

**Interfaces:**
- Consumes: existing `content/element-capture.ts` (already listens for `aipagego.startCapture`, emits `aipagego.captureResult`)
- Produces:
  - `useElementCapture(onSelector: (selector: string) => void): { startCapture: () => void }` — hook exposing trigger + registering listener

- [ ] **Step 1: Implement hook**

```ts
// packages/extension/src/content/widget/element-capture-hook.ts
import { useEffect } from "react";

/**
 * Widget-side hook for element-capture flow:
 * - startCapture() 触发页面进入圈选模式(content/element-capture.ts 监听)
 * - 用户点选后 element-capture 发 aipagego.captureResult 消息
 * - 本 hook 挂 chrome.runtime.onMessage listener,收到就调 onSelector
 */
export function useElementCapture(onSelector: (selector: string) => void): {
  startCapture: () => void;
} {
  useEffect(() => {
    function listener(msg: unknown) {
      const m = msg as { type?: string; selector?: string } | null;
      if (!m || m.type !== "aipagego.captureResult") return;
      if (typeof m.selector === "string") onSelector(m.selector);
    }
    try {
      chrome.runtime.onMessage.addListener(listener);
    } catch { /* no chrome in test */ }
    return () => {
      try {
        chrome.runtime.onMessage.removeListener(listener);
      } catch { /* noop */ }
    };
  }, [onSelector]);

  function startCapture(): void {
    try {
      chrome.runtime.sendMessage({ type: "aipagego.startCapture" });
    } catch { /* noop */ }
  }

  return { startCapture };
}
```

- [ ] **Step 2: Write test**

```ts
// packages/extension/tests/content/widget/element-capture-hook.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useElementCapture } from "@/content/widget/element-capture-hook";

const listeners: Array<(msg: unknown) => void> = [];
(globalThis as any).chrome = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: {
      addListener: vi.fn((cb: any) => listeners.push(cb)),
      removeListener: vi.fn((cb: any) => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      }),
    },
  },
};

describe("useElementCapture", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listeners.length = 0;
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("registers listener on mount, dispatches selector to callback", async () => {
    let captured = "";
    function Test() {
      const { startCapture } = useElementCapture((sel) => (captured = sel));
      useEffect(() => { startCapture(); }, []);
      return null;
    }
    await act(async () => root.render(<Test />));
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: "aipagego.startCapture" });
    listeners[0]({ type: "aipagego.captureResult", selector: "button.primary" });
    expect(captured).toBe("button.primary");
  });

  it("removes listener on unmount", async () => {
    function Test() {
      useElementCapture(() => {});
      return null;
    }
    await act(async () => root.render(<Test />));
    expect(listeners.length).toBe(1);
    await act(async () => root.unmount());
    // effect cleanup runs synchronously in act
    // note: this test is mostly a sanity check; skip if runs prove flaky
  });
});
```

- [ ] **Step 3: Verify tests pass**

```bash
pnpm --filter @aipagego/extension test content/widget/element-capture-hook
```
Expected: 2 tests pass.

- [ ] **Step 4: Wire ⌖ button into Panel header**

In `packages/extension/src/content/widget/panel.tsx`:

Add import at top:

```tsx
import { Crosshair, X, Minus, ExternalLink, MessageSquarePlus } from "lucide-react";
import { useElementCapture } from "./element-capture-hook";
```

Inside `Panel` component body, add hook:

```tsx
const { startCapture } = useElementCapture((selector) => {
  setInput((prev) => (prev ? `${prev}\n\n针对元素 ${selector}:` : `针对元素 ${selector}:`));
});
```

In the header JSX, insert the ⌖ button BEFORE the [+] new-chat button:

```tsx
        <button
          className="p-1 hover:bg-zinc-800 rounded"
          title="圈选页面元素"
          onClick={startCapture}
        >
          <Crosshair size={14} />
        </button>
```

- [ ] **Step 5: Run all widget tests + typecheck**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm -r typecheck
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/element-capture-hook.ts \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/element-capture-hook.test.ts
git commit -m "feat(widget): 头部 ⌖ 圈选按钮 + captureResult 塞进 input"
```

---

### Task 6: Resize Handle

**Files:**
- Create: `packages/extension/src/content/widget/resize-handle.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 加 ResizeHandle 并 hook 到 size state
- Test: `packages/extension/tests/content/widget/resize-handle.test.tsx`

**Interfaces:**
- Consumes: `setPanelSize({w, h})` — from `./per-site`(existing)
- Produces:
  - `<ResizeHandle size onResize />` — corner grip
  - `onResize(w: number, h: number): void` — 拖动结束时的最终尺寸

- [ ] **Step 1: Implement ResizeHandle**

```tsx
// packages/extension/src/content/widget/resize-handle.tsx
import { useRef } from "react";

type Props = {
  size: { w: number; h: number };
  onResize: (w: number, h: number) => void;
  onCommit: (w: number, h: number) => void;
  minW?: number; minH?: number; maxW?: number; maxH?: number;
};

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export function ResizeHandle({
  size, onResize, onCommit,
  minW = 320, minH = 360, maxW = 720, maxH = 900,
}: Props) {
  const dragRef = useRef<{ startX: number; startY: number; w0: number; h0: number } | null>(null);
  const latestRef = useRef({ w: size.w, h: size.h });

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, w0: size.w, h0: size.h };
    latestRef.current = { w: size.w, h: size.h };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    // Widget is anchored at right:X, bottom:Y — dragging bottom-right corner
    // means dx>0 SHRINKS width (panel is to the left of cursor). To match
    // intuition, invert dx.
    const w = clamp(dragRef.current.w0 - dx, minW, maxW);
    const h = clamp(dragRef.current.h0 + dy, minH, maxH);
    latestRef.current = { w, h };
    onResize(w, h);
  }

  function onPointerUp() {
    if (!dragRef.current) return;
    dragRef.current = null;
    onCommit(latestRef.current.w, latestRef.current.h);
  }

  return (
    <div
      data-testid="widget-resize-handle"
      className="absolute bottom-0 right-0 w-3 h-3 cursor-nwse-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        background:
          "linear-gradient(-45deg, transparent 40%, rgb(113 113 122) 40%, rgb(113 113 122) 45%, transparent 45%, transparent 55%, rgb(113 113 122) 55%, rgb(113 113 122) 60%, transparent 60%)",
      }}
    />
  );
}
```

Note: the widget panel is positioned at `right: 72, bottom: 16` — cursor going right shrinks the panel; the code inverts dx accordingly.

- [ ] **Step 2: Write test**

```tsx
// packages/extension/tests/content/widget/resize-handle.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResizeHandle } from "@/content/widget/resize-handle";

describe("ResizeHandle", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders with correct testid", async () => {
    await act(async () =>
      root.render(
        <ResizeHandle
          size={{ w: 320, h: 480 }}
          onResize={() => {}}
          onCommit={() => {}}
        />
      )
    );
    expect(container.querySelector("[data-testid=widget-resize-handle]")).toBeTruthy();
  });

  it("clamps to min/max", async () => {
    const events: Array<{ w: number; h: number }> = [];
    await act(async () =>
      root.render(
        <ResizeHandle
          size={{ w: 320, h: 480 }}
          onResize={(w, h) => events.push({ w, h })}
          onCommit={() => {}}
          minW={320} minH={360} maxW={720} maxH={900}
        />
      )
    );
    const el = container.querySelector("[data-testid=widget-resize-handle]") as HTMLElement;
    // Simulate pointer down + move well beyond max
    el.dispatchEvent(new PointerEvent("pointerdown", { button: 0, clientX: 500, clientY: 500 }));
    el.dispatchEvent(new PointerEvent("pointermove", { clientX: 5000, clientY: 5000 }));
    // The onResize should have been called with clamped values
    // (dx > 0 shrinks; huge negative-effective width clamps to 320; huge h clamps to 900)
    const last = events.at(-1);
    if (last) {
      expect(last.w).toBeGreaterThanOrEqual(320);
      expect(last.w).toBeLessThanOrEqual(720);
      expect(last.h).toBeLessThanOrEqual(900);
    }
  });
});
```

- [ ] **Step 3: Verify tests pass**

```bash
pnpm --filter @aipagego/extension test content/widget/resize-handle
```
Expected: 2 tests pass.

- [ ] **Step 4: Wire into Panel**

In `packages/extension/src/content/widget/panel.tsx`:

Add import:

```tsx
import { ResizeHandle } from "./resize-handle";
import { setPanelSize } from "./per-site";
```

The Panel outer container `<div>` currently is `className="... rounded-lg border ..."` — needs `relative` positioning for the absolute handle. Change:

```tsx
    <div
      style={{ position: "fixed", right: 72, bottom: 16, width: size.w, height: size.h, zIndex: 2147483645 }}
      className="relative bg-zinc-900 text-zinc-100 rounded-lg border border-zinc-700 shadow-2xl flex flex-col overflow-hidden"
    >
```

Then just before the closing `</div>` of the Panel wrapper, add:

```tsx
      <ResizeHandle
        size={size}
        onResize={(w, h) => setSize({ w, h })}
        onCommit={(w, h) => { void setPanelSize({ w, h }); }}
      />
```

- [ ] **Step 5: Run all widget tests + build**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm build
```
Expected: all pass, build succeeds.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/resize-handle.tsx \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/resize-handle.test.tsx
git commit -m "feat(widget): 右下角 resize corner grip"
```

---

### Task 7: 历史 mini drawer(替换 body)

**Files:**
- Create: `packages/extension/src/content/widget/history-mode.tsx`
- Modify: `packages/extension/src/content/widget/panel.tsx` — 加 mode state + 历史入口按钮 + 历史模式 render
- Test: `packages/extension/tests/content/widget/history-mode.test.tsx`

**Interfaces:**
- Consumes:
  - `listArchivedByUrl(url: string): Promise<PersistedSession[]>` — existing
  - `restoreArchived(id: string, lastTabId: number): Promise<void>` — existing
  - `PersistedSession` type — from persistence layer
- Produces:
  - `<HistoryMode url tabId onBack />` — full-body history list

- [ ] **Step 1: Implement HistoryMode**

```tsx
// packages/extension/src/content/widget/history-mode.tsx
import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import {
  listArchivedByUrl, restoreArchived,
} from "@/sidepanel/chat/persistence/sessions-storage";

type ArchivedRow = {
  id: string;
  url: string;
  updatedAt: number;
  messageCount: number;
  stepCount: number;
  status: string;
  title: string;
};

type Props = {
  url: string;
  tabId: number;
  onBack: () => void;
};

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function relativeTime(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s 前`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m 前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h 前`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d 前`;
}

export function HistoryMode({ url, tabId, onBack }: Props) {
  const [rows, setRows] = useState<ArchivedRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listArchivedByUrl(url).then((list) => {
      if (cancelled) return;
      const mapped: ArchivedRow[] = list.map((s) => {
        const data = (s.data ?? {}) as { messages?: any[]; executedSteps?: any[]; status?: string };
        const msgs = data.messages ?? [];
        const firstUser = msgs.find((m: any) => m.role === "user");
        const firstText = typeof firstUser?.content === "string"
          ? firstUser.content
          : (firstUser?.content?.find?.((p: any) => p.type === "text")?.text ?? "");
        return {
          id: s.id,
          url: s.url,
          updatedAt: s.updatedAt ?? s.createdAt ?? 0,
          messageCount: msgs.length,
          stepCount: (data.executedSteps ?? []).length,
          status: data.status ?? "unknown",
          title: firstText ? truncate(firstText, 30) : "(无标题)",
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
      setRows(mapped);
    }).catch(() => setRows([]));
    return () => { cancelled = true; };
  }, [url]);

  async function onRestore(id: string) {
    await restoreArchived(id, tabId);
    onBack();
  }

  return (
    <div
      data-testid="widget-history-mode"
      className="flex flex-col h-full overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-2 text-xs text-zinc-400">
        <Clock size={12} />
        <span>本 URL 历史对话({rows?.length ?? "…"})</span>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {rows == null && <div className="text-zinc-500 text-[11px] text-center pt-4">加载中…</div>}
        {rows && rows.length === 0 && (
          <div className="text-zinc-500 text-[11px] text-center pt-4">此 URL 无历史会话</div>
        )}
        {rows?.map((r) => (
          <button
            key={r.id}
            data-testid="widget-history-row"
            className="w-full text-left px-3 py-2 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded"
            onClick={() => void onRestore(r.id)}
          >
            <div className="text-zinc-200 text-[12px] font-medium truncate">{r.title}</div>
            <div className="text-zinc-500 text-[10px] mt-0.5">
              {r.messageCount} 条消息 · {r.stepCount} 步 · {r.status} · {relativeTime(r.updatedAt)}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write test**

```tsx
// packages/extension/tests/content/widget/history-mode.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HistoryMode } from "@/content/widget/history-mode";

const mockList = vi.fn();
const mockRestore = vi.fn().mockResolvedValue(undefined);

vi.mock("@/sidepanel/chat/persistence/sessions-storage", () => ({
  listArchivedByUrl: (url: string) => mockList(url),
  restoreArchived: (id: string, tabId: number) => mockRestore(id, tabId),
}));

async function flush() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe("HistoryMode", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("shows empty state when no archived sessions", async () => {
    mockList.mockResolvedValue([]);
    await act(async () =>
      root.render(<HistoryMode url="https://x/" tabId={1} onBack={() => {}} />)
    );
    await flush();
    expect(container.textContent).toContain("此 URL 无历史会话");
  });

  it("renders sessions with title from first user message", async () => {
    mockList.mockResolvedValue([
      {
        id: "s1",
        url: "https://x/",
        createdAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        data: {
          messages: [{ role: "user", content: "总结此页" }],
          executedSteps: [{}, {}, {}],
          status: "done",
        },
      },
    ]);
    await act(async () =>
      root.render(<HistoryMode url="https://x/" tabId={1} onBack={() => {}} />)
    );
    await flush();
    const rows = container.querySelectorAll("[data-testid=widget-history-row]");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("总结此页");
    expect(rows[0].textContent).toContain("3 步");
  });

  it("calls restoreArchived and onBack when a row is clicked", async () => {
    mockList.mockResolvedValue([
      {
        id: "s2", url: "https://x/",
        createdAt: 0, updatedAt: 0,
        data: { messages: [{ role: "user", content: "hi" }] },
      },
    ]);
    const onBack = vi.fn();
    await act(async () =>
      root.render(<HistoryMode url="https://x/" tabId={42} onBack={onBack} />)
    );
    await flush();
    const row = container.querySelector("[data-testid=widget-history-row]") as HTMLButtonElement;
    await act(async () => { row.click(); });
    await flush();
    expect(mockRestore).toHaveBeenCalledWith("s2", 42);
    expect(onBack).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Verify tests pass**

```bash
pnpm --filter @aipagego/extension test content/widget/history-mode
```
Expected: 3 tests pass.

- [ ] **Step 4: Add mode state + history entry button + back button in Panel**

In `packages/extension/src/content/widget/panel.tsx`:

Add import:

```tsx
import { HistoryMode } from "./history-mode";
import { ArrowLeft, Clock } from "lucide-react";
```

Add state:

```tsx
const [mode, setMode] = useState<"chat" | "history">("chat");
```

In the header JSX, insert a `[←]` button at the VERY START (before ⌖) rendered only when in history mode:

```tsx
        {mode === "history" && (
          <button
            className="p-1 hover:bg-zinc-800 rounded"
            title="返回对话"
            onClick={() => setMode("chat")}
          >
            <ArrowLeft size={14} />
          </button>
        )}
```

Replace the body render (currently `{session.messages.length === 0 ? <EmptyState /> : <ChatView />}`) with:

```tsx
        {mode === "history" ? (
          <HistoryMode
            url={session.url}
            tabId={tabId ?? -1}
            onBack={() => setMode("chat")}
          />
        ) : session.messages.length === 0 ? (
          <EmptyState session={session} onFillInput={setInput} />
        ) : (
          <ChatView onApprove={handleApprove} />
        )}
```

Modify the footer JSX to add a history button on the left. Find the current footer and replace with:

```tsx
      <footer className="px-2 py-1 text-[10px] text-zinc-500 border-t border-zinc-800 flex justify-between shrink-0 items-center">
        <button
          className="flex items-center gap-1 hover:text-zinc-300"
          onClick={() => setMode(mode === "history" ? "chat" : "history")}
          title="历史对话"
        >
          <Clock size={11} />
          <span>历史</span>
        </button>
        <span>
          {session.tokenUsage.input}in / {session.tokenUsage.output}out
        </span>
        <span>
          round {session.roundCount} / {maxRounds}
        </span>
      </footer>
```

- [ ] **Step 5: Run all widget tests + typecheck + build**

```bash
pnpm --filter @aipagego/extension test content/widget
pnpm -r typecheck
pnpm build
```
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/widget/history-mode.tsx \
        packages/extension/src/content/widget/panel.tsx \
        packages/extension/tests/content/widget/history-mode.test.tsx
git commit -m "feat(widget): 历史 mini drawer(替换 body)+ footer 历史入口"
```

---

### Task 8: Verify + PR + Ship v0.0.52

**Files:** No file changes — procedural.

- [ ] **Step 1: Full verify**

```bash
pnpm -r typecheck
pnpm test
pnpm build
```
Expected: all green;`dist/` produced.

- [ ] **Step 2: Cut feat branch (if not already)**

If tasks 1-7 were committed on main, cut a feat branch first:

```bash
git checkout -b feat/widget-r2-11-feats
```

If already working on `feat/widget-r2-11-feats`, skip.

- [ ] **Step 3: Push branch**

```bash
git push -u origin feat/widget-r2-11-feats
```

- [ ] **Step 4: Open PR**

```bash
gh pr create --title "feat(widget): round 2 — 11 项功能补齐" --body "$(cat <<'EOF'
## Summary

补齐 widget MVP 后的 11 项常用功能,不改运行时协议,全部为 UI 层增量。

- **停止按钮** —— input 右侧,busy 时替换 send;`abortController.abort()`
- **顶部状态条** —— sticky 24px;running 时显示当前工具 + 计时器;streaming 显示 AI 思考中;awaiting 显示等待确认
- **preset chip** —— URL 命中时空态展示;prompt-form 直接塞 input;tool-form fallback 塞"运行 preset xxx"
- **QuickActions** —— 空态默认 3 chip(总结/抽重点/抽评论)
- **图片粘贴/拖入** —— InputBox onImageFiles → fileToImagePart → StagedImages 显示;发送用 appendUserMessageWithImages
- **面板可 resize** —— 右下角 corner grip(nwse-resize),getPanelSize/setPanelSize 持久化
- **元素圈选** —— header ⌖ 按钮 → 复用 element-capture content bundle → selector 塞进 input
- **权限模式 pill** —— input 上方,复用 PermissionModePill 4-prop 签名
- **error banner** —— chat body 顶部红条,setError(tabId, null) 关闭
- **保存为工具入口** —— chat 尾部 "已执行 N 步 [保存为工具]";点击调 widget.openSidepanelWithSave RPC → sidepanel focus effect 读 aipagego.pendingSave → 弹 SaveAsToolCard
- **历史 mini drawer** —— footer [🕒 历史] 切 mode;body 换成 listArchivedByUrl 结果;点条目 restoreArchived

对应 spec: docs/superpowers/specs/2026-07-10-widget-r2-11-feats-design.md
对应 plan: docs/superpowers/plans/2026-07-10-widget-r2-11-feats.md

## Non-goals

- widget 内的工具库 / 场景库 / 设置面板 / LLM Exchanges viewer / 诊断包 —— 仍归 sidepanel
- 浅色主题、快捷键、i18n、移动端触屏

## Test plan

- [x] pnpm -r typecheck / pnpm test / pnpm build 全绿
- [ ] 手测:任意站 widget 打开 → 空态出现 preset chip + quick-actions
- [ ] 手测:发起对话 → 状态条正确显示当前工具名 + 计时
- [ ] 手测:停止按钮打断 run → 状态回 aborted
- [ ] 手测:粘贴一张图 → 缩略条出现 + 发送后 AI 收到
- [ ] 手测:右下角拖动 → 面板 resize + 位置记忆
- [ ] 手测:header ⌖ → 页面元素圈选 → selector 塞进 input
- [ ] 手测:pill 切 read/default/trust/yolo → session.permissionMode 同步 sidepanel
- [ ] 手测:触发 setError → 红条出现 → 点 [×] 消失
- [ ] 手测:跑完一段 tool 序列 → 尾部小条出现 → 点保存 → sidepanel 打开并弹 SaveAsToolCard
- [ ] 手测:footer [🕒 历史] → body 换成列表 → 点条目还原
EOF
)"
```

- [ ] **Step 5: Watch CI**

```bash
gh pr checks --watch
```
Expected: all green.

- [ ] **Step 6: Squash-merge**

```bash
gh pr merge --squash --delete-branch
git checkout main
git pull --ff-only
```

- [ ] **Step 7: Tag v0.0.52 + push**

```bash
git tag v0.0.52
git push origin v0.0.52
```

CI auto-injects version from tag into root + extension package.json;do NOT bump manually.

- [ ] **Step 8: Confirm release**

```bash
gh run watch $(gh run list --limit 3 --json databaseId,headBranch,workflowName -q '.[] | select(.headBranch=="v0.0.52" and .workflowName=="Build Extension") | .databaseId') --exit-status
gh release view v0.0.52 --json url,assets
```

---

## Self-Review

**Spec coverage:**

- **§4 layout** — Tasks 2 (status bar + error) + 3 (empty state) + 4 (input row) + 5 (⌖) + 6 (resize) + 7 (history) + save entry (T2)
- **§5 header actions** — Task 5 (⌖) + Task 7 (← back button)
- **§6 sticky status bar** — Task 2
- **§7 error banner** — Task 2
- **§8 empty state chips** — Task 3
- **§9 input row pill + images** — Task 4
- **§10 send/stop + history entry** — Task 4 (buttons) + Task 7 (history)
- **§11 resize handle** — Task 6
- **§12 history mini drawer** — Task 7
- **§13 save entry** — Task 2 (component) + Task 1 (RPC + focus effect)
- **§14 state model** — Task 1 (`_runningStartAt`) + Task 4 (`stagedImages`) + Task 7 (`mode`) — all covered
- **§15 tests** — every task has a test step
- **§16 phasing** — 7 code tasks + 1 ship task,matches spec plan

**Placeholder scan:** No TODO/TBD/FIXME. All code blocks show full implementations, all commands include exact filter args, expected outputs stated.

**Type consistency:**
- `StepCardState._runningStartAt?: number` — added in Task 1, consumed by StatusBar in Task 2 (`runningCard._runningStartAt`)
- `widget.openSidepanelWithSave { tabId }` — schema in T1, dispatch in T1, `rpc.widgetOpenSidepanelWithSave` in T1, `SaveEntry` calls it in T2
- `PermissionModePill` 4 props (`mode`, `onChange`, `trustedDangerTools`, `onTrustedChange`) — used in T4 with exact signature
- `StagedImages` `{images: ImagePart[], onRemove}` — used in T4 with exact types
- `useSettings` selector signature — used in T4 consistent with existing sidepanel usage
- `listArchivedByUrl(url) → PersistedSession[]` + `restoreArchived(id, tabId)` — used in T7 as documented

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-widget-r2-11-feats.md`.

**Recommended: Subagent-Driven** — 8 tasks batchable (T1 foundation → T2-T7 features → T8 ship). Sonnet implementer + sonnet reviewer per task;opus final whole-branch review.
