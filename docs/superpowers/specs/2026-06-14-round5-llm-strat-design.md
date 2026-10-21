# Round 5 — LLM 策略升级 + AIPex 借鉴

**状态**：草稿 · 2026-06-14 · 作者：assistant + attson

把 AIPex 系统提示词 + 工具 schema 对比里的 Tier 1+2+3+4 一并实装。一份 PR、单 tag v0.0.31。

## 1 · 4 个 Tier

- **Tier 1 系统提示词重写**：ReAct 框架显式化 + TODO list 管理 + 任务分析模板 + worked examples + tool_calls 格式强制
- **Tier 2 工具描述升级**：每个工具加优先级标签（`[FAST]` / `[FIRST]`） + 内联示例 + DRY tabId 描述
- **Tier 3 小工具补全**：新增 `closeTab` / `switchToTab` / `searchBookmarks` / `searchHistory` / `downloadImage` 5 个 BuiltinTool
- **Tier 4 架构补丁**：基础版 UID-based interaction（`takeSnapshot` 返带 UID 元素 + `clickByUid` / `fillByUid` 调用）+ `highlightElement` / `highlightText` 视觉标注 + `fillForm` 多字段一发

## 2 · 非目标

- AIPex 的 ReAct **强制执行**（我们只是 prompt 建议，AI 可不遵循）
- AIPex 的「自动 switch_to_tab on context switch」机制（我们每 tab 一会话，不需要）
- 把 selector-based 工具全替换为 UID-based（**加新工具不破旧**）
- AIPex 的 computerTool（视觉坐标操作，留下一轮）

## 3 · Tier 1 · 系统提示词重写

### 3.1 新 prompt 结构（中英混合，根据用户语言切）

```
你是 AIPageGo，一个嵌入浏览器侧边面板的 AI 网页助手。

=== 工具调用格式 ===
当你调用工具时，必须使用标准 tool_calls 格式，禁止把 <|tool_call_begin|> 这类 marker 写在文本里。

=== 工作流程（ReAct 框架）===
对所有任务遵循 THINK → ACT → OBSERVE → REASON 循环：
1. THINK   - 分析当前情况和下一步
2. ACT     - 调用一个工具
3. OBSERVE - 看工具返回，更新理解
4. REASON  - 决定继续 / 收尾

=== 复杂任务：先建 TODO ===
任务涉及 3+ 步骤时，开头先生成 TODO list，每完成一项更新：
- [x] 已完成
- [ ] 未完成

格式：
📋 任务分析:
- 目标: <一句话目标>
- 复杂度: <简单|中|复杂>
- 需要的工具: <列出>
- 依赖关系: <什么需要先做>

📝 TODO:
- [ ] 第一步
- [ ] 第二步
...

=== 工具使用建议 ===
- 每次任务起手：snapshotDOM 或 takeSnapshot 看页面结构
- 不确定元素位置：querySelector* / search by extractText 探查
- 操作前可先 hover/focus 把节点带到视野
- 填表：fillForm 一发；不行再用 fillInput / setCheckbox / selectOption
- 不确定字段名：先 extractFormState 列出所有可填字段
- dangerous 工具（submitForm / uploadFile / readStorage / withCredentials httpRequest / 含 cookie/eval/storage 的 runJS）会被用户审阅，必要时主动用 askUser 让用户做决定
- 数据采集类任务：收尾前验证数据完整性（分页齐没、懒加载触发没、总条数对没）；不齐别总结

=== 跨 tab 协议 ===
本会话绑定 1 个主 tab。要操作主 tab：tabId 字段整个不填，不要 0 / null。
要操作其它 tab：tabId 必须先在 attachedTabs 里；用 listTabs 发现，用 attachTab 申请。

=== 示例 ===
[6 个 worked example — 见 §3.2]

=== 当前上下文 ===
URL: ...
Title: ...
已保存工具（URL 命中）: ...
已挂 tab: ...
```

### 3.2 6 个 worked examples

1. **简单**：「翻译这页第一段」→ extractText → 翻译
2. **采集**：「拿前 50 条评论」→ snapshotDOM → 找 API → httpRequest 翻页 → 累积 → 汇总
3. **填表**：「客户名张三、电话…比萨配料勾两个」→ extractFormState → fillForm → 不提交
4. **多 tab**：「比较 A 站和 B 站的价格」→ openTab(B) → 在两 tab 各 extractText → 对比
5. **危险操作**：「下单这件衣服」→ snapshot → askUser(尺码) → click → submitForm
6. **修复型**：「按钮没反应」→ snapshotDOM → 找按钮 → check disabled / waitFor enabled → click

### 3.3 实装

- `system-prompt.ts` 整段重写
- 加 `examplesBlock(examples)` 子函数让 examples 集中管理
- 加 `language` 参数（zh / en），根据用户最近一条消息检测

## 4 · Tier 2 · 工具描述升级

### 4.1 DRY tabId

抽 `TAB_ID_FIELD` 常量：
```ts
const TAB_ID_FIELD = {
  type: "integer",
  description: "目标 tab。操作主会话 tab 整个不填；操作其它 tab 必须先在 attachedTabs（用 attachTab 申请）"
};
```

每个工具的 `tabId` 字段从 17+ 处长描述改成 `tabId: TAB_ID_FIELD`。

### 4.2 优先级标签

每个工具描述前加标签，AI 一眼看优先级：

| 工具 | 标签 | 描述补充 |
|---|---|---|
| `snapshotDOM` | `[FIRST]` | 每次任务起手用 |
| `querySelector` | `[FAST]` | 探查具体节点 |
| `extractText` | `[FAST]` | 提取文本 |
| `screenshot` | `[VISION]` | 给 vision 模型看 |
| `askUser` | `[ASK]` | 卡住时用 |
| `runJS` | `[LAST RESORT]` | 结构化工具不够才用 |
| `submitForm` | `[CONFIRM]` | 用户必须审阅 |
| `fillForm` | `[BATCH]` | 一发填多字段 |

### 4.3 内联示例

挑几个高频工具，描述里加示例：

```ts
{
  name: "snapshotDOM",
  description: "[FIRST] 页面 DOM 摘要... \n\n示例：\n- 看整页：snapshotDOM({})\n- 看某区域：snapshotDOM({root: '.main-content'})\n- 看深层：snapshotDOM({maxDepth: 5})",
  ...
}
```

10 个工具加示例。

## 5 · Tier 3 · 5 个新 BuiltinTool

### 5.1 `closeTab`

control-plane 工具，关一个 tab。仅当 tabId 在 attachedTabs 时才允许（防止误关用户其它窗口）。返回 `{ok}`。

### 5.2 `switchToTab`

control-plane 工具，把 chrome 切到目标 tab（`chrome.tabs.update({active: true})` + window.focus）。返回 `{ok, tabId, url}`。

### 5.3 `searchBookmarks`

`{query: string, limit?: number}` → `chrome.bookmarks.search(query)`，过滤掉文件夹节点，返回 `[{id, title, url}]`。我们已经有 `loadBookmarks` 工具函数，加一个 query 版本即可。**SAFE 级。**

### 5.4 `searchHistory`

`{query: string, daysBack?: number, limit?: number}` → `chrome.history.search(...)`，返回 `[{url, title, lastVisitTime, visitCount}]`。需要 `"history"` 权限。**SAFE 级**（只读历史记录）。

### 5.5 `downloadImage`

`{url: string, filename?: string}` → `chrome.downloads.download({url, filename})`。返回 `{downloadId, filename}`。需要 `"downloads"` 权限。**CAUTION 级**（会写本地磁盘）。

## 6 · Tier 4 · 架构补丁（增量、不破旧）

### 6.1 UID-based 元素交互

**新增 3 个 BuiltinTool**（旧 `snapshotDOM` / `click` / `fillInput` 不动）：

#### `takeSnapshot`（替代品，但 NOT 替代）

```ts
{
  name: "takeSnapshot",
  description: "[FIRST·NEW] 抓页面 accessibility snapshot：返回 [{uid, role, name, tag, text, bounds}]。UID 在本次 snapshot 内稳定，可后续 clickByUid / fillByUid。比 selector 健壮——页面布局微调（class 变名）仍能复用。每次操作前刷新一次 snapshot。",
  input_schema: {
    type: "object",
    properties: {
      tabId: TAB_ID_FIELD,
      includeAll: { type: "boolean", default: false, description: "true=全部 element；false=只 interactive（默认）" }
    }
  }
}
```

实装：
- content script 新文件 `tools/take-snapshot.ts`
- 用 `document.querySelectorAll('button, a, input, textarea, select, [role], [data-testid]')` 找所有 interactive 元素
- 每个元素生成 uid（`el_<random>`）+ 用 `selectorFor()` 推 CSS selector
- 在 content script 模块级 WeakMap `uidCache: Map<string, string>`（uid → selector）保留 5 分钟
- 返回数组（不含 selector，AI 只看 uid）

#### `clickByUid` / `fillByUid`

```ts
{
  name: "clickByUid",
  description: "[BY-UID] 用 takeSnapshot 返回的 uid 点击元素。",
  input_schema: {
    type: "object",
    properties: { uid: { type: "string" }, tabId: TAB_ID_FIELD },
    required: ["uid"]
  }
}
{
  name: "fillByUid",
  description: "[BY-UID] 用 takeSnapshot 返回的 uid 填值（input/textarea/contenteditable）。",
  input_schema: {
    type: "object",
    properties: { uid: { type: "string" }, value: { type: "string" }, tabId: TAB_ID_FIELD },
    required: ["uid", "value"]
  }
}
```

实装：content script 从 uidCache 查 selector → querySelector → 复用 click / fillInput 现有内部实现。

### 6.2 视觉标注：`highlightElement` / `highlightText`

让 AI 给用户视觉提示。两个 BuiltinTool：

#### `highlightElement`

```ts
{
  name: "highlightElement",
  description: "[VISUAL] 给页面上某个元素加红色虚线框 3 秒，让用户知道你在说哪个。仅视觉用途，不点击不修改。",
  input_schema: {
    type: "object",
    properties: {
      selector: { type: "string" },
      uid: { type: "string", description: "或 takeSnapshot 返回的 uid" },
      ms: { type: "integer", default: 3000 },
      tabId: TAB_ID_FIELD
    }
  }
}
```

实装：content script 在元素上加临时 outline + 3s 后移除。**SAFE 级。**

#### `highlightText`

```ts
{
  name: "highlightText",
  description: "[VISUAL] 在页面文本里高亮某段文字 3 秒（黄色背景）。",
  input_schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      ms: { type: "integer", default: 3000 },
      tabId: TAB_ID_FIELD
    }
  }
}
```

实装：content script 找文本节点 → 包 `<mark>` → 3s 后还原。

### 6.3 批量填表：`fillForm`

```ts
{
  name: "fillForm",
  description: "[BATCH] 一次性填多个字段。每个字段写 selector + value 或 uid + value。返回 {filled: N, failed: [{selector, error}]}。",
  input_schema: {
    type: "object",
    properties: {
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            selector: { type: "string" },
            uid: { type: "string" },
            value: { type: "string" }
          },
          required: ["value"]
        }
      },
      tabId: TAB_ID_FIELD
    },
    required: ["fields"]
  }
}
```

实装：content script 内部循环调用 fillInput；收集成功/失败结果一次返回。**CAUTION 级。**

## 7 · 文件计划

**新增（13）：**
```
docs/superpowers/specs/2026-06-14-round5-llm-strat-design.md   (this)

packages/extension/src/content/tools/take-snapshot.ts          T4
packages/extension/src/content/tools/click-by-uid.ts           T4
packages/extension/src/content/tools/fill-by-uid.ts            T4
packages/extension/src/content/tools/highlight-element.ts      T4
packages/extension/src/content/tools/highlight-text.ts         T4
packages/extension/src/content/tools/fill-form.ts              T4
packages/extension/src/content/tools/uid-cache.ts              T4（共享模块级缓存）

packages/extension/src/background/storage/bookmarks.ts         T3
packages/extension/src/background/storage/history.ts           T3
packages/extension/src/background/storage/downloads.ts         T3

packages/extension/tests/sidepanel/llm/system-prompt.test.ts   T1
packages/extension/tests/content/tools/take-snapshot.test.ts   T4
packages/extension/tests/content/tools/fill-form.test.ts       T4
```

**修改：**
- `packages/extension/src/sidepanel/llm/system-prompt.ts`：整段重写 (T1)
- `packages/shared/src/llm/builtin-tool-defs.ts`：DRY tabId + 加 10 个新工具定义 + 加优先级标签和示例 (T2 + T3 + T4)
- `packages/shared/src/types.ts`：BuiltinTool 加 10 个新名（closeTab / switchToTab / searchBookmarks / searchHistory / downloadImage / takeSnapshot / clickByUid / fillByUid / highlightElement / highlightText / fillForm = 11 个）
- `packages/extension/src/sidepanel/chat/severity.ts`：SAFE/CAUTION 分类更新
- `packages/extension/src/sidepanel/chat/run-session.ts`：closeTab / switchToTab / searchBookmarks / searchHistory / downloadImage 走 control-plane（不进 content script）
- `packages/extension/src/sidepanel/shell/app-shell.tsx`：BG-side 工具回调（关 tab 等）通过 chrome.tabs API 直接调
- `packages/extension/src/content/tools/index.ts`：注册 6 个新 content-script 工具
- `packages/extension/src/manifest.ts`：加 `"history"` 和 `"downloads"` 权限

## 8 · State 变化

- `severity.ts SAFE` 加：`takeSnapshot`、`clickByUid`、`fillByUid`、`highlightElement`、`highlightText`、`searchBookmarks`、`searchHistory`、`switchToTab`、`closeTab`
- `severity.ts CAUTION` 加：`fillForm`、`downloadImage`
- `ReplayableTool` 不动（新工具都进可重放范围；askUser+screenshot 仍 exclude）

## 9 · 风险

| 风险 | 缓解 |
|---|---|
| 11 个新工具 LLM 调用混乱 | 用优先级标签 + 示例 + 系统提示词显式建议 |
| UID 系统跨 snapshot 失效 | uid 5min TTL；clickByUid 失败时返回明确错误「snapshot 过期，重 takeSnapshot」 |
| highlight 元素被页面 CSP 拦 | 用 inline outline style 而非注入 stylesheet；失败静默 |
| chrome.history 隐私 | `searchHistory` 在 Settings 加 toggle，默认 off；新会话 prompt 不会提它 |
| download 写本地误下大文件 | filename 限定后缀；同名追后缀；用户在 Chrome 通知能看到 |

## 10 · Out of scope

- AIPex 的 computerTool（视觉 XY 操作）
- AIPex 的 organize_tabs（AI 自动分组 tab）
- 旧 selector-based 工具的迁移（仍可用，新旧并行）
- prompt 多语言（仅 zh/en 切换，其它语言留默认 zh）
