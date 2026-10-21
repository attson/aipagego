# 短中期 6 特性设计（追平 AIPex 体验差距）

**状态**：草稿 · 2026-06-14 · 作者：assistant + attson

把 [AIPex 差异对比](../../../README.md) 后的 7 项短/中期差距合并实装。一份 spec、一份 plan、一次 ship。每个特性独立模块、互不耦合，只是打包发布。

## 1 · 目标 & 非目标

**目标**
- S1 主题切换（light / dark / system，dark 仍是默认）
- S2 Update banner（GitHub release tag 比对，新版本提示）
- S2 Per-message actions（每条 assistant 消息出复制 / 重生成）
- S3 @ picker 加 Tools 类（已保存工具可以被 @ 引用做后续话题源）
- S5 跨 tab pending prompt（context menu / 外部链接唤起 sidepanel 带 prompt）
- S6 Conversation 心跳 + 页面 breathing border（content script 给页加发光边）
- S4 Intervention modal（AI 中途 SelectionCard / ConfirmCard 弹窗向用户征询）

**非目标**
- 语音输入 / 图片 / i18n（留下次）
- 多 agent 编排
- 非 BYOK 托管账号
- ZenFS / QuickJS 沙箱

## 2 · 整体形态

每个特性是一个独立模块；shell / store 改动有限。

```
shell/
  app-shell.tsx                       ← 调用 update-banner + cross-tab prompt + heartbeat
  theme-provider.tsx       (S1)        ← 新
  update-banner.tsx        (S2)        ← 新

chat/
  message-actions.tsx      (S2)        ← 新 per-message 操作
  heartbeat.ts             (S6)        ← 新 chrome.storage.local 心跳 writer
  intervention-store.ts    (S4)        ← 新 zustand store + manager
  intervention-ui.tsx      (S4)        ← 新 SelectionCard / ConfirmCard overlay

input/
  mention-picker.tsx                   ← 改：加 Tools 类（S3）

background/
  context-menu.ts          (S5)        ← 新 chrome.contextMenus + storage handshake
  pending-prompt.ts        (S5)        ← 新 helper（write/read with 5s TTL）

content/
  breathing-border.ts      (S6)        ← 新 content script 给 body 加 ::after 发光边
```

## 3 · S1 · 主题切换

### 3.1 形态
- Settings drawer → LLM section 上方新增一个 「外观」section：3 个 radio: `light / dark / system`，默认 `dark`
- 持久化到 `chrome.storage.local: aipagego.theme`
- 整体 sidepanel 容器加 `data-theme="light|dark"`，所有色用 CSS 变量

### 3.2 Token 切换
新建 `src/sidepanel/theme.css`：
```css
:root, [data-theme="dark"] {
  --bg-0: #0c0c0e;
  --bg-1: #18181b;
  --bg-2: #27272a;
  --bg-3: #3f3f46;
  --fg-0: #fafafa;
  --fg-1: #d4d4d8;
  --fg-2: #a1a1aa;
  --fg-3: #71717a;
  --border: #27272a;
  --accent: #2563eb;
}
[data-theme="light"] {
  --bg-0: #fafafa;
  --bg-1: #ffffff;
  --bg-2: #f4f4f5;
  --bg-3: #e4e4e7;
  --fg-0: #18181b;
  --fg-1: #27272a;
  --fg-2: #52525b;
  --fg-3: #71717a;
  --border: #e4e4e7;
  --accent: #2563eb;
}
```

Tailwind extend 让 `bg-canvas / bg-surface / text-fg / border-edge` 等语义类映射到变量。所有现有 `bg-zinc-XXX` / `text-zinc-XXX` 全文件替换为新语义类。

### 3.3 ThemeProvider
```tsx
// shell/theme-provider.tsx
type Theme = "light" | "dark" | "system";
function getResolved(t: Theme): "light" | "dark" {
  if (t !== "system") return t;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
// 监听 matchMedia change；data-theme 加到 root；persist to chrome.storage
```

### 3.4 范围控制
**只换 sidepanel 内部**。content script 注入的 breathing border 自带色（深色半透明发光），不参与 theme。

## 4 · S2 · Update banner + Per-message actions

### 4.1 Update banner
- `shell/update-banner.tsx`：sidepanel boot 后 fetch `https://api.github.com/repos/attson/aipagego/releases/latest`，取 `tag_name`，跟本地 `package.json.version`（通过 vite define 注入 `__APP_VERSION__`）比对。
- 高于当前 → 在 header 下出一条横条：`有新版本 v0.0.28（当前 v0.0.27）[查看 release]`。点关闭后写 `chrome.storage.local: aipagego.dismissed_update = "v0.0.28"`，同 tag 不再提醒。
- 失败 / 离线 / rate limit → 静默。
- 24h 缓存 in storage，避免每次开 sidepanel 都打 API。

### 4.2 Per-message actions
- 在 `components/message-bubble.tsx`（如果不存在则改 `components/chat-view.tsx` 渲染 assistant 消息处）：每个 assistant 文本气泡右下挂 2 个小按钮
  - `复制`：navigator.clipboard.writeText(纯文本)
  - `重生成`：仅在该消息是 messages 末位时显示。点击 = 把这条 assistant message 删掉 + 重新 send 上一条 user message
- 按钮平时隐藏，hover 出现（用 `group-hover:opacity-100`）

### 4.3 重生成实现
- 加 `regenerateLast(tabId)` 到 session-store：
  1. 找最后一条 assistant message
  2. 删除它 + 它对应的所有 cards
  3. 找上一条 user message，调用 `send(prompt)` 等价逻辑

## 5 · S3 · @ picker 加 Tools

### 5.1 形态
现 picker 只有 Tabs 一类。加 Tools tab，旁边 segmented control：`Tabs | Tools`

### 5.2 数据源
`rpc.listTools()` 已有。picker 加载所有工具，按 URL pattern 匹配当前页排前面（绿色高亮）。

### 5.3 行为
- 选中工具 → 插入 `@tool:{toolName}` 文本标记到 textarea
- 当前 spec：发送时不做 tool 自动调用（不影响 chat loop），只是文本化引用，让 LLM 知道用户提到了哪个工具
- 后续可以扩展为 system prompt 注入"用户提到了 {toolName} 工具，定义为 {steps}"

### 5.4 键盘
Tab 切换 Tabs ↔ Tools；↑↓ 在当前列表内动；Enter 选中。

## 6 · S5 · 跨 tab pending prompt

### 6.1 入口
两种方式：
- **Context menu**（右键）："让 AIPageGo 处理"，子菜单：`总结此页 / 提取此选区 / 自定义...`
- **External URL handler**（暂缓，本次只做 context menu）

### 6.2 流程
1. 用户右键 → 选项
2. background.ts 把 prompt 写 `chrome.storage.local: aipagego.pending_prompt = {text, ts, sourceUrl}`
3. background.ts 调 `chrome.sidePanel.open({tabId})` 唤起当前 tab 的 sidepanel
4. sidepanel boot 时 `usePendingPrompt()` hook 读取（5s TTL，过期忽略），写到 input、自动发送（或仅填充等用户回车——配置项）
5. 读完即删

### 6.3 注册的菜单项
固定 3 个：
```ts
chrome.contextMenus.create({ id: "summarize", title: "AIPageGo: 总结此页", contexts: ["page"] });
chrome.contextMenus.create({ id: "extract", title: "AIPageGo: 处理此选区", contexts: ["selection"] });
chrome.contextMenus.create({ id: "custom", title: "AIPageGo: 让 AI 处理…", contexts: ["page", "selection"] });
```

`custom` 不带 prompt，仅唤起 sidepanel 并 focus input。

### 6.4 Settings toggle
Settings → Mounting section 加：「右键菜单」开关，默认 on。off 时不注册 contextMenus。

## 7 · S6 · Conversation 心跳 + 页面 breathing border

### 7.1 心跳 writer
- `chat/heartbeat.ts`：每 2s 写 `chrome.storage.local: aipagego.active = {ts, tabId, sessionStatus}`
- 由 AppShell 监听 `session.status`，进 `streaming/awaiting/running` 时 start，进 `idle/done/error/aborted` 时 stop（清掉 key）
- 关 sidepanel = visibilitychange hidden → 也清掉

### 7.2 Content script overlay
新建 `content/breathing-border.ts`，每 tab 注入（已经在 manifest content_scripts 里跑）：
- listen `chrome.storage.onChanged` 监 `aipagego.active`
- 当 `aipagego.active.tabId === currentTabId` 时给 `document.body` 加 class `aipagego-breathing`
- 用 `<style>` 注入：
```css
body.aipagego-breathing::after {
  content: ""; position: fixed; inset: 0;
  pointer-events: none; z-index: 2147483647;
  border: 3px solid transparent;
  border-image: linear-gradient(90deg, #10b981, #3b82f6) 1;
  animation: aipagego-breath 1.4s ease-in-out infinite;
}
@keyframes aipagego-breath {
  0%, 100% { opacity: 0.3 }
  50% { opacity: 0.85 }
}
```

### 7.3 多 tab attach 时怎么算
- AI 操作了 attached tab B → B 的 breathing border 也亮。
- 实现：心跳里加 `attachedTabIds: number[]`，content script 自己 tab id 在这个列表 OR 等于主 tab 时亮。

### 7.4 用户感知 toggle
Settings → Mounting section 加：「AI 跑动时给页面发光边」开关，默认 on。

## 8 · S4 · Intervention modal

### 8.1 形态
AI 在跑动中可以"暂停问用户"，比如：
- 「页面上有 3 条相似商品候选，你想要哪一个？」→ SelectionCard，渲染 3 个选项 + 用户点一个
- 「确认要提交订单吗？」→ ConfirmCard（其实是 dangerous 工具审批的另一种皮肤）

跟现有 StepCard 审批不同的是：**Intervention 是 LLM 主动调出来的**（通过专用 tool），不是某个工具调用的副作用。

### 8.2 新增 BuiltinTool `askUser`
schema：
```ts
{
  prompt: string;           // 问题文本，渲染在卡片顶部
  kind: "select" | "confirm" | "text";
  options?: Array<{ id: string; label: string; description?: string }>;  // select 时必填
}
```
返回：用户选择的 `{ id, value }` 或 `{ cancelled: true }`

### 8.3 UI
overlay 模态卡，居中显示，跟 dangerous-confirm modal 一个层级。卡片样式：
- `confirm`：标题 + body + 两按钮（取消 / 确认）
- `select`：标题 + 选项列表（行点击）
- `text`：标题 + textarea + 提交按钮

用户操作完成后 = `askUser` 工具返回结果 → LLM 在下轮使用。

### 8.4 与 dangerous gate 的关系
- dangerous 审批仍走 StepCard 内的 inline 按钮（已有）
- Intervention modal 仅服务 `askUser` 工具
- 二者不互替；但 UI 风格保持一致（同 modal shell）

### 8.5 心智模型
让 AI "可以问回来"是个能力解锁。typical flow：
```
[user] 帮我下单这件衣服
[ai]   askUser({ kind: "select", prompt: "页面上有 3 个尺码，你要哪个？", options: [...] })
[user] 点 M
[ai]   ... 继续 click 按钮 + submitForm
```

## 9 · 文件计划

**新增（13）：**
```
src/sidepanel/
  theme.css                            S1
  shell/theme-provider.tsx             S1
  shell/update-banner.tsx              S2
  chat/heartbeat.ts                    S6
  chat/regenerate.ts                   S2（helper）
  chat/intervention-store.ts           S4
  components/message-actions.tsx       S2
  components/intervention-overlay.tsx  S4
  drawers/settings/section-appearance.tsx  S1

src/background/
  context-menu.ts                      S5
  pending-prompt.ts                    S5

src/content/
  breathing-border.ts                  S6

src/sidepanel/
  hooks/use-pending-prompt.ts          S5
```

**修改：**
- `src/sidepanel/main.tsx`：包 `<ThemeProvider>`
- `src/sidepanel/index.css`：import `./theme.css`
- 所有 sidepanel `.tsx`：把 `bg-zinc-XXX / text-zinc-XXX` 替换为 `bg-surface / text-fg-X` 等语义类（脚本批量）
- `src/sidepanel/input/mention-picker.tsx`：加 Tools tab
- `src/sidepanel/input/input-toolbar.tsx`：把 Tools 数据传进 picker
- `src/sidepanel/shell/app-shell.tsx`：装 UpdateBanner + InterventionOverlay + 心跳 effect + pending prompt hook
- `src/sidepanel/components/chat-view.tsx`：加 MessageActions
- `src/sidepanel/chat/session-store.ts`：加 `regenerateLast` 动作
- `src/sidepanel/drawers/settings/section-mounting.tsx`：加 breathing border + 右键菜单 toggle
- `src/sidepanel/drawers/settings-drawer.tsx`：插入 SectionAppearance
- `src/background/index.ts`：注册 context menu + 心跳清理
- `src/manifest.ts`：加 `contextMenus` 权限；breathing-border content script 在 `content_scripts` 注册
- `src/sidepanel/lib/builtin-tool-defs.ts`：加 `askUser` 工具定义
- `vite.config.ts`：define `__APP_VERSION__`

## 10 · State 变化

`session-store.ts`：
- 新增 `regenerateLast(tabId, send: Function)` —— 仅 helper，不存新字段
- 新增 `appendInterventionRequest(...)` 由 askUser 工具触发

`settings-store.ts`：
- 新增字段 `theme: 'light'|'dark'|'system'`（默认 'dark'）
- 新增字段 `breathingBorder: boolean`（默认 true）
- 新增字段 `contextMenuEnabled: boolean`（默认 true）
- 新增字段 `autoSendPendingPrompt: boolean`（默认 true）

新建 `intervention-store.ts`：
```ts
type InterventionState = {
  current: { id, kind, prompt, options? } | null;
  resolve: (result) => void;
};
```

## 11 · 测试

- 主题切换：theme-provider unit；section-appearance click 切换；matchMedia 模拟系统主题
- Update banner：mock fetch；mock storage cache；mock dismiss
- Per-message actions：复制 / 重生成 hover 可见 + 触发；regenerateLast 删 + send
- @ picker Tools：列出 + 排序 + 选中插入文本
- 心跳：start/stop 跟 session.status 联动 + storage 写入
- breathing border：content script 监 storage change + class toggle
- intervention：askUser 工具 → store → overlay 渲染 → 用户选 → resolve
- contextMenu：onClicked → storage write → sidePanel.open

## 12 · 风险

| 风险 | 缓解 |
|---|---|
| 全文件 `bg-zinc-XXX` → 语义 token 替换出错 | 用脚本 + grep 校验；典型映射 zinc-900→bg-surface, zinc-950→bg-canvas, zinc-100→fg-0 等 |
| Breathing border 影响目标页布局 / 事件 | `position: fixed`, `pointer-events: none`, 仅 `::after`；多页验证 |
| Context menu 在某些站点不可用 | 注册时 try/catch；失败静默 |
| `askUser` LLM 调用错（误用作日常 chat） | 系统提示词加示例 + 限制：只在多歧义 / 需要授权时调 |
| Update banner 触发 GitHub rate limit | 24h 缓存 + 失败静默 |

## 13 · Out of scope

- @ picker 的 History / Skills 类（保留 spec §15）
- 语音输入 / 图片 / i18n / 浅色之外的主题 token 色调
- Auth / SSO

## 14 · 本轮推迟

**S1 主题切换推迟到独立 ship**：实装中发现要把所有 sidepanel 文件里 `bg-zinc-XXX / text-zinc-XXX` 全量换成语义类，颗粒度跟其它 5 个完全不同，容易引入大量回归。本次 PR 只包含 S2/S3/S4/S5/S6 五个特性。S1 独立走一份 spec。
