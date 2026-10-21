# Prompt Optimize Button — 输入框内一键优化提示词

**状态**：草稿 · 2026-07-02 · 作者：assistant + attson

在输入框内右下角加一个「魔法棒」按钮。点了之后，LLM 把用户草稿改写为对当前页面 + 内置工具更友好的具体指令，弹一个预览面板让用户接受 / 重新生成 / 弃用。

## 1 · 背景

现状：用户在输入框写自然语言（"帮我找一下当前页产品的竞品"）→ 提交 → 主 LLM 拿到含糊指令，第一步经常问回、试错或找错工具。

痛点：**用户不知道怎么写才能让 agent 少绕弯**——不清楚有哪些内置工具、不知道该点名 URL / 结构化输出。已经有沉淀成"工具"的场景走 save-as-tool，但**每次首发新任务**都要 cold-start，成本高。

解法：加个「魔法棒」一键调用小模型改写草稿，改写目标是"对 browser-agent 更好使的具体指令"（提示信息源、点名工具、约定输出）。**不是**通用文风改写。

## 2 · 非目标

- ❌ 通用写作助手 / 语气改写 / 翻译
- ❌ prompt 模板管理（自定义系统提示、多版本）—— 系统提示写死一份，需要改时改代码
- ❌ 与主对话 LLM 混流（优化独立跑，不进 `llmExchanges`）
- ❌ 流式输出（结果小 < 1KB，非流式简单）
- ❌ 逐字 diff 高亮（只显示前后文本对照）
- ❌ 支持"编辑优化文本再接受"——要改就直接改输入框（YAGNI）
- ❌ 记住上次优化历史 / 每次输入都保留 undo 栈
- ❌ 为优化单独一套 provider / API key 配置

## 3 · 用户体验

### 3.1 位置

魔法棒图标（lucide `Sparkles`）浮在 `InputBox` 的 textarea 内部右下角，尺寸 14px，颜色 `text-zinc-500` hover `text-zinc-200`，绝对定位。textarea 右下 padding 加 `pr-8 pb-6` 给出让位。

```
┌─────────────────────────────────────┐
│ 帮我找一下当前页产品的竞品           │
│                                     │
│                                  ✨ │  ← 优化按钮
└─────────────────────────────────────┘
[默认] @ 📎 🎯                     [↑]
```

### 3.2 三态

| 状态 | 图标 | 是否可点 | 说明 |
|------|------|---------|------|
| idle | ✨ 静态 | 是（草稿非空）；否（空 / streaming） | 默认 |
| loading | ✨ 旋转 spinner | 否 | LLM 请求进行中 |
| error | ✨ 红色 + tooltip | 是（可重试） | 上次请求失败 |

### 3.3 预览面板

优化完成 → 输入框**上方**弹一个绝对定位面板（覆盖在 `AboveInputTabs` 之上，`z-index` 高于 tab bar）：

```
┌────────────────────────────────────────┐
│ ✨ 优化后                    [关闭 ×] │
├────────────────────────────────────────┤
│ 在当前页面（{tab.title}）上打开每个   │
│ 产品详情，用 takeSnapshot 抓交互      │
│ 元素，提取商品标题/价格/规格，然后    │
│ 用 httpRequest 在 Google 搜同品类     │
│ 竞品，汇总成表格返回。                │
├────────────────────────────────────────┤
│ ▸ 查看原文（折叠）                    │
├────────────────────────────────────────┤
│ [ 弃用 ] [ 重新生成 ]  [ 接受 (Enter) ] │
└────────────────────────────────────────┘
```

- **接受**：`props.onChange(optimized)`，关闭面板；焦点回到 textarea 末尾
- **重新生成**：重新调 LLM（loading → 新预览）
- **弃用**：不改输入框，关闭面板
- **关闭 ×** 等同"弃用"
- **原文折叠**：默认收起，点开显示 `session.inputDraft` 原文（普通 pre 展示）

键盘：面板出现时，`Enter` 触发接受，`Esc` 触发弃用。焦点在面板容器上以支持这两个键。

### 3.4 错误态

LLM 请求失败（网络 / 401 / abort）→ 预览面板显示红色错误行 + 唯一按钮「重试」，保留输入框原内容：

```
┌────────────────────────────────────────┐
│ ⚠ 优化失败：{error.message}   [关闭×] │
│                       [ 重试 ]        │
└────────────────────────────────────────┘
```

## 4 · 架构

### 4.1 新增文件

```
packages/extension/src/sidepanel/input/prompt-optimize-button.tsx   (~40 行)
packages/extension/src/sidepanel/input/prompt-optimize-preview.tsx  (~80 行)
packages/extension/src/sidepanel/lib/optimize-prompt.ts             (~60 行)
packages/extension/tests/sidepanel/lib/optimize-prompt.test.ts      (~50 行)
packages/extension/tests/sidepanel/input/prompt-optimize-preview.test.tsx (~50 行)
```

### 4.2 修改文件

```
packages/shared/src/types.ts                                  (+1 字段 optimizerModel)
packages/extension/src/sidepanel/input/input-box.tsx          (支持 rightAction slot; textarea padding)
packages/extension/src/sidepanel/input/input-toolbar.tsx      (state 机 + 组装)
packages/extension/src/sidepanel/drawers/settings/section-llm.tsx (加一行 input)
```

### 4.3 `optimize-prompt.ts`（纯逻辑）

```ts
import type { LlmSettings } from "@aipagego/shared/types";
import { pickClient } from "@/sidepanel/llm/client";
import { TOOL_DEFS } from "@aipagego/shared/llm/builtin-tool-defs";

const SYSTEM_PROMPT = `你是「浏览器自动化 agent 的提示词教练」。用户会给你一段自然语言草稿，你要改写成更具体、可执行的指令，让下游的 browser-agent 一次就能选对工具、找对信息源。

改写原则：
1. 明确目标产物（要什么、什么格式）
2. 说清楚信息在哪里能找到（当前页 / 搜索 / 特定 URL）
3. 必要时点名工具（如 takeSnapshot / clickByUid / httpRequest）
4. 保留用户原语气和语言（中文 / 英文）
5. 不要问回，不要解释，不要加"以下是优化后的："之类的前缀

**只输出改写后的纯文本**。`;

type Ctx = {
  draft: string;
  tabUrl: string;
  tabTitle: string;
  settings: LlmSettings;
  signal: AbortSignal;
};

export async function optimizePrompt(ctx: Ctx): Promise<string> {
  const client = pickClient(ctx.settings.provider);
  const model = ctx.settings.optimizerModel?.trim() || ctx.settings.model;
  const toolCatalog = TOOL_DEFS
    .map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 80)}`)
    .join("\n");

  const userMessage =
    `[当前页] ${ctx.tabTitle || "(untitled)"} — ${ctx.tabUrl || "(no url)"}\n` +
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

不依赖 zustand，不写 session 状态。纯函数，好测。

### 4.4 `prompt-optimize-button.tsx`

```tsx
import { Sparkles, Loader2 } from "lucide-react";

type Props = {
  status: "idle" | "loading" | "error";
  disabled: boolean;   // 草稿为空 or 上层 streaming
  onClick: () => void;
};

export function PromptOptimizeButton({ status, disabled, onClick }: Props) {
  const iconCls =
    status === "error"
      ? "text-red-400"
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
      {status === "loading" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
    </button>
  );
}
```

### 4.5 `prompt-optimize-preview.tsx`

上层组件持有 `{original, optimized, error?}`，通过 props 传给预览。预览负责渲染 + 键盘 + 三个按钮：

```tsx
type Props = {
  original: string;
  optimized?: string;
  error?: string;
  loading: boolean;
  onAccept: () => void;
  onRegenerate: () => void;
  onDiscard: () => void;
};

export function PromptOptimizePreview({ original, optimized, error, loading, onAccept, onRegenerate, onDiscard }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);

  return (
    <div
      ref={ref}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Enter" && optimized && !loading) { e.preventDefault(); onAccept(); }
        if (e.key === "Escape") { e.preventDefault(); onDiscard(); }
      }}
      className="absolute bottom-full left-3 right-3 mb-2 rounded-lg border border-zinc-700 bg-zinc-900 shadow-lg z-20 outline-none"
    >
      {/* header / body / actions — 参见 §3.3 mock */}
    </div>
  );
}
```

原文折叠用简单 `<details>`。

### 4.6 `input-box.tsx` 改造

```diff
 type Props = {
   ...
+  /** 右下角浮动按钮（如优化提示词）。有值时 textarea padding 让位 */
+  rightAction?: React.ReactNode;
 };

 export function InputBox({ ..., rightAction }: Props) {
   ...
   return (
-    <textarea .../>
+    <div className="relative">
+      <textarea
+        ...
+        className={`w-full ... ${rightAction ? "pr-8 pb-6" : ""}`}
+      />
+      {rightAction}
+    </div>
   );
 }
```

### 4.7 `input-toolbar.tsx` 编排

新增 hook 状态：

```ts
type OptState =
  | { kind: "closed" }
  | { kind: "loading"; original: string; ac: AbortController }
  | { kind: "preview"; original: string; optimized: string }
  | { kind: "error"; original: string; error: string };

const [opt, setOpt] = useState<OptState>({ kind: "closed" });
```

按钮的 `status` 映射：`closed → idle | loading → loading | preview → idle | error → error`。

点击行为：
- `closed`：读 `props.value` → `setOpt({loading, ...})` → 跑 `optimizePrompt` → 成功 `setOpt({preview, ...})`；失败 `setOpt({error, ...})`
- `loading`：忽略
- `preview`：忽略（面板已开）
- `error`：直接重试

预览面板 `onAccept` 时调 `props.onChange(optimized)` 后 `setOpt({closed})`。

上下文从新加的 props 传：

```diff
 type Props = {
   ...
+  settings: LlmSettings;    // 从 useSettings 传入
+  currentTabTitle: string;
 };
```

### 4.8 Settings 字段

`packages/shared/src/types.ts`：

```diff
 export type LlmSettings = {
   ...
+  /** 提示词优化用哪个模型。留空 = 用 chat model。复用 provider / apiKey / endpoint */
+  optimizerModel?: string;
 };
```

`section-llm.tsx` 在 `max_tokens` 一行下面新增：

```tsx
<div className="flex items-center gap-2">
  <span className="w-20 text-zinc-400">优化模型</span>
  <input
    value={settings.optimizerModel ?? ""}
    onChange={(e) => void settings.save({ optimizerModel: e.target.value })}
    placeholder="留空 = 用对话模型（推荐 haiku）"
    className="bg-zinc-800 px-2 py-1 rounded font-mono flex-1"
    list={datalistId}
  />
</div>
```

复用同一个 datalist。

## 5 · 数据流

```
[User types draft]
      ↓
[User clicks Sparkles]
      ↓
[InputToolbar] setOpt({loading, ac})
      ↓
[optimizePrompt(draft, tabTitle, tabUrl, settings, ac.signal)]
      ↓ (LlmClient.stream, non-stream aggregation)
[settings.provider client] → LLM API
      ↓
[optimizePrompt returns string]
      ↓
[InputToolbar] setOpt({preview, original, optimized})
      ↓
[PromptOptimizePreview] renders above InputBox
      ↓
[User clicks 接受 / Enter]
      ↓
[InputToolbar] props.onChange(optimized); setOpt({closed})
```

- 用户在 loading 期间关闭面板 → 调 `ac.abort()`
- 用户切换到别的 tab / 重挂 InputToolbar → useEffect cleanup 里 `ac.abort()`

## 6 · 测试

### 6.1 `optimize-prompt.test.ts`

Mock `pickClient` 返回一个 fake `LlmClient`，验证：

- **传入正确的模型**（`optimizerModel` 优先，回退到 `model`）
- **system prompt 包含"改写"关键词** —— sanity check
- **user message 包含 tabTitle / tabUrl / 全部工具名**
- **收到 text_delta 累加并 trim**
- **收到 `error` 事件时 throw**
- **abort signal 透传给 client.stream**

### 6.2 `prompt-optimize-preview.test.tsx`

沿用 quick-actions.test.tsx 的 mount/cleanup 模式：

- 渲染 preview（optimized 非空）→ 三个按钮出现
- 点接受 → 触发 `onAccept`
- 按 Enter → 触发 `onAccept`
- 按 Esc → 触发 `onDiscard`
- error 态 → 只有「重试」按钮 + 错误文字

### 6.3 手工 QA

- [ ] 空草稿：按钮 disabled
- [ ] streaming 中：按钮 disabled
- [ ] 正常草稿：点击 → 面板出现 → 接受后输入框内容变化
- [ ] Esc / 弃用：输入框不变
- [ ] 重新生成：调第二次 API
- [ ] 断网：错误面板 + 重试
- [ ] 优化中切换 tab：请求 abort，无 log 报错
- [ ] Settings 填入 haiku-4-5：验证 exchanges 里**不**出现优化的 exchange（不写进 llmExchanges）

## 7 · 风险

| 风险 | 缓解 |
|------|------|
| 优化模型延迟高 → 用户点后等半天 | 默认 placeholder 推荐 haiku；loading 有 spinner；用户可以直接按 Esc 取消 |
| API key 未配置时点击 | 复用 chat 的 key，未配置时错误面板会显示 "apiKey missing"；不引入新校验 |
| optimizerModel 配错模型 ID | LLM API 报错走错误面板；不做客户端预校验 |
| 优化后语义偏离用户原意 | 用户能预览 + 弃用，是可逆的。系统提示强调"保留原语气/语言" |
| 与 mention picker 面板 z-index 冲突 | mention picker `z-index` 是 InputToolbar 内部 flex，优化预览用 `z-20`（>10），二者不同时出现（打开预览时不允许打字） |
| 优化按钮遮住 textarea 长文最右下字符 | `pr-8 pb-6` padding 让位；只有 `rightAction` 存在时才加，不影响其它使用者 |
| 单元测试引入真实网络 | `optimize-prompt.test.ts` mock `pickClient`，无网 |

## 8 · Out of scope（明确不做）

- 多组预设 system prompt / 用户自定义
- 保留多次优化历史（撤销栈仅靠浏览器 textarea 自身 undo，够用）
- Streaming 显示
- 逐字 diff 高亮
- 面板里再编辑优化文本
- 为优化单独一套 API 配置（provider / apiKey / endpoint）
- 快捷键调起优化（如 Cmd+K）—— 后续视用户使用频率再决定
- 优化 exchange 出现在调试抽屉 —— 独立跑，不进 `llmExchanges`
