# 原始 LLM 交互日志（Raw LLM Exchange Log）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `LlmClient.stream()` 边界录制每一次模型交互（请求去 apiKey + 组装好的响应），持久化到 IndexedDB（带体积上限），并在专用面板按轮查看 / 复制 / 导出。

**Architecture:** 一个 `createRecordingClient` 包住真实 provider client：透传事件流给 run-session（零侵入），同时累积组装一条 `LlmExchange`，经回调写入 session-store 的 `llmExchanges`（FIFO 上限），随现有 auto-persist 落库。新增全高面板 `LlmExchangePanel` 展示。

**Tech Stack:** TypeScript、React 18、zustand、vitest 2 + happy-dom、IndexedDB（现有 sessions-storage）。

参考 spec：`docs/superpowers/specs/2026-05-23-raw-llm-exchange-log-design.md`

**常量默认值：** `MAX_CONTENT_CHARS = 8000`（单块 content 截断阈值）、`MAX_EXCHANGES = 60`（每会话保留条数）。

---

## Task 1: `stop_reason` 贯通（types + anthropic + openai + 更新既有 stream 测试）

给 `message_end` 事件加可选 `stop_reason`，并在两个 provider 里填上。run-session 只读 `usage`，对新字段无感。

**Files:**
- Modify: `packages/extension/src/sidepanel/llm/types.ts`
- Modify: `packages/extension/src/sidepanel/llm/anthropic.ts`
- Modify: `packages/extension/src/sidepanel/llm/openai.ts`
- Modify: `packages/extension/tests/sidepanel/llm/anthropic-stream.test.ts`
- Modify: `packages/extension/tests/sidepanel/llm/openai-stream.test.ts`

- [ ] **Step 1: 先更新既有测试期望（让它们变红）**

在 `anthropic-stream.test.ts` 把两处 `message_end` 期望改为带 `stop_reason`：

第一个测试（text-only，行 54 附近）：
```ts
      { type: "message_end", usage: { input_tokens: 5, output_tokens: 3 }, stop_reason: "end_turn" }
```
第二个测试（tool_use，行 90 附近）：
```ts
      { type: "message_end", usage: { input_tokens: 7, output_tokens: 4 }, stop_reason: "tool_use" }
```

在 `openai-stream.test.ts` 同样改两处：

text-only（行 41 附近）：
```ts
      { type: "message_end", usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: "stop" }
```
tool_calls（行 66 附近）：
```ts
      { type: "message_end", usage: { input_tokens: 7, output_tokens: 4 }, stop_reason: "tool_calls" }
```

- [ ] **Step 2: 运行确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/anthropic-stream.test.ts tests/sidepanel/llm/openai-stream.test.ts`
Expected: FAIL —— message_end 缺 `stop_reason`，`toEqual` 不匹配。

- [ ] **Step 3: types.ts 加字段**

`packages/extension/src/sidepanel/llm/types.ts`，把 `message_end` 一行改为：
```ts
  | { type: "message_end"; usage?: { input_tokens: number; output_tokens: number }; stop_reason?: string }
```

- [ ] **Step 4: anthropic.ts 捕获并带出 stop_reason**

`packages/extension/src/sidepanel/llm/anthropic.ts`：

在 `parseAnthropicStream` 顶部已有 `let usageInput = 0; let usageOutput = 0;`，其后加：
```ts
  let stopReason: string | undefined;
```

把 `message_delta` 分支改为同时读 stop_reason：
```ts
    } else if (type === "message_delta") {
      const delta = payload.delta as { stop_reason?: string } | undefined;
      if (delta?.stop_reason) stopReason = delta.stop_reason;
      const usage = payload.usage as { output_tokens?: number } | undefined;
      if (usage?.output_tokens != null) usageOutput = usage.output_tokens;
    } else if (type === "message_stop") {
      yield {
        type: "message_end",
        usage: { input_tokens: usageInput, output_tokens: usageOutput },
        ...(stopReason ? { stop_reason: stopReason } : {})
      };
    }
```

- [ ] **Step 5: openai.ts 带出 finish_reason**

`packages/extension/src/sidepanel/llm/openai.ts`，两处 `yield { type: "message_end", usage: {...} }`（`[DONE]` 分支行 33、收尾分支行 103）都改为：
```ts
        yield {
          type: "message_end",
          usage: { input_tokens: usageIn, output_tokens: usageOut },
          ...(finishReason ? { stop_reason: finishReason } : {})
        };
```
（`finishReason` 变量已存在于函数作用域。）

- [ ] **Step 6: 运行确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/anthropic-stream.test.ts tests/sidepanel/llm/openai-stream.test.ts`
Expected: PASS（4 个相关用例都过）。

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/sidepanel/llm/types.ts packages/extension/src/sidepanel/llm/anthropic.ts packages/extension/src/sidepanel/llm/openai.ts packages/extension/tests/sidepanel/llm/anthropic-stream.test.ts packages/extension/tests/sidepanel/llm/openai-stream.test.ts
git commit -m "feat(llm): surface stop_reason on message_end (anthropic + openai)"
```

---

## Task 2: `LlmExchange` 类型 + 持久化字段

**Files:**
- Modify: `packages/shared/src/types.ts`

- [ ] **Step 1: 加类型**

在 `packages/shared/src/types.ts` 的 `LlmSettings` 之后、`AttachedTab` 相关之前（任意稳定位置）加：
```ts
export type LlmExchangeRequest = {
  provider: LlmProvider;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  system: string;
  messages: ChatMessage[];   // 完整上下文，单块内容按上限截断
  toolNames: string[];
};

export type LlmExchangeResponse = {
  text: string;
  toolUses: { id: string; name: string; input: Json }[];
  usage?: { input_tokens: number; output_tokens: number };
  stopReason?: string;
  error?: string;
  aborted?: boolean;
};

export type LlmExchange = {
  id: string;
  round: number;
  kind: "main";
  startedAt: number;
  durationMs: number;
  request: LlmExchangeRequest;
  response: LlmExchangeResponse;
};
```

- [ ] **Step 2: PersistedSessionData 加字段**

在 `PersistedSessionData`（约行 205）末尾加一行：
```ts
  llmExchanges: LlmExchange[];
```

- [ ] **Step 3: typecheck（会报 auto-persist/session-store 缺字段，预期，后续任务补齐）**

Run: `pnpm --filter @aipagego/shared typecheck`
Expected: shared 包 0 error（类型本身自洽）。extension 包此刻还不 typecheck（留到后续任务）。

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(shared): LlmExchange types + PersistedSessionData.llmExchanges"
```

---

## Task 3: 截断 helper

**Files:**
- Create: `packages/extension/src/sidepanel/llm/truncate.ts`
- Create: `packages/extension/tests/sidepanel/llm/truncate.test.ts`

- [ ] **Step 1: 写测试**

`packages/extension/tests/sidepanel/llm/truncate.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { truncateContent, truncateMessages } from "@/sidepanel/llm/truncate";
import type { ChatMessage } from "@aipagego/shared/types";

describe("truncateContent", () => {
  it("returns as-is when within cap", () => {
    expect(truncateContent("hello", 10)).toBe("hello");
  });
  it("returns as-is when exactly at cap", () => {
    expect(truncateContent("12345", 5)).toBe("12345");
  });
  it("truncates head+tail with marker when over cap", () => {
    const s = "a".repeat(100);
    const out = truncateContent(s, 10);
    expect(out).toContain("[截断 90 字]");
    expect(out.length).toBeLessThan(s.length);
  });
  it("handles empty string", () => {
    expect(truncateContent("", 10)).toBe("");
  });
});

describe("truncateMessages", () => {
  it("truncates a long user string content", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "x".repeat(50) }];
    const out = truncateMessages(msgs, 10);
    expect(typeof out[0].content).toBe("string");
    expect(out[0].content as string).toContain("[截断");
  });
  it("truncates tool_result content but keeps structure", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "y".repeat(50) }] }
    ];
    const out = truncateMessages(msgs, 10);
    const part = (out[0].content as Array<{ type: string; tool_use_id?: string; content?: string }>)[0];
    expect(part.type).toBe("tool_result");
    expect(part.tool_use_id).toBe("t1");
    expect(part.content).toContain("[截断");
  });
  it("leaves tool_use parts untouched", () => {
    const msgs: ChatMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "u1", name: "snapshotDOM", input: { a: 1 } }] }
    ];
    const out = truncateMessages(msgs, 10);
    const part = (out[0].content as Array<{ type: string; input?: unknown }>)[0];
    expect(part.type).toBe("tool_use");
    expect(part.input).toEqual({ a: 1 });
  });
});
```

- [ ] **Step 2: 确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/truncate.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`packages/extension/src/sidepanel/llm/truncate.ts`：
```ts
import type { ChatMessage, TextPart, ToolResultPart, ToolUsePart } from "@aipagego/shared/types";

export function truncateContent(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const half = Math.floor(cap / 2);
  const head = s.slice(0, half);
  const tail = s.slice(s.length - half);
  return `${head}\n…[截断 ${s.length - cap} 字]…\n${tail}`;
}

export function truncateMessages(messages: ChatMessage[], cap: number): ChatMessage[] {
  return messages.map((m): ChatMessage => {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        return { role: "user", content: truncateContent(m.content, cap) };
      }
      const content = m.content.map((part): TextPart | ToolResultPart => {
        if (part.type === "text") return { ...part, text: truncateContent(part.text, cap) };
        return typeof part.content === "string"
          ? { ...part, content: truncateContent(part.content, cap) }
          : part;
      });
      return { role: "user", content };
    }
    const content = m.content.map((part): TextPart | ToolUsePart =>
      part.type === "text" ? { ...part, text: truncateContent(part.text, cap) } : part
    );
    return { role: "assistant", content };
  });
}
```

- [ ] **Step 4: 确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/truncate.test.ts`
Expected: PASS（7 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/llm/truncate.ts packages/extension/tests/sidepanel/llm/truncate.test.ts
git commit -m "feat(llm): truncate helpers for raw-log content caps"
```

---

## Task 4: 录制 wrapper `createRecordingClient`

**Files:**
- Create: `packages/extension/src/sidepanel/llm/recording-client.ts`
- Create: `packages/extension/tests/sidepanel/llm/recording-client.test.ts`

- [ ] **Step 1: 写测试**

`packages/extension/tests/sidepanel/llm/recording-client.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { createRecordingClient } from "@/sidepanel/llm/recording-client";
import type { LlmClient, LlmStreamEvent } from "@/sidepanel/llm/types";
import type { LlmExchange } from "@aipagego/shared/types";

function fakeClient(events: LlmStreamEvent[]): LlmClient {
  return {
    async *stream() {
      for (const e of events) yield e;
    }
  };
}

const baseInput = {
  apiKey: "sk-SECRET",
  model: "m",
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "snapshotDOM", description: "", input_schema: {} }]
};

async function drain(it: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("createRecordingClient", () => {
  it("passes events through unchanged", async () => {
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "Hi" },
      { type: "message_end", usage: { input_tokens: 1, output_tokens: 2 }, stop_reason: "end_turn" }
    ];
    const rec = createRecordingClient(fakeClient(events), () => {}, { provider: "anthropic" });
    expect(await drain(rec.stream(baseInput))).toEqual(events);
  });

  it("records one exchange with assembled response and no apiKey", async () => {
    let captured: LlmExchange | null = null;
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      { type: "tool_use_start", id: "t1", name: "snapshotDOM" },
      { type: "tool_use_end", id: "t1", input: { maxDepth: 3 } },
      { type: "message_end", usage: { input_tokens: 9, output_tokens: 4 }, stop_reason: "tool_use" }
    ];
    const rec = createRecordingClient(fakeClient(events), (ex) => { captured = ex; }, { provider: "anthropic" });
    await drain(rec.stream(baseInput));

    expect(captured).not.toBeNull();
    const ex = captured!;
    expect(ex.request.model).toBe("m");
    expect(ex.request.provider).toBe("anthropic");
    expect(ex.request.toolNames).toEqual(["snapshotDOM"]);
    expect(ex.response.text).toBe("Hello");
    expect(ex.response.toolUses).toEqual([{ id: "t1", name: "snapshotDOM", input: { maxDepth: 3 } }]);
    expect(ex.response.usage).toEqual({ input_tokens: 9, output_tokens: 4 });
    expect(ex.response.stopReason).toBe("tool_use");
    // apiKey 绝不出现在记录里
    expect(JSON.stringify(ex)).not.toContain("SECRET");
  });

  it("truncates oversized message content per cap", async () => {
    let captured: LlmExchange | null = null;
    const big = { ...baseInput, messages: [{ role: "user" as const, content: "z".repeat(100) }] };
    const rec = createRecordingClient(
      fakeClient([{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }]),
      (ex) => { captured = ex; },
      { provider: "anthropic", maxContentChars: 10 }
    );
    await drain(rec.stream(big));
    expect(captured!.request.messages[0].content as string).toContain("[截断");
  });

  it("records partial exchange (aborted) when consumer breaks early", async () => {
    let captured: LlmExchange | null = null;
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "partial" },
      { type: "text_delta", text: " more" },
      { type: "message_end", usage: { input_tokens: 1, output_tokens: 1 } }
    ];
    const rec = createRecordingClient(fakeClient(events), (ex) => { captured = ex; }, { provider: "anthropic" });
    for await (const e of rec.stream(baseInput)) {
      if (e.type === "text_delta") break; // consumer aborts after first event
    }
    expect(captured).not.toBeNull();
    expect(captured!.response.aborted).toBe(true);
    expect(captured!.response.text).toBe("partial");
  });

  it("records error from inner error event", async () => {
    let captured: LlmExchange | null = null;
    const rec = createRecordingClient(
      fakeClient([{ type: "error", error: "boom" }]),
      (ex) => { captured = ex; },
      { provider: "anthropic" }
    );
    await drain(rec.stream(baseInput));
    expect(captured!.response.error).toBe("boom");
  });

  it("increments round per stream() call", async () => {
    const rounds: number[] = [];
    const rec = createRecordingClient(
      fakeClient([{ type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }]),
      (ex) => rounds.push(ex.round),
      { provider: "anthropic" }
    );
    await drain(rec.stream(baseInput));
    await drain(rec.stream(baseInput));
    expect(rounds).toEqual([0, 1]);
  });
});
```

- [ ] **Step 2: 确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/recording-client.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`packages/extension/src/sidepanel/llm/recording-client.ts`：
```ts
import type { Json, LlmExchange, LlmExchangeResponse, LlmProvider } from "@aipagego/shared/types";
import type { LlmClient } from "./types";
import { truncateMessages } from "./truncate";

export type RecordingOptions = {
  provider: LlmProvider;
  kind?: LlmExchange["kind"];
  maxContentChars?: number;
};

const DEFAULT_MAX_CONTENT_CHARS = 8000;

export function createRecordingClient(
  inner: LlmClient,
  onExchange: (ex: LlmExchange) => void,
  opts: RecordingOptions
): LlmClient {
  let round = 0;
  const cap = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const kind = opts.kind ?? "main";

  return {
    async *stream(input) {
      const startedAt = Date.now();
      const myRound = round++;
      const request = {
        provider: opts.provider,
        model: input.model,
        endpoint: input.endpoint,
        maxTokens: input.maxTokens,
        system: input.system,
        messages: truncateMessages(input.messages, cap),
        toolNames: input.tools.map((t) => t.name)
      };

      let text = "";
      const toolUses: { id: string; name: string; input: Json }[] = [];
      const names = new Map<string, string>();
      let usage: { input_tokens: number; output_tokens: number } | undefined;
      let stopReason: string | undefined;
      let error: string | undefined;
      let completed = false;

      try {
        for await (const ev of inner.stream(input)) {
          switch (ev.type) {
            case "text_delta":
              text += ev.text;
              break;
            case "tool_use_start":
              names.set(ev.id, ev.name);
              break;
            case "tool_use_end":
              toolUses.push({ id: ev.id, name: names.get(ev.id) ?? "", input: ev.input });
              break;
            case "message_end":
              usage = ev.usage;
              stopReason = ev.stop_reason;
              break;
            case "error":
              error = ev.error;
              break;
          }
          yield ev;
        }
        completed = true;
      } finally {
        const aborted = !completed && !error;
        const response: LlmExchangeResponse = {
          text,
          toolUses,
          ...(usage ? { usage } : {}),
          ...(stopReason ? { stopReason } : {}),
          ...(error ? { error } : {}),
          ...(aborted ? { aborted: true } : {})
        };
        try {
          onExchange({
            id: crypto.randomUUID(),
            round: myRound,
            kind,
            startedAt,
            durationMs: Date.now() - startedAt,
            request,
            response
          });
        } catch (err) {
          console.warn("[recording-client] onExchange threw", err);
        }
      }
    }
  };
}
```

- [ ] **Step 4: 确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/llm/recording-client.test.ts`
Expected: PASS（6 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/llm/recording-client.ts packages/extension/tests/sidepanel/llm/recording-client.test.ts
git commit -m "feat(llm): recording-client — capture structured LlmExchange at stream boundary"
```

---

## Task 5: session-store —— `llmExchanges` + `addLlmExchange` + rehydrate

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts`
- Modify: `packages/extension/tests/sidepanel/chat/session-store.test.ts`

- [ ] **Step 1: 写测试（追加到 session-store.test.ts 末尾的合适 describe 内）**

在 `packages/extension/tests/sidepanel/chat/session-store.test.ts` 顶部 import 里确保引入了需要的符号（按文件现有风格，从 `@/sidepanel/chat/session-store` 引 `addLlmExchange`、`getSessionFor`、`ensureSession`、`rehydrateFromPersisted`、`MAX_EXCHANGES`）。新增：
```ts
import {
  addLlmExchange,
  ensureSession,
  getSessionFor,
  rehydrateFromPersisted,
  MAX_EXCHANGES
} from "@/sidepanel/chat/session-store";
import type { LlmExchange } from "@aipagego/shared/types";

function makeExchange(round: number): LlmExchange {
  return {
    id: `ex-${round}`,
    round,
    kind: "main",
    startedAt: 0,
    durationMs: 1,
    request: { provider: "anthropic", model: "m", system: "s", messages: [], toolNames: [] },
    response: { text: "t", toolUses: [] }
  };
}

describe("llmExchanges", () => {
  it("appends exchanges to the session", () => {
    ensureSession(1, "u");
    addLlmExchange(1, makeExchange(0));
    addLlmExchange(1, makeExchange(1));
    expect(getSessionFor(1).llmExchanges.map((e) => e.round)).toEqual([0, 1]);
  });

  it("caps retained exchanges at MAX_EXCHANGES (FIFO)", () => {
    ensureSession(2, "u");
    for (let i = 0; i < MAX_EXCHANGES + 5; i++) addLlmExchange(2, makeExchange(i));
    const got = getSessionFor(2).llmExchanges;
    expect(got.length).toBe(MAX_EXCHANGES);
    expect(got[0].round).toBe(5); // oldest 5 dropped
    expect(got[got.length - 1].round).toBe(MAX_EXCHANGES + 4);
  });

  it("rehydrate restores llmExchanges (defaults to [] when absent)", () => {
    rehydrateFromPersisted(3, {
      messages: [],
      cards: [],
      executedSteps: [],
      tokenUsage: { input: 0, output: 0 },
      roundCount: 0,
      attachedTabs: [],
      url: "u",
      runRecordId: null,
      errorMessage: null,
      llmExchanges: [makeExchange(7)]
    });
    expect(getSessionFor(3).llmExchanges.map((e) => e.round)).toEqual([7]);
  });
});
```

> 注：若该测试文件用了 `beforeEach` 重置 store，沿用其既有方式；上面用不同 tabId 隔离避免互相污染。

- [ ] **Step 2: 确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/chat/session-store.test.ts`
Expected: FAIL —— `addLlmExchange` / `MAX_EXCHANGES` 未导出、`llmExchanges` 字段不存在。

- [ ] **Step 3: 实现 session-store 改动**

`packages/extension/src/sidepanel/chat/session-store.ts`：

(a) import 加 `LlmExchange`：
```ts
import type { AttachedTab, ChatMessage, Json, LlmExchange, PersistedSessionData, Step, ToolUsePart } from "@aipagego/shared/types";
```

(b) 文件顶部（import 后）加常量：
```ts
export const MAX_EXCHANGES = 60;
```

(c) `SessionData` 类型加字段（放在 `logs` 附近）：
```ts
  llmExchanges: LlmExchange[];
```

(d) `makeEmptySession` 返回对象里加：
```ts
    llmExchanges: [],
```

(e) 新增 action（放在 `addUsage` 附近）：
```ts
export function addLlmExchange(tabId: number, ex: LlmExchange): void {
  patchSession(tabId, (s) => ({
    ...s,
    llmExchanges: [...s.llmExchanges, ex].slice(-MAX_EXCHANGES)
  }));
}
```

(f) `rehydrateFromPersisted` 的 `rehydrated` 对象里加：
```ts
      llmExchanges: data.llmExchanges ?? [],
```

(g) `LegacySession` 类型加：
```ts
  addLlmExchange: (ex: LlmExchange) => void;
```

(h) `useSession()` 返回对象里加：
```ts
    addLlmExchange: (ex) => addLlmExchange(tabId, ex),
```

- [ ] **Step 4: 确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/chat/session-store.test.ts`
Expected: PASS（含新增 3 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts packages/extension/tests/sidepanel/chat/session-store.test.ts
git commit -m "feat(chat): session-store llmExchanges + addLlmExchange (FIFO cap) + rehydrate"
```

---

## Task 6: auto-persist 落库 `llmExchanges`

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/persistence/auto-persist.ts`
- Modify: `packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts`

- [ ] **Step 1: 写测试**

在 `packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts` 末尾加一个用例（沿用文件现有的 import 与 setup 风格；下面假设可从被测模块拿到 `toPersistedData` 的等价验证路径——若该文件是通过观察 `sessions-storage` 写入来断言，则改为断言写入的 `data.llmExchanges`）。最稳妥、与实现解耦的做法是直接测 `toPersistedData`，为此把它从 auto-persist 导出：

先在实现里 `export` `toPersistedData`（见 Step 3），再写：
```ts
import { toPersistedData } from "@/sidepanel/chat/persistence/auto-persist";
import { makeEmptySession } from "@/sidepanel/chat/session-store";
import type { LlmExchange } from "@aipagego/shared/types";

describe("toPersistedData", () => {
  it("includes llmExchanges", () => {
    const ex: LlmExchange = {
      id: "e1", round: 0, kind: "main", startedAt: 0, durationMs: 1,
      request: { provider: "anthropic", model: "m", system: "s", messages: [], toolNames: [] },
      response: { text: "t", toolUses: [] }
    };
    const s = { ...makeEmptySession(1, "u"), llmExchanges: [ex] };
    expect(toPersistedData(s).llmExchanges).toEqual([ex]);
  });
});
```

- [ ] **Step 2: 确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/chat/persistence/auto-persist.test.ts`
Expected: FAIL —— `toPersistedData` 未导出 / 结果缺 `llmExchanges`。

- [ ] **Step 3: 实现**

`packages/extension/src/sidepanel/chat/persistence/auto-persist.ts`：把 `toPersistedData` 改为导出并加字段：
```ts
export function toPersistedData(s: SessionData): PersistedSessionData {
  return {
    messages: s.messages,
    cards: s.cards,
    executedSteps: s.executedSteps,
    tokenUsage: s.tokenUsage,
    roundCount: s.roundCount,
    attachedTabs: s.attachedTabs,
    url: s.url,
    runRecordId: s.runRecordId,
    errorMessage: s.errorMessage,
    llmExchanges: s.llmExchanges
  };
}
```

- [ ] **Step 4: 确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/chat/persistence/auto-persist.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/chat/persistence/auto-persist.ts packages/extension/tests/sidepanel/chat/persistence/auto-persist.test.ts
git commit -m "feat(persist): persist llmExchanges with session data"
```

---

## Task 7: 查看面板 `LlmExchangePanel`

**Files:**
- Create: `packages/extension/src/sidepanel/components/llm-exchange-panel.tsx`
- Create: `packages/extension/tests/sidepanel/components/llm-exchange-panel.test.tsx`

- [ ] **Step 1: 写测试**

`packages/extension/tests/sidepanel/components/llm-exchange-panel.test.tsx`：
```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LlmExchangePanel } from "@/sidepanel/components/llm-exchange-panel";
import type { LlmExchange } from "@aipagego/shared/types";

function ex(round: number, text: string): LlmExchange {
  return {
    id: `e${round}`, round, kind: "main", startedAt: 0, durationMs: 12,
    request: { provider: "anthropic", model: "claude-x", maxTokens: 4096, system: "SYS", messages: [{ role: "user", content: "hello" }], toolNames: ["snapshotDOM"] },
    response: { text, toolUses: [], usage: { input_tokens: 100, output_tokens: 5 }, stopReason: "end_turn" }
  };
}

beforeEach(() => {
  Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
});

describe("LlmExchangePanel", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<LlmExchangePanel open={false} exchanges={[ex(0, "hi")]} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("lists exchanges with model and usage", () => {
    render(<LlmExchangePanel open exchanges={[ex(0, "hi"), ex(1, "yo")]} onClose={() => {}} />);
    expect(screen.getAllByText(/claude-x/).length).toBe(2);
    expect(screen.getByText(/in 100/)).toBeTruthy();
  });

  it("shows request/response detail when an exchange is expanded", () => {
    render(<LlmExchangePanel open exchanges={[ex(0, "the-answer-text")]} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/#0/));
    expect(screen.getByText(/the-answer-text/)).toBeTruthy();
    expect(screen.getByText(/SYS/)).toBeTruthy();
  });

  it("copy writes JSON to clipboard", () => {
    render(<LlmExchangePanel open exchanges={[ex(0, "hi")]} onClose={() => {}} />);
    fireEvent.click(screen.getByText(/#0/));
    fireEvent.click(screen.getByRole("button", { name: /复制本条/ }));
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
  });

  it("close button fires onClose", () => {
    const onClose = vi.fn();
    render(<LlmExchangePanel open exchanges={[]} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /关闭/ }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 确认变红**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/components/llm-exchange-panel.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

`packages/extension/src/sidepanel/components/llm-exchange-panel.tsx`：
```tsx
import { useState } from "react";
import type { ChatMessage, LlmExchange } from "@aipagego/shared/types";

type Props = {
  open: boolean;
  exchanges: LlmExchange[];
  onClose: () => void;
};

export function LlmExchangePanel({ open, exchanges, onClose }: Props) {
  if (!open) return null;

  async function copyOne(ex: LlmExchange) {
    try {
      await navigator.clipboard.writeText(JSON.stringify(ex, null, 2));
    } catch {
      // ignore
    }
  }

  function exportAll() {
    const blob = new Blob([JSON.stringify(exchanges, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llm-exchanges-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="absolute inset-0 z-50 bg-zinc-950 flex flex-col text-xs">
      <div className="flex items-center gap-2 p-2 border-b border-zinc-800">
        <span className="text-zinc-200 font-medium">原始 LLM 交互（{exchanges.length}）</span>
        <button onClick={exportAll} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
          导出全部
        </button>
        <button onClick={onClose} className="ml-auto px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
          关闭
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-2">
        {exchanges.length === 0 && <div className="text-zinc-500">暂无交互记录</div>}
        {exchanges.map((ex) => (
          <ExchangeCard key={ex.id} ex={ex} onCopy={() => copyOne(ex)} />
        ))}
      </div>
    </div>
  );
}

function ExchangeCard({ ex, onCopy }: { ex: LlmExchange; onCopy: () => void }) {
  const [open, setOpen] = useState(false);
  const u = ex.response.usage;
  const bad = ex.response.error || ex.response.aborted;
  return (
    <div className={`rounded border ${bad ? "border-amber-700" : "border-zinc-700"} bg-zinc-900`}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left p-2 flex items-center gap-2 flex-wrap"
      >
        <span>{open ? "▾" : "▸"}</span>
        <span className="font-medium">#{ex.round}</span>
        <span className="text-zinc-400">{ex.request.model}</span>
        <span className="text-zinc-500">{ex.durationMs}ms</span>
        {u && <span className="text-zinc-500">in {u.input_tokens}/out {u.output_tokens}</span>}
        {ex.response.stopReason && <span className="text-zinc-500">{ex.response.stopReason}</span>}
        {ex.response.aborted && <span className="text-amber-400">aborted</span>}
        {ex.response.error && <span className="text-red-400">error</span>}
      </button>
      {open && (
        <div className="p-2 border-t border-zinc-800 space-y-2">
          <button onClick={onCopy} className="px-2 py-0.5 bg-zinc-700 rounded text-[11px]">
            复制本条
          </button>
          <Section title="Request">
            <Field label="system" value={ex.request.system} />
            <div className="text-zinc-500">
              tools: {ex.request.toolNames.join(", ") || "(none)"} · max_tokens: {ex.request.maxTokens ?? "(默认)"}
              {ex.request.endpoint ? ` · endpoint: ${ex.request.endpoint}` : ""}
            </div>
            <MessageList messages={ex.request.messages} />
          </Section>
          <Section title="Response">
            {ex.response.text && <Field label="text" value={ex.response.text} />}
            {ex.response.toolUses.map((t) => (
              <Field key={t.id} label={`tool_use ${t.name}`} value={JSON.stringify(t.input, null, 2)} />
            ))}
            {ex.response.error && <div className="text-red-400">error: {ex.response.error}</div>}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-zinc-300 font-medium">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-zinc-500">{label}</div>
      <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-1 overflow-auto whitespace-pre-wrap max-h-48">
        {value}
      </pre>
    </div>
  );
}

function MessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <div className="space-y-1">
      {messages.map((m, i) => (
        <div key={i}>
          <div className="text-zinc-500">[{m.role}]</div>
          <pre className="text-[10px] text-zinc-300 bg-zinc-950 rounded p-1 overflow-auto whitespace-pre-wrap max-h-48">
            {typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 确认变绿**

Run: `pnpm --filter @aipagego/extension test run tests/sidepanel/components/llm-exchange-panel.test.tsx`
Expected: PASS（5 个用例）。

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/components/llm-exchange-panel.tsx packages/extension/tests/sidepanel/components/llm-exchange-panel.test.tsx
git commit -m "feat(sidepanel): LlmExchangePanel — per-round raw request/response viewer"
```

---

## Task 8: chat-page 接线（包 client + 入口按钮 + 渲染面板）

**Files:**
- Modify: `packages/extension/src/sidepanel/pages/chat-page.tsx`

无新单测（接线层）；靠 typecheck + 既有 chat-page 测试不回归 + Task 9 build 验证 + 手动冒烟。

- [ ] **Step 1: import**

在 `chat-page.tsx` 顶部 import 区加：
```ts
import { createRecordingClient } from "../llm/recording-client";
import { LlmExchangePanel } from "../components/llm-exchange-panel";
```
并在已有的 `from "../chat/session-store"` 那个 import 块里加入 `addLlmExchange`：
```ts
import {
  addLlmExchange,
  attachTab,
  detachTab,
  ensureSession,
  getSessionFor,
  setCurrentTab,
  startNewSession,
  useCurrentTabId,
  useSession,
  useStore
} from "../chat/session-store";
```

- [ ] **Step 2: 面板开关 state**

在组件顶部其它 `useState` 旁加：
```ts
  const [exchangePanelOpen, setExchangePanelOpen] = useState(false);
```

- [ ] **Step 3: 包装 client**

把 `send` 里的：
```ts
      const client = pickClient(settings.provider);
```
改为：
```ts
      const client = createRecordingClient(
        pickClient(settings.provider),
        (ex) => addLlmExchange(tabId, ex),
        { provider: settings.provider }
      );
```
（`tabId` 是 `send` 开头 `const { tabId, url } = await currentTabInfo();` 捕获的，确保切 tab 也写对会话。）

- [ ] **Step 4: 头部加入口按钮**

在头部 `≡ 历史` 按钮之后加：
```tsx
        <button
          onClick={() => setExchangePanelOpen(true)}
          className="px-2 py-0.5 bg-zinc-800 rounded"
        >
          🗎 原始日志
        </button>
```

- [ ] **Step 5: 渲染面板**

在 `<LogsDrawer />` 之后（同级）加：
```tsx
      <LlmExchangePanel
        open={exchangePanelOpen}
        exchanges={session.llmExchanges}
        onClose={() => setExchangePanelOpen(false)}
      />
```
（注意：最外层容器是 `h-full flex flex-col`，面板用 `absolute inset-0`，需父级 `relative`。把最外层 `div` 的 className 从 `"h-full flex flex-col"` 改为 `"h-full flex flex-col relative"`。）

- [ ] **Step 6: typecheck + 既有 chat-page 测试**

```bash
pnpm --filter @aipagego/extension typecheck
pnpm --filter @aipagego/extension test run tests/sidepanel/pages
```
Expected: typecheck 0 error；chat-page 相关测试不回归。

- [ ] **Step 7: Commit**

```bash
git add packages/extension/src/sidepanel/pages/chat-page.tsx
git commit -m "feat(sidepanel): wire recording-client + 原始日志 panel into chat page"
```

---

## Task 9: 全量验证

- [ ] **Step 1: typecheck + test + build**

```bash
pnpm typecheck
pnpm test
pnpm build
```
Expected:
- typecheck：3 包 0 error。
- test：既有全绿 + 本计划新增（truncate 7 + recording-client 6 + session-store 3 + auto-persist 1 + panel 5）≈ +22，全绿。
- build：产出 extension dist。

- [ ] **Step 2: 手动冒烟（可选）**

加载 `packages/extension/dist/` 到 chrome://extensions，跑一次采集任务后点头部「🗎 原始日志」，确认能看到每轮 request（system / 全部 messages / 工具名 / max_tokens）与 response（文本 / tool_use / usage / stopReason），且 **messages 里看不到 apiKey**；测试「复制本条」「导出全部」。

- [ ] **Step 3: 收尾确认**

```bash
git status
git log --oneline -9
```
Expected：工作区干净，8 个功能提交（Task 1–8）。

---

## Self-Review

- ✅ spec「结构化完整捕获」→ Task 4（recording-client 组装 request+response）+ Task 1（stop_reason）
- ✅ spec「持久化 + 体积上限」→ Task 3（截断）+ Task 5（FIFO MAX_EXCHANGES）+ Task 6（落库）
- ✅ spec「专用查看面板（当前+历史、复制、导出）」→ Task 7 + Task 8（历史经 rehydrate 复用，Task 5 已支持）
- ✅ spec「captura 点 = LlmClient 边界包一层」→ Task 4 + Task 8
- ✅ spec「脱敏 apiKey」→ Task 4 实现 + 测试（JSON 不含 SECRET）
- ✅ spec「run-session 零改动」→ 计划未触 run-session.ts
- ✅ spec「向后兼容、无 DB 迁移」→ Task 5 rehydrate `?? []`
- ✅ 类型/命名一致：`LlmExchange` / `LlmExchangeRequest` / `LlmExchangeResponse` / `createRecordingClient` / `RecordingOptions` / `addLlmExchange` / `MAX_EXCHANGES` / `truncateContent` / `truncateMessages` / `LlmExchangePanel` 全程一致
- ✅ 无 TBD/占位；每个代码步给出完整代码与命令
- ✅ 既有 stream 测试因 stop_reason 会破 → Task 1 已显式更新
