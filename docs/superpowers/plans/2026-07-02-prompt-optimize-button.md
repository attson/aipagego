# Prompt Optimize Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在输入框内右下角加一个「魔法棒」按钮，点击后调 LLM 把用户草稿改写为对 browser-agent 更友好的具体指令，弹预览面板让用户接受 / 重新生成 / 弃用。

**Architecture:** 独立的 `optimize-prompt.ts` 纯函数封装 LLM 调用（复用现有 `pickClient` + settings，不写 exchanges）；`InputBox` 加 `rightAction` slot；`InputToolbar` 加本地状态机 `idle/loading/preview/error`；预览面板绝对定位于输入框上方，支持 Enter=接受 / Esc=弃用。

**Tech Stack:** React 18 + Zustand（复用 `useSettings`）+ lucide-react（`Sparkles` / `Loader2`）+ vitest + happy-dom + `pickClient()` （复用主对话 LLM 客户端）。

## Global Constraints

- 测试沿用仓库现有模式：**vitest + happy-dom + `react-dom/client` + 本地 `mount/cleanup` 辅助**，**不**引入 `@testing-library`（参考 `packages/extension/tests/sidepanel/chat/quick-actions.test.tsx`）。
- `type Props` 组件外定义；组件 export named function（沿用现有风格）。
- 中文文案：按钮 `aria-label="优化提示词"`，按钮 title 空态 `"让 AI 帮你把草稿写清楚"`、错误态 `"点击重试"`。
- 图标统一使用 lucide-react（`Sparkles` idle、`Loader2` loading，加 `className="animate-spin"`）。
- 优化调用**不进** `llmExchanges`（spec §2 明确排除）——`optimize-prompt.ts` 直接调 `pickClient(provider).stream()`，不套 `createRecordingClient`。
- 复用 `settings.provider / settings.apiKey / settings.endpoint`；`optimizerModel` 留空回退到 `settings.model`。
- `optimize-prompt.ts` **不依赖** zustand，纯参数入出，便于单测。
- 每次 tab 切换 / InputToolbar 卸载时，若正在 loading 必须 abort（`useEffect` cleanup）。

---

### Task 1: LlmSettings 加 optimizerModel 字段 + Settings UI

**Files:**
- Modify: `packages/shared/src/types.ts` (LlmSettings 类型定义)
- Modify: `packages/extension/src/sidepanel/drawers/settings/section-llm.tsx` (加一行 input)

**Interfaces:**
- Consumes: 无（第一个 task）
- Produces:
  - `LlmSettings.optimizerModel?: string` — 可选字段，留空 = 用 `model`
  - `SectionLlm` 组件多渲染一行「优化模型」input，绑定到 `settings.optimizerModel`

**Rationale:** 独立小步；类型改动落地后，下游 task 可以直接引用 `settings.optimizerModel`。

- [ ] **Step 1: 加类型字段**

Modify `packages/shared/src/types.ts`。定位 `export type LlmSettings = {` 定义，在末尾（`maxContinuationNudges` 之后）插入：

```ts
  /**
   * 提示词优化按钮用哪个模型。留空 = 用 `model`（对话模型）。
   * 复用同一份 provider / apiKey / endpoint。
   */
  optimizerModel?: string;
```

先看下现有定义：

```bash
grep -n "export type LlmSettings" packages/shared/src/types.ts
```

用 grep 找到 LlmSettings 起止行范围，确认插入位置（在结束 `};` 之前）。

- [ ] **Step 2: 跑 typecheck 确认没炸**

```bash
pnpm typecheck 2>&1 | tail -15
```

Expected: 全绿。（新字段是可选的，不会影响任何现有 `LlmSettings` 消费者。）

- [ ] **Step 3: Settings 页面加一行**

Modify `packages/extension/src/sidepanel/drawers/settings/section-llm.tsx`。在 `max_tokens` 那一行下方（`grep -n 'max_tokens' packages/extension/src/sidepanel/drawers/settings/section-llm.tsx` 定位）**紧接着**插入：

```tsx
      <div className="flex items-center gap-2">
        <span className="w-20 text-zinc-400">优化模型</span>
        <input
          value={settings.optimizerModel ?? ""}
          onChange={(e) => void settings.save({ optimizerModel: e.target.value })}
          placeholder="留空 = 用对话模型（推荐 haiku）"
          list={datalistId}
          className="bg-zinc-800 px-2 py-1 rounded font-mono flex-1"
        />
      </div>
```

（`datalistId` 已在文件顶部定义为 `models-${settings.provider}`，直接复用。）

- [ ] **Step 4: 手工验证 + typecheck**

```bash
pnpm typecheck 2>&1 | tail -5
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/shared/src/types.ts packages/extension/src/sidepanel/drawers/settings/section-llm.tsx
git commit -m "feat(settings): add optimizerModel field for prompt-optimize button

留空回退到对话模型，复用同一份 provider / apiKey / endpoint。
"
```

---

### Task 2: optimize-prompt.ts 纯函数 + 单测

**Files:**
- Create: `packages/extension/src/sidepanel/lib/optimize-prompt.ts`
- Create: `packages/extension/tests/sidepanel/lib/optimize-prompt.test.ts`

**Interfaces:**
- Consumes:
  - `LlmSettings` from `@aipagego/shared/types` (Task 1)
  - `pickClient` from `@/sidepanel/llm/client`
  - `TOOL_DEFS` from `@aipagego/shared/llm` (re-exports `builtin-tool-defs.ts`)
- Produces:
  - `optimizePrompt(ctx): Promise<string>` — 传入 `{draft, tabId, settings, signal}`，返回优化后的字符串
  - 内部通过 `chrome.tabs.get(tabId)` 拿 `title` / `url`

**Rationale:** 纯逻辑先落地，与 UI 解耦；测试用 fake client / fake `chrome.tabs`，无网络。

- [ ] **Step 1: 写失败测试**

Create `packages/extension/tests/sidepanel/lib/optimize-prompt.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmStreamEvent } from "@aipagego/shared/llm";
import type { LlmSettings } from "@aipagego/shared/types";

// Mock pickClient BEFORE importing the module under test
const streamSpy = vi.fn();
vi.mock("@/sidepanel/llm/client", () => ({
  pickClient: () => ({ stream: streamSpy }) as LlmClient,
}));

import { optimizePrompt } from "@/sidepanel/lib/optimize-prompt";

const BASE_SETTINGS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "sk-fake",
  apiKeyMode: "persistent",
  maxRounds: 20,
  trustedDangerTools: [],
  defaultPermissionMode: "default",
  theme: "dark",
  maxContinuationNudges: 1,
};

async function* fakeStream(events: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  for (const e of events) yield e;
}

beforeEach(() => {
  streamSpy.mockReset();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: {
      get: vi.fn(async (_tabId: number) => ({
        title: "Fake Product Page",
        url: "https://shop.example/p/1",
      })),
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe("optimizePrompt", () => {
  it("prefers optimizerModel over settings.model", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "rewritten" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: { ...BASE_SETTINGS, optimizerModel: "claude-haiku-4-5-20251001" },
      signal: new AbortController().signal,
    });
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5-20251001" })
    );
  });

  it("falls back to settings.model when optimizerModel empty", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: { ...BASE_SETTINGS, optimizerModel: "  " },
      signal: new AbortController().signal,
    });
    expect(streamSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-sonnet-4-6" })
    );
  });

  it("passes system prompt containing 改写 keyword", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "hi",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    const call = streamSpy.mock.calls[0][0];
    expect(call.system).toContain("改写");
  });

  it("user message includes tab title, tab url, tool catalog and draft", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    await optimizePrompt({
      draft: "帮我找竞品",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    const call = streamSpy.mock.calls[0][0];
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("Fake Product Page");
    expect(userContent).toContain("https://shop.example/p/1");
    expect(userContent).toContain("takeSnapshot");
    expect(userContent).toContain("帮我找竞品");
  });

  it("accumulates text_delta and trims", async () => {
    streamSpy.mockReturnValueOnce(
      fakeStream([
        { type: "text_delta", text: "  hello " },
        { type: "text_delta", text: "world  \n" },
      ])
    );
    const out = await optimizePrompt({
      draft: "d",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: new AbortController().signal,
    });
    expect(out).toBe("hello world");
  });

  it("throws on error event", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "error", error: "429 rate limit" }]));
    await expect(
      optimizePrompt({
        draft: "d",
        tabId: 42,
        settings: BASE_SETTINGS,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/429 rate limit/);
  });

  it("throws when empty output", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "   " }]));
    await expect(
      optimizePrompt({
        draft: "d",
        tabId: 42,
        settings: BASE_SETTINGS,
        signal: new AbortController().signal,
      })
    ).rejects.toThrow(/empty/);
  });

  it("passes abortSignal through", async () => {
    streamSpy.mockReturnValueOnce(fakeStream([{ type: "text_delta", text: "x" }]));
    const ac = new AbortController();
    await optimizePrompt({
      draft: "d",
      tabId: 42,
      settings: BASE_SETTINGS,
      signal: ac.signal,
    });
    expect(streamSpy.mock.calls[0][0].abortSignal).toBe(ac.signal);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aipagego/extension test optimize-prompt.test.ts 2>&1 | tail -20
```

Expected: 8 tests failed with "Cannot find module '@/sidepanel/lib/optimize-prompt'"。

- [ ] **Step 3: 写实现**

Create `packages/extension/src/sidepanel/lib/optimize-prompt.ts`：

```ts
import type { LlmSettings } from "@aipagego/shared/types";
import { TOOL_DEFS } from "@aipagego/shared/llm";
import { pickClient } from "@/sidepanel/llm/client";

const SYSTEM_PROMPT =
  "你是「浏览器自动化 agent 的提示词教练」。用户会给你一段自然语言草稿，你要改写成更具体、可执行的指令，让下游的 browser-agent 一次就能选对工具、找对信息源。\n\n" +
  "改写原则：\n" +
  "1. 明确目标产物（要什么、什么格式）\n" +
  "2. 说清楚信息在哪里能找到（当前页 / 搜索 / 特定 URL）\n" +
  "3. 必要时点名工具（如 takeSnapshot / clickByUid / httpRequest）\n" +
  "4. 保留用户原语气和语言（中文 / 英文）\n" +
  "5. 不要问回，不要解释，不要加「以下是优化后的：」之类的前缀\n\n" +
  "**只输出改写后的纯文本**。";

type Ctx = {
  draft: string;
  tabId: number;
  settings: LlmSettings;
  signal: AbortSignal;
};

export async function optimizePrompt(ctx: Ctx): Promise<string> {
  const client = pickClient(ctx.settings.provider);
  const model = (ctx.settings.optimizerModel ?? "").trim() || ctx.settings.model;

  const tab = await chrome.tabs.get(ctx.tabId);
  const title = tab.title || "(untitled)";
  const url = tab.url || "(no url)";

  const toolCatalog = TOOL_DEFS.map(
    (t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 80)}`
  ).join("\n");

  const userMessage =
    `[当前页] ${title} — ${url}\n` +
    `[可用工具]\n${toolCatalog}\n\n` +
    `[用户草稿]\n${ctx.draft}`;

  let out = "";
  for await (const ev of client.stream({
    apiKey: ctx.settings.apiKey,
    endpoint: ctx.settings.endpoint,
    model,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: [],
    maxTokens: 1024,
    abortSignal: ctx.signal,
  })) {
    if (ev.type === "text_delta") out += ev.text;
    if (ev.type === "error") throw new Error(ev.error);
  }
  const trimmed = out.trim();
  if (!trimmed) throw new Error("optimizer returned empty");
  return trimmed;
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @aipagego/extension test optimize-prompt.test.ts 2>&1 | tail -20
```

Expected: 8 tests passed。

- [ ] **Step 5: 全量 typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/extension/src/sidepanel/lib/optimize-prompt.ts packages/extension/tests/sidepanel/lib/optimize-prompt.test.ts
git commit -m "feat(sidepanel): add optimize-prompt helper — LLM 改写用户草稿

纯函数 + 8 个单测；复用 pickClient + settings，通过 chrome.tabs.get 拿页面
标题与 URL 一起送给 LLM。留空 optimizerModel 时回退 chat model。"
```

---

### Task 3: PromptOptimizePreview 组件 + 测试

**Files:**
- Create: `packages/extension/src/sidepanel/input/prompt-optimize-preview.tsx`
- Create: `packages/extension/tests/sidepanel/input/prompt-optimize-preview.test.tsx`

**Interfaces:**
- Consumes: 无（受控组件）
- Produces:
  - `type PromptOptimizePreviewProps = { original: string; optimized?: string; error?: string; loading: boolean; onAccept: () => void; onRegenerate: () => void; onDiscard: () => void }`
  - `PromptOptimizePreview` — 显示优化结果 / 错误 / 三个按钮，支持 Enter / Esc 键盘

- [ ] **Step 1: 写失败测试**

Create `packages/extension/tests/sidepanel/input/prompt-optimize-preview.test.tsx`：

```tsx
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PromptOptimizePreview } from "@/sidepanel/input/prompt-optimize-preview";

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

const NOOP = () => {};

describe("PromptOptimizePreview", () => {
  it("renders optimized text and 3 action buttons in success state", () => {
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="原文"
        optimized="优化后"
        loading={false}
        onAccept={NOOP}
        onRegenerate={NOOP}
        onDiscard={NOOP}
      />
    );
    expect(c.textContent).toContain("优化后");
    const btns = [...c.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(btns.some((t) => t.includes("接受"))).toBe(true);
    expect(btns.some((t) => t.includes("重新生成"))).toBe(true);
    expect(btns.some((t) => t.includes("弃用"))).toBe(true);
    cleanup();
  });

  it("clicking 接受 fires onAccept", () => {
    const onAccept = vi.fn();
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="a"
        optimized="b"
        loading={false}
        onAccept={onAccept}
        onRegenerate={NOOP}
        onDiscard={NOOP}
      />
    );
    const btn = [...c.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("接受")
    ) as HTMLButtonElement;
    act(() => btn.click());
    expect(onAccept).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("Enter key fires onAccept when optimized present", () => {
    const onAccept = vi.fn();
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="a"
        optimized="b"
        loading={false}
        onAccept={onAccept}
        onRegenerate={NOOP}
        onDiscard={NOOP}
      />
    );
    const panel = c.firstElementChild as HTMLElement;
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("Escape key fires onDiscard", () => {
    const onDiscard = vi.fn();
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="a"
        optimized="b"
        loading={false}
        onAccept={NOOP}
        onRegenerate={NOOP}
        onDiscard={onDiscard}
      />
    );
    const panel = c.firstElementChild as HTMLElement;
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
      );
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it("Enter is a no-op when loading (optimized still absent)", () => {
    const onAccept = vi.fn();
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="a"
        loading={true}
        onAccept={onAccept}
        onRegenerate={NOOP}
        onDiscard={NOOP}
      />
    );
    const panel = c.firstElementChild as HTMLElement;
    act(() => {
      panel.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
      );
    });
    expect(onAccept).not.toHaveBeenCalled();
    cleanup();
  });

  it("error state shows retry button only + error text; Enter/接受 absent", () => {
    const onRegen = vi.fn();
    const { c, cleanup } = mount(
      <PromptOptimizePreview
        original="a"
        error="429 rate limit"
        loading={false}
        onAccept={NOOP}
        onRegenerate={onRegen}
        onDiscard={NOOP}
      />
    );
    expect(c.textContent).toContain("429 rate limit");
    const btns = [...c.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(btns.some((t) => t.includes("接受"))).toBe(false);
    const retry = [...c.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("重试")
    ) as HTMLButtonElement;
    expect(retry).toBeTruthy();
    act(() => retry.click());
    expect(onRegen).toHaveBeenCalledTimes(1);
    cleanup();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
pnpm --filter @aipagego/extension test prompt-optimize-preview.test.tsx 2>&1 | tail -20
```

Expected: 6 tests failed with "Cannot find module '@/sidepanel/input/prompt-optimize-preview'"。

- [ ] **Step 3: 写实现**

Create `packages/extension/src/sidepanel/input/prompt-optimize-preview.tsx`：

```tsx
import { useEffect, useRef } from "react";
import { X, Loader2 } from "lucide-react";

type Props = {
  original: string;
  optimized?: string;
  error?: string;
  loading: boolean;
  onAccept: () => void;
  onRegenerate: () => void;
  onDiscard: () => void;
};

export function PromptOptimizePreview({
  original,
  optimized,
  error,
  loading,
  onAccept,
  onRegenerate,
  onDiscard,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const acceptable = !!optimized && !loading && !error;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Enter" && acceptable) {
          e.preventDefault();
          onAccept();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onDiscard();
        }
      }}
      className="absolute bottom-full left-3 right-3 mb-2 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg z-20 outline-none text-xs"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <span className="text-zinc-300">
          {error ? "⚠ 优化失败" : loading ? "✨ 优化中…" : "✨ 优化后"}
        </span>
        <button
          type="button"
          aria-label="关闭"
          onClick={onDiscard}
          className="text-zinc-500 hover:text-zinc-200"
        >
          <X size={14} />
        </button>
      </div>

      {error ? (
        <div className="px-3 py-2 space-y-2">
          <div className="text-red-400 break-all">{error}</div>
          <button
            type="button"
            onClick={onRegenerate}
            className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
          >
            重试
          </button>
        </div>
      ) : loading ? (
        <div className="px-3 py-3 flex items-center gap-2 text-zinc-400">
          <Loader2 size={14} className="animate-spin" /> 正在改写…
        </div>
      ) : (
        <>
          <pre className="px-3 py-2 whitespace-pre-wrap break-words text-zinc-100 max-h-52 overflow-auto">
            {optimized}
          </pre>
          <details className="border-t border-zinc-800 px-3 py-1.5 text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">查看原文</summary>
            <pre className="mt-1 whitespace-pre-wrap break-words text-zinc-400">{original}</pre>
          </details>
          <div className="flex items-center gap-2 px-3 py-2 border-t border-zinc-800 justify-end">
            <button
              type="button"
              onClick={onDiscard}
              className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
            >
              弃用
            </button>
            <button
              type="button"
              onClick={onRegenerate}
              className="px-2 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-zinc-100"
            >
              重新生成
            </button>
            <button
              type="button"
              onClick={onAccept}
              className="px-2 py-0.5 rounded bg-blue-700 hover:bg-blue-600 text-white"
              title="Enter"
            >
              接受
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
pnpm --filter @aipagego/extension test prompt-optimize-preview.test.tsx 2>&1 | tail -20
```

Expected: 6 tests passed。

- [ ] **Step 5: 提交**

```bash
git add packages/extension/src/sidepanel/input/prompt-optimize-preview.tsx packages/extension/tests/sidepanel/input/prompt-optimize-preview.test.tsx
git commit -m "feat(sidepanel): add PromptOptimizePreview component

绝对定位在输入框上方，展示优化结果 / loading / error 三态。
键盘：Enter 接受、Esc 弃用；error 态收敛为单个「重试」按钮。"
```

---

### Task 4: InputBox 加 rightAction slot

**Files:**
- Modify: `packages/extension/src/sidepanel/input/input-box.tsx`

**Interfaces:**
- Consumes: 无
- Produces:
  - `InputBox` Props 新增可选 `rightAction?: React.ReactNode`
  - 有 `rightAction` 时 textarea 自动加 `pr-8 pb-6` 让位；外层套 `relative` 容器承载绝对定位的浮动按钮

**Rationale:** 只做 slot 与容器 padding 让位；不引入按钮逻辑。测试沿用 InputBox 无现成测试的现状——手工验证 + typecheck。

- [ ] **Step 1: 改造 InputBox**

Modify `packages/extension/src/sidepanel/input/input-box.tsx`。

在 `Props` 定义末尾追加字段（`placeholder?: string;` 后）：

```ts
  /** 右下角浮动动作槽位（如「优化提示词」按钮）。有值时 textarea 自动 padding 让位。 */
  rightAction?: React.ReactNode;
```

组件参数解构 `disabled, placeholder,` 后追加 `rightAction,`。

`return` 部分把裸 `<textarea .../>` 包一层 `<div className="relative">`，并在 textarea `className` 里追加 `${rightAction ? "pr-8 pb-6" : ""}`：

```tsx
  return (
    <div className="relative">
      <textarea
        ref={ref}
        data-testid="input-box"
        value={value}
        disabled={disabled}
        placeholder={placeholder ?? "告诉 AI 你要做什么…"}
        onChange={(e) => {
          const next = e.target.value;
          if (onAtTrigger && next.length > value.length && next.endsWith("@")) {
            onAtTrigger();
          }
          onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !disabled) {
            e.preventDefault();
            if (value.trim()) onSubmit();
          }
        }}
        onPaste={(e) => {
          if (!onImageFiles) return;
          const imgs = imagesFromClipboard(e.clipboardData?.items ?? null);
          if (imgs.length > 0) {
            e.preventDefault();
            onImageFiles(imgs);
          }
        }}
        onDragOver={(e) => {
          if (onImageFiles) e.preventDefault();
        }}
        onDrop={(e) => {
          if (!onImageFiles) return;
          const imgs = imagesFromList(e.dataTransfer?.files ?? null);
          if (imgs.length > 0) {
            e.preventDefault();
            onImageFiles(imgs);
          }
        }}
        className={`w-full resize-none bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-zinc-100 text-[12px] placeholder:text-zinc-500 focus:outline-none focus:ring-1 focus:ring-blue-700 disabled:opacity-50 ${rightAction ? "pr-8 pb-6" : ""}`}
        style={{ minHeight: MIN_PX, maxHeight: MAX_PX }}
      />
      {rightAction}
    </div>
  );
```

- [ ] **Step 2: typecheck**

```bash
pnpm typecheck 2>&1 | tail -10
```

Expected: 全绿。

- [ ] **Step 3: 全量测试确认无回归**

```bash
pnpm --filter @aipagego/extension test 2>&1 | tail -15
```

Expected: 全绿（InputBox 无既有单测，Task 3 加的 preview 测通过）。

- [ ] **Step 4: 提交**

```bash
git add packages/extension/src/sidepanel/input/input-box.tsx
git commit -m "refactor(sidepanel): InputBox 支持 rightAction slot

有值时 textarea 自动 pr-8 pb-6 让位；外层 relative 承载浮动按钮。
本 commit 不引入按钮，只做容器改造。"
```

---

### Task 5: PromptOptimizeButton + InputToolbar 状态机 + AppShell 接线

**Files:**
- Create: `packages/extension/src/sidepanel/input/prompt-optimize-button.tsx`
- Modify: `packages/extension/src/sidepanel/input/input-toolbar.tsx`
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx`

**Interfaces:**
- Consumes:
  - `optimizePrompt` from `@/sidepanel/lib/optimize-prompt` (Task 2)
  - `PromptOptimizePreview` from `@/sidepanel/input/prompt-optimize-preview` (Task 3)
  - `InputBox` `rightAction` prop (Task 4)
  - `LlmSettings.optimizerModel` (Task 1)
- Produces:
  - 浏览器可见的完整功能：点魔法棒 → 面板 → 接受 → 输入框替换

- [ ] **Step 1: 写 PromptOptimizeButton**

Create `packages/extension/src/sidepanel/input/prompt-optimize-button.tsx`：

```tsx
import { Sparkles, Loader2 } from "lucide-react";

type Props = {
  status: "idle" | "loading" | "error";
  disabled: boolean;
  onClick: () => void;
};

export function PromptOptimizeButton({ status, disabled, onClick }: Props) {
  const iconCls =
    status === "error"
      ? "text-red-400 hover:text-red-300"
      : disabled
        ? "text-zinc-700"
        : "text-zinc-500 hover:text-zinc-200";
  return (
    <button
      type="button"
      aria-label="优化提示词"
      title={status === "error" ? "点击重试" : "让 AI 帮你把草稿写清楚"}
      disabled={disabled || status === "loading"}
      onClick={onClick}
      className={`absolute bottom-1.5 right-1.5 p-1 ${iconCls}`}
    >
      {status === "loading" ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Sparkles size={14} />
      )}
    </button>
  );
}
```

- [ ] **Step 2: InputToolbar 加 props + 状态机 + 编排**

Modify `packages/extension/src/sidepanel/input/input-toolbar.tsx`。

**改动 1:** 顶部 import 追加：

```ts
import { useEffect, useRef, useState } from "react";
import type { LlmSettings } from "@aipagego/shared/types";
import { optimizePrompt } from "@/sidepanel/lib/optimize-prompt";
import { PromptOptimizeButton } from "./prompt-optimize-button";
import { PromptOptimizePreview } from "./prompt-optimize-preview";
```

（`useEffect` / `useRef` 在原文件里可能未 import，一并补上。）

**改动 2:** `Props` 类型新增字段：

```ts
  // prompt optimize
  settings: LlmSettings;
  currentTabId: number | null;
```

**改动 3:** 组件内新增状态与 handler（放在 `const [mentionOpen, setMentionOpen] = useState(false);` 之后）：

```ts
  type OptState =
    | { kind: "closed" }
    | { kind: "loading"; original: string; ac: AbortController }
    | { kind: "preview"; original: string; optimized: string }
    | { kind: "error"; original: string; error: string };
  const [opt, setOpt] = useState<OptState>({ kind: "closed" });
  const optRef = useRef(opt);
  optRef.current = opt;

  useEffect(() => {
    return () => {
      // 卸载时如果还在 loading，取消请求
      if (optRef.current.kind === "loading") optRef.current.ac.abort();
    };
  }, []);

  async function runOptimize(original: string) {
    if (props.currentTabId == null) return;
    const ac = new AbortController();
    setOpt({ kind: "loading", original, ac });
    try {
      const optimized = await optimizePrompt({
        draft: original,
        tabId: props.currentTabId,
        settings: props.settings,
        signal: ac.signal,
      });
      // 若在等待期间被 abort 或替换，忽略结果
      if (ac.signal.aborted) return;
      setOpt({ kind: "preview", original, optimized });
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setOpt({ kind: "error", original, error: msg });
    }
  }

  function handleOptimizeClick() {
    if (opt.kind === "loading" || opt.kind === "preview") return;
    if (opt.kind === "error") {
      // 直接重试
      void runOptimize(opt.original);
      return;
    }
    const draft = props.value.trim();
    if (!draft) return;
    void runOptimize(props.value);
  }

  const optimizeStatus: "idle" | "loading" | "error" =
    opt.kind === "loading" ? "loading" : opt.kind === "error" ? "error" : "idle";
  const optimizeDisabled = !props.value.trim() || props.status === "streaming";
```

**改动 4:** `<InputBox .../>` 增加 `rightAction`：

```tsx
        <InputBox
          value={props.value}
          onChange={props.onChange}
          onSubmit={() => props.onSubmit(props.value)}
          onAtTrigger={() => setMentionOpen(true)}
          onImageFiles={props.onImageFiles}
          disabled={props.status === "streaming"}
          rightAction={
            <PromptOptimizeButton
              status={optimizeStatus}
              disabled={optimizeDisabled}
              onClick={handleOptimizeClick}
            />
          }
        />
```

**改动 5:** 在 `<InputBox>` **上方**（就在 `<div className="border-t border-zinc-800 bg-zinc-900 px-3 py-2 space-y-2 relative">` 里、`InputBox` 前面）加预览：

```tsx
        {opt.kind !== "closed" && (
          <PromptOptimizePreview
            original={opt.original}
            optimized={opt.kind === "preview" ? opt.optimized : undefined}
            error={opt.kind === "error" ? opt.error : undefined}
            loading={opt.kind === "loading"}
            onAccept={() => {
              if (opt.kind === "preview") {
                props.onChange(opt.optimized);
                setOpt({ kind: "closed" });
              }
            }}
            onRegenerate={() => {
              if (opt.kind === "loading") opt.ac.abort();
              void runOptimize(opt.original);
            }}
            onDiscard={() => {
              if (opt.kind === "loading") opt.ac.abort();
              setOpt({ kind: "closed" });
            }}
          />
        )}
```

（外层 `<div>` 已有 `relative`，所以预览的 `absolute bottom-full` 相对它定位。）

- [ ] **Step 3: AppShell 传入两个新 prop**

Modify `packages/extension/src/sidepanel/shell/app-shell.tsx`。

找到 `<InputToolbar` 那一段（`grep -n '<InputToolbar' packages/extension/src/sidepanel/shell/app-shell.tsx`），在任意一条现有 prop 之后追加：

```tsx
        settings={settings}
        currentTabId={currentTabId}
```

`settings` 已经从 `const settings = useSettings();` 拿到；`currentTabId` 从 `const currentTabId = useCurrentTabId();` 拿到——都在作用域内。

- [ ] **Step 4: 全量 typecheck**

```bash
pnpm typecheck 2>&1 | tail -15
```

Expected: 全绿。

- [ ] **Step 5: 全量测试**

```bash
pnpm --filter @aipagego/extension test 2>&1 | tail -10
```

Expected: 全绿；`optimize-prompt.test.ts` (8) + `prompt-optimize-preview.test.tsx` (6) 都过。

- [ ] **Step 6: 生产 build**

```bash
pnpm build 2>&1 | tail -20
```

Expected: `✓ built in ...s`，无 warning / error。

- [ ] **Step 7: 手工 QA 清单**

用 `chrome://extensions` reload 一下扩展，在真实网页上验证：

- [ ] 空草稿：魔法棒变暗、不可点
- [ ] 打字后：魔法棒变亮
- [ ] streaming 期间：魔法棒不可点
- [ ] 点击：出现 spinner → 面板出现
- [ ] 面板显示优化文本，「查看原文」折叠里显示原始 draft
- [ ] Enter 键接受，输入框内容替换成优化文本
- [ ] Esc 键弃用，输入框不变
- [ ] 「重新生成」再跑一次 API
- [ ] Settings → LLM → 填入 `claude-haiku-4-5-20251001` 到「优化模型」，验证优化用的是 haiku（可打开调试抽屉的 Exchanges 页确认**不出现**优化的 exchange —— spec §2 明确不写入）
- [ ] 断网/错误 API：错误面板 + 重试
- [ ] 优化中切换 tab：请求被 abort，无 console 报错

- [ ] **Step 8: 提交**

```bash
git add packages/extension/src/sidepanel/input/prompt-optimize-button.tsx packages/extension/src/sidepanel/input/input-toolbar.tsx packages/extension/src/sidepanel/shell/app-shell.tsx
git commit -m "feat(sidepanel): prompt optimize button — 输入框内一键 LLM 改写草稿

魔法棒图标浮在 InputBox 右下角，点击后调 optimize-prompt 拿 LLM 改写
结果，弹预览面板让用户接受/重新生成/弃用。状态机：closed/loading/
preview/error。Enter=接受、Esc=弃用。优化调用不进 llmExchanges。"
```

---

## Self-Review

**Spec coverage:**

| Spec 节 | 覆盖 task |
|---|---|
| §3.1 位置（魔法棒 InputBox 右下角） | Task 4（slot）+ Task 5 Step 1（按钮） |
| §3.2 三态 | Task 5 Step 1（`status` 映射） |
| §3.3 预览面板 | Task 3 |
| §3.4 错误态 | Task 3 Step 3（error 分支）+ Task 5（error 状态机） |
| §4.3 optimize-prompt.ts | Task 2 |
| §4.4 PromptOptimizeButton | Task 5 Step 1 |
| §4.5 PromptOptimizePreview | Task 3 |
| §4.6 InputBox rightAction | Task 4 |
| §4.7 InputToolbar 编排 + abort cleanup | Task 5 Step 2 |
| §4.8 Settings optimizerModel | Task 1 |
| §5 数据流 | Task 5 Step 2 端到端拼装 |
| §6 测试 | Task 2（optimize-prompt）+ Task 3（preview）+ Task 5 Step 7（手工 QA） |

**Placeholder scan:** 已通读，无 TBD / TODO / 「implement later」；所有代码块可复制运行；所有 grep 定位都是 anchor（`export type LlmSettings`、`<InputToolbar`）而非文件行号。

**Type consistency:**
- `LlmSettings.optimizerModel?: string` 在 Task 1 定义 → Task 2 (`ctx.settings.optimizerModel`) 消费 → Task 1 Step 3 UI 消费 ✓
- `optimizePrompt(ctx: {draft, tabId, settings, signal}): Promise<string>` 在 Task 2 定义 → Task 5 Step 2 (`runOptimize`) 消费 ✓
- `PromptOptimizePreview` 的 6 个 props 在 Task 3 定义 → Task 5 Step 2 消费全部 ✓
- `PromptOptimizeButton` 的 3 个 props（`status | disabled | onClick`）在 Task 5 Step 1 定义 → Task 5 Step 2 消费 ✓
- `InputBox.rightAction?: React.ReactNode` 在 Task 4 定义 → Task 5 Step 2 传 `PromptOptimizeButton` 实例 ✓
- `InputToolbar` 新增 props `settings: LlmSettings; currentTabId: number | null` 在 Task 5 Step 2 定义 → Task 5 Step 3 AppShell 传入 ✓

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-02-prompt-optimize-button.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
