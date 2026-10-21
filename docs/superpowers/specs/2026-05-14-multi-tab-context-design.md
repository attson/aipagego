# 多标签页上下文：一个会话访问多个 tab — 设计文档

- 日期：2026-05-14
- 状态：草案，待评审
- 范围：让一次 AIPageGo 会话可以读写多个浏览器 tab 的数据；保留现有 per-tab 会话隔离作为默认，跨 tab 是显式扩展
- 前置：Plan 4（Per-Tab 会话）已落地

## 1. 背景与目标

当前 AIPageGo 一个会话只能操作绑定的那个 tab（`sessionsByTab` + `currentTabId`，见 `2026-05-10-plan4-per-tab-sessions-design.md`）。但用户在做对比、汇总、跨页核对一类的分析时，常常需要把多个已打开 tab 的数据放到同一段对话里判断。例如：

- 同款商品在多个电商平台的价格、规格、评价横向对比
- 同一篇报告分散在三个内部页面里，让 AI 汇总成一篇
- 在 A tab 查到一条线索后，让 AI 顺着到 B、C tab 取证

目标是让一个会话**有受控地**访问多个 tab。"受控"指三条信任入口都明确：用户主动 `@` 指定、AI 自己 `openTab` 打开（或被动新开）、AI 中途请求访问其他已存在 tab。所有跨 tab 访问对用户可见、可撤销、可在设置里预批准。

非目标：

- 不做侧边面板内"多个聊天会话并排"的 UI；一个会话还是一个 chat view
- 已保存的 Steps tools 仍然单 tab 语义，不支持跨 tab 重放
- 不持久化跨浏览器重启的 attached 状态
- 不做隐身窗口 tab 支持（第一版过滤掉）
- 不支持多 side panel 实例之间共享会话

## 2. 产品决策

| 决策点 | 选择 |
|---|---|
| 信任入口 | 三种：`@` 指定 / AI `openTab` 或被动新开 / AI 主动 `attachTab` 请求 |
| 已附加 tab 在会话内的权限 | 读 + 写（与会话主 tab 一致），单次工具调用仍按各自 severity 走审批 |
| `@` 附加持续期 | 整个会话期间一直附着，可手动 × 解附 |
| AI "主动访问其他 tab" 的批准粒度 | 按 tab：同意一次后该 tab 进入"本会话可读写"名单，后续不再问 |
| 跨窗口 | 支持，`listTabs` 返回全部窗口 |
| tab URL 变化后 | 保留附着但标 `urlChanged=true`，不自动解附；UI 显示红 ⚠ |
| tab 被关 | 自动解附 + 消息流推系统提示 |
| 已保存 Steps tools 行为 | 保持单 tab；不接受 `tabId` 参数 |
| 预批准入口 | 复用现有 `LlmSettings.autoApproveDangerous` 名单，加候选项 `attachTab` |

## 3. 数据模型

会话维度新增 `attachedTabs`，存在已有的 `SessionData` 上（已经按 primary tabId 分桶、跟着 `closedSessions` 走 5 分钟回收，无需新存储位）。

```ts
// shared/types.ts
export type AttachedTabSource = "mention" | "ai-open" | "approval";

export type AttachedTab = {
  tabId: number;
  windowId: number;
  source: AttachedTabSource;
  addedAt: number;
  lastSeenUrl: string;
  lastSeenTitle: string;
  /** tab 离开了 addedAt 时的 URL 后置 true；不会自动解附 */
  urlChanged?: boolean;
};

// 修改 SessionData
export type SessionData = {
  // ... 现有字段
  attachedTabs: AttachedTab[];
};
```

判定规则：

- 会话主 tab（`currentTabId`，chat-page 绑定的那个）**隐式可读写**，不出现在 chips、不出现在 `attachedTabs`
- 其它 `tabId` 必须出现在 `attachedTabs` 中才允许任何工具读写
- 同一 tabId 同时被多种入口加入，只保留首次 source（避免覆盖语义混乱）

## 4. 工具层改动

### 4.1 现有 19 个工具：可选 `tabId`

所有现有内置工具的 `input_schema` 加一个**可选** `tabId: number`：

- 省略 → 当前焦点 tab（行为不变）
- 提供 → 校验目标 tab 是焦点 tab 或在 `attachedTabs` 中；否则返回 `tool_result { is_error: true, content: "tab N not attached; call attachTab first or pick another tabId" }`，**不打断会话循环**
- 已保存的 Steps tools 反序列化时不引入 `tabId`，运行时仍只跑在调用 tab

`Step` schema 不变（`StepSchema` 里的 `args` 是 `z.unknown()`，自然兼容多出来的 `tabId` 字段；运行时校验在 background runOneStep 处）。

### 4.2 新增 4 个控制面工具

| 工具 | 入参 | 出参 | severity |
|---|---|---|---|
| `listTabs` | `{ windowId?: number }` | `{ tabs: Array<{tabId, windowId, url, title, attached: boolean, isCurrent: boolean}> }` | caution |
| `openTab` | `{ url: string, active?: boolean }` | `{ tabId, url, title }`；成功后自动入 `attachedTabs`，source=`ai-open` | caution |
| `attachTab` | `{ tabId: number, reason?: string }` | `{ ok: true }`；未预批准时通过审批流向用户索 | caution |
| `detachTab` | `{ tabId: number }` | `{ ok: true }` | safe |

`autoApproveDangerous` 名单可勾选 `attachTab`，用户预批后此后跨 tab 请求免询。

### 4.3 工具层过滤

`listTabs` 过滤掉：

- `chrome://*` / `chrome-extension://*` / `about:*` / `edge://*` 等扩展无 host_permissions 的 URL
- 隐身窗口的 tab（`tab.incognito === true`）
- 已被 discard / pending 的 tab（`tab.discarded === true`，可选行为：列出但标灰，工具调用前自动 reload）

`openTab` 拒接同类协议 URL，返回 tool_result error。

## 5. RPC 层改动（background）

### 5.1 新增 RPC 类型

```ts
// shared/messages.ts
{ type: "tabs.list", windowId?: number }
  → RpcOk<{ tabs: Array<{tabId, windowId, url, title}> }>

{ type: "tabs.open", url: string, active?: boolean }
  → RpcOk<{ tabId, url, title }>
```

`attachTab` / `detachTab` 是纯 sidepanel session-store 操作（更新 `attachedTabs`），不走 RPC。

### 5.2 runOneStep 权限闸

`runs.runOneStep` 的 schema 扩一个字段：

```ts
{
  type: "runs.runOneStep",
  step: StepSchema,
  tabId: number,              // 仍是默认要发到的 tab
  attachedTabIds: number[],   // 新增：sidepanel 持有的可读写白名单
  bindings: z.record(z.unknown()).default({})
}
```

BG handler 处理顺序：

1. 解析目标 tab：
   - `step.kind === "tool"`（内置工具调用，包括 LLM 调用 `runJS` 工具的情况）：取 `args.tabId`，没有则用 RPC.tabId
   - `step.kind === "js"`（saved Steps tools 中的 JS step）：始终用 RPC.tabId，**不接受 `tabId` 覆盖**；saved tool 单 tab 语义见 4.1
2. 校验：目标 tab 必须等于 RPC.tabId（即 sidepanel 当前会话主 tab）或在 RPC.attachedTabIds 中；否则直接返回 `RpcErr("tab N not attached")`，runner 把它包成 `is_error tool_result`
3. 通过则按现有逻辑派发到 content script / MAIN world，复用 inject-on-missing-receiver 重试

为什么把白名单从 sidepanel 传过来而不是 BG 自己存：sidepanel 才是会话状态的真实持有者，BG 是无状态 worker 且会休眠；让 BG 持镜像会引入同步问题。每个 runOneStep 把白名单一起带上是 stateless 设计，开销可忽略。

### 5.3 tab-watcher 扩展

`background/tab-watcher.ts` 现有逻辑：监听 `chrome.tabs` / `chrome.webNavigation` → 更新 badge + 推送 `tabs.recommendations` 给 sidepanel。

新增三个推送（保持 push 模型，sidepanel 拉一次会话状态）：

| 事件 | 触发 | 推送内容 |
|---|---|---|
| `tabs.spawned` | `chrome.tabs.onCreated` 且 `openerTabId` 命中本扩展任一活动会话的主 tab 或 attached tab | `{ tabId, openerTabId, url, title, windowId }` |
| `tabs.urlChanged` | `chrome.tabs.onUpdated` 的 status=`complete` 且 URL 与 sidepanel 上次告知的 attached URL 不同 | `{ tabId, newUrl, newTitle }` |
| `tabs.removed` | `chrome.tabs.onRemoved` | `{ tabId }` |

sidepanel 通过 `onTabRecommendations` 同一通道扩展接收（或新开 `onTabEvents`，实现时择一即可，建议复用以减少 listener）。

sidepanel 收到 `tabs.spawned` 后：自动把新 tab 加入对应会话的 `attachedTabs`（source=`ai-open`），推一条 system 行进 messages：`🆕 AI 在 #167 打开了 example.com/page`。识别"对应会话"需要 sidepanel 自己维护 "`openerTabId` → sessionTabId" 的逆向索引（焦点 tab + 所有 attached 都算 opener 触发点）。

## 6. 侧边面板 UI

### 6.1 顶部 chips 栏

紧贴现有 "Tab #142 当前页 URL" 那一行之下：

```
[Tab #142] shop.example.com/goods.html?…
附加: [🛒 商品B ×] [🛒 商品C ×] [⚠ 商品D ×]  [+]
```

- 每个 chip：favicon + 截断 title（最长 ~20 char）+ × 按钮；hover 显示完整 URL
- `urlChanged=true` 的 chip：前缀红 ⚠，hover tooltip 显示原 URL 和当前 URL
- × 点击：从 `attachedTabs` 移除，不影响 tab 本身
- chip 数 = 0 时整行隐藏
- chip 数 ≥ 8 时折叠为 `[chip][chip] +N`，点 `+N` 展开

### 6.2 `+` 按钮 / `@` 触发器

`+` 按钮和输入框内输入 `@` 触发同一个 picker 组件：

- 列出所有窗口的可访问 tab，按 `windowId` 分组
- 每行：favicon + title + URL（小字）
- 点选 → 加入 `attachedTabs`，source=`mention`；`@` 触发的情况下从输入框文本里删掉触发用的 `@` 字符
- 输入框文本不留 `@xxx` 字面量——chip 就是上下文锚点，避免重复表达

### 6.3 AI 主动 attachTab 的批准 UI

复用现有 tool approval 行的样式，渲染在消息流中：

```
🔐 AI 想访问 Tab #167 (taobao.com/item?id=…)
   原因：对比另一家同款价格
   [允许一次]  [允许并始终通过 attachTab]  [拒绝]
```

- "允许一次"：本会话内允许该 tabId 进 `attachedTabs`；以后其它 tabId 仍要询问
- "允许并始终通过 attachTab"：在 `LlmSettings.autoApproveDangerous` 中追加 `"attachTab"`（与设置页勾选等价），此后任何 `attachTab` 都免询
- "拒绝"：返回 `tool_result { is_error: true, content: "user denied attachTab" }`

`attachTab` 当 `autoApproveDangerous` 包含自身时直接通过，不渲染审批行。

### 6.4 "AI 打开了新 tab" 的系统提示

`tabs.spawned` 到达 sidepanel 后，在对应会话的消息流插一条灰色 system 行：

```
🆕 AI 在 #167 打开了 example.com/page
```

让用户能看到也能立即手动 × 解附。

### 6.5 step-card 标题标记目标 tab

工具 step（step-card 组件）渲染时，如果 `args.tabId` 存在且不是会话主 tab：

```
[snapshotDOM → Tab #167]   caution   approved
```

确保审批弹窗 / 重放视图里不会把"在别的 tab 跑的操作"看成在主 tab 跑。

## 7. System prompt

`sidepanel/llm/system-prompt.ts` 输出新增段：

```
[Current tab]
#142 (focused): https://shop.example.com/goods.html?id=…

[Attached tabs]
#167 https://item.taobao.com/item.htm?id=…  (source: mention)
#189 https://detail.tmall.com/item.htm?id=…  (source: ai-open)

[Cross-tab protocol]
- Pass `tabId` in any tool input to act on a non-focused tab.
- Allowed tabIds: the focused tab + the attached list above.
- Call listTabs() to discover other open tabs.
- Call attachTab(tabId) to request access; user must approve.
- Call openTab(url) to spawn a new tab; it auto-attaches.
```

attached 数 > 8 时改成 `+N more, call listTabs() for the full list`，前 8 个仍列。

## 8. Severity 集成

`sidepanel/chat/severity.ts`：

```ts
const SAFE = new Set([
  // 现有...
  "detachTab"
]);

const CAUTION = new Set([
  // 现有...
  "listTabs",
  "openTab",
  "attachTab"
]);
```

`autoApproveDangerous` 的设置页 UI 展示区：除了现有 `readStorage / submitForm / uploadFile` 外，新增可勾选项 `attachTab`，标签写"始终允许 AI 跨 tab 访问"，配 tooltip 解释。

## 9. 错误与边界

| 场景 | 行为 |
|---|---|
| AI 用未 attached 的 tabId 调工具 | 返回 `is_error` tool_result，提示 "call attachTab first"；AI 收到后自行 attach |
| 工具调用中 tab 被关 | RPC 抛错 → 包装成 `is_error` tool_result；sidepanel 同步把它从 `attachedTabs` 移除 + 推 system 行 |
| 工具调用中 URL 变 | 步骤照常执行；执行完后 `onUpdated` 才标 `urlChanged`，避免半执行被打断 |
| `chrome://` / `about:` / 其它扩展页 | `listTabs` 不返回；`openTab` 该类 URL 直接拒，返回 tool_result error |
| 隐身窗口的 tab | 初版过滤掉，`listTabs` 不返回 |
| SW 唤醒后 attached tabId 已不存在 | sidepanel 启动时遍历 `attachedTabs` 校验 `chrome.tabs.get`，丢失的从集合移除 + 推 system 行 |
| `openTab` 后 chrome 新开但加载失败 | 仍记入 `attachedTabs`（用户可见、可手动 ×）；首次工具调用拿到的就是失败页内容 |
| 跨窗口聚焦切换 | 不影响；`currentTabId` 仍是 chat-page 绑定的那个 |
| sidepanel 切换会话（用户从 #142 切到 #200） | 各会话各自的 `attachedTabs` 互不干扰 |

## 10. 持久化与会话恢复

- `attachedTabs` 跟 `SessionData` 一起进 IndexedDB / `closedSessions`
- 5 分钟 closed 期内恢复时：遍历 `attachedTabs` 调 `chrome.tabs.get`，存在的保留、不存在的去掉
- 不跨浏览器重启持久化（已是非目标）

## 11. 测试

vitest + happy-dom + fake-indexeddb：

**单测**：

- `severity.ts`：4 个新工具分类
- `session-store.ts`：`attachTab` / `detachTab` / `onUrlChanged` / `onTabRemoved` actions；同一 tabId 重复 attach 保留首次 source
- `system-prompt.ts`：含 attached tabs 段；attached 数 > 8 截断
- 权限闸（在 rpc-handlers 单测里 mock chrome）：tabId 不在白名单 → 返回 RpcErr
- onCreated.openerTabId 命中 attached → 推 `tabs.spawned`
- closed-sessions 恢复路径：保留 attachedTabs；恢复时校验丢弃失效项

**手动 e2e**（无 Playwright）：

- 三入口都走一遍：`@` 选；AI 调 `openTab`；AI 调 `attachTab` 走审批
- 跨窗口：在第二个浏览器窗口的 tab 上做附加和读写
- URL 变：在附加 tab 上手动导航 → chip 出现红 ⚠
- tab 关：手动关附加 tab → chips 移除 + system 行
- SW 唤醒：等 sidepanel 闲置 > 30s 触发 SW 休眠，再发消息验证恢复
- 预批准：勾选设置里 `attachTab` 始终允许；AI 调 `attachTab` 不弹审批

## 12. 显式不做（YAGNI）

- 侧边面板内"多 chat 并列"UI
- Saved Steps tools 跨 tab
- 跨浏览器重启的 attached 持久化
- 多 side panel 实例之间共享会话
- attached tab 数量上限（不主动限制；超 8 个折叠 UI 已经在 #6.1）
- 自动按 URL 模式批量 attach（"打开所有匹配 X 的 tab"）
- 隐身窗口 tab

## 13. 兼容性 / 迁移

- `SessionData` 加 `attachedTabs` 字段：旧数据反序列化时缺失 → 默认 `[]`
- `LlmSettings.autoApproveDangerous` 无 schema 变化，只是允许多一个名称值
- 已保存的 Tools / RunRecord：不动；`Step.args` 反序列化不强制 `tabId` 字段
- 现有所有内置工具 input_schema 多了可选 `tabId`：对存量保存的 tools 无影响（schema 用于 LLM 描述，运行时不强校验）

## 14. 工作流位置

```
brainstorming  →  本 spec  →  writing-plans  →  plan (../plans/)  →  executing-plans
```

下一步：用户审阅本 spec → 通过 `superpowers:writing-plans` 出实施计划。
