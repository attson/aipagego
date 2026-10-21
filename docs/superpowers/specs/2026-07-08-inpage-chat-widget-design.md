# 页内浮窗对话入口(In-Page Chat Widget)

**状态**：草稿 · 2026-07-08 · 作者:assistant + attson

在每个可注入网页右下角提供一个可拖动 FAB,点开一个 Shadow DOM 承载的 mini 对话面板,让 AIPageGo 的"读/写/采"能在页内直接完成。sidepanel 保留为全功能后备(工具库/场景库/settings/诊断);widget 是**同一份会话**的第二个入口,不重写不分叉。

## 1 · 背景

现状:AIPageGo 唯一入口是浏览器右上角扩展图标 → sidepanel。这有两个心智门槛:
- **入口不显眼**:非重度用户每次要点扩展图标,失去"聊天永远在手边"的感觉
- **占屏严重**:sidepanel 会挤压主内容区域;很多"看一眼、问一句"的场景不值得撑开面板

同类产品(Intercom / Notion AI / Google Gemini in-page bubble / ChatGPT sidebar)证明:**页内浮窗**是 AI 助手最贴近用户心智的形态。AIPageGo 的核心资产(自愈 / 场景 preset / 36 工具)全在页面上生效,理应把入口也放到页面。

## 2 · 目标

- 每个可注入的顶层 HTML 页面右下角**默认出现 FAB**,单击打开 320×480 mini 对话面板
- **90% 常见对话**(总结 / 抽取 / 采集 / 填表)不用打开 sidepanel 就能完成
- Widget 与 sidepanel 是**同一个会话的两个视图**,并存时数据实时同步
- 遇 `dangerous` step:widget 自动请求打开 sidepanel 并高亮待审步骤,不让 dangerous 操作停留在 in-page 上下文
- 每站可"本站不再显示";全局可开关(默认 on)
- 无 IDB schema 迁移;sidepanel 现有代码零回归

## 3 · 非目标

- ❌ 替换 sidepanel(sidepanel 仍是工具库/设置/诊断/场景库的唯一宿主)
- ❌ 在 iframe subpage 内注入(只顶层 window)
- ❌ 在 `chrome://` / Web Store / PDF viewer 上注入(content-script 天生进不去,不做 fallback)
- ❌ 移动版触屏优化
- ❌ i18n(首版只中文,与 sidepanel 一致)
- ❌ Widget 内的工具库 / save-as-tool / 场景库 drawer / LLM exchanges viewer / 诊断面板 —— 全部跳 sidepanel
- ❌ Widget 里做 Coordinator 设置

## 4 · 顶层骨架

```
┌────────────────────────────────────────────────────────────────┐
│  packages/extension/src/content/widget/                        │
│  (新增第 5 个 content-script bundle,与 breathing-border 并列) │
│                                                                │
│  ├─ mount.ts          document_idle → 创建 <aipagego-widget> │
│  │                    custom element + attachShadow({mode:open})│
│  ├─ fab.tsx           悬浮球:拖动 / 双击最小化 / 右键小菜单   │
│  ├─ panel.tsx         mini shell:header + chat + input        │
│  ├─ approval-modal.tsx caution step 审阅弹层                  │
│  ├─ handoff.ts        遇 dangerous → widget.openSidepanel RPC │
│  ├─ store.ts          widget 侧 zustand session-store 实例    │
│  ├─ styles.ts         Tailwind 提取 → adoptedStyleSheets       │
│  ├─ per-site.ts       chrome.storage.local 黑名单 host 读写   │
│  └─ react-root.tsx    Shadow DOM 内的 React root              │
└────────────────────────────────────────────────────────────────┘
        │
        ▼ chrome.runtime.sendMessage(既有通道)
┌────────────────────────────────────────────────────────────────┐
│  Background 扩展                                               │
│  ├─ session-broker.ts  广播 session mutations 给所有 host     │
│  └─ rpc-handlers.ts    新增 widget.openSidepanel /            │
│                        widget.markHostHidden                   │
└────────────────────────────────────────────────────────────────┘
        │                       ▲
        ▼                       │ session.state.changed events
┌───────────────────┐     ┌──────────────────┐
│  Sidepanel        │     │  Widget (shadow) │
│  (原有,零改动)   │◄────┤  同 tab 会话     │
│  session-store    │     │  session-store    │
│  订阅 broker      │     │  订阅 broker     │
└───────────────────┘     └──────────────────┘
           同一份 sessionsByTab[tabId] 的两个视图
```

**关键不变量**:
- Widget bundle **独立打包**,不进 sidepanel dist(避免 sidepanel 体积膨胀)
- Widget 与 sidepanel 都是"扩展代码域",host page JS 读不到 API key 与会话内容
- `getApproverForTab(tabId)` 单例天生跨面板 → dangerous approval 从 widget 转 sidepanel 时的 Promise 自然接手
- 广播 payload 是 full snapshot + rev 号;并发场景由 rev 号仲裁,不用 diff/patch(YAGNI)

## 5 · 数据模型 & 存储

### 5.1 chrome.storage.local(新增 key)

```ts
"aipagego.widget.hiddenHosts"     // string[]  精确匹配 host
"aipagego.widget.fabPos"          // { [host: string]: { x, y } }
"aipagego.widget.panelSize"       // { w, h }  全局记忆
```

**注**:总闸 `widgetEnabled` 走 LlmSettings(存于 `aipagego.llm`),不引入独立 `aipagego.widget.globalEnabled`;这样设置页与其他 LLM 偏好一同展示,CRUD 路径统一。

### 5.2 LlmSettings 扩展(`packages/shared/src/types.ts`)

```ts
widgetEnabled: boolean;    // 默认 true;总闸;存于 aipagego.llm 下
```

### 5.3 SessionData 加 `_rev`

```ts
type SessionData = {
  // 原有字段 …
  _rev: number;  // 每次 mutation +1,用于广播冲突仲裁
};
```

- 现有 sessions 缺 `_rev` 视为 0
- Persistence 层(chat_sessions IDB)可选存 rev(向后兼容:missing = 0)

### 5.4 pendingApprovalId 中继(chrome.storage.session)

```ts
"aipagego.pendingApproval"       // { tabId, approvalId, ts } | null
```

Widget 触发 sidebar 打开时写入;sidepanel 起来后 `useEffect` 读一次,scroll 到该 step-card + 高亮 2s;读完立刻 clear。

## 6 · Widget 组件

### 6.1 挂载路径(`mount.ts`)

```ts
async function mount() {
  if (window !== window.top) return;                      // 只顶层
  if (document.contentType !== "text/html") return;       // 不是 HTML
  const s = await chrome.storage.local.get(["aipagego.llm"]);
  const enabled = s["aipagego.llm"]?.widgetEnabled !== false;
  if (!enabled) return;
  const hosts = (await chrome.storage.local.get(["aipagego.widget.hiddenHosts"]))["aipagego.widget.hiddenHosts"] ?? [];
  if (hosts.includes(location.host)) return;

  const el = document.createElement("aipagego-widget");
  document.documentElement.appendChild(el);
  const shadow = el.attachShadow({ mode: "open" });
  await bootstrapReact(shadow);
}
```

### 6.2 FAB(`fab.tsx`)

- 48×48 圆角,浅底 + `Sparkles` lucide 图标
- 运行中脉动 emerald 边框(与 breathing-border 视觉呼应)
- 默认 `right: 16px; bottom: 16px`;拖动时按 host 记忆
- 单击 → 打开/关闭 panel
- 右键(或长按 500ms)→ 小菜单:`[本站不再显示 / 拖回默认位置 / 打开 sidepanel]`

### 6.3 Panel(`panel.tsx`)

布局:
```
┌──────────────────────────────────────┐
│ ⚡AIPageGo [↗sidepanel] [—] [×]     │  header (拖动)
├──────────────────────────────────────┤
│ (URL 命中的 preset 卡片 - EmptySuggestions) │
├──────────────────────────────────────┤
│ (ChatView - 复用组件)                │
│  [自愈] 系统气泡也在这里              │
├──────────────────────────────────────┤
│ 5.2k in / 1.8k out · round 3/20      │  状态条
├──────────────────────────────────────┤
│ [输入框                    ] [发送]  │  input-box
└──────────────────────────────────────┘
     320×480(可拖到 480×720)
```

- Panel 相对 shadow root `position: fixed;right: 72px; bottom: 16px`
- Header `[↗ 打开 sidepanel]` 图标点击 → `widget.openSidepanel({tabId})` RPC
- `[—]` 最小化到 FAB;`[×]` 关闭 panel(FAB 仍在)

### 6.4 Approval Modal(`approval-modal.tsx`)

- caution step 需 approval → Panel 内弹覆盖 modal(在 shadow root 内,不覆盖 host page)
- 复用 sidepanel `intervention-overlay.tsx` 的视觉:工具名 + args JSON preview + `[通过] [拒绝]`
- Approver 与 sidepanel 共享(`getApproverForTab(tabId)`)—— widget resolve/reject 就是全局 resolve

### 6.5 复用 vs 新建

| 组件 | 决策 |
|---|---|
| `sidepanel/components/chat-view.tsx` | **复用**(直接 import,133 行) |
| `StepCard` compact 版本 | 复用 |
| `EmptySuggestions` + `QuickActions` | 复用 |
| `settings-store`(读 LlmSettings) | 复用 hook |
| `session-store` | 复用 hook,widget 与 sidepanel 各 mount 一个 zustand 实例 |
| `sidepanel/chat/run-session.ts` | 复用(纯 DI) |
| `sidepanel/chat/approval.ts` | 复用 |
| `sidepanel/llm/*` | 复用 |
| `input-box.tsx` / `permission-mode-pill.tsx` | 复用 |
| Save-as-tool 弹窗 / 场景库 drawer / settings-drawer / logs-drawer / tool-detail-pane | **不带**(sidepanel 独占) |

Widget bundle 预估 ~120KB gzip(tree-shake 后)。

## 7 · 状态同步机制

### 7.1 广播源:session-store mutation hook

Widget + sidepanel 各自持有一个 zustand session-store 实例。为让两侧收敛,每次 mutation 走同一 helper:

```ts
// packages/extension/src/sidepanel/chat/session-store.ts (改造)
function broadcastMutation(tabId: number, snapshot: SessionData) {
  chrome.runtime.sendMessage({
    type: "session.state.changed",
    tabId,
    snapshot: { ...snapshot, _rev: (snapshot._rev ?? 0) + 1 }
  }).catch(() => {});
}
```

所有原来直接 `set(state => ...)` 的 action 里 append 一行 `broadcastMutation(tabId, get().sessionsByTab[tabId])`。

### 7.2 广播接收 & rev 仲裁

Widget 与 sidepanel 都注册:

```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== "session.state.changed") return;
  const { tabId, snapshot } = msg;
  const current = useStore.getState().sessionsByTab[tabId];
  if ((current?._rev ?? 0) >= snapshot._rev) return;  // 忽略过时
  useStore.setState((s) => ({
    sessionsByTab: { ...s.sessionsByTab, [tabId]: snapshot }
  }));
});
```

自发的 mutation 不需要被自己接住 —— 通过 sender check 忽略(`_sender.id === chrome.runtime.id && msg._origin === selfInstanceId` 一类)。

### 7.3 BG session-broker

BG 侧一个 `session-broker.ts`,单一职责:
- listen `session.state.changed`
- 用 `chrome.tabs.sendMessage` 广播给同 tab 的所有 content-scripts(widget)
- sidepanel 通过 `chrome.runtime.sendMessage` 收到(runtime-wide)

**为什么 BG 不 dedupe**:sender check 在接收方做,BG 不用状态,零 bug 面。

### 7.4 Run ownership

- `SessionData.status ∈ {"idle","running","streaming","waiting_approval"}` 已存在
- 只有 `status === "idle"` 时,两侧 send 按钮才 enabled
- 谁点了 send,谁的 `runChatSession` 起来 —— 另一侧只是被广播刷 UI

## 8 · Dangerous Step 交接

### 8.1 触发路径

Widget 内 `runChatSession` 遇到 dangerous step:
1. `approval.request(step)` 返回 pending Promise
2. Widget UI 不弹 caution modal(dangerous 独占路径)—— 弹一个 "此步需在扩展面板确认" 卡片,里面一个 `[打开扩展面板]` 按钮
3. Widget 也可以设为**自动**打开(设置项 `widgetAutoOpenSidepanelForDangerous`,默认 on)
4. 触发 `widget.openSidepanel` RPC(见 5.4)

### 8.2 BG 处理

```ts
case "widget.openSidepanel": {
  await chrome.sidePanel.open({ tabId: req.tabId });
  if (req.pendingApprovalId) {
    await chrome.storage.session.set({
      "aipagego.pendingApproval": { tabId: req.tabId, approvalId: req.pendingApprovalId, ts: Date.now() }
    });
  }
  return null;
}
```

- `chrome.sidePanel.open` 需要 user gesture chain — widget 按钮 click 触发 → content-script 里的 chrome.runtime.sendMessage → BG,MV3 允许这条链
- 若 gesture chain 中断(Chrome 保守判定)→ 返回 error,widget 显示 "请手动点击浏览器右上角扩展图标"

### 8.3 Sidepanel 侧 focus

Sidepanel mount 时的 `useEffect`:
```ts
useEffect(() => {
  chrome.storage.session.get(["aipagego.pendingApproval"]).then((res) => {
    const p = res["aipagego.pendingApproval"];
    if (!p) return;
    if (Date.now() - p.ts > 30_000) return;  // 太老忽略
    scrollToStepCard(p.approvalId);
    chrome.storage.session.remove(["aipagego.pendingApproval"]);
  });
}, []);
```

Approver 是同一个单例 → widget 的 pending Promise 在 sidepanel approve 后自然 resolve;widget 的 `runChatSession` 继续跑该步之后的 steps。

## 9 · 安全 & 隐私

- Shadow DOM `mode: "open"` — host page 可查到 tag 存在但**读不到 shadow tree 内容**(是的,open 也够;closed 只是防意外 API 探查,不阻挡 devtools)
- Host page 无法通过 postMessage 触发 widget 内部行为 —— widget 不监听 `window.message`
- API key 只在 `chrome.storage.local | session` — widget script 与 sidepanel 同为扩展代码域,host page 脚本无权读
- Widget 里不显示完整 session history 中的敏感 field(仅显示 message text + 工具名 + args preview,与 sidepanel 保持一致口径)
- Shadow root **不注入 host 的 CSS** —— 页面主题不污染 widget,widget 也不污染页面

## 10 · CSP & 特殊页

- Content-script 注入不受页 CSP 影响(浏览器机制)
- `X-Frame-Options` / `CSP frame-ancestors` 与 widget 无关(shadow DOM 不是 iframe)
- Trusted Types(某些 Google 内网页 / 政府站)可能拒 innerHTML —— widget 全用 `document.createElement + appendChild`,不用 innerHTML
- CSP `style-src` 拒 inline style —— 用 `adoptedStyleSheets`(所有 Chromium ≥ 96 支持)
- 无法注入的页(`chrome://` / Web Store / PDF viewer / file:// with restricted flag)—— content-script 天生进不去,零 fallback,用户仍可以点扩展图标开 sidepanel

## 11 · 测试策略

### 11.1 新增单元测试(happy-dom)

- `packages/extension/tests/content/widget/mount.test.ts` — top-window / iframe guard、globalEnabled=false skip、hiddenHosts skip
- `packages/extension/tests/content/widget/per-site.test.ts` — hiddenHosts 读写
- `packages/extension/tests/content/widget/store.test.ts` — hydrateFromBroadcast rev 冲突处理

### 11.2 集成测试

- `packages/extension/tests/content/widget/broadcast-sync.test.ts` — 起两个 zustand 实例模拟 widget+sidepanel,dispatch mutation 后收敛
- `packages/extension/tests/content/widget/handoff.test.ts` — dangerous step → widget.openSidepanel 被调用一次,pendingApprovalId 写入 storage.session

### 11.3 sidepanel 端回归

- 现有 `packages/extension/tests/sidepanel/chat/session-store.test.ts` 若存在,增加 `_rev` 递增断言
- session-store 已有测试保证 broadcastMutation append 后原有行为不变

### 11.4 不引入 Playwright

沿用现有约定;UI smoke 手动。

## 12 · 迁移 & 兼容

- 无 IDB schema 变化
- `LlmSettings.widgetEnabled` 缺省 → DEFAULTS = `true`(现有 settings-store `load()` 已 merge)
- `SessionData._rev` 可选,老数据缺失 = 0,首次 mutation → 1
- Content-script bundle 新增一个,manifest 追加一行,现有 4 个不变
- 现有 sidepanel 代码只改 session-store.ts 一个文件(加 broadcastMutation hook)
- Coordinator EXEC / chat 路径:BG 端会话不动;广播 hook 不影响 BackgroundToolRunner 与 CoordinatorChatHost

## 13 · 度量 & 观测

- widget mount 每次打 `console.info("[aipagego-widget] mounted on", location.host)`
- 诊断包(现有 `[导出诊断包]`)加两段:`fabPos` / `hiddenHosts` / `widgetEnabled` 值
- 会话消息里若一条来自 widget、后续 sidepanel 补的,不做区分标签(共享 session,溯源无意义)

**不上报服务器** —— 与自愈同款,所有度量本地可见即可。

## 14 · 分阶段落地

Plan 会拆成 5 phase:

1. **Phase 1** — 骨架:manifest 追加 content-script;`mount.ts` + Shadow DOM + 一个 hello-world FAB(占位)。1 PR
2. **Phase 2** — Panel + 复用 ChatView + 输入框 + session-store 广播 hook。1 PR
3. **Phase 3** — Approval modal + dangerous handoff + `widget.openSidepanel` RPC + sidepanel focus effect。1 PR
4. **Phase 4** — 逐站黑名单 + 拖动 FAB + 位置记忆 + panel 大小记忆 + settings 里的 widgetEnabled 开关。1 PR
5. **Phase 5** — 全量测试 + docs-site 补章节 + 诊断包补新字段。1 PR

每 phase 可独立发版;首版目标全打包一次性发 v0.0.46。

## 15 · 未来议题(备忘,不做)

- FAB 位置跨设备同步(需要 chrome.storage.sync 或后端;未来)
- Widget 内的多 tab 视图(现在仅当前 tab)
- Widget 内的场景库 mini 版(现在跳 sidepanel)
- FAB 图标定制 / 品牌白标(付费版议题)
- 触屏 & 移动 Chrome 支持
- iframe 备选方案(如果 Shadow DOM 遇到 host 页面严重冲突再考虑)
