# Plan 2: AI 对话与工具固化 — 设计文档

- 日期：2026-05-10
- 状态：草案，待评审
- 范围：在 Plan 1 已落地的扩展骨架基础上，加上 LLM 接入、tool-use 会话循环、step 卡片人工审阅、`runJS` 静态扫描、tab-watcher 推送、保存为工具与失败修复入口
- 前置：`docs/superpowers/specs/2026-05-09-ai-collector-extension-design.md`、`docs/superpowers/plans/2026-05-09-plan1-executable-skeleton.md`

## 1. 目标

让用户在被注入页面（如商品详情页）打开侧边面板，用自然语言描述要采集什么，AI 通过多轮 tool-use 自动调用 Plan 1 的内置工具完成采集；过程中每个有副作用的 step 必须经人工审阅；成功后一键保存为可复用工具，下次访问同类页面时面板顶部 banner 推荐重放。

非目标（推迟到 Plan 3 或之后）：
- 多模态（截图当输入）
- 通用站点 host_permissions 动态请求
- 自动备份开关
- 自动化 e2e
- 跨 session 持久化的聊天历史

## 2. 关键决策回顾

下列决策已在头脑风暴阶段定型：

| 决策点 | 选择 |
|---|---|
| LLM provider | Anthropic + OpenAI 两家，设置页选择 |
| 响应模式 | 流式（SSE） |
| 会话循环位置 | sidepanel（BG 不持有 chat 状态） |
| Step 审阅 UX | 内联卡片 + "全部通过 safe + caution" toggle |
| 会话持久化 | 仅内存，面板关掉即清 |
| URL 命中提示 | 顶部 banner + action icon 角标 |
| 失败修复入口 | 跳 ChatPage 预填 prompt + 上下文 |
| RunRecord 粒度 | 一会话 = 一 RunRecord |
| API Key 存储 | `chrome.storage.local` 或 `chrome.storage.session`（用户选） |
| Tool round 上限 | 默认 20，设置可改 |

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│ Side Panel (React)                                               │
│                                                                  │
│  ChatPage                                                        │
│   ├─ sessionState (in-memory, useReducer / zustand)              │
│   │   ├─ messages: ChatMessage[]                                 │
│   │   ├─ pendingApprovals: Map<toolUseId, ToolUse>               │
│   │   ├─ runRecordId: string                                     │
│   │   ├─ approveAllSafe: boolean (默认 true)                      │
│   │   ├─ tokenUsage: { input, output }                            │
│   │   └─ roundCount: number                                       │
│   ├─ LlmClient (Anthropic / OpenAI 适配器)                        │
│   ├─ ToolRunner (调 BG.runOneStep)                                │
│   ├─ Approver (持有 pending Promise resolvers)                    │
│   └─ ChatView / StepCard / StaticScanBadge / Banner / StatusBar  │
└──────┬─────────────────────────────────────────────┬─────────────┘
       │ chrome.runtime.sendMessage                  │ fetch + ReadableStream
       ▼                                             ▼
┌──────────────────────────────┐               ┌────────────────────┐
│ Service Worker               │               │ Anthropic /        │
│   - rpc handler 扩展:        │               │ OpenAI API         │
│     - runs.runOneStep         │               │ (stream=true)      │
│     - chat.session.start      │               └────────────────────┘
│     - chat.session.appendLog  │
│     - chat.session.end        │
│   - tab-watcher (NEW)         │
│   - tab.recommendations 推送   │
└──────┬───────────────────────┘
       │ chrome.tabs.sendMessage
       ▼
┌──────────────────────────────┐
│ Content Script (Plan 1 已建)  │
└──────────────────────────────┘
```

核心约束：

- BG 不持有任何 chat 状态；所有 session state 都在 sidepanel React state 里
- LLM API Key 只从 `chrome.storage.local` 或 `chrome.storage.session` 读，不进 IDB、不入导出 bundle
- LLM 流式 fetch 直接从 sidepanel 发出（manifest `host_permissions` 包含 `https://api.anthropic.com/*` 和 `https://api.openai.com/*`）
- tab-watcher 用 `tabs.onUpdated` + `webNavigation.onHistoryStateUpdated`，不在页面 inject toast

## 4. LLM 客户端与统一适配层

### 4.1 抽象接口

`src/sidepanel/llm/types.ts`：

```typescript
export type LlmProvider = "anthropic" | "openai";

export type LlmTool = {
  name: string;
  description: string;
  input_schema: JsonSchema;          // 标准 JSON Schema
};

export type TextPart = { type: "text"; text: string };
export type ToolUsePart = { type: "tool_use"; id: string; name: string; input: Json };
export type ToolResultPart = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export type LlmMessage =
  | { role: "user"; content: string | Array<TextPart | ToolResultPart> }
  | { role: "assistant"; content: Array<TextPart | ToolUsePart> };

export type LlmStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "tool_use_end"; id: string; input: Json }      // 解析完整后给出
  | { type: "message_end"; usage?: { input_tokens: number; output_tokens: number } }
  | { type: "error"; error: string };

export interface LlmClient {
  stream(input: {
    model: string;
    system: string;
    messages: LlmMessage[];
    tools: LlmTool[];
    maxTokens?: number;
    abortSignal?: AbortSignal;
  }): AsyncIterable<LlmStreamEvent>;
}
```

### 4.2 适配器

| 文件 | 职责 |
|---|---|
| `sidepanel/llm/anthropic.ts` | `POST https://api.anthropic.com/v1/messages` with `x-api-key`、`anthropic-version: 2023-06-01`；解析 SSE：`message_start` / `content_block_start{tool_use}` / `content_block_delta{input_json_delta.partial_json}` / `content_block_stop` / `message_delta` / `message_stop` → 翻译成 `LlmStreamEvent` |
| `sidepanel/llm/openai.ts` | `POST https://api.openai.com/v1/chat/completions` with `Authorization: Bearer`、`stream:true`、`tools`；解析 SSE chunks：`choices[0].delta.content` 文本流；`choices[0].delta.tool_calls[]` 按 `index` 累积 `function.arguments`（JSON 字符串增量）；`finish_reason:"tool_calls"` 时整段 input 完整 |
| `sidepanel/llm/client.ts` | `pickClient(provider)` → `LlmClient` |
| `sidepanel/llm/tool-schema.ts` | 9 个内置工具 + 1 个 `runJS` 的 `LlmTool[]`，input_schema 为 JSON Schema |
| `sidepanel/llm/system-prompt.ts` | 系统 prompt 模板（含调用约定、安全提示、URL/title 上下文注入） |

### 4.3 内置工具的 JSON Schema（节选）

```typescript
// snapshotDOM
{ type: "object",
  properties: {
    maxDepth: { type: "integer", default: 3 },
    root:     { type: "string", description: "CSS selector; falls back to <html>" }
  } }

// extractImages
{ type: "object",
  properties: {
    root:     { type: "string" },
    includeBg:{ type: "boolean", default: false }
  } }

// scroll
{ type: "object",
  properties: {
    to:           { oneOf: [{const:"bottom"},{const:"top"},{type:"number"}] },
    max:          { type: "integer", default: 1 },
    intervalMs:   { type: "integer", default: 250 },
    untilSelector:{ type: "string" }
  },
  required: ["to"] }

// runJS
{ type: "object",
  properties: {
    source: { type: "string",
              description: "async function body; receives `ctx` (bindings); use `return`" }
  },
  required: ["source"] }
```

完整 schema 在 `tool-schema.ts` 实现。

### 4.4 模型与配置

设置页字段：

| 字段 | 类型 | 默认 |
|---|---|---|
| provider | "anthropic" \| "openai" | "anthropic" |
| model | string（按 provider 给下拉） | `claude-sonnet-4-6` / `gpt-4o-mini` |
| apiKey | string | "" |
| apiKeyMode | "persistent" \| "session" | "persistent" |
| maxRounds | int | 20 |

`apiKeyMode = "session"` → 写 `chrome.storage.session`，浏览器重启需重输；否则 `chrome.storage.local`。

## 5. 会话循环

`src/sidepanel/chat/run-session.ts` 核心伪代码：

```typescript
async function runChatSession(input: { userPrompt: string; tabId: number; url: string }) {
  const session = sessionStore.getState();
  session.messages.push({ role: "user", content: input.userPrompt });

  if (!session.runRecordId) {
    session.runRecordId = (await rpc.startSession({ url: input.url })).id;
  }

  for (let round = 0; round < session.maxRounds; round++) {
    session.roundCount = round + 1;
    const stream = client.stream({
      model: settings.model,
      system: SYSTEM_PROMPT(input.url),
      messages: session.messages,
      tools: TOOL_DEFS,
      abortSignal: session.abortController.signal
    });

    const assistant: LlmMessage = { role: "assistant", content: [] };
    let textBuf = "";
    const inputBufs = new Map<string, string>();    // tool_use_id → partial_json

    for await (const ev of stream) {
      switch (ev.type) {
        case "text_delta":
          textBuf += ev.text;
          renderAssistantText(textBuf);
          break;
        case "tool_use_start":
          inputBufs.set(ev.id, "");
          break;
        case "tool_use_input_delta":
          inputBufs.set(ev.id, (inputBufs.get(ev.id) ?? "") + ev.partial_json);
          break;
        case "tool_use_end":
          assistant.content.push({ type: "tool_use", id: ev.id, name: ev.name, input: ev.input });
          break;
        case "message_end":
          if (ev.usage) session.tokenUsage = addUsage(session.tokenUsage, ev.usage);
          break;
        case "error":
          session.error = ev.error;
          await rpc.finalizeSession(session.runRecordId, "error");
          return;
      }
    }
    if (textBuf) assistant.content.unshift({ type: "text", text: textBuf });
    session.messages.push(assistant);

    const toolUses = assistant.content.filter(c => c.type === "tool_use") as ToolUsePart[];
    if (toolUses.length === 0) break;     // 流程结束

    const results: ToolResultPart[] = [];
    for (const tu of toolUses) {
      const decision = await approver.waitForApproval(tu);
      if (decision.kind === "deny") {
        await rpc.finalizeSession(session.runRecordId, "aborted");
        return;
      }
      if (decision.kind === "skip") {
        results.push({ type: "tool_result", tool_use_id: tu.id, content: '{"skipped":true}' });
        continue;
      }

      const step: Step = tu.name === "runJS"
        ? { kind: "js", source: (tu.input as {source:string}).source }
        : { kind: "tool", tool: tu.name as BuiltinTool, args: tu.input as Json };

      const start = Date.now();
      try {
        const out = await rpc.runOneStep({ step, tabId: input.tabId, bindings: {} });
        await rpc.appendStepLog(session.runRecordId, {
          stepIndex: results.length, input: tu.input as Json, output: out, ms: Date.now() - start
        });
        results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
        session.executedSteps.push(step);   // ← 给 "保存为工具" 用
      } catch (e) {
        const errStr = e instanceof Error ? e.message : String(e);
        await rpc.appendStepLog(session.runRecordId, {
          stepIndex: results.length, input: tu.input as Json, output: null,
          ms: Date.now() - start, error: errStr
        });
        results.push({
          type: "tool_result", tool_use_id: tu.id, is_error: true,
          content: JSON.stringify({ error: errStr })
        });
        // 注意：不直接终止 — AI 可能改 args 重试
      }
    }
    session.messages.push({ role: "user", content: results });
  }

  await rpc.finalizeSession(session.runRecordId, "ok", session.lastOutput());
  session.showSaveDialog = true;
}
```

### 5.1 Approver

```typescript
// sidepanel/chat/approval.ts
export type Decision = { kind: "run" } | { kind: "skip" } | { kind: "deny" };

class Approver {
  private pending = new Map<string, (d: Decision) => void>();

  waitForApproval(tu: ToolUsePart): Promise<Decision> {
    const severity = classifyTool(tu.name, tu.input);
    if (autoApproves(severity, sessionStore.getState().approveAllSafe)) {
      return Promise.resolve({ kind: "run" });
    }
    return new Promise((resolve) => this.pending.set(tu.id, resolve));
  }
  resolve(toolUseId: string, decision: Decision) {
    this.pending.get(toolUseId)?.(decision);
    this.pending.delete(toolUseId);
  }
}
```

UI 点 StepCard 按钮 → 调 `approver.resolve(id, decision)`。

### 5.2 三类工具与默认行为

| 等级 | 工具 | `approveAllSafe=true` 时 | `false` 时 |
|---|---|---|---|
| safe | snapshotDOM, querySelector*, extractText, extractImages, waitFor, scroll | 自动通过 | 自动通过 |
| caution | click, httpRequest（无 cookie）, runJS（扫描全过） | 自动通过 | 必须人工 |
| dangerous | httpRequest（withCredentials）, readStorage, runJS（含 dangerous 命中） | 必须人工 | 必须人工 |

`classifyTool(name, input)` 实现要点：
- name in safeSet → safe
- name === "httpRequest" → 看 input.withCredentials
- name === "readStorage" → dangerous
- name === "click" → caution
- name === "runJS" → 跑 `runStaticScan(input.source)`，取 `highestSeverity()`

## 6. runJS 静态扫描

`src/shared/static-scan.ts`，纯函数纯类型，单测重点。

```typescript
export type Severity = "info" | "caution" | "dangerous";

export type ScanFinding = {
  rule: string;
  severity: Severity;
  message: string;
  matches: { line: number; col: number; text: string }[];
};

export const RULES: Array<{ rule: string; severity: Severity; message: string; pattern: RegExp }> = [
  { rule: "uses-document-cookie", severity: "dangerous", message: "读取/写入 cookie",
    pattern: /\bdocument\s*\.\s*cookie\b/g },
  { rule: "uses-eval", severity: "dangerous", message: "eval() 执行动态代码",
    pattern: /\beval\s*\(/g },
  { rule: "uses-new-function", severity: "dangerous", message: "new Function 执行动态代码",
    pattern: /\bnew\s+Function\s*\(/g },
  { rule: "uses-chrome-api", severity: "dangerous", message: "尝试访问扩展 API",
    pattern: /\b(chrome|browser)\s*\.\s*[a-zA-Z_$]/g },
  { rule: "uses-fetch", severity: "caution", message: "发起网络请求 (fetch)",
    pattern: /\bfetch\s*\(/g },
  { rule: "uses-xhr", severity: "caution", message: "发起网络请求 (XMLHttpRequest)",
    pattern: /\bnew\s+XMLHttpRequest\b|\bXMLHttpRequest\s*\(/g },
  { rule: "uses-send-beacon", severity: "caution", message: "navigator.sendBeacon",
    pattern: /navigator\s*\.\s*sendBeacon\b/g },
  { rule: "uses-storage", severity: "caution", message: "读/写 localStorage / sessionStorage",
    pattern: /\b(local|session)Storage\b/g },
  { rule: "uses-indexed-db", severity: "caution", message: "读/写 IndexedDB",
    pattern: /\bindexedDB\b/g },
  { rule: "uses-mutation-observer", severity: "info", message: "MutationObserver",
    pattern: /\bMutationObserver\b/g }
];

export function runStaticScan(source: string): ScanFinding[];
export function highestSeverity(findings: ScanFinding[]): Severity;
```

扫描结果**永远不阻断执行**，只用于：
1. 决定 `runJS` 卡片是否能"自动通过"
2. 卡片顶部 chip 区列出命中的规则名
3. 源码 viewport 把命中行加底色

已知不足（接受）：
- 假阳性：注释/字符串里写 `document.cookie` 也命中
- 假阴性：动态拼接 `window['document']['cook'+'ie']` 不命中

目标是给人提示，不是防御对手。

## 7. UI 设计

### 7.1 ChatPage 布局

```
┌──────────────────────────────────────────┐
│ ⚙ aipagego2 — 对话采集                       │
├──────────────────────────────────────────┤
│ [Banner: ▶ 此页面可用 2 个工具 ...]        │ ← 仅当 URL 命中
├──────────────────────────────────────────┤
│ [Status: ◉ AI 工作中 · 3/20 · 1.2K tok ⏸]│ ← 仅当 running
├──────────────────────────────────────────┤
│ 消息流（scrollable）:                     │
│  user: 把主图、详情图、前 50 条评论拿出来    │
│  assistant: 我先看一下 DOM 结构...         │
│  ┌─ #1 · snapshotDOM [safe] ✓ 0.3s ────┐ │
│  │ ...                                  │ │
│  └──────────────────────────────────────┘ │
│  ┌─ #2 · scroll [safe] ✓ 1.2s ─────────┐ │
│  │ ...                                  │ │
│  └──────────────────────────────────────┘ │
│  ┌─ #3 · runJS [caution]              ─┐ │
│  │ chips: [fetch]                      │ │
│  │ source: ...                          │ │
│  │ [✓ 通过] [⊘ 跳过] [✕ 终止]            │ │
│  └──────────────────────────────────────┘ │
│  assistant: 抓到 12 张图...               │
├──────────────────────────────────────────┤
│ ☑ 自动通过 safe + caution                 │
│ ┌──────────────────────────────────────┐ │
│ │ 输入消息...                           │ │
│ └──────────────────────────────────────┘ │
│                              [发送]      │
└──────────────────────────────────────────┘
```

### 7.2 Step Card 状态机

```
[draft] LLM 正在流式生成 input → 显示 partial JSON 的 args
   │
   ▼
[awaiting] 完整 input 可用，等审阅
   - safe / (caution & approveAllSafe) → 立即变 [running]
   - dangerous 或开关关 → 等用户点
   │
   ▼
[running] 正在跑（calling rpc.runOneStep）
   │
   ▼
[ok] | [error] | [skipped] | [denied]
```

`runJS` 的卡多两块：StaticScanBadge（chip 区）+ 源码 viewport（命中行染色）。

### 7.3 状态条

`StatusBar` 仅在会话进行中显示：

```
◉ AI 工作中 · round 3/20 · 1,240 tokens   [⏸]
```

`⏸` 触发 `session.abortController.abort()`，会话状态置 `aborted`，RunRecord status `aborted`。

## 8. Tab Watcher（URL 命中推荐）

```typescript
// src/background/tab-watcher.ts
chrome.tabs.onUpdated.addListener(async (tabId, change, _tab) => {
  if (!change.url) return;
  await refresh(tabId, change.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(async ({ tabId, url }) => {
  await refresh(tabId, url);
});

async function refresh(tabId: number, url: string) {
  const tools = await matchingTools(url);
  await chrome.action.setBadgeText({
    tabId,
    text: tools.length ? String(tools.length) : ""
  });
  if (tools.length) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#10b981" });
  }
  // 推给 sidepanel（如果不在听就 swallow）
  chrome.runtime
    .sendMessage({ type: "tabs.recommendations", tabId, url, tools })
    .catch(() => {});
}
```

Sidepanel 在 `app.tsx` mount 时注册 `chrome.runtime.onMessage` 监听 `tabs.recommendations`，仅在该消息的 `tabId === currentTabId()` 时刷 banner。

## 9. 保存为工具

会话结束（LLM 不再返 tool_use 或用户停止）→ ChatPage 顶部出现 inline 提示：

```
AI 已完成 6 步采集，最终输出 1.4 KB JSON   [保存] ❎
```

点"保存"弹 modal：

| 字段 | 默认 |
|---|---|
| 名称 | AI 在收尾文本里给的建议名 |
| URL 模式 | 当前 tab URL 的 host 通配（`https://*.host.com/**`） |
| 描述 | AI 收尾文本前 200 字符 |
| 步骤 | 折叠展示，仅取**通过审阅且执行成功**的 step（跳过/失败/终止不入） |
| 输出 schema | AI 推断（对最终 output 跑 `inferJsonSchema`） |

确认 → 调 `rpc.saveTool(draft)`（已有），写 IDB v1。

## 10. 失败修复入口

工具详情页（`tool-detail-page.tsx`）的"运行"失败时：

```
✗ Step 3 失败: querySelectorAll('.review-item') 返回 0 条
   [让 AI 修复] [手动重跑] [回滚到上一版本]
```

点"让 AI 修复"：
1. 切到 ChatPage
2. 预填 user message：包含工具名/版本、失败 step、失败原因
3. 后台先调一次 `snapshotDOM` 拿当前页快照
4. 在 messages 头部插入一条 system context（URL、snapshot 摘要、原 steps 数组）
5. 用户只需点"发送"

修复成功 → 保存对话框默认勾选 "作为现有工具的新版本"，调 `rpc.appendVersion(toolId, {steps, outputSchema, note})`。

## 11. RPC 协议增量

`shared/messages.ts` 新增：

```typescript
// sidepanel → BG
{ type: "runs.runOneStep", step: StepSchema,
  tabId: z.number(), bindings: z.record(z.unknown()) }

{ type: "chat.session.start", url: z.string() }
{ type: "chat.session.appendLog", runId: z.string(),
  entry: RunStepLogEntrySchema }
{ type: "chat.session.end", runId: z.string(),
  status: z.enum(["ok","error","aborted"]),
  output: z.unknown().optional() }

// BG → sidepanel (broadcast)
{ type: "tabs.recommendations", tabId: z.number(),
  url: z.string(), tools: z.array(ToolSchema) }
```

`runs.runOneStep` 的实现复用 Plan 1 已有的 `chrome.tabs.sendMessage(ContentRequest)` 路径，但只跑一步、由 sidepanel 控制循环。

`chat.session.*` 是给 IDB 写 `RunRecord` 的薄包装：start 创建 RunRecord，appendLog 追加 stepLog，end 写 finalize。

`sidepanel/rpc.ts` 在 Plan 1 typed wrapper 上扩展，新增的便捷函数命名约定为：

| 协议层 RPC type | wrapper 函数名 |
|---|---|
| `runs.runOneStep` | `rpc.runOneStep` |
| `chat.session.start` | `rpc.startSession` |
| `chat.session.appendLog` | `rpc.appendStepLog` |
| `chat.session.end` | `rpc.finalizeSession` |

§5 伪代码使用 wrapper 函数名；§11 列的是协议层 type 字符串。两者一一对应。

## 12. 错误处理

| 场景 | 行为 |
|---|---|
| API Key 缺失 / 401 | 顶部红条 + "去设置" 跳设置页 |
| LLM 返回 4xx/429 | 红条显示原始错误 |
| LLM `tool_use.input` JSON 解析失败 | 给 AI 回灌 `is_error:true` 的 tool_result，让它重试；连续 3 次失败终止会话 |
| LLM 返回非法 tool 名 | 同上 |
| Step 执行失败（DOM/超时/注入异常） | 把 error 字符串作为 `tool_result.content` 回灌，AI 自行决定改 args 重试 |
| 跨域 fetch 被 host_permissions 拒 | step 错误 + "打开权限" 按钮（动态权限请求推迟到 Plan 3） |
| 用户 abort | `AbortController.abort()`；当前 fetch 流断；待审阅 step 全部 deny；RunRecord `aborted` |
| 达到 maxRounds | 红条 + "继续 +20 轮" 按钮 |
| 累计 token > 200k | 软警告（不阻断） |

## 13. 测试策略

| 层 | 工具 | 重点 |
|---|---|---|
| 单元 | vitest + happy-dom | static-scan 规则、severity 分类、SSE 解析（喂样本字符串验证 events 序列）、run-session 状态机（DI 全 mock） |
| 集成 | vitest（mock chrome.*） | tab-watcher 的 onUpdated → matchingTools → setBadgeText 联动 |
| e2e | 手动 | 真 API key 跑一次"采主图 + 详情图"会话；验证 step 卡审阅、保存、重放、修复入口 |

LLM 真接入仍 mock 为主，e2e 留 README 手测脚本（不进 CI）。

## 14. 文件结构（增量）

```
aipagego2/
├─ src/
│  ├─ shared/
│  │  ├─ static-scan.ts                  # NEW
│  │  ├─ messages.ts                     # MOD: 新增 4 种 RPC
│  │  └─ types.ts                        # MOD: ChatMessage, ToolUse, ToolResult, ScanFinding,
│  │                                              Severity, LlmSettings
│  ├─ background/
│  │  ├─ rpc-handlers.ts                 # MOD: runOneStep / chat.session.*
│  │  ├─ tab-watcher.ts                  # NEW
│  │  └─ index.ts                        # MOD: 装 tab-watcher
│  └─ sidepanel/
│     ├─ llm/
│     │  ├─ types.ts                     # NEW
│     │  ├─ anthropic.ts                 # NEW
│     │  ├─ openai.ts                    # NEW
│     │  ├─ tool-schema.ts               # NEW
│     │  ├─ system-prompt.ts             # NEW
│     │  └─ client.ts                    # NEW
│     ├─ chat/
│     │  ├─ session-store.ts             # NEW
│     │  ├─ run-session.ts               # NEW
│     │  ├─ tool-runner.ts               # NEW
│     │  ├─ severity.ts                  # NEW
│     │  └─ approval.ts                  # NEW
│     ├─ pages/
│     │  ├─ chat-page.tsx                # NEW (默认页)
│     │  ├─ tool-detail-page.tsx         # MOD: 失败 → 跳 ChatPage
│     │  ├─ run-page.tsx                 # MOD: 折叠成"DEV: 粘 JSON" 入口
│     │  └─ settings-page.tsx            # MOD: provider/model/apiKey/apiKeyMode/maxRounds
│     ├─ components/
│     │  ├─ chat-view.tsx                # NEW
│     │  ├─ message-bubble.tsx           # NEW
│     │  ├─ step-card.tsx                # NEW
│     │  ├─ static-scan-badge.tsx        # NEW
│     │  ├─ recommendations-banner.tsx   # NEW
│     │  └─ status-bar.tsx               # NEW
│     ├─ app.tsx                         # MOD: 默认 route 改 chat
│     └─ rpc.ts                          # MOD: runOneStep + chat 会话 RPC + 接收 tab 推送
└─ tests/
   ├─ shared/static-scan.test.ts                     # NEW
   ├─ sidepanel/llm/anthropic-stream.test.ts         # NEW
   ├─ sidepanel/llm/openai-stream.test.ts            # NEW
   ├─ sidepanel/chat/run-session.test.ts             # NEW
   ├─ sidepanel/chat/severity.test.ts                # NEW
   └─ background/tab-watcher.test.ts                 # NEW
```

## 15. 已知限制与 Plan 3 候选

- 通用站点 host_permissions 动态请求（`chrome.permissions.request`）
- 多模态截屏给 AI（用 `chrome.tabs.captureVisibleTab` 替代/补充 snapshotDOM）
- 自动备份开关（保存工具时自动下载 `<tool>-vN-<date>.json`）
- 自动化 e2e（playwright loadExtension + 商品页 fixture）
- 跨 session 持久化的聊天历史（如果用户开始反复编辑同一工具）
- AI agent 视角看 stepLog 的成本控制（snapshotDOM 输出可能上万字，需要 truncation/summarization 策略）

## 16. 评审与下一步

本文档评审通过后调用 writing-plans 技能产出 Plan 2 实施计划。计划预期任务量 25-35 个，按以下里程碑：

1. shared types + static-scan + messages 增量
2. LLM client（Anthropic / OpenAI 适配 + 流解析）
3. tool schema + system prompt
4. session store + approver + run-session 主循环
5. ChatPage UI（消息流 / Step Card / Status Bar）
6. tab-watcher + 推荐 banner
7. 保存对话框 + 失败修复入口
8. 设置页扩展
9. 全量回归 + 手测脚本
