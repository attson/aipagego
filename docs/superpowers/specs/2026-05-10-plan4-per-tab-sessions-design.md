# Plan 4: Per-Tab Chat Sessions — 设计文档

- 日期：2026-05-10
- 状态：草案，待评审
- 范围：把 sidepanel 里的全局单例聊天会话改造成"按 tab 挂钩"的多会话——每个浏览器 tab 一份独立 ChatSession，切 tab 看到该 tab 的对话历史，关 tab 后会话进入 5 分钟"近期会话"临时区可恢复
- 前置：Plan 1+2+3 已落地

## 1. 目标与定位

AIPageGo 的会话目前是 sidepanel 全局单例：用户切到另一个浏览器 tab 后再发指令，AI 看到的还是上一个 tab 的对话历史与 url 上下文，导致结果错乱。本 plan 把会话与 tab 绑定，让助手"挂在 tab 上"——每个 tab 独立的对话历史、独立的 step 卡、独立的 token 计数、独立的输入框草稿。

非目标：
- 持久化（关浏览器后恢复）
- 跨设备同步
- 多 window 协作

## 2. 关键决策回顾

| 决策点 | 选择 |
|---|---|
| 粒度 | tabId |
| 同 tab 内 navigate（URL 变化） | 保留同一会话；向 messages 追加 system note `[页面跳转] 新 URL: ...`，让 LLM 知道上下文切换 |
| 切 tab 时正在跑的会话 | 后台继续跑，UI 不可见；切回时看到进度 |
| 关 tab 处理 | 对应 SessionData 移入 5 min 临时区"近期会话"，过期释放；用户可主动"恢复"到当前 tab |
| 实现方案 | 单 zustand store + `sessionsByTab` 切片（actions 都接 `tabId` 参数） |

## 3. 整体架构

```
zustand store
  ├─ sessionsByTab: Record<number, SessionData>
  ├─ closedSessions: ClosedSession[]
  ├─ currentTabId: number | null
  └─ actions(tabId, ...)

chat-page.tsx (UI)
  ├─ useSession() → 当前 tab 的 SessionData (selector)
  ├─ tab-tracker (NEW) — chrome.tabs.{onActivated,onUpdated,onRemoved}
  ├─ closed-sessions-pruner (NEW) — 30s 间隔扫过期
  └─ run-session.send() 闭包持有 tabId，所有 onEvent → action(tabId, ...)

approval.ts
  └─ approversByTab: Map<number, Approver>     ← per-tab pending Promise
```

会话循环依旧住在 sidepanel React state（与 Plan 2 设计一致）。run-session 内部通过 onEvent 触发外部 store 更新，update 调用都带启动它时的 tabId（不依赖 currentTabId）——这样切 tab 后原 tab session 仍能正确推进。

## 4. 数据结构

### 4.1 SessionData（per tab）

```typescript
type SessionData = {
  // identity
  tabId: number;
  url: string;
  runRecordId: string | null;

  // chat
  messages: ChatMessage[];
  streamingAssistantText: string;
  cards: StepCardState[];

  // settings (per session)
  approveAllSafe: boolean;

  // status
  status: "idle" | "streaming" | "awaiting" | "running" | "done" | "error" | "aborted";
  errorMessage: string | null;
  roundCount: number;
  tokenUsage: { input: number; output: number };

  // tool save
  executedSteps: Step[];
  lastOutput: Json;
  showSaveDialog: boolean;

  // abort
  abortController: AbortController | null;

  // logs
  logs: LogEntry[];
  logsOpen: boolean;

  // input draft (per tab textarea)
  inputDraft: string;
};
```

### 4.2 ClosedSession

```typescript
type ClosedSession = {
  tabId: number;       // 原 tabId（仅作 key 与显示）
  url: string;         // 关闭时该 tab 的 url
  closedAt: number;
  data: SessionData;
};
```

### 4.3 StoreShape

```typescript
type StoreShape = {
  sessionsByTab: Record<number, SessionData>;
  closedSessions: ClosedSession[];
  currentTabId: number | null;
  // 加上 ~25 个 actions（见 §5）
};
```

`EMPTY_SESSION: SessionData` 是 deepFrozen 的 sentinel，UI 在 currentTabId 为 null 或对应 SessionData 缺失时用作兜底，避免 ?? 链。

## 5. Actions 与 Selectors

### 5.1 Actions（全部首参 `tabId: number`）

```typescript
ensureSession(tabId, url)               // 没有则新建空 SessionData
appendUserMessage(tabId, text)
beginAssistantTurn(tabId)
appendAssistantText(tabId, delta)
finalizeAssistantTurn(tabId, toolUses)
upsertCard(tabId, card)
setCardStatus(tabId, id, patch)
appendToolResults(tabId, results)
pushExecutedStep(tabId, step)
setLastOutput(tabId, value)
incrementRound(tabId)
addUsage(tabId, usage)
setStatus(tabId, status)
setError(tabId, msg)
setApproveAllSafe(tabId, v)
setIdentity(tabId, { url, runRecordId })
setUrl(tabId, url)
appendSystemNote(tabId, text)           // navigate 时用
setAbortController(tabId, ac)
showSave(tabId)
hideSave(tabId)
appendLog(tabId, level, message, details?)
clearLogs(tabId)
setLogsOpen(tabId, open)
setInputDraft(tabId, text)              // textarea 输入
resetSession(tabId)                     // "清空对话"

// 全局
setCurrentTab(tabId)
closeTab(tabId)                         // onRemoved 调
restoreClosed(closedIndex, targetTabId) // 用户恢复
pruneClosed(now)                        // timer 调
```

### 5.2 Selectors

```typescript
// hook：返回当前 tab 的整个 SessionData（与现有 useSession() 用法一致）
export function useSession(): SessionData {
  return useStore((s) => {
    const id = s.currentTabId;
    return id == null ? EMPTY_SESSION : (s.sessionsByTab[id] ?? EMPTY_SESSION);
  });
}

// 给 run-session 用，固定到 tabId
export function getSessionFor(tabId: number): SessionData;

// 全局
export function useCurrentTabId(): number | null;
export function useClosedSessions(): ClosedSession[];
```

## 6. 生命周期事件

### 6.1 sidepanel mount

```typescript
useEffect(() => {
  // 1. 初始化当前 tab
  currentTabInfo().then(({ tabId, url }) => {
    setCurrentTab(tabId);
    ensureSession(tabId, url);
  });

  // 2. 安装 tab-tracker
  const off = installTabTracker();   // chrome.tabs.{onActivated,onUpdated,onRemoved}

  // 3. 启动 pruner
  const t = setInterval(() => pruneClosed(Date.now()), 30_000);

  return () => { off(); clearInterval(t); };
}, []);
```

### 6.2 tab-tracker（新文件 `chat/tab-tracker.ts`）

```typescript
export function installTabTracker(): () => void {
  const onAct = ({ tabId }: { tabId: number }) => {
    chrome.tabs.get(tabId).then((tab) => {
      store.setCurrentTab(tabId);
      store.ensureSession(tabId, tab.url ?? "");
    }).catch(() => store.setCurrentTab(tabId));
  };

  const onUpd = (tabId: number, change: chrome.tabs.TabChangeInfo) => {
    if (!change.url) return;
    store.setUrl(tabId, change.url);
    const s = getSessionFor(tabId);
    if (s.messages.length > 0) {
      store.appendSystemNote(tabId, `[页面跳转] 新 URL: ${change.url}`);
    }
  };

  const onRem = (tabId: number) => {
    store.closeTab(tabId);                       // 内部判空 + abort + 移入 closedSessions
    disposeApproverForTab(tabId);                // 见 §7
  };

  chrome.tabs.onActivated.addListener(onAct);
  chrome.tabs.onUpdated.addListener(onUpd);
  chrome.tabs.onRemoved.addListener(onRem);
  return () => {
    chrome.tabs.onActivated.removeListener(onAct);
    chrome.tabs.onUpdated.removeListener(onUpd);
    chrome.tabs.onRemoved.removeListener(onRem);
  };
}
```

### 6.3 appendSystemNote 设计

system note 是塞进 messages 的一条特殊 user message：

```typescript
{ role: "user", content: `[系统提示] 页面已跳转到: ${url}\n（继续在新 URL 上处理用户的下一条指令）` }
```

放 user role 比 system 更兼容（Anthropic / OpenAI 都接受 multi-user message；改 system 字段会触发 reset）。LLM 看到这种文本会自动调整。

### 6.4 closeTab 实现

```typescript
closeTab(tabId) {
  const s = sessionsByTab[tabId];
  if (!s) return;
  s.abortController?.abort();
  if (s.messages.length === 0) {
    delete sessionsByTab[tabId];
    return;
  }
  closedSessions.push({
    tabId, url: s.url, closedAt: Date.now(), data: s
  });
  delete sessionsByTab[tabId];
}
```

### 6.5 restoreClosed 实现

```typescript
restoreClosed(idx, targetTabId) {
  const c = closedSessions[idx];
  if (!c) return;
  const existing = sessionsByTab[targetTabId];
  if (existing && existing.messages.length > 0) {
    // 调用方应已 confirm；这里直接覆盖
  }
  // 复制 + 重置易变字段
  sessionsByTab[targetTabId] = {
    ...c.data,
    tabId: targetTabId,
    abortController: null,
    status: "idle",
    showSaveDialog: false,
    streamingAssistantText: "",
    runRecordId: null     // 不复用旧 RunRecord，恢复后视为新会话写新 record
  };
  closedSessions.splice(idx, 1);
  // 加 system note 让 AI 知道这是恢复来的
  appendSystemNote(targetTabId, `[已恢复] 来自 tab ${c.tabId}（${c.url}）的会话，请继续`);
}
```

### 6.6 pruneClosed 实现

```typescript
pruneClosed(now: number) {
  closedSessions = closedSessions.filter(
    (c) => now - c.closedAt < 5 * 60 * 1000
  );
}
```

## 7. Per-tab Approver

```typescript
// approval.ts
const approversByTab = new Map<number, Approver>();

export function getApproverForTab(tabId: number): Approver {
  let a = approversByTab.get(tabId);
  if (!a) {
    a = new Approver();
    approversByTab.set(tabId, a);
  }
  return a;
}

export function disposeApproverForTab(tabId: number): void {
  const a = approversByTab.get(tabId);
  if (a) {
    a.resolveAllPending({ kind: "deny" });
    approversByTab.delete(tabId);
  }
}
```

`getGlobalApprover()` 删除（曾在 Plan 2 引入）。chat-page.tsx 与 chat-view.tsx 改用 `getApproverForTab(currentTabId)`。

## 8. UI 改动

### 8.1 closed-sessions banner（新组件）

`src/sidepanel/components/closed-sessions-banner.tsx`：

```
┌─────────────────────────────────────────────────────────────┐
│ 📁 近期会话（5 分钟内可恢复）                                  │
│  · "总结网页内容..."  https://x.com/foo  4 min 前   [恢复]    │
│  · "填写注册表单..."  https://y.com/reg  2 min 前   [恢复]    │
└─────────────────────────────────────────────────────────────┘
```

每条显示：
- 第一条 user message 前 30 字（去掉 system note）
- url（host + 缩略 path）
- 距关闭多少秒/分钟前
- [恢复] 按钮

恢复点击：
```
if (currentSession.messages.length > 0) {
  if (!confirm("将覆盖当前 tab 会话？")) return;
}
restoreClosed(idx, currentTabId);
```

### 8.2 当前 tab 信息条

在 status bar 之上加一个细条（仅当 currentTabId 与 sessionData.url 已知）：

```
[Tab #142] shop.example.com/goods.html?...
```

让用户清楚正在和哪个 tab 聊。点击不做事（或后期可加"聚焦该 tab"）。

### 8.3 输入框 draft 按 tab

```typescript
// chat-page.tsx
const session = useSession();
const [input, setInput] = useState(session.inputDraft);

useEffect(() => {
  setInput(session.inputDraft);    // 切 tab 时同步
}, [currentTabId]);

<textarea
  value={input}
  onChange={(e) => {
    setInput(e.target.value);
    setInputDraft(currentTabId, e.target.value);    // 写回 store
  }}
/>
```

发送后清空：`setInputDraft(currentTabId, "")`。

### 8.4 chat-page send() 改造

`send(prompt)` 函数顶部固定一次 tabId（启动时的）：

```typescript
const send = async (prompt: string) => {
  const { tabId, url } = await currentTabInfo();    // 启动时的 tabId
  ensureSession(tabId, url);
  setError(tabId, null);
  setStatus(tabId, "streaming");
  appendUserMessage(tabId, prompt);
  appendLog(tabId, "info", "提交 prompt", ...);
  setInputDraft(tabId, "");
  setInput("");

  const ac = new AbortController();
  setAbortController(tabId, ac);

  const approver = getApproverForTab(tabId);
  ...

  const onEvent = (e: SessionEvent) => {
    switch (e.type) {
      case "round_start":
        incrementRound(tabId); beginAssistantTurn(tabId); break;
      case "text_delta":
        appendAssistantText(tabId, e.text); break;
      case "tool_use_start":
        upsertCard(tabId, { toolUseId: e.id, ... }); break;
      // ...所有 actions 都带 tabId
    }
  };

  await runChatSession({ ... });
};
```

`onEvent` 内闭包持有的 `tabId` 不会被 setCurrentTab 影响——这是关键。

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| sidepanel 打开时 currentTab 无对应 SessionData | `ensureSession(tabId, url)` 自动创建 |
| `chrome.tabs.onActivated` 触发但 tab 已关 | `chrome.tabs.get` reject，仅 `setCurrentTab(tabId)` 后续 `ensureSession` 用空 url |
| 切 tab 时原 tab 有 awaiting 审阅 step | 该 step 留在原 SessionData.cards；切回后用户继续审；approver pending 保留 |
| 切 tab 时原 tab 正在跑 LLM | run-session closure 持有原 tabId，所有 onEvent → store 写入原 SessionData；UI 显示新 tab，原 tab 在后台推进 |
| `closeTab` 时 tab 在跑 | `abortController.abort()`；`appendLog(tabId,"warn","tab 关闭，会话中止")`；data 移入 closedSessions |
| `closeTab` 时 messages 为空 | 不入 closedSessions，直接 `delete` |
| 5 min timer 过期但用户在看 banner 项 | 直接消失（5 分钟已过，可接受） |
| `restoreClosed` 时 currentTab 已有 messages | 调用方先 `confirm`；若用户取消则不动作 |
| `restoreClosed` 时 closedSessions[idx] 已被 prune | 静默 noop（防 race） |

## 10. 模块边界与文件结构（增量）

```
src/sidepanel/
├─ chat/
│  ├─ session-store.ts                       # MOD: 全部重写
│  ├─ approval.ts                            # MOD: per-tab factory
│  ├─ run-session.ts                         # 不变（onEvent 接口不变）
│  ├─ tab-tracker.ts                         # NEW
│  └─ closed-sessions-pruner.ts              # NEW: setInterval hook
├─ pages/
│  └─ chat-page.tsx                          # MOD: send() 用 tabId；input 绑 inputDraft
├─ components/
│  ├─ closed-sessions-banner.tsx             # NEW
│  ├─ tab-info-bar.tsx                       # NEW (轻量)
│  ├─ chat-view.tsx                          # MOD: 用 getApproverForTab
│  ├─ status-bar.tsx                         # 不变（仍 useSession）
│  ├─ logs-drawer.tsx                        # MOD: 调 actions 时带 tabId
│  ├─ recommendations-banner.tsx             # 不变
│  └─ save-as-tool-dialog.tsx                # 不变
└─ app.tsx                                   # MOD: mount tab-tracker + pruner

tests/sidepanel/chat/
├─ session-store.test.ts                     # NEW: per-tab CRUD + close/restore/prune
└─ tab-tracker.test.ts                       # NEW: chrome.tabs 事件 → store
```

## 11. 测试策略

### 11.1 session-store.test.ts（约 10 case）

- `ensureSession` 创建空 SessionData
- `appendUserMessage` 仅写入指定 tabId
- 切 tab 不影响其他 tab 的 messages
- `closeTab` 把 SessionData 移入 closedSessions（messages 非空时）
- `closeTab` messages 为空时直接 delete
- `closeTab` 调 abort
- `restoreClosed` 复制到 targetTab 并清易变字段
- `restoreClosed` 之后 closedSessions[idx] 被移除
- `pruneClosed(now)` 删除 5 min 之前的项
- `setInputDraft` 仅作用于指定 tab

### 11.2 tab-tracker.test.ts（约 5 case）

- mock `chrome.tabs.onActivated` → setCurrentTab + ensureSession 被调
- mock `chrome.tabs.onUpdated` URL 变 → setUrl + appendSystemNote（仅当 messages 非空）
- mock `chrome.tabs.onUpdated` URL 变但 messages 为空 → 不 appendSystemNote
- mock `chrome.tabs.onRemoved` → closeTab + disposeApproverForTab
- 卸载 listener 后再触发不影响 store

新增约 15 个 test。total 134 + 15 = **149 tests**。

## 12. 范围内 vs 不在 Plan 4

**在**：第 4-10 节列出的所有 NEW + MOD。

**不在**（推迟）：
- chrome.storage 持久化（关浏览器后恢复）
- 跨设备同步
- closedSessions 用户主动"延长保留"按钮
- 多 window 协作（chrome.windows API）
- 给 tab-info-bar 加"聚焦该 tab"功能（chrome.tabs.update active=true）

## 13. 评审与下一步

本文档评审通过后调用 writing-plans 技能产出 Plan 4 实施计划。计划预期 12-16 task，按以下里程碑：

1. 数据结构 + EMPTY_SESSION + actions 骨架
2. session-store 重写 + 单测
3. approver per-tab factory + 替换 callsite
4. tab-tracker + closed-sessions-pruner
5. chat-page send() 改造（onEvent 全带 tabId）
6. closed-sessions-banner + tab-info-bar
7. logs-drawer / chat-view 等组件 callsite 修
8. 全量回归（149 tests + 手测三个场景）

**不影响**：
- IDB DB_NAME（仍 `aipagego`）
- run-session.ts 公共接口
- LLM 适配 / 工具集 / system prompt
- 设置页 / 工具库 / 工具详情页

仓库目录重命名仍留给用户在更晚阶段手动处理。
