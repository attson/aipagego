# Sidepanel UI 重构（AIPex 风格）

**状态**：草稿 · 2026-06-13 · 作者：assistant + attson

把 sidepanel 从「5-tab 顶导 + 多堆栏 chat 页」重构为「单 chat surface + 4 个右侧 drawer」，参考 AIPex 的 single-surface 哲学，同时保留 AIPageGo 自有的差异化产品概念（URL 匹配工具推荐、每-tab 一会话、危险工具分级授权、保存为可重放工具）。

参考: [`packages/extension/src/sidepanel/`](../../../packages/extension/src/sidepanel/) · AIPex `AIPexStudio/AIPex` `packages/browser-ext/src/pages/common/app-root.tsx`

---

## 1 · 目标

- chat 永远是默认且唯一的「正面」surface，所有其它面板下沉为右侧 drawer
- 顶层路由 5-tab 全删，header 改为 5 个 icon + tab 身份行
- chat 页底部 5 条横栏（status / recommendations / tab-chips / error / save-as-tool）全部退场，能内化的内化进 input toolbar / system bubble / 末尾 action card，剩下的进 drawer
- 危险授权从「caution 勾选 + 5 选 N popover」升级为 Claude Code 风格 4 档权限模式（只读 / 默认 / 信任白名单 / 全自动），`Shift+Tab` 循环
- 保留每-tab 独立会话模型（README 明点名的差异点）
- 一次性 big-bang 重构（单人项目，不留双 shell 兼容层）

## 2 · 非目标

- 浅色主题、theme switcher
- i18n 多语言（现状 zh-only 保持）
- 19 个 BuiltinTool / runJS 静态扫描 / WS 协议 / mcp-server / coordinator 协议层
- 会话模型重写（继续用 `sessionsByTab`，不改 IDB 持久化）
- 19 个内置工具的呈现细节（StepCard 复用）

## 3 · 决策摘要（来自 brainstorming）

| ID | 决策 |
|---|---|
| A | 全面塌成单 surface |
| 推荐布局 A | 空态推荐工具卡 + above-input 多 tab 细条 |
| 模式 I | 4 模式 + pill 极简（带 ⓘ） |
| 会话 L | 保留每-tab 一会话 |
| Debug O | 错误 → system bubble；logs/exchanges → header 微章 → drawer；保存 → 末尾 action card |
| 节奏 P1 | Big bang，单 PR / 单分支系列 commit，不留双 shell |

## 4 · 整体形态

```
┌──────────────────────────────────────────────────┐
│ AIPageGo          + ⏱ 🧰 ⚙ 💭•                │  header title 行
│ ● shop.example.com/goods.html · Tab #142     │  tab 身份行
├──────────────────────────────────────────────────┤
│                                                  │
│      ┌────────────────────────────────┐          │
│      │ 此页有 1 个匹配工具              │          │
│      │ ┌──────────────────────────┐  │          │  messages 区
│      │ │ shop 竞品信息采集 v3 [运行] │  │          │  （空态：suggestions）
│      │ │ 已运行 7 次 · 平均 4.2s   │  │          │
│      │ └──────────────────────────┘  │          │
│      │ 或用 @ 引用其他 tab / 工具…    │          │
│      └────────────────────────────────┘          │
│                                                  │
├──────────────────────────────────────────────────┤
│ 挂载: 🏠 当前  📄 yzf ×   + tab                  │  above-input chips
├──────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────┐  │
│ │ 告诉 AI 你要做什么…                          │  │  input box
│ └────────────────────────────────────────────┘  │
│ [默认 ⓘ ▾]  [@]               9/20  7.8k  [↑] │  input toolbar
└──────────────────────────────────────────────────┘

(drawer 从右侧覆盖式滑出，宽 = 100% sidepanel)
```

## 5 · Header & Tab 身份行

### 5.1 Header title 行（~40px）

- 左：`AIPageGo`（点 = 关闭所有 drawer + 滚到最新消息）
- 右 5 个 icon：

  | icon | 含义 | 点击行为 | badge |
  |---|---|---|---|
  | `＋` | 新会话 | 当前 tab 的 session 入栈到 history，sessionData reset | — |
  | `⏱` | 历史 | 开 History drawer | — |
  | `🧰` | 工具库 | 开 Tools drawer | — |
  | `⚙` | 设置 | 开 Settings drawer（`Cmd/Ctrl+,` 直开） | — |
  | `💭` | 调试 | 开 Debug drawer | 红点=有 error；黄点=有 unread exchange；蓝点=仅有日志 |

  Badge 通过 zustand `session.debugBadge: {kind: 'error'\|'exchange'\|'log', count} \| null` 计算。优先级 error > exchange > log。

### 5.2 Tab 身份行（~24px）

- 显示 `● <URL 截断到 ~36 字符> · Tab #<id>`
- `●` 颜色：streaming 中=绿（动画）；idle=灰；error=红
- 行尾仅在「该 tab URL 在 IDB `chat_sessions` 有可恢复条目且当前 session 为空」时显示 `[恢复 →]`
- 切换 Chrome tab → zustand `currentTabId` 触发整 sidepanel 重渲（已有逻辑）

## 6 · Drawer 系统

### 6.1 Drawer shell（`drawer.tsx`）

- 通用组件：右侧覆盖式 sheet，宽 = `100% sidepanel`，ESC 关
- 内部支持「push 子页」（如 Tools → ToolDetail）；带返回箭头
- 同时只允许 1 个 drawer 打开；zustand `openedDrawer: 'history'|'tools'|'settings'|'debug'|null`
- 打开任一 drawer 时不暂停 chat 跑动（LLM 仍 stream，badge 实时变）

### 6.2 ⏱ History drawer

- 顶部 toggle `按当前 URL` / `所有`
- 列表：`SessionListItem`（URL pattern · 最后消息时间 · 消息数 · 首条 user msg 截断）
- 点击：关 drawer + load 进当前 chat（IDB → store）
- 长按 / 三点：删除 / 重命名 / 导出 JSON
- 沿用 IDB `chat_sessions`（每 URL ≤20）

### 6.3 🧰 Tools drawer

- 顶部：`[导入 JSON]` + 搜索框
- 列表：`ToolCard`（name · url-pattern · runs · version · `[详情] [导出] [删除]`）
- 点 `[详情]` → drawer 内 push 一层 `ToolDetailPane`：
  - prompt tool：prompt 文本 + `[在当前会话运行]`
  - step tool：`[在当前 tab 运行]`、步骤定义折叠、运行结果、`[让 AI 修复]`（条件：上次运行失败）
- ToolDetailPane 顶部带 ← 返回，回到 Tools 列表

### 6.4 ⚙ Settings drawer

5 个 section（折叠/常驻均可，默认全展开）：

1. **LLM**（沿用现状字段）
   - Provider / Endpoint / Model / API Key (+ session-only) / max_tokens / 最大轮数 / 续作 nudge

2. **权限默认值**
   - `defaultPermissionMode`：4 档下拉（新会话用哪档启动）
   - `trustedDangerTools[]`：5 个 checkbox（哪些 dangerous 工具在「信任白名单」模式下自动通过）
   - 注：这里是默认值；当前 session 的 `permissionMode` 在 input toolbar 切换

3. **挂载 / 多 tab**
   - 「允许 AI 用 `openTab` 自动挂新 tab」开关（current）
   - 「允许 AI 用 `attachTab` 申请挂任意 tab（需审阅）」开关（current）

4. **Coordinator**
   - 沿用 `coordinator-settings-page` 内容（URL / token / 连接状态 / 允许 chat session 远程驱动）

5. **高级 / 调试**
   - `[DEV: JSON 运行]` 按钮 → 弹 modal（即原 `run-page` 内容）
   - `[导出工具库]`、`[导入工具库]`
   - `[清空所有数据]`（红色警告 + 双重确认）

### 6.5 💭 Debug drawer

内部 2 个 tab（drawer 顶部）：

1. **日志**：当前 session 的 SessionEvent 流（沿用 `LogsDrawer` 渲染逻辑）
2. **Exchanges**：当前 session 的 LLM stream request/response（沿用 `LlmExchangePanel` 渲染逻辑）

- error 不自动弹 drawer（错误已经在 messages 区以 SystemBubble 可见）。仅亮 `💭` 红 badge
- 用户点 `💭` 打开后默认切到「日志」tab + 滚到首个未读 error / event
- header `💭` badge 颜色与最高优先级事件一致
- 沿用 `recording-client` 抓 stream，不动协议层

## 7 · Chat 内容区

### 7.1 空态（`empty-suggestions.tsx`）

判定：`messages.filter(m => m.role !== 'system').length === 0 && cards.length === 0`

- 顶：标题 `此页有 N 个匹配工具`（N=0 时隐藏整组）
- N≥1：渲染 ≤3 张 `SuggestionCard`（grad green 背景，name + meta + `[运行]`），超出 `+N 折叠`
- 下：`告诉 AI 你要做什么` 弱提示 + 一行 `或用 @ 引用其他 tab / 工具 / 历史`

### 7.2 已对话态（沿用 `ChatView`）

- `messages` + `cards` 渲染保持不变
- 移除：原 `<ErrorBanner>` / `<LogSummaryBar>` / `<RecommendationsBanner>`
- 新增：
  - `SystemBubble`（替代原 error banner + 「页面跳转」system note 行）：
    - `kind: 'error' | 'warning' | 'navigation'`
    - 居中、圆角、低饱和度的色块
    - error 类型点击 = 跳 Debug drawer
  - `SaveAsToolCard`（末尾 inline 卡片）：
    - 触发：`executedSteps.length > 0 && session.status === 'idle' && !showSaveDialog`
    - 内容：`✓ N 步成功执行` + `[保存为工具]`
    - 点击 → 原 `SaveAsToolDialog` modal

### 7.3 滚动行为

- 已有 auto-scroll-to-bottom 沿用
- 打开 Debug drawer 时正在 stream，drawer 内日志区独立滚动；主 chat 区滚动不受影响

## 8 · Above-input chips + Input 区

### 8.1 Above-input chips（`above-input-tabs.tsx`，高 ~28px）

- 横滚不换行
- 第一个 chip `🏠 当前`（不可关闭，表示 sidepanel 所在 tab）
- 后续 chip 渲染 `attachedTabs[]`：`📄 <title 截断> ×`
- 末尾 `+ tab` 占位（虚线），点击 → 原 `TabPicker` modal
- chip × 点击 = 卸载该 tab（既有 detach 流程）

### 8.2 Input box

- 多行 textarea，自适应高度（min 56px, max 200px）
- `@` 触发 `MentionPicker`（弹层 popover，键盘可导航）：
  - 仅 1 个 tab：`Tabs`（可选项 = 当前 chrome 中其它可见 tab，行为 = 原 `TabPicker` 替代品）
  - 选项点击 = 插入 `<mention type="tab" id="142" label="shop"/>` 标记到 textarea
  - 序列化进 user message 作为引用块
- @ Tools / History / Skills 后续迭代再开（§15）；本次菜单不出这 3 类标签
- `Enter` 发送，`Shift+Enter` 换行
- streaming 时输入框 disabled + 灰

### 8.3 Input toolbar 左

- **权限模式 pill**（`permission-mode-pill.tsx`，详见 §9）
- **@ 按钮**（与 textarea `@` 触发同一 picker）

### 8.4 Input toolbar 右

- `round-pill`：`<roundCount>/<maxRounds>`，仅 `roundCount > 0` 时显示
- `token-meter`：跑动期间 = `in/out` 累计；闲时合并 = `<total>`，灰字
- 发送/停止按钮：streaming → `■ stop`（红）；idle → `↑`（蓝）；error → `✕`（提示有 error，点击 = 开 Debug drawer）

## 9 · 权限模式系统

### 9.1 4 档定义

| key | 显示名 | 颜色 | 行为 |
|---|---|---|---|
| `read` | 只读 | 蓝 | 只 `safe` 自动；`caution` 和 `dangerous` 全部询问 |
| `default` | 默认 | 绿 | `safe` + `caution` 自动；`dangerous` 询问（≈ 当前默认行为） |
| `trust` | 信任白名单 | 橙 | `safe` + `caution` 自动 + `trustedDangerTools[]` 内的 `dangerous` 自动；其余 `dangerous` 询问 |
| `yolo` | 全自动 | 红（脉冲） | 所有工具自动执行（含 dangerous） |

`safe` / `caution` / `dangerous` 三类映射沿用 `packages/extension/src/content/builtin-tools/index.ts` 中已有的工具分级。

### 9.2 UI（`permission-mode-pill.tsx`）

- 关闭态：`<displayName> ⓘ ▾`（背景色 = 该档颜色）
- 下拉菜单（240px 宽）：每行 `<color-dot> <name> [✓ if current] ⓘ`，宽度等高紧凑
- hover ⓘ → tooltip：`<完整说明>` + `当前自动: [tool list]` + `当前会问: [tool list]`
- 点击「信任白名单」：菜单底部展开 5 个 checkbox（trustedDangerTools 编辑）
- 点击「全自动」：弹 modal `这会让 AI 跳过所有审核，包括 submitForm / uploadFile / runJS。本会话生效。` + `[取消]` `[我知道风险，继续]`
- `Shift+Tab` 在 4 档循环（read → default → trust → yolo → read）
- 切换瞬间生效；正在执行的 step 不回滚

### 9.3 数据 & scope

- `session-store.SessionData.permissionMode: PermissionMode`，默认值 = `settings.defaultPermissionMode`
- 当前 session scope；切 tab 切换 session，跟随当前 session 自己的 mode
- 新建 session（点 `＋`）继承 `settings.defaultPermissionMode`，不继承上一会话

### 9.4 旧字段迁移

- `settings.autoApproveDangerous: string[]` → `settings.trustedDangerTools: string[]`（同语义，改名）
- `settings.load()` 末尾插一次性迁移：
  - 若读到 `autoApproveDangerous` 且 `trustedDangerTools` 不存在 → 复制过去 + 删旧 key
- 移除：`settings.autoApproveDangerous`
- 新增：`settings.defaultPermissionMode: PermissionMode`，初值 `'default'`

## 10 · State 变化

`session-store.ts`（增量）：
```ts
type SessionData = {
  // ...existing
  permissionMode: PermissionMode;  // 新增，初始 = settings.defaultPermissionMode
  debugBadge: { kind: 'error' | 'exchange' | 'log'; count: number } | null;  // 新增
  // 删除: logsOpen（被 openedDrawer 包含，且移至全局）
}

// 全局（顶层 store，不在 SessionData 内部）：
type GlobalUiState = {
  openedDrawer: 'history' | 'tools' | 'settings' | 'debug' | null;
}
```

理由：drawer 跟 sidepanel 走，跟具体 tab/session 无关。切 chrome tab 不应该关 drawer，否则切回来还要重新打开。

`settings-store.ts`（增量）：
```ts
type LlmSettings = {
  // ...existing 除 autoApproveDangerous
  defaultPermissionMode: PermissionMode;  // 新增
  trustedDangerTools: string[];  // 改名（语义同 autoApproveDangerous）
}
```

类型新增：
```ts
type PermissionMode = 'read' | 'default' | 'trust' | 'yolo';
```

写一个工具函数 `evaluateAutoApproval(tool, mode, trustedList): 'auto' | 'ask'`，集中替代分散的「caution + dangerous 白名单」判定。

## 11 · 文件计划

### 新增

```
sidepanel/
├─ shell/
│  ├─ app-shell.tsx              # 替换 app.tsx
│  ├─ header.tsx
│  ├─ tab-identity-bar.tsx
│  └─ drawer.tsx                 # 通用右侧 sheet
├─ drawers/
│  ├─ history-drawer.tsx
│  ├─ tools-drawer.tsx
│  ├─ tool-detail-pane.tsx
│  ├─ settings-drawer.tsx
│  │  ├─ section-llm.tsx
│  │  ├─ section-permissions.tsx
│  │  ├─ section-mounting.tsx
│  │  ├─ section-coordinator.tsx
│  │  └─ section-advanced.tsx     # 含 DEV: JSON modal trigger
│  └─ debug-drawer.tsx            # tab: 日志 / Exchanges
├─ chat/
│  ├─ empty-suggestions.tsx
│  ├─ system-bubble.tsx
│  └─ save-as-tool-card.tsx
├─ input/
│  ├─ above-input-tabs.tsx
│  ├─ input-box.tsx
│  ├─ input-toolbar.tsx
│  ├─ mention-picker.tsx
│  └─ permission-mode-pill.tsx
└─ lib/
   └─ evaluate-auto-approval.ts   # safe/caution/dangerous + mode → auto|ask
```

### 删除

```
sidepanel/
├─ app.tsx                        → app-shell.tsx
├─ pages/                         (整目录删)
│  ├─ chat-page.tsx
│  ├─ tools-page.tsx
│  ├─ tool-detail-page.tsx
│  ├─ settings-page.tsx
│  ├─ coordinator-settings-page.tsx
│  └─ run-page.tsx                → 移进 section-advanced 的 modal
├─ components/
│  ├─ recommendations-banner.tsx  → empty-suggestions
│  ├─ tab-chips-bar.tsx           → above-input-tabs
│  ├─ status-bar.tsx              → 拆进 input-toolbar
│  ├─ session-history-drawer.tsx  → history-drawer
│  ├─ logs-drawer.tsx             → debug-drawer
│  ├─ llm-exchange-panel.tsx      → debug-drawer
│  ├─ danger-approval-popover.tsx → permission-mode-pill
│  ├─ danger-approval-group.tsx   → section-permissions + permission-mode-pill
│  ├─ url-recovery-banner.tsx     → tab-identity-bar 的 [恢复 →] 链接
│  ├─ tab-info-bar.tsx            → tab-identity-bar
│  └─ error-banner.tsx            → system-bubble (kind: error)
```

### 复用（基本不动）

- `chat/session-store.ts`（+3 字段，-1 字段）
- `chat/settings-store.ts`（+2 字段，-1 字段 + 迁移）
- `chat/run-chat-session.ts` 等核心逻辑层全部不动
- `components/step-card.tsx`、`components/chat-view.tsx`、`components/tab-picker.tsx`、`components/save-as-tool-dialog.tsx`
- `background/`、`content/`、`shared/`、`coordinator/`、`mcp-server/` 全部不动

## 12 · 测试

### 新增单测（RTL + happy-dom）

- `header.test.tsx`：5 icon click 触发对应 `openedDrawer`；badge 颜色优先级（error > exchange > log）
- `drawer.test.tsx`：ESC 关；同时只允许一个 drawer；push/pop 子页
- `permission-mode-pill.test.tsx`：4 档切换；Shift+Tab 循环；Yolo 二次确认；trust 子 checkbox 改 `trustedDangerTools`
- `empty-suggestions.test.tsx`：URL 匹配 0/1/3/5 工具的渲染（含折叠）
- `save-as-tool-card.test.tsx`：触发条件
- `evaluate-auto-approval.test.ts`：4 mode × 3 类 × 边界（trust 内/外）= 完整真值表
- `session-store.test.ts`：新字段默认值、新建 session 继承 defaultPermissionMode

### 迁移测试

- `settings-store.test.ts`：旧 `autoApproveDangerous=[a,b]` → 加载后 `trustedDangerTools=[a,b]` 且旧 key 删除

### 沿用（0 改动）

- runChatSession、protocol、所有 builtin-tool 测试

### 手动 smoke

跟 README 的「阅读 / 操作 / 采集 / 多 tab」4 个手测脚本完整跑一遍；新增：

- Shift+Tab 在 4 档循环 + 切到 yolo 弹 modal
- 切 chrome tab 看 mode 跟 session 走
- error 后 💭 红点 + Debug drawer 自弹

## 13 · 风险 & 缓解

| 风险 | 缓解 |
|---|---|
| 删 11 个文件 + 改 stores，typecheck 一片红 | 按 plan 分阶段：先加新文件 + stores + 兼容老导出 → typecheck 绿 → 删旧 → 再 typecheck |
| 切 tab 时 drawer 状态丢失 | `openedDrawer` 放在全局 store（非 SessionData 内部），切 tab 不关 drawer，仅 chat 主区切换。详见 §10。 |
| Yolo 模式被误开 | 二次确认 modal + pill 颜色脉冲红 + Debug drawer header 持续 ⚠ 提示 |
| 旧 `autoApproveDangerous` 数据被截断 | 迁移在 `load()` 内首次执行，迁移完写 `_migrated_v1: true`；写单测覆盖 |
| 多 drawer 之间状态争用 | drawer 全部从 zustand 读，无 prop-drilling；不同 drawer 不互访 |

## 14 · Out of scope（明确不做）

- 浅色主题、theme switcher
- i18n（保持 zh）
- @ picker 的 Tools / History / Skills 三个 tab 本次不出现（仅 Tabs 一类，替换原 `TabPicker`）
- 任何与 `background/` / `content/` / 19 个 BuiltinTool / runJS 静态扫描 / WS 协议层相关的改动

## 15 · 后续（非本次范围）

- @ picker 的 Tools / History / Skills 三 tab 实装（让 @ 真能挂工具 / 历史会话）
- 浅色主题
- i18n（如果做，先把 zh 字符串集中到 `i18n/zh.ts`）
- 「同 tab 内 navigate」后会话保留行为的策略选择（继续 / 新会话 / 询问）

## 16 · 兼容性 & 数据迁移

- IDB `chat_sessions` 无 schema 变化
- IDB `tools` 无 schema 变化
- `chrome.storage.local` 字段：
  - 新：`defaultPermissionMode`, `trustedDangerTools`, `_settings_migrated_v1`
  - 删：`autoApproveDangerous`（迁移完即删）
  - 不动：API Key 相关、Coordinator 相关、全部 LLM settings
- `chrome.storage.session`：不动
- 用户首次升级 → `settings.load()` 自动迁移 → 无感
