# Plan 5: 「让 AI 生成汇总 step」 — 设计文档

- 日期：2026-05-10
- 状态：草案，待评审
- 范围：在保存为工具对话框里加一个"让 AI 生成汇总步骤"按钮，调一次非流式 LLM 生成 runJS 源码，展示给用户预览（含静态扫描），用户接受后 append 为最后一步，使工具重放时输出与对话期间 AI 总结结构一致
- 前置：Plan 1-4 已落地

## 1. 目标与定位

当前痛点：用户在对话里看到 AI 给的结构化报告（如 `{title, main_image, detail_images, reviews}`），但保存为工具后，重放时输出只有最后一步 step 的 raw return（评论拼接字符串），与对话产出格式不一致。

根因：AI 在对话里写的"分析报告"是 markdown/text，不是 step；保存对话产物为工具时只收成功执行过的 tool_use（`executedSteps`），不包含 AI 自由生成的总结文本。重放时无法复现报告。

本计划目标：让 AI 主动**写一段** runJS 代码作为最后一步，重放时执行它产出与对话报告同结构的 JSON。

非目标：
- 在工具详情页给已保存工具追加汇总 step（仅保存对话框）
- 干跑验证生成的 step（仅静态扫描预览）
- 让用户填"期望输出 schema"（AI 自主决定）
- 多次会话累积运行历史 UI（独立 plan）

## 2. 关键决策回顾

| 决策点 | 选择 |
|---|---|
| 触发位置 | 保存对话框内 |
| 插入方式 | append 到 executedSteps 末尾，不动原 step |
| 输出结构 | AI 自主决定，看对话报告与 outputs 反推 |
| 验证方式 | 仅预览源码 + 静态扫描；用户接受 / 重生 / 取消 |

## 3. UX 流程

保存对话框 layout 加一段：

```
保存为工具

名称       [shop 竞品信息采集____________]
URL 模式   [https://*.example.com/**__]
描述       [帮我提取当前商品页的标题..]
步骤       9 个 (展开)

┌─ 汇总 step ──────────────────────────────────┐
│ ⚠ 重放时输出 = 最后一步 step 的 return 值。 │
│   通常 AI 写过的"分析报告"是 markdown 不是    │
│   step，重放无法复现。                        │
│                                              │
│ [让 AI 生成汇总步骤] (尚未生成)               │
└──────────────────────────────────────────────┘

[取消] [保存]
```

点击「让 AI 生成汇总步骤」 → 状态机切到 generating：

```
┌─ 汇总 step ──────────────────────────────────┐
│ ◉ AI 生成中... 67 tokens   [取消生成]         │
└──────────────────────────────────────────────┘
```

完成后 → ready：

```
┌─ 汇总 step ──────────────────────────────────┐
│ ✓ AI 已生成（caution: uses-fetch）            │
│                                              │
│ ▾ 源码                                        │
│  const init=window.rawData.store.initDataObj; │
│  const goods=init.goods;                      │
│  return { title: goods.goodsName,             │
│           main_image: goods.thumbUrl,         │
│           detail_images: ...,                 │
│           reviews_text: ctx.lastReviewsText };│
│                                              │
│ [接受 → 添加为最后一步] [重新生成] [取消]     │
└──────────────────────────────────────────────┘
```

接受 → append 到 localSteps，UI 显示「步骤数 10 个」，[保存] 按钮按现有流程持久化。

## 4. LLM 调用细节

新文件 `src/sidepanel/llm/summary-step.ts`，纯函数 + 一次性 LLM call，不进 chat session、不写 RunRecord。

### 4.1 接口

```typescript
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
};

export async function generateSummaryStep(
  input: GenerateSummaryStepInput
): Promise<GenerateSummaryStepResult>;
```

### 4.2 system prompt（专用）

```
你是 AIPageGo 的「汇总 step 生成器」。

任务：基于刚刚一段成功的对话与已执行的 step 序列，写一段 runJS 代码作为
该工具的"汇总最后一步"。重放该工具时，这段代码会作为最后 step 在
MAIN world 跑，它的 return 值就是工具的最终 output。

要求：
1. 读取页面上下文（window.rawData / DOM / 之前 step 已采到的数据
   通过 ctx[bindResultTo] 取——但只有有 bindResultTo 的步骤才在 ctx
   里）。如果 ctx 为空，从页面 DOM/全局变量重新拉一次最关键字段。
2. 不要重新发请求做大量数据抓取——只做整合。如果重放时数据不在
   window.rawData，应回退到从 ctx 取。
3. return 一个稳定结构的 JSON 对象，字段名见用户对话里 AI 给过的总结
   报告。结构不存在则你自己设计简洁字段。
4. 仅返回纯 JS 函数体（不带 ```js fence）。形如：
     const init = window.rawData?.store?.initDataObj;
     return { title: ..., main_image: ..., reviews: ... };
5. 不调用 fetch / cookie / eval / 扩展 API。仅整合数据。
```

### 4.3 user prompt 构造

```typescript
function buildUserPrompt(input: GenerateSummaryStepInput): string {
  const lines: string[] = [];

  // 已执行的 step + outputs（截断）
  lines.push("# 已执行的 step 序列与最近一次 outputs（节选）");
  for (let i = 0; i < input.executedSteps.length; i++) {
    const s = input.executedSteps[i];
    if (s.kind === "tool") {
      lines.push(`[step ${i}] tool: ${s.tool} args: ${JSON.stringify(s.args).slice(0, 300)}`);
    } else {
      const src = s.source.replace(/\s+/g, " ").slice(0, 200);
      lines.push(`[step ${i}] js: ${src}${s.source.length > 200 ? "…" : ""}`);
    }
  }
  lines.push("");
  lines.push("# 最末步 output（截断）");
  lines.push(JSON.stringify(input.lastOutput).slice(0, 1500));
  lines.push("");

  // 对话最后一段 assistant text
  const lastAssistant = [...input.messages].reverse().find(
    (m) => m.role === "assistant"
  );
  if (lastAssistant && Array.isArray(lastAssistant.content)) {
    const text = lastAssistant.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .slice(0, 2000);
    if (text) {
      lines.push("# 对话最后一段 assistant 总结报告");
      lines.push(text);
      lines.push("");
    }
  }

  lines.push("# 请生成汇总 step 的 runJS 源码（仅函数体，不带围栏）：");
  return lines.join("\n");
}
```

### 4.4 输出解析

LLM 返回纯文本。处理：

```typescript
function extractSource(raw: string): string {
  let s = raw.trim();

  // 剥 ```js / ```javascript / ``` 围栏
  const fenceMatch = s.match(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)\n```/);
  if (fenceMatch) s = fenceMatch[1].trim();

  if (!s) throw new Error("AI returned empty source");
  if (s.length > 32 * 1024) throw new Error("AI source too large");
  if (!/\breturn\b/.test(s)) {
    throw new Error("AI source has no `return` statement");
  }
  return s;
}
```

### 4.5 token 进度

消费 `LlmClient.stream()` 流：

```typescript
let tokens = 0;
let textBuf = "";
for await (const ev of stream) {
  if (input.abortSignal?.aborted) throw new DOMException("aborted", "AbortError");
  if (ev.type === "text_delta") {
    textBuf += ev.text;
  } else if (ev.type === "message_end" && ev.usage) {
    tokens = ev.usage.input_tokens + ev.usage.output_tokens;
    input.onTokenProgress?.(tokens);
  } else if (ev.type === "error") {
    throw new Error(ev.error);
  }
}
return { source: extractSource(textBuf) };
```

中间不实时推 token 进度（onTokenProgress 仅在 message_end 调一次）；UI 上显示"AI 生成中…"即可。

## 5. UI 状态机（SaveAsToolDialog）

### 5.1 SummaryState

```typescript
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
```

dialog 关闭即丢；不持久化。

### 5.2 接受后

```typescript
const summaryStep: Step = { kind: "js", source: state.source };
setLocalSteps((prev) => [...prev, summaryStep]);
setSummary({ phase: "idle" });
```

`localSteps` 是 dialog 内本地拷贝，初始 = props.steps；保存时 rpc.saveTool({steps: localSteps})。

### 5.3 props 扩展

```typescript
type Props = {
  initialName: string;
  initialDescription: string;
  initialUrl: string;
  steps: Step[];
  lastOutput: Json;
  // 新增
  messages: ChatMessage[];
  llmSettings: LlmSettings;
  onClose: () => void;
  onSaved: (toolId: string) => void;
};
```

`chat-page.tsx` 调用处补两个 prop：`messages={session.messages}` 与 `llmSettings={settings}`。

### 5.4 outputSchema 处理

不重算。沿用现有 `inferJsonSchema(lastOutput)`。dialog 内一行小字提示：

```
output schema 推断自上次会话的实际输出。汇总 step 接受后，重放
时会得到新结构，schema 不会自动重算。
```

工程量小、改动可控。

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| 没填 API Key | 按钮 disabled + tooltip "请先在设置页填入 API Key" |
| LLM 4xx / 网络错 | `phase: "error"`；UI 显示原始错误；[重试] |
| LLM 返回为空 / 无 `return` | `phase: "error"` + "AI 输出不含可用 source"；[重新生成] |
| 输出 > 32KB | 同上，错误信息 "AI source too large" |
| 静态扫描命中 dangerous | 接受按钮变红字 "⚠ 含 dangerous 关键词，确认接受？"；用户仍可接受 |
| 用户点 [取消] / 关闭 dialog 时 generating | abortController.abort()；state 重置为 idle |
| executedSteps 为空 | 按钮 disabled + tooltip "需要先有成功的 step" |

## 7. 模块边界与文件结构

```
src/sidepanel/
├─ llm/
│  └─ summary-step.ts                # NEW: generateSummaryStep + buildUserPrompt + extractSource
├─ components/
│  └─ save-as-tool-dialog.tsx        # MOD: 加 SummaryState + UI panel + props
└─ pages/
   └─ chat-page.tsx                  # MOD: SaveAsToolDialog 多传 messages / llmSettings

tests/sidepanel/llm/
└─ summary-step.test.ts              # NEW: extractSource 单测 + mock LlmClient 行为
```

每个文件单一职责；与 Plan 1-4 沿用同样模式。

## 8. 测试策略

### 8.1 summary-step.test.ts（约 5 case，纯函数）

```typescript
describe("extractSource", () => {
  it("returns trimmed source as-is", ...)
  it("strips ```js fence", ...)
  it("strips ```javascript fence", ...)
  it("extracts code block from explanation + fence", ...)
  it("throws when source has no return", ...)
});
```

### 8.2 summary-step.test.ts（generateSummaryStep 行为）

```typescript
describe("generateSummaryStep", () => {
  it("calls client.stream with built prompts", ...)  // mock client
  it("returns extracted source on text_delta + message_end", ...)
  it("throws on stream error event", ...)
});
```

新增约 8 case。total 150 + 8 = **158 tests**。

## 9. 范围内 vs 不在 Plan 5

**在**：第 4-7 节列出的 NEW + MOD。

**推迟**：
- 在工具详情页对已保存工具补汇总 step
- 干跑验证（dry-run）
- 用户填"期望输出 schema"
- 运行历史页

## 10. 评审与下一步

本文档评审通过后调用 writing-plans 技能产出 Plan 5 实施计划。预期 6-8 task，按里程碑：

1. `summary-step.ts` 类型 + 实现（buildUserPrompt + extractSource + generateSummaryStep）
2. `summary-step.test.ts`
3. `SaveAsToolDialog` props 扩展 + 状态机 + UI
4. `chat-page.tsx` 调用处补 props
5. 全量回归（约 158 tests）+ 手测
