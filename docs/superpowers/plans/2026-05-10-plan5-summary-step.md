# Plan 5: 「让 AI 生成汇总 step」 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保存为工具对话框里加一个「让 AI 生成汇总步骤」按钮——一次性非流式 LLM 调用基于对话历史与已执行 steps，产出一段 runJS 源码作为最后一步 append 到工具，使重放产物结构与对话期间 AI 的总结报告一致。

**Architecture:** 新增 `summary-step.ts` 纯函数模块（buildUserPrompt + extractSource + generateSummaryStep），不依赖 chat-session / store / Approver，复用现有 LlmClient 流式接口但内部消费完毕。SaveAsToolDialog 加 `SummaryState` 状态机（idle / generating / ready / error），UI 渲染源码预览 + 静态扫描；接受后 step append 到 dialog 内本地拷贝；保存时一并 rpc.saveTool。

**Tech Stack:** 复用 Plan 1-4 的 Vite + React + TS + zustand + zod + LlmClient；无新增依赖。

---

## 文件结构（Plan 5 增量）

```
src/sidepanel/
├─ llm/
│  └─ summary-step.ts                 # NEW: extractSource + buildUserPrompt + generateSummaryStep
├─ components/
│  └─ save-as-tool-dialog.tsx         # MOD: 加 SummaryState UI + props
└─ pages/
   └─ chat-page.tsx                   # MOD: SaveAsToolDialog 多传 messages / llmSettings

tests/sidepanel/llm/
└─ summary-step.test.ts               # NEW: extractSource + generateSummaryStep 行为
```

每个文件单一职责。`summary-step.ts` 纯函数 + 一次 LLM call，可单测；UI 与状态在 `save-as-tool-dialog.tsx`，调用 summary-step 并管 SummaryState。

---

## Task 1: summary-step.ts 模块骨架（types + extractSource + buildUserPrompt）

**Files:**
- Create: `src/sidepanel/llm/summary-step.ts`
- Create: `tests/sidepanel/llm/summary-step.test.ts`

- [ ] **Step 1: 写 extractSource + buildUserPrompt 单测**

```ts
// tests/sidepanel/llm/summary-step.test.ts
import { describe, expect, it } from "vitest";
import {
  buildUserPrompt,
  extractSource
} from "@/sidepanel/llm/summary-step";
import type { ChatMessage, Step } from "@/shared/types";

describe("extractSource", () => {
  it("returns trimmed source as-is when no fence", () => {
    const raw = "  const x = 1;\nreturn x;  ";
    expect(extractSource(raw)).toBe("const x = 1;\nreturn x;");
  });

  it("strips ```js fence", () => {
    const raw = "```js\nreturn { a: 1 };\n```";
    expect(extractSource(raw)).toBe("return { a: 1 };");
  });

  it("strips ```javascript fence", () => {
    const raw = "```javascript\nconst x = 1;\nreturn x;\n```";
    expect(extractSource(raw)).toBe("const x = 1;\nreturn x;");
  });

  it("extracts code block from explanation + fence", () => {
    const raw =
      "Here is the summary code:\n\n```js\nconst init = window.rawData;\nreturn init;\n```\n\nThis returns the data.";
    expect(extractSource(raw)).toBe("const init = window.rawData;\nreturn init;");
  });

  it("throws when source has no return", () => {
    expect(() => extractSource("```js\nconst x = 1;\nconsole.log(x);\n```")).toThrow(
      /no `return` statement/i
    );
  });

  it("throws when source is empty", () => {
    expect(() => extractSource("   ")).toThrow(/empty source/i);
    expect(() => extractSource("```js\n\n```")).toThrow(/empty source/i);
  });

  it("throws when source > 32KB", () => {
    const huge = "```js\n" + "a".repeat(33000) + "\nreturn 1;\n```";
    expect(() => extractSource(huge)).toThrow(/too large/i);
  });
});

describe("buildUserPrompt", () => {
  const baseInput = {
    messages: [] as ChatMessage[],
    executedSteps: [] as Step[],
    lastOutput: null
  };

  it("includes step list with tool args truncated", () => {
    const steps: Step[] = [
      { kind: "tool", tool: "snapshotDOM", args: { maxDepth: 3 } },
      { kind: "js", source: "return location.href;" }
    ];
    const prompt = buildUserPrompt({ ...baseInput, executedSteps: steps });
    expect(prompt).toContain("[step 0] tool: snapshotDOM");
    expect(prompt).toContain('"maxDepth":3');
    expect(prompt).toContain("[step 1] js: return location.href;");
  });

  it("truncates long js source with ellipsis marker", () => {
    const longSrc = "x;".repeat(200);
    const steps: Step[] = [{ kind: "js", source: longSrc }];
    const prompt = buildUserPrompt({ ...baseInput, executedSteps: steps });
    expect(prompt).toContain("…");
  });

  it("includes lastOutput truncated to 1500 chars", () => {
    const big = { items: Array(200).fill({ a: 1, b: "very long text here" }) };
    const prompt = buildUserPrompt({ ...baseInput, lastOutput: big });
    const lastOutputSection = prompt.split("# 最末步 output")[1] ?? "";
    // 该段含截断的 JSON
    expect(lastOutputSection.length).toBeLessThan(2200);
  });

  it("includes last assistant text when present", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "总结此页" },
      {
        role: "assistant",
        content: [{ type: "text", text: "## 商品标题\n加粗长椅...\n## 评论分析\n..." }]
      }
    ];
    const prompt = buildUserPrompt({ ...baseInput, messages });
    expect(prompt).toContain("# 对话最后一段 assistant 总结报告");
    expect(prompt).toContain("商品标题");
  });

  it("omits assistant section when last assistant has no text", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "snapshotDOM", input: {} }]
      }
    ];
    const prompt = buildUserPrompt({ ...baseInput, messages });
    expect(prompt).not.toContain("# 对话最后一段 assistant 总结报告");
  });
});
```

- [ ] **Step 2: 跑测试，确认失败**

Run: `pnpm test tests/sidepanel/llm/summary-step.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现纯函数部分**

```ts
// src/sidepanel/llm/summary-step.ts
import type { ChatMessage, Json, LlmSettings, Step } from "@/shared/types";
import type { LlmClient } from "./types";

export const SUMMARY_SYSTEM_PROMPT = [
  "你是 AIPageGo 的「汇总 step 生成器」。",
  "",
  "任务：基于刚刚一段成功的对话与已执行的 step 序列，写一段 runJS 代码作为",
  "该工具的「汇总最后一步」。重放该工具时，这段代码会作为最后 step 在",
  "MAIN world 跑，它的 return 值就是工具的最终 output。",
  "",
  "要求：",
  "1. 读取页面上下文（window.rawData / DOM / 之前 step 已采到的数据",
  "   通过 ctx[bindResultTo] 取——但只有有 bindResultTo 的步骤才在 ctx",
  "   里）。如果 ctx 为空，从页面 DOM/全局变量重新拉一次最关键字段。",
  "2. 不要重新发请求做大量数据抓取——只做整合。如果重放时数据不在",
  "   window.rawData，应回退到从 ctx 取。",
  "3. return 一个稳定结构的 JSON 对象，字段名见用户对话里 AI 给过的总结",
  "   报告。结构不存在则你自己设计简洁字段。",
  "4. 仅返回纯 JS 函数体（不带 ```js fence）。形如：",
  "     const init = window.rawData?.store?.initDataObj;",
  "     return { title: ..., main_image: ..., reviews: ... };",
  "5. 不调用 fetch / cookie / eval / 扩展 API。仅整合数据。"
].join("\n");

export type GenerateSummaryStepInput = {
  client: LlmClient;
  apiKey: string;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
  abortSignal?: AbortSignal;
  onTokenProgress?: (tokens: number) => void;
};

export type GenerateSummaryStepResult = {
  source: string;
  tokens: number;
};

const MAX_SOURCE_BYTES = 32 * 1024;

export function buildUserPrompt(input: {
  messages: ChatMessage[];
  executedSteps: Step[];
  lastOutput: Json;
}): string {
  const lines: string[] = [];

  lines.push("# 已执行的 step 序列与最近一次 outputs（节选）");
  for (let i = 0; i < input.executedSteps.length; i++) {
    const s = input.executedSteps[i];
    if (s.kind === "tool") {
      lines.push(
        `[step ${i}] tool: ${s.tool} args: ${JSON.stringify(s.args).slice(0, 300)}`
      );
    } else {
      const flat = s.source.replace(/\s+/g, " ").trim();
      const head = flat.slice(0, 200);
      lines.push(`[step ${i}] js: ${head}${flat.length > 200 ? "…" : ""}`);
    }
  }
  lines.push("");
  lines.push("# 最末步 output（截断）");
  lines.push(JSON.stringify(input.lastOutput).slice(0, 1500));
  lines.push("");

  const lastAssistant = [...input.messages]
    .reverse()
    .find((m) => m.role === "assistant");
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const text = lastAssistant.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 2000);
    if (text.trim()) {
      lines.push("# 对话最后一段 assistant 总结报告");
      lines.push(text);
      lines.push("");
    }
  }

  lines.push("# 请生成汇总 step 的 runJS 源码（仅函数体，不带围栏）：");
  return lines.join("\n");
}

export function extractSource(raw: string): string {
  let s = raw.trim();

  const fence = s.match(/```(?:js|javascript|ts|typescript)?\s*\n?([\s\S]*?)\n?```/);
  if (fence) s = fence[1].trim();

  if (s.length === 0) throw new Error("AI returned empty source");
  if (s.length > MAX_SOURCE_BYTES) {
    throw new Error(`AI source too large (${s.length} > ${MAX_SOURCE_BYTES})`);
  }
  if (!/\breturn\b/.test(s)) {
    throw new Error("AI source has no `return` statement");
  }
  return s;
}

export async function generateSummaryStep(
  input: GenerateSummaryStepInput
): Promise<GenerateSummaryStepResult> {
  const userPrompt = buildUserPrompt({
    messages: input.messages,
    executedSteps: input.executedSteps,
    lastOutput: input.lastOutput
  });

  const stream = input.client.stream({
    apiKey: input.apiKey,
    model: input.model,
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools: [],
    maxTokens: input.maxTokens,
    endpoint: input.endpoint,
    abortSignal: input.abortSignal
  });

  let textBuf = "";
  let tokens = 0;

  for await (const ev of stream) {
    if (input.abortSignal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    if (ev.type === "text_delta") {
      textBuf += ev.text;
    } else if (ev.type === "message_end") {
      if (ev.usage) {
        tokens = ev.usage.input_tokens + ev.usage.output_tokens;
        input.onTokenProgress?.(tokens);
      }
    } else if (ev.type === "error") {
      throw new Error(ev.error);
    }
  }

  return { source: extractSource(textBuf), tokens };
}

// silence unused-import warning in case downstream needs LlmSettings; re-exported for callers
export type { LlmSettings };
```

注意：`SUMMARY_SYSTEM_PROMPT` 的字符串里含 `"汇总最后一步"` 这种带英文双引号的中文段，TypeScript 字符串里用了正常 ASCII 双引号 `"…"`，没问题。

- [ ] **Step 4: 跑测试，确认全过**

Run: `pnpm test tests/sidepanel/llm/summary-step.test.ts`
Expected: 13 个 test PASS（extractSource 7 + buildUserPrompt 5 + 别的 = 13；以实际运行结果为准）。

- [ ] **Step 5: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 6: Commit**

```bash
git add src/sidepanel/llm/summary-step.ts tests/sidepanel/llm/summary-step.test.ts
git commit -m "feat(llm): add summary-step generator (extractSource + buildUserPrompt + generateSummaryStep)"
```

---

## Task 2: generateSummaryStep 的 mock client 行为单测

**Files:**
- Modify: `tests/sidepanel/llm/summary-step.test.ts`

- [ ] **Step 1: 在测试文件末尾追加 generateSummaryStep 单测**

```ts
// 在 tests/sidepanel/llm/summary-step.test.ts 末尾追加

import { vi } from "vitest";
import { generateSummaryStep } from "@/sidepanel/llm/summary-step";
import type { LlmClient, LlmStreamEvent } from "@/sidepanel/llm/types";

function streamFrom(events: LlmStreamEvent[]): AsyncIterable<LlmStreamEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function makeClient(events: LlmStreamEvent[]): LlmClient {
  return {
    stream: vi.fn(() => streamFrom(events))
  };
}

describe("generateSummaryStep", () => {
  const baseArgs = {
    apiKey: "k",
    model: "m",
    messages: [] as ChatMessage[],
    executedSteps: [] as Step[],
    lastOutput: null as Json
  };

  it("returns extracted source on text_delta + message_end", async () => {
    const client = makeClient([
      { type: "text_delta", text: "```js\nreturn { ok: " },
      { type: "text_delta", text: "true };\n```" },
      { type: "message_end", usage: { input_tokens: 50, output_tokens: 10 } }
    ]);
    const result = await generateSummaryStep({ ...baseArgs, client });
    expect(result.source).toBe("return { ok: true };");
    expect(result.tokens).toBe(60);
  });

  it("calls onTokenProgress at message_end", async () => {
    const client = makeClient([
      { type: "text_delta", text: "return 1;" },
      { type: "message_end", usage: { input_tokens: 5, output_tokens: 2 } }
    ]);
    const onTokenProgress = vi.fn();
    await generateSummaryStep({ ...baseArgs, client, onTokenProgress });
    expect(onTokenProgress).toHaveBeenCalledWith(7);
  });

  it("throws when stream emits error event", async () => {
    const client = makeClient([
      { type: "error", error: "Anthropic 401: bad key" }
    ]);
    await expect(generateSummaryStep({ ...baseArgs, client })).rejects.toThrow(/401/);
  });

  it("throws when source extraction fails (no return)", async () => {
    const client = makeClient([
      { type: "text_delta", text: "```js\nconst x = 1;\n```" },
      { type: "message_end" }
    ]);
    await expect(generateSummaryStep({ ...baseArgs, client })).rejects.toThrow(/no `return`/i);
  });

  it("throws AbortError when signal aborted mid-stream", async () => {
    const ac = new AbortController();
    ac.abort();
    const client = makeClient([
      { type: "text_delta", text: "return 1;" },
      { type: "message_end" }
    ]);
    await expect(
      generateSummaryStep({ ...baseArgs, client, abortSignal: ac.signal })
    ).rejects.toThrow();
  });

  it("passes endpoint / maxTokens through to client.stream", async () => {
    const events: LlmStreamEvent[] = [
      { type: "text_delta", text: "return 1;" },
      { type: "message_end" }
    ];
    const stream = vi.fn(() => streamFrom(events));
    const client: LlmClient = { stream };
    await generateSummaryStep({
      ...baseArgs,
      client,
      endpoint: "https://my-proxy/v1",
      maxTokens: 8192
    });
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://my-proxy/v1",
        maxTokens: 8192
      })
    );
  });
});
```

注：在文件顶部 import 区如已有 `Json` / `ChatMessage` / `Step` 则不要重复 import；如没有，加上。

- [ ] **Step 2: 跑测试**

Run: `pnpm test tests/sidepanel/llm/summary-step.test.ts`
Expected: 之前 13 + 新增 6 = 19 PASS（实际计数以输出为准）。

- [ ] **Step 3: Commit**

```bash
git add tests/sidepanel/llm/summary-step.test.ts
git commit -m "test(summary-step): cover generateSummaryStep stream consumption + abort"
```

---

## Task 3: SaveAsToolDialog props 扩展

**Files:**
- Modify: `src/sidepanel/components/save-as-tool-dialog.tsx`

加 `messages` 与 `llmSettings` props。先扩 props 类型并接住，UI 暂不动；下个 task 接 UI。

- [ ] **Step 1: 修改 Props 类型 + 函数签名**

打开 `src/sidepanel/components/save-as-tool-dialog.tsx`，把现有 `Props` 类型与函数声明替换：

```tsx
import { useState } from "react";
import { inferJsonSchema } from "@/shared/infer-json-schema";
import type { ChatMessage, Json, LlmSettings, Step } from "@/shared/types";
import { rpc } from "../rpc";

type Props = {
  initialName: string;
  initialDescription: string;
  initialUrl: string;
  steps: Step[];
  lastOutput: Json;
  // Plan 5 additions
  messages: ChatMessage[];
  llmSettings: LlmSettings;
  onClose: () => void;
  onSaved: (toolId: string) => void;
};
```

- [ ] **Step 2: dialog 函数签名加入新 props 解构（暂不使用）**

把 `export function SaveAsToolDialog(props: Props) {` 内首行 destructure 改为接收所有 props，避免未使用警告：

```tsx
export function SaveAsToolDialog(props: Props) {
  const [name, setName] = useState(props.initialName || "新工具");
  const [description, setDescription] = useState(props.initialDescription || "");
  const [patternsText, setPatternsText] = useState(defaultPattern(props.initialUrl));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // localSteps allows appending the AI-generated summary step
  const [localSteps, setLocalSteps] = useState<Step[]>(props.steps);
  // Reference messages / llmSettings to silence noUnusedParameters; real use in next task
  void props.messages;
  void props.llmSettings;
  ...
```

注意：之前 save() 用 `props.steps`，现在改为 `localSteps`：

```tsx
  async function save() {
    setErr(null);
    setBusy(true);
    try {
      const urlPatterns = patternsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      if (urlPatterns.length === 0) throw new Error("至少填一个 URL 模式");
      if (localSteps.length === 0) throw new Error("没有可保存的成功 step");
      const tool = await rpc.saveTool({
        name,
        urlPatterns,
        description,
        steps: localSteps,
        outputSchema: inferJsonSchema(props.lastOutput)
      });
      props.onSaved(tool.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
```

并修改"将保存 N 个成功执行的 step"那段文案的 N：

```tsx
        <p className="text-zinc-500">将保存 {localSteps.length} 个成功执行的 step。</p>
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: 报错——chat-page.tsx 的 `<SaveAsToolDialog>` 没传 `messages` / `llmSettings`。下个 task 修。

为了让 typecheck 在中间阶段绿，临时把这两个 prop 改成可选：

```ts
  messages?: ChatMessage[];
  llmSettings?: LlmSettings;
```

并把 `void props.messages` 同步改为 `void props.messages; void props.llmSettings;`（已是）。

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 4: Commit**

```bash
git add src/sidepanel/components/save-as-tool-dialog.tsx
git commit -m "refactor(save-dialog): introduce localSteps + accept messages/llmSettings (transitional)"
```

---

## Task 4: chat-page.tsx 调用处补 props

**Files:**
- Modify: `src/sidepanel/pages/chat-page.tsx`

- [ ] **Step 1: 找到 SaveAsToolDialog 调用并补两个 prop**

定位到（约文件 340 行附近）：

```tsx
      {session.showSaveDialog && (
        <SaveAsToolDialog
          initialName={ ... }
          initialDescription={ ... }
          initialUrl={session.url}
          steps={session.executedSteps}
          lastOutput={session.lastOutput}
          onClose={() => session.hideSave()}
          onSaved={() => {
            session.hideSave();
          }}
        />
      )}
```

在 `lastOutput={...}` 后加两行：

```tsx
          messages={session.messages}
          llmSettings={settings}
```

完整片段：

```tsx
      {session.showSaveDialog && (
        <SaveAsToolDialog
          initialName={
            recommendations[0]?.name ?? `AIPageGo 任务 ${new Date().toISOString().slice(0, 10)}`
          }
          initialDescription={
            (session.messages.find(
              (m): m is Extract<typeof m, { role: "user" }> & { content: string } =>
                m.role === "user" && typeof m.content === "string"
            )?.content ?? "")
              .replace(/^\[已恢复\][^\n]*\n?/, "")
              .replace(/^\[页面跳转\][^\n]*\n?/, "")
              .slice(0, 80)
          }
          initialUrl={session.url}
          steps={session.executedSteps}
          lastOutput={session.lastOutput}
          messages={session.messages}
          llmSettings={settings}
          onClose={() => session.hideSave()}
          onSaved={() => {
            session.hideSave();
          }}
        />
      )}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 3: Commit**

```bash
git add src/sidepanel/pages/chat-page.tsx
git commit -m "feat(chat-page): pass messages + llmSettings into save-as-tool dialog"
```

---

## Task 5: SummaryState 状态机 + UI panel

**Files:**
- Modify: `src/sidepanel/components/save-as-tool-dialog.tsx`

把 props 改回必填，加 SummaryState + UI panel。

- [ ] **Step 1: 必填化 props**

把：

```ts
  messages?: ChatMessage[];
  llmSettings?: LlmSettings;
```

改回：

```ts
  messages: ChatMessage[];
  llmSettings: LlmSettings;
```

并删除 `void props.messages; void props.llmSettings;` 这两行（即将在 UI 中真实使用）。

- [ ] **Step 2: 加 imports**

文件顶部 import 区追加：

```ts
import { highestSeverity, runStaticScan } from "@/shared/static-scan";
import type { ScanFinding } from "@/shared/types";
import { pickClient } from "../llm/client";
import { generateSummaryStep } from "../llm/summary-step";
```

- [ ] **Step 3: 加 SummaryState 类型与 state**

在 `SaveAsToolDialog` 函数体顶部，`const [localSteps, ...]` 之后追加：

```tsx
  type SummaryState =
    | { phase: "idle" }
    | { phase: "generating"; abort: AbortController }
    | {
        phase: "ready";
        source: string;
        findings: ScanFinding[];
        severity: "info" | "caution" | "dangerous";
      }
    | { phase: "error"; error: string };

  const [summary, setSummary] = useState<SummaryState>({ phase: "idle" });
```

- [ ] **Step 4: 加生成 / 接受 / 取消逻辑**

在 `save()` 函数前追加：

```tsx
  async function generateSummary() {
    if (!props.llmSettings.apiKey) {
      setSummary({ phase: "error", error: "请先在设置页填入 API Key" });
      return;
    }
    if (localSteps.length === 0) {
      setSummary({ phase: "error", error: "需要先有成功的 step" });
      return;
    }
    const ac = new AbortController();
    setSummary({ phase: "generating", abort: ac });
    try {
      const client = pickClient(props.llmSettings.provider);
      const result = await generateSummaryStep({
        client,
        apiKey: props.llmSettings.apiKey,
        model: props.llmSettings.model,
        endpoint: props.llmSettings.endpoint,
        maxTokens: props.llmSettings.maxTokens,
        messages: props.messages,
        executedSteps: localSteps,
        lastOutput: props.lastOutput,
        abortSignal: ac.signal
      });
      const findings = runStaticScan(result.source);
      const sev = highestSeverity(findings);
      setSummary({
        phase: "ready",
        source: result.source,
        findings,
        severity: sev
      });
    } catch (e) {
      if ((e as { name?: string })?.name === "AbortError") {
        setSummary({ phase: "idle" });
        return;
      }
      setSummary({
        phase: "error",
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }

  function acceptSummary() {
    if (summary.phase !== "ready") return;
    const summaryStep: Step = { kind: "js", source: summary.source };
    setLocalSteps((prev) => [...prev, summaryStep]);
    setSummary({ phase: "idle" });
  }

  function cancelGeneration() {
    if (summary.phase === "generating") {
      summary.abort.abort();
      setSummary({ phase: "idle" });
    }
  }
```

- [ ] **Step 5: 在 dialog modal body 中插入 UI panel**

找到 `<p className="text-zinc-500">将保存 {localSteps.length} 个成功执行的 step。</p>` 这行；在它**之前**插入：

```tsx
        <SummaryStepPanel
          state={summary}
          onGenerate={generateSummary}
          onCancel={cancelGeneration}
          onAccept={acceptSummary}
          onReset={() => setSummary({ phase: "idle" })}
          hasApiKey={!!props.llmSettings.apiKey}
          stepsCount={localSteps.length}
        />
```

- [ ] **Step 6: 在文件末尾（`SaveAsToolDialog` 函数之外）追加 SummaryStepPanel 组件**

```tsx
function SummaryStepPanel(props: {
  state:
    | { phase: "idle" }
    | { phase: "generating"; abort: AbortController }
    | {
        phase: "ready";
        source: string;
        findings: ScanFinding[];
        severity: "info" | "caution" | "dangerous";
      }
    | { phase: "error"; error: string };
  onGenerate: () => void;
  onCancel: () => void;
  onAccept: () => void;
  onReset: () => void;
  hasApiKey: boolean;
  stepsCount: number;
}) {
  const { state } = props;
  return (
    <section className="bg-zinc-950 border border-zinc-800 rounded p-2 flex flex-col gap-1">
      <div className="text-zinc-300">汇总 step</div>
      <div className="text-zinc-500 text-[11px]">
        ⚠ 重放时输出 = 最后一步 step 的 return 值。AI 写过的 markdown 报告
        不是 step，重放无法复现。让 AI 生成一段 runJS 整合数据为稳定 JSON。
      </div>

      {state.phase === "idle" && (
        <button
          onClick={props.onGenerate}
          disabled={!props.hasApiKey || props.stepsCount === 0}
          className="self-start px-2 py-0.5 bg-emerald-700 rounded disabled:opacity-50"
          title={
            !props.hasApiKey
              ? "请先在设置页填入 API Key"
              : props.stepsCount === 0
              ? "需要先有成功的 step"
              : ""
          }
        >
          让 AI 生成汇总步骤
        </button>
      )}

      {state.phase === "generating" && (
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-zinc-300">AI 生成中…</span>
          <button
            onClick={props.onCancel}
            className="ml-auto px-2 py-0.5 bg-zinc-700 rounded"
          >
            取消生成
          </button>
        </div>
      )}

      {state.phase === "ready" && (
        <>
          <div className="text-zinc-300 flex items-center gap-2">
            <span>✓ AI 已生成</span>
            {state.findings.length > 0 && (
              <span
                className={
                  "text-[10px] px-1 py-0.5 rounded " +
                  (state.severity === "dangerous"
                    ? "bg-red-700 text-red-100"
                    : state.severity === "caution"
                    ? "bg-amber-700 text-amber-100"
                    : "bg-zinc-700")
                }
              >
                {state.severity}: {state.findings.map((f) => f.rule).join(", ")}
              </span>
            )}
          </div>
          <details className="bg-zinc-900 rounded p-1">
            <summary className="cursor-pointer text-zinc-300 text-[11px]">源码</summary>
            <pre className="text-[10px] text-zinc-300 mt-1 overflow-auto max-h-48 whitespace-pre-wrap">
              {state.source}
            </pre>
          </details>
          <div className="flex gap-2">
            <button
              onClick={props.onAccept}
              className={
                "px-2 py-0.5 rounded text-zinc-100 " +
                (state.severity === "dangerous" ? "bg-red-700" : "bg-emerald-700")
              }
            >
              {state.severity === "dangerous" ? "⚠ 接受（含 dangerous）" : "接受 → 添加为最后一步"}
            </button>
            <button
              onClick={props.onGenerate}
              className="px-2 py-0.5 bg-zinc-700 rounded"
            >
              重新生成
            </button>
            <button
              onClick={props.onReset}
              className="px-2 py-0.5 bg-zinc-700 rounded"
            >
              取消
            </button>
          </div>
        </>
      )}

      {state.phase === "error" && (
        <>
          <div className="text-red-400 text-[11px] whitespace-pre-wrap break-words">
            {state.error}
          </div>
          <div className="flex gap-2">
            <button
              onClick={props.onGenerate}
              className="px-2 py-0.5 bg-emerald-700 rounded"
            >
              重试
            </button>
            <button
              onClick={props.onReset}
              className="px-2 py-0.5 bg-zinc-700 rounded"
            >
              取消
            </button>
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 7: 类型检查 + 构建**

Run: `pnpm typecheck && pnpm build`
Expected: 退出码 0。

- [ ] **Step 8: Commit**

```bash
git add src/sidepanel/components/save-as-tool-dialog.tsx
git commit -m "feat(save-dialog): SummaryStepPanel with idle/generating/ready/error state"
```

---

## Task 6: 全量回归

**Files:** 无

- [ ] **Step 1: 类型检查**

Run: `pnpm typecheck`
Expected: 退出码 0。

- [ ] **Step 2: 全量单元测试**

Run: `pnpm test`
Expected: 所有 test PASS。预期数：

- 既有 150 个
- 新增 summary-step.test.ts：~19（extractSource 7 + buildUserPrompt 5 + generateSummaryStep 6 = 18，实际计数以 vitest 报告为准；微差不影响）
- 合计 **~168 tests**

- [ ] **Step 3: 构建**

Run: `pnpm build`
Expected: 退出码 0。

- [ ] **Step 4: 手测验证**

1. 装载 `dist/`，打开任意支持的页面（如 商品详情页）
2. 「对话」页发"采集主图与标题，并给我汇总报告"
3. AI 跑完后顶部出现「保存为工具」按钮，点击
4. 在保存对话框看到「汇总 step」section：
   - [让 AI 生成汇总步骤] 按钮可点（已填 API Key 且有 step）
5. 点击该按钮：
   - 状态变 `AI 生成中…`，几秒后变 `✓ AI 已生成`
   - 展开"源码"看 runJS code
6. 点 [接受 → 添加为最后一步]：
   - 步骤数从 N 变 N+1
7. 点 [保存]：保存到工具库
8. 「工具库」→ 该工具 → [运行]：
   - 重放完成后 ResultView 输出**结构化 JSON**（与对话期间 AI 报告字段一致）
   - 与 Plan 5 之前那种"评论字符串单值"对比，结构对了

如有失败，记录控制台报错并修复。

- [ ] **Step 5: 收尾 commit（如手测发现 bug 修补）**

```bash
# 通常无新文件
echo "Plan 5 complete"
```

---

## 自检清单

- [ ] 全量单元测试通过（约 168 个）
- [ ] 类型检查通过
- [ ] dist 装载后，保存对话框含「汇总 step」section
- [ ] [让 AI 生成汇总步骤] 在没填 API Key 时 disabled + tooltip
- [ ] 生成完成后展示源码 + 静态扫描标签 + 接受/重生/取消
- [ ] 接受后 step 数 +1，保存后工具运行产物为结构化 JSON
- [ ] 既有 150+ tests 仍通过（无回归）
