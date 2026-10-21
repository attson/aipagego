# Widget Round 2 — 11 项功能补齐(v0.0.52)

**状态**:草稿 · 2026-07-10 · 作者:assistant + attson

在 v0.0.51 的 widget MVP 上补齐 11 项功能,让"页内浮窗"从"能收发消息"抬到"日常聊天足够,不用切 sidepanel"。全部改动是 UI 层增量,不改运行时协议(runChatSession/自愈/Approver 保持一致)。

## 1 · 背景

v0.0.46 落地 widget(input + messages + caution 审阅 + dangerous 交接);v0.0.47–v0.0.51 修了样式、tab 归属、发送、cross-tab 误识、新对话等 5 波关键 bug。用户至此可以在页内跑完基本对话,但仍缺:

- 无入口打断 run(只能等或去 sidepanel)
- Streaming/awaiting 时不知道 AI 正在干什么(状态盲区)
- 空态只有一个 placeholder,拉新提示为零(sidepanel 已有的 preset chip / QuickActions 没进来)
- InputBox 不接图片
- 面板 320×480 固定不可调
- session.errorMessage 存在但小 viewport 里几乎不可见
- 顶部权限模式无 pill(每次要跳设置改)
- 没入口"保存为工具"
- 无法在 widget 内浏览本 URL 历史会话
- 没法就页面元素圈选投喂 AI

## 2 · 目标

- 11 项功能全部落地,widget 内可完成 90% 常见对话周期(问、审、执行、保存、翻旧账)
- 不改运行时协议:runChatSession / Approver / 自愈路径与 v0.0.51 完全一致
- 尽量复用现有 sidepanel 组件与 helper,少造新轮子
- 单 iteration 打包发 v0.0.52
- 无 IDB schema 迁移

## 3 · 非目标

- ❌ widget 内的工具库 drawer / 场景库 drawer / 设置面板 / LLM Exchanges viewer / 诊断包 / Coordinator 设置 —— 仍归 sidepanel
- ❌ 浅色主题跟随 sidepanel(v0.0.51 就硬编码 dark;这一版仍 dark)
- ❌ 快捷键(Cmd+K 呼出 widget 等)
- ❌ i18n(中文为主,和 sidepanel 一致)
- ❌ Widget 内 mini SaveAsToolCard(明确决定跳 sidepanel 正规对话框)
- ❌ 移动版触屏优化

## 4 · Panel 布局总览

```
┌────────────────────────────────────────┐
│ [←] ⚡AIPageGo [⌖][+][↗][—][×]      │  ← [←] 仅历史模式;⌖ 新元素圈选;其余同 v0.0.51
├────────────────────────────────────────┤
│ ⚠ 上次运行失败: xxx           [×关闭]  │  ← Error Banner (§7)
├────────────────────────────────────────┤
│ 🔧 snapshotDOM · 2.3s ⟳                │  ← Sticky Status Bar (§6)
├────────────────────────────────────────┤
│                                        │
│  (三选一:ChatView / EmptyState        │
│   / 历史列表)                          │
│                                        │
│  空态:                                 │
│    - EmptySuggestions(preset chip)   │
│    - QuickActions(默认 3 项)         │
│                                        │
│  chat 尾部小条(有 executedSteps 时): │
│    ✓ 已执行 N 步 [保存为工具]          │
│                                        │
├────────────────────────────────────────┤
│ [🕒 历史] · 0in/0out · round 5/200    │  ← footer 加历史入口 (§10)
├────────────────────────────────────────┤
│ [default▾]  🖼 [thumb][thumb][x]      │  ← §9 pill + §8 图片缩略
│ [告诉 AI...             ]  [▶ 或 ■]   │  ← input + Send/Stop
└────────────────────────────────────────┘
                                   ↘ ← 右下角 resize corner grip (§11)
```

**关键不变量**:
- 运行时协议不变:runChatSession + Approver + 自愈路径与 v0.0.51 一致
- 所有 UI 组件位于 Shadow DOM 内,adoptedStyleSheets 装载 Tailwind + zinc 变量(v0.0.47 修完)
- widget 与 sidepanel 共享 sessionsByTab(v0.0.46 broadcast 机制)

## 5 · 顶部按钮 / 元素圈选

**Header 5 个 icon 顺序**(左→右):

| Icon | 说明 | 显示条件 |
|---|---|---|
| `[←]` (ArrowLeft) | 返回 chat(离开历史模式) | 仅 `mode === "history"` |
| `[⌖]` (Crosshair) | 元素圈选 | 常驻 |
| `[+]` (MessageSquarePlus) | 新对话(v0.0.51) | 常驻 |
| `[↗]` (ExternalLink) | 打开 sidepanel(v0.0.51) | 常驻 |
| `[—]` (Minus) | 最小化 | 常驻 |
| `[×]` (X) | 关闭 | 常驻 |

**元素圈选流程**:

1. 用户点 `⌖` → `chrome.runtime.sendMessage({type: "aipagego.startCapture", tabId})`
2. `content/element-capture.ts` 收到 → 页面进入 hover 高亮 + 单次 click 模式
3. 用户点选元素 → element-capture 发 `{type: "aipagego.captureResult", selector}`
4. Widget 挂 `chrome.runtime.onMessage` listener 接住 → `setInput((prev) => prev + \`\\n\\n针对元素 ${selector}:\`)` + `inputRef.focus()`

已有基础设施:`packages/extension/src/content/element-capture.ts` 完整实现;widget 只加**触发按钮 + 结果 listener**。

## 6 · Sticky Status Bar

**条件**:`session.status !== "idle" && session.status !== "done" && session.status !== "aborted"`

**内容**:

- 若 `session.cards` 里有 `status === "running"` 的 card → `🔧 {tool_name} · {elapsed}s ⟳`
  - `elapsed = (Date.now() - card._runningStartAt) / 1000`,`setInterval` 250ms 刷新
- 否则若 `session.status === "streaming"` → `💭 AI 思考中...`
- 否则若 `session.status === "awaiting"` → `⏸ 等待你确认下一步`

**新增字段**:`StepCardState._runningStartAt?: number`(session-store.ts)。`upsertCard(tabId, { toolUseId, status: "running", _runningStartAt: Date.now() })` 在现有 setCardStatus 里以 running 转态时盖。

**样式**:24px 高,`px-3 py-1 border-b border-zinc-800 text-[11px] text-zinc-400 flex items-center gap-2 shrink-0`。

## 7 · Error Banner

**条件**:`session.errorMessage != null`

**内容**:红条 `⚠ 上次运行失败: {errorMessage}`,右侧 `[×]` 按钮 → `setError(tabId, null)` 关闭。

**样式**:`px-3 py-1.5 bg-red-950 border-b border-red-900 text-[11px] text-red-200 flex items-start gap-2 shrink-0`。

## 8 · 空态 chip(preset + QuickActions)

**条件**:`session.messages.length === 0`

**结构**:垂直堆叠两组

- `<EmptySuggestions matchedTools={[]} presets={matchedPresets} onPresetPick={handlePresetPick} onRun={() => {}} onDetail={() => {}} />`
  - `matchedPresets = matchPresetsByUrl(session.url)`(现有 `@aipagego/shared/match-presets`)
- `<QuickActions currentUrl={session.url} onPick={(text) => setInput(text)} />`

**handlePresetPick 分类处理**:

- prompt-form → `setInput(preset.prompt)`(用户可继续改)
- tool-form → 首版降级为 `setInput(\`运行 preset "${preset.name}"\`)` 让 AI 自主挑对应保存工具;不做 materialize 跳转(避免体验断裂)

## 9 · Input 上方 Pill + 图片

**新组件**:`packages/extension/src/content/widget/input-row.tsx`(把 pill + staged images + input + send 一起管)

**Pill**(左对齐):`<PermissionModePill mode={session.permissionMode} onChange={(m) => setPermissionMode(tabId, m)} />` —— 现成组件,现成 session action

**Staged Images**(右对齐):

- 复用 `packages/extension/src/sidepanel/components/staged-images.tsx` 的 `<StagedImages images={stagedImages} onRemove={onRemoveImage} />`
- Widget-local state:`const [stagedImages, setStagedImages] = useState<StagedImage[]>([])`(StagedImage 类型已在 sidepanel input 里,复用)
- InputBox 的 `onImageFiles` 接住粘贴/拖入 → 校验大小/类型 → `setStagedImages([...prev, ...imgs])`

**发送时**:

```ts
async function handleSubmit() {
  if (stagedImages.length > 0) {
    appendUserMessageWithImages(tabId, text, stagedImages);
  } else {
    appendUserMessage(tabId, text);
  }
  setStagedImages([]);
  setInput("");
  // ... existing runFromInput
}
```

## 10 · Send / Stop 按钮 + 历史入口

**Send / Stop 互斥**(input 右侧):

```tsx
{isBusy ? (
  <button onClick={handleStop}><Square size={16}/></button>
) : (
  <button onClick={handleSubmit} disabled={!input.trim()}><Send size={16}/></button>
)}
```

- `isBusy = session.status ∈ {streaming, running, awaiting}`
- `handleStop`:`session.abortController?.abort()` + `setStatus(tabId, "aborted")`(和 sidepanel 一样)

**历史入口**(footer 左侧):

- Footer 结构改为 `[🕒 历史] · {input}in / {output}out · round X/N`
- 点 `🕒 历史` → `setMode("history")`

## 11 · Resize Handle

**位置**:Panel 右下角 12×12 grip,cursor `nwse-resize`,视觉:两条对角小斜线。

**行为**:

```tsx
function onResizeStart(e) {
  const startX = e.clientX, startY = e.clientY;
  const startW = size.w, startH = size.h;
  function onMove(e2) {
    const w = clamp(startW + (e2.clientX - startX), 320, 720);
    const h = clamp(startH + (e2.clientY - startY), 360, 900);
    setSize({ w, h });
  }
  function onUp() {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    setPanelSize(size).catch(() => {});
  }
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
}
```

- 边界:`320×360` ~ `720×900`
- `getPanelSize / setPanelSize`(v0.0.46)复用

## 12 · 历史 mini drawer(替换 body)

**触发**:footer `🕒 历史` → `setMode("history")`

**Header 变化**:`mode === "history"` 时首位插一个 `[←]` 返回按钮,点击 `setMode("chat")`

**内容**:

```
🕒 本 URL 历史对话(N)

┌─ 采集商品评论 · 2h 前 ─────────┐
│ 12 条消息 · 8 步 · done         │
└──────────────────────────────────┘

┌─ 总结此页 · 昨天 ────────────────┐
│ 4 条消息 · done                 │
└──────────────────────────────────┘
```

**数据源**:`listArchivedByUrl(session.url)` — 现有 `sessions-storage.ts`

**列表项**:`ArchivedSessionRow` 组件

- Title:第一条 user message 前 30 字,fallback "无标题"
- Meta:`{n} 条消息 · {steps?} 步 · {status}` + `{relativeTime}`
- 点击:`restoreArchived(id, tabId)` — 现有,widget 复用

**空态**:`此 URL 无历史会话`

**样式**:与 sidepanel history drawer 一致的 zinc-900 卡片

## 13 · 保存为工具入口

**位置**:chat body 尾部小条,`session.executedSteps.length > 0 && session.status === "done"` 显示

**内容**:

```
✓ 已执行 N 步  [保存为工具]
```

点击:`rpc.widgetOpenSidepanelWithSave({tabId})` → BG 打开 sidepanel + 存 `aipagego.pendingSave: {tabId, ts}`;sidepanel `useEffect` 读到 → 调 `showSave(tabId)` → SaveAsToolCard 弹出

**新增 RPC**:

```ts
// packages/shared/src/messages.ts
z.object({ type: z.literal("widget.openSidepanelWithSave"), tabId: z.number().int() })
```

BG 处理:

```ts
case "widget.openSidepanelWithSave": {
  await chrome.sidePanel.open({ tabId: req.tabId });
  await chrome.storage.session.set({
    "aipagego.pendingSave": { tabId: req.tabId, ts: Date.now() }
  });
  return null;
}
```

Sidepanel focus effect(和 pendingApproval 同款,加一段):

```ts
useEffect(() => {
  chrome.storage.session.get(["aipagego.pendingSave"]).then((res) => {
    const p = res["aipagego.pendingSave"];
    if (!p) return;
    if (Date.now() - p.ts > 30_000) {
      chrome.storage.session.remove(["aipagego.pendingSave"]);
      return;
    }
    showSave(p.tabId);
    chrome.storage.session.remove(["aipagego.pendingSave"]);
  });
}, []);
```

## 14 · State 模型

**新增 session field**(`packages/shared/src/types.ts`):

- `StepCardState._runningStartAt?: number`

**Widget-local state**(Panel 组件):

- `mode: "chat" | "history"`
- `stagedImages: StagedImage[]`
- `size: {w: number, h: number}` — 已有
- `input: string` — 已有

**Storage keys**(chrome.storage.session):

- `aipagego.pendingSave: {tabId, ts}` — save 中继

## 15 · 测试策略

**新增测试**(happy-dom + createRoot + act):

- `panel-status-bar.test.tsx` — running/streaming/awaiting/idle 各态的显示
- `panel-error-banner.test.tsx` — errorMessage 存在时显示 + 关闭清空
- `panel-empty-suggestions.test.tsx` — URL 命中 preset 时 chip;quick-actions 出现
- `panel-history.test.tsx` — 切 mode 到 history 时 body 换成列表;点条目 restoreArchived 被调
- `panel-input-row.test.tsx` — pill 显示 + 图片粘贴入 stagedImages + stop 按钮 abort
- `panel-resize.test.tsx` — corner grip 拖动更新 size + setPanelSize 被调
- `widget-openSidepanelWithSave.test.ts` — BG RPC 存 pendingSave + 打开 sidePanel
- `element-capture-relay.test.ts` — captureResult 消息塞进 input

**回归**:现有 30 个 widget 测试保持通过。

## 16 · 分阶段落地

Plan 拆 8 batch,单 iteration 一 PR:

| Batch | 内容 | LOC 估算 |
|---|---|---|
| B1 | `StepCardState._runningStartAt` + widget.openSidepanelWithSave RPC + pendingSave 中继 + sidepanel focus effect | 150 |
| B2 | Sticky Status Bar + Error Banner + save-as-tool 入口小条 | 250 |
| B3 | 空态 preset chip + QuickActions 接入 | 200 |
| B4 | Input Row(pill + staged images + stop 按钮)+ input-row 组件重构 | 300 |
| B5 | 元素圈选(Header ⌖ 按钮 + captureResult listener) | 100 |
| B6 | Resize handle | 150 |
| B7 | 历史 mini drawer(mode 切换 + 列表 + 恢复) | 300 |
| B8 | Verify + PR + ship v0.0.52 | 0 |

## 17 · 兼容 & 迁移

- 无 IDB 迁移
- `StepCardState._runningStartAt` 可选,老数据缺失 = undefined,状态条降级为 `💭 AI 思考中...`
- `widget.openSidepanelWithSave` 是新 RPC,老 widget 无此调用,行为不变
- 现有 30 个 widget 测试保持通过

## 18 · 未来议题

- 浅色主题跟随 sidepanel
- 快捷键(Cmd+K 呼出、Esc 关闭、Cmd+Enter 强制发送)
- Widget 内的 mini 工具库(只展示 URL 命中的用户工具,一键运行)
- i18n
- 移动版触屏适配
