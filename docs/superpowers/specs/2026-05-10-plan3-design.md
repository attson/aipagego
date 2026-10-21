# Plan 3: AIPageGo — 网页助手定位与操作工具集

- 日期：2026-05-10
- 状态：草案，待评审
- 范围：把 Plan 1+2 的"AI 网页采集器"重新定位为"AI 网页助手 (AIPageGo)"，新增 9 个交互工具（fillInput / setCheckbox / selectOption / submitForm / hover / focus / uploadFile / getValue / extractFormState），引入"按工具名"粒度的 dangerous 自动通过白名单，重写 system prompt 与全部用户可见文案
- 前置：`docs/superpowers/specs/2026-05-09-ai-collector-extension-design.md`、`2026-05-10-plan2-design.md`、Plan 2 实施计划

## 1. 目标与定位

AIPageGo 是侧边面板里的 AI 网页助手。三类用法：

- **读**：总结当前页、翻译、抽取重点、回答关于本页内容的问题
- **写**：填表、勾选、选下拉、点击按钮、提交表单、上传文件
- **采**：保留原采集能力（主图、详情、评论）

任意一段对话（无论是读、写还是采）都可以**一键固化为 URL 模式匹配的可重放工具**——这是 AIPageGo 的核心价值，与传统 AI 助手的差异点。

非目标（推迟到后续）：
- 跨 tab 导航（`chrome.tabs.update` / 新开 tab）
- 键盘事件（KeyboardEvent 派发、上下方向键自动补全）
- 多 tab 协作
- 多模态（截屏给 AI）
- 自动备份开关
- e2e 自动化

## 2. 关键决策回顾

| 决策点 | 选择 |
|---|---|
| 新工具集 | fillInput / setCheckbox / selectOption / submitForm / hover / focus / uploadFile / getValue / extractFormState（9 个） |
| 产品名 | 全重命名为 AIPageGo；仓库目录由用户在 plan 完成后手动 `mv` |
| IDB DB_NAME | 保持 `"aipagego"` 不变（避免丢已保存工具） |
| URL pattern 推荐 | 不变（用户主动保存才入库；保存后按 pattern 匹配） |
| system prompt | 全场景重写（读 / 写 / 采 / 多步） |
| dangerous 自动通过 | 按工具名粒度的白名单 `autoApproveDangerous: BuiltinTool[]`，对话页 + 设置页都能改 |

## 3. 整体架构

无大变动。Plan 1+2 已建好的三入口（service worker / content / sidepanel）+ 流式会话循环 + tool-use 审阅 + 工具固化机制全部沿用。本 plan 是：

- **content/tools/ 增 9 个工具文件**
- **shared/static-scan + severity** 调整签名引入 dangerous 白名单
- **sidepanel/llm/tool-schema + system-prompt** 重写
- **UI 文案换皮 + 加 DangerApprovalPopover/Group**

```
sidepanel (chat)
  ├─ DangerApprovalPopover (NEW, 对话页)
  ├─ DangerApprovalGroup   (NEW, 设置页)
  └─ severity.autoApproves(severity, toolName, approveAllSafe, dangerousAllowlist)
       │
       └─ run-session 调用决定是否跳过审阅

content/tools/
  ├─ fill-input.ts            (NEW)
  ├─ set-checkbox.ts          (NEW)
  ├─ select-option.ts         (NEW)
  ├─ submit-form.ts           (NEW)
  ├─ hover.ts                 (NEW)
  ├─ focus.ts                 (NEW)
  ├─ upload-file.ts           (NEW, 通过 BG 拿文件二进制)
  ├─ get-value.ts             (NEW)
  └─ extract-form-state.ts    (NEW)

background/
  └─ http-proxy.ts            (MOD, 加 fetchAsBase64 给 uploadFile)
```

## 4. 新工具集

### 4.1 输入与表单（caution / dangerous）

```typescript
// fillInput — caution
{
  name: "fillInput",
  description: "往 input/textarea/contenteditable 填值；触发 input/change 事件以兼容 React/Vue",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      value:    { type: "string" },
      clear:    { type: "boolean", default: true }
    },
    required: ["selector", "value"]
  }
}

// setCheckbox — caution
{
  name: "setCheckbox",
  description: "设置 checkbox 勾选状态；派发 change 事件",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      checked:  { type: "boolean" }
    },
    required: ["selector", "checked"]
  }
}

// selectOption — caution
{
  name: "selectOption",
  description: "<select> 元素按 value 或 label 选项。同时给两者时优先 value",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      value:    { type: "string" },
      label:    { type: "string" }
    },
    required: ["selector"]
  }
}

// submitForm — dangerous
{
  name: "submitForm",
  description: "提交 <form>。会触发服务端动作（下单、留言等），需要审阅",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string", default: "form" }
    }
  }
}
```

实现要点：

- `fillInput` 设 `el.value = value` 后必须派发 `new Event('input', {bubbles:true})` 与 `'change'`，否则 React 受控组件不更新。`contenteditable` 走 `el.textContent = value` + `input` 事件
- `setCheckbox` 用 `el.click()` 切到目标态比直接 set `el.checked` 更兼容
- `selectOption` 找到对应 `<option>` 后 `select.value = option.value` + 派发 `change`
- `submitForm` 优先派发 `submit` 事件让框架监听器能拦截；事件 `defaultPrevented` 则回退到 `form.submit()`

### 4.2 鼠标 / 焦点（safe）

```typescript
// hover — safe
{
  name: "hover",
  description: "把鼠标悬停在元素上（触发 mouseenter / mouseover / mousemove）",
  input_schema: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"]
  }
}

// focus — safe
{
  name: "focus",
  description: "把焦点给某元素（触发 focus / focusin）",
  input_schema: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"]
  }
}
```

实现要点：

- `hover` 派发 `mouseenter` + `mouseover` + `mousemove`，用 `dispatchEvent(new MouseEvent(...))`
- `focus` 调 `el.focus({preventScroll: false})` 让滚动到视野内

### 4.3 文件上传（dangerous）

```typescript
// uploadFile — dangerous
{
  name: "uploadFile",
  description: "把后端代理拉到的文件填到 <input type=file>。某些站点会拒绝合成 File（isTrusted 校验）",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      url:      { type: "string" },
      filename: { type: "string" },
      mime:     { type: "string" }
    },
    required: ["selector", "url"]
  }
}
```

数据通道：

```
content/upload-file.ts:
  ├─ chrome.runtime.sendMessage({type:"http.fetchBinary", url})  ← BG fetch + base64
  ├─ base64 → Uint8Array → Blob → File
  ├─ const dt = new DataTransfer(); dt.items.add(file);
  ├─ Object.defineProperty(input, 'files', {value: dt.files})
  └─ input.dispatchEvent(new Event('change', {bubbles:true}))
```

`http-proxy.ts` 加新分支：

```typescript
// background/http-proxy.ts (新增)
export async function fetchAsBase64(url: string): Promise<{
  base64: string;
  mime: string;
}> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const blob = await res.blob();
  const arr = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return { base64: btoa(bin), mime: blob.type || "application/octet-stream" };
}
```

并在 `shared/messages.ts` 加 RPC：

```typescript
z.object({
  type: z.literal("http.fetchBinary"),
  url: z.string().url()
})
```

回返 `{base64, mime}`。

### 4.4 读取（safe）

```typescript
// getValue — safe
{
  name: "getValue",
  description: "读 input/select/textarea/contenteditable 的当前值",
  input_schema: {
    type: "object",
    properties: { selector: { type: "string" } },
    required: ["selector"]
  }
}

// extractFormState — safe
{
  name: "extractFormState",
  description: "把 <form> 内所有可填字段读成 {name: value} 对象",
  input_schema: {
    type: "object",
    properties: { selector: { type: "string", default: "form" } }
  }
}
```

实现要点：

- `getValue`：根据 tag 区分 `input/select/textarea` 用 `.value`、`contenteditable` 用 `.textContent`
- `extractFormState`：遍历 `form.elements`，按 `name` 分组（同名 radio 取选中值；checkbox 多选取数组）

### 4.5 严重度归类

| 工具 | severity |
|---|---|
| `getValue`, `extractFormState`, `hover`, `focus` | safe |
| `fillInput`, `setCheckbox`, `selectOption` | caution |
| `submitForm`, `uploadFile`, `readStorage`, `runJS(scan dangerous)`, `httpRequest(withCredentials)` | dangerous |

`severity.ts` 的 `classifyTool` 加上述新工具的分支。

## 5. 自动通过策略

### 5.1 三级判定

```typescript
export function autoApproves(
  severity: ToolSeverity,
  toolName: string,
  approveAllSafe: boolean,
  dangerousAllowlist: string[]
): boolean {
  if (severity === "safe") return true;
  if (severity === "caution") return approveAllSafe;
  if (severity === "dangerous") return dangerousAllowlist.includes(toolName);
  return false;
}
```

- safe — 总是 auto
- caution — `approveAllSafe` toggle 决定
- dangerous — 按 **工具名** 粒度的白名单决定

### 5.2 LlmSettings 增量

```typescript
export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiKeyMode: "persistent" | "session";
  maxRounds: number;
  endpoint?: string;
  /** dangerous 工具白名单。空数组 = 全部人工 */
  autoApproveDangerous: string[];
};
```

默认 `autoApproveDangerous: []`。

### 5.3 UI

**对话页底部 toolbar**（输入框上方一行）：

```
☑ 自动通过 caution     |   ⚠ dangerous 自动: 0/5  [▾]
                                                    ↓ click
                                                  ┌─────────────────────────────┐
                                                  │ ☐ submitForm                │
                                                  │ ☐ uploadFile                │
                                                  │ ☐ readStorage               │
                                                  │ ☐ httpRequest(withCred)     │
                                                  │ ☐ runJS(扫描命中)           │
                                                  │                             │
                                                  │ ⚠ 勾选 = 这一类不再人工审阅 │
                                                  └─────────────────────────────┘
```

**设置页**（"自动通过策略" section）：

```
☑ 自动通过 caution 工具

允许自动执行的 dangerous 工具：
  ☐ submitForm           — 提交表单（会触发服务端动作）
  ☐ uploadFile           — 上传文件
  ☐ readStorage          — 读 localStorage / sessionStorage
  ☐ httpRequest(带 cookie)  — 带登录会话发请求
  ☐ runJS(扫描命中)      — 含 cookie/eval/storage 的脚本

⚠ 勾选意味着这一类调用不再人工确认。
```

两处共用 `<DangerApprovalList>` 组件。

### 5.4 dangerous 标签显示

`severity.ts` 的 `classifyTool("runJS", input)` 仍按 source 内容动态判定。白名单是按 **当次解析后的 toolName** 匹配 —— `runJS` 在白名单里，则 dangerous 级别的 runJS 也自动通过。用户主动勾选，自负风险。

`httpRequest` 同理：input.withCredentials=true 时 severity=dangerous，白名单含 "httpRequest" 时自动通过。

## 6. 文案与 system prompt

### 6.1 替换表

| 位置 | 旧 | 新 |
|---|---|---|
| `package.json` `name` | `aipagego2` | `aipagego` |
| `package.json` `description` | （空） | `AIPageGo — AI 网页助手` |
| `manifest.name` | `aipagego2 — AI 网页采集器` | `AIPageGo — AI 网页助手` |
| `manifest.description` | `对话式 AI 采集 + 工具固化复用` | `让 AI 帮你浏览、总结、操作网页，并把成功的对话固化为可复用工具` |
| `manifest.action.default_title` | `aipagego2` | `AIPageGo` |
| `index.html <title>` | `aipagego2` | `AIPageGo` |
| `app.tsx <h1>`（如有） | `aipagego2` | `AIPageGo` |
| `console.info("[aipagego2] ...")` | `[aipagego2]` | `[aipagego]` |
| 输入框 placeholder | `描述要采集什么…（Ctrl/⌘ + Enter 发送）` | `要让 AI 做什么？例如"总结此页"/"填写注册表单"/"采集前 50 条评论"（Ctrl/⌘ + Enter 发送）` |
| 空 chat 提示 | `输入指令，让 AI 帮你浏览、总结、操作或采集网页…` | （新增） |
| save dialog 默认名 | `采集器 ${date}` | `AIPageGo 任务 ${date}` |
| **IDB DB_NAME** | `"aipagego"` | **不变** |
| 仓库目录路径 | `aipagego2` | spec 收尾后用户手动 `mv` |
| 包 import 别名 `@/...` | 不变 | 不影响功能 |

### 6.2 system prompt 重写

`src/sidepanel/llm/system-prompt.ts`：

```typescript
export function buildSystemPrompt(input: { url: string; title?: string }): string {
  return [
    "你是 AIPageGo，一个嵌入到浏览器侧边面板的 AI 网页助手。",
    "用户在浏览网页时会请你完成各种任务：",
    "",
    "1. 阅读类：总结、翻译、提取重点、回答关于本页内容的问题",
    "2. 采集类：把图片、文本、列表、评论结构化抓出来给用户",
    "3. 操作类：填写表单、点击按钮、选择下拉、提交表单、上传文件",
    "4. 多步任务：上述任意组合",
    "",
    "工具使用建议：",
    "- 拿到任务先用 snapshotDOM 看一下页面骨架；不确定时用 querySelector* /",
    "  extractText / extractFormState 探查",
    "- 操作前先 hover/focus 把目标节点带到视野内（可选）",
    "- 表单填写：fillInput / setCheckbox / selectOption 优先；按用户描述映射",
    "  字段名，不确定就先用 extractFormState 列出可填字段",
    "- 提交类（submitForm / uploadFile / 带 cookie 的 httpRequest）会触发服务",
    "  端动作，用户可能要求你最后再做、或不要做",
    "- 仅在结构化工具不足时调用 runJS（会经过静态扫描与人工审阅）",
    "",
    "完成任务后用一段简短文本总结，并以 JSON 形式给出最终输出（结构与字段尽量",
    "稳定，方便后续重放）。",
    "",
    "注意：所有工具调用对当前用户可见，dangerous 级别（cookie/eval/withCred/",
    "storage 读取/submitForm/uploadFile）需要明确审阅。",
    "",
    `当前页面 URL: ${input.url}`,
    input.title ? `页面标题: ${input.title}` : ""
  ].filter(Boolean).join("\n");
}
```

## 7. 错误处理

| 场景 | 行为 |
|---|---|
| 选择器命中 0 个节点 | 抛 `selector miss: <selector>` |
| 节点不是预期类型（fillInput 给了 div） | 抛 `not an input/textarea/contenteditable: <selector>` |
| `selectOption` value/label 都不匹配 | 抛 `option not found: value=X label=Y` |
| `uploadFile` 跨域 fetch 失败 | 抛 `download failed: <reason>` |
| `uploadFile` 站点用 isTrusted 拒绝 | 工具返回 `{ok:true, warning:"target site requires user-initiated upload"}`；不抛错，让 AI 决策 |
| `submitForm` 找不到 form | 抛 `form not found` |
| 自动通过白名单含 X 但 X 当次 args 异常 | 仍 auto（白名单按工具名粒度） |
| 用户中途取消勾选 dangerous | 不撤已发出去的 step；下个该类工具变回人工 |

所有错误回灌为 `tool_result is_error:true` 给 AI，由其决策。**不直接终止会话**——与 Plan 2 一致。

## 8. 模块边界与文件结构

```
aipagego2/                                  ← 仓库目录暂不动
├─ package.json                          # MOD: name → aipagego, description
├─ README.md                             # MOD: 全篇重写为"网页助手"
├─ src/
│  ├─ manifest.ts                        # MOD: name/description/title
│  ├─ background/
│  │  ├─ index.ts                        # MOD: console 前缀
│  │  ├─ rpc-handlers.ts                 # MOD: 加 http.fetchBinary case
│  │  └─ http-proxy.ts                   # MOD: 加 fetchAsBase64
│  ├─ shared/
│  │  ├─ types.ts                        # MOD: BuiltinTool union 加 9 个；
│  │  │                                          LlmSettings 加 autoApproveDangerous
│  │  └─ messages.ts                     # MOD: 加 http.fetchBinary
│  ├─ content/
│  │  ├─ index.ts                        # MOD: console 前缀
│  │  └─ tools/
│  │     ├─ index.ts                     # MOD: 注册新 9 个
│  │     ├─ fill-input.ts                # NEW
│  │     ├─ set-checkbox.ts              # NEW
│  │     ├─ select-option.ts             # NEW
│  │     ├─ submit-form.ts               # NEW
│  │     ├─ hover.ts                     # NEW
│  │     ├─ focus.ts                     # NEW
│  │     ├─ upload-file.ts               # NEW
│  │     ├─ get-value.ts                 # NEW
│  │     └─ extract-form-state.ts        # NEW
│  └─ sidepanel/
│     ├─ llm/
│     │  ├─ tool-schema.ts               # MOD: 加 9 个 LlmTool def
│     │  └─ system-prompt.ts             # MOD: 全场景重写
│     ├─ chat/
│     │  ├─ severity.ts                  # MOD: 新签名 + 9 个分类
│     │  ├─ run-session.ts               # MOD: autoApproves 新签名
│     │  └─ settings-store.ts            # MOD: 默认 autoApproveDangerous: []
│     ├─ pages/
│     │  ├─ chat-page.tsx                # MOD: 加 DangerApprovalPopover；
│     │  │                                  placeholder + empty 文案
│     │  └─ settings-page.tsx            # MOD: 加 DangerApprovalGroup
│     └─ components/
│        ├─ danger-approval-list.tsx     # NEW: 5 项复选框（共用）
│        ├─ danger-approval-popover.tsx  # NEW: 对话页折叠按钮 + List
│        ├─ danger-approval-group.tsx    # NEW: 设置页常驻 List
│        ├─ chat-view.tsx                # MOD: empty state 文案
│        └─ save-as-tool-dialog.tsx      # MOD: 默认名
└─ tests/
   ├─ content/tools/
   │  ├─ fill-input.test.ts              # NEW (4)
   │  ├─ set-checkbox.test.ts            # NEW (2)
   │  ├─ select-option.test.ts           # NEW (3)
   │  ├─ submit-form.test.ts             # NEW (2)
   │  ├─ hover.test.ts                   # NEW (2)
   │  ├─ focus.test.ts                   # NEW (2)
   │  ├─ upload-file.test.ts             # NEW (3)
   │  ├─ get-value.test.ts               # NEW (4)
   │  └─ extract-form-state.test.ts      # NEW (3)
   └─ sidepanel/chat/
      ├─ severity.test.ts                # MOD: 加 5 case
      └─ run-session.test.ts             # MOD: 加 1 case
```

新增 31 个 test。total 88 + 31 = **119 tests**。

## 9. 测试策略

| 层 | 工具 | 重点 |
|---|---|---|
| 单元 | vitest + happy-dom | 9 个新工具：DOM 操作 + 事件派发 + 错误路径 |
| 单元 | vitest | severity 加测：5 个 dangerous 工具白名单；空白名单 fallback |
| 单元 | vitest（mock chrome.runtime） | upload-file: BG.fetchAsBase64 RPC 模拟 |
| 集成 | 已有 | 不变 |
| e2e | 手动 | README 里加 3 个手测脚本：总结 / 填表（GitHub 评论框 / 注册表单）/ 采集 |

## 10. 已知限制（spec 显式记录）

- **uploadFile 不保证成功**：仅模拟 input.files + change，不能合成 isTrusted 拖拽事件；上传到 Cloudflare 验证、Google Drive 等严校验站点会失败
- **submitForm 不等待页面跳转**：调用后立即返回；如果表单提交后 navigate 到新 URL，下一步可能在新页面执行——AI 用 `waitFor` 或 `snapshotDOM` 重新探测
- **没有 navigate 工具**：本计划不加跨页面导航；用户切 tab 是用户的事
- **没有 keypress 工具**：键盘事件（Enter / 上下方向键自动补全）不支持，需要时让 AI 用 runJS 派发 KeyboardEvent
- **dangerous 白名单是工具名粒度**：勾选 `submitForm` 后所有 submitForm 调用都自动通过，不区分 args 中的 form selector

## 11. 范围内 vs 不在 Plan 3

**在**：第 4-8 节列出的所有 NEW + MOD。

**不在**（明确推迟）：
- navigate（chrome.tabs.update）
- keypress / 拖拽
- 多 tab 协作
- 多模态截屏
- 自动备份开关
- e2e 自动化
- 仓库**目录**重命名（spec 完成后用户自行 `mv ~/code/aipagego2 ~/code/aipagego`）

## 12. 评审与下一步

本文档评审通过后调用 writing-plans 技能产出 Plan 3 实施计划。计划预期 25-30 task，按以下里程碑：

1. shared types + messages + severity + settings store 增量
2. background http-proxy.fetchAsBase64 + RPC handler
3. 9 个新工具（一个一 task，TDD）
4. tool-schema + system-prompt 重写
5. UI（DangerApprovalList/Popover/Group + 文案）
6. 重命名（package.json / manifest / README / console 前缀）
7. 全量回归（119 tests + 手测）
