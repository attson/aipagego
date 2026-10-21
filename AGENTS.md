# Agent Guide — AIPageGo

This file orients AI agents (Claude Code / Codex / Cursor) working in this
repo. Read it before making non-trivial changes.

## What this is

AIPageGo is a Chromium MV3 side-panel extension that lets a user converse
with an LLM and have it read / write / collect on the currently-open web
page. Successful conversations can be **固化 (solidified)** into reusable
URL-pattern-matched tools that replay the same step sequence on similar
pages without an LLM round-trip.

Three personas of work the user expects help with:

- **read**: summarize / translate / extract / answer about the page
- **write**: fill forms, click, select, submit, upload
- **collect**: gather images, lists, reviews into structured data

## Tech stack

- Vite 5 + `@crxjs/vite-plugin` (MV3 build), React 18, TypeScript 5 (strict)
- Tailwind 3, zustand 4, zod 3, idb 8
- vitest + happy-dom + fake-indexeddb (no Playwright dependency; live-browser
  UI smoke uses the AIPageGo MCP, with manual fallback; coordinator-driven
  E2E covers the chat loop via a real `ws` server)
- pnpm 9 workspaces (4 packages: `shared` / `coordinator` / `extension` / `mcp-server`)
- LLM: Anthropic Messages API + OpenAI Chat API; both stream via fetch
  directly from the side panel (no proxy, no key on disk except
  `chrome.storage.local | session`)
- Remote control: optional WebSocket coordinator client (`packages/coordinator`
  is the reference server) — exposes EXEC for individual tools and a
  separate opt-in surface for full chat sessions; off by default

## Repo layout

```
aipagego/                                # pnpm workspaces monorepo（Phase 0 起）
├─ packages/
│  ├─ shared/                         纯函数 + 类型 + zod wire schemas（无 chrome / 无 DOM 依赖）
│  │  └─ src/
│  │     ├─ types.ts                  Tool(+origin?) / Step / RunRecord(+source, +healed?) / ChatMessage / Severity / ToolUsePart / JsonSchema / LlmSettings(+selfHealEnabled, +maxSelfHealOutputTokens)
│  │     ├─ messages.ts               zod RPC schemas (sidepanel <-> bg <-> content)；含 ToolOriginSchema、presets.list/presets.materialize RPC
│  │     ├─ preset.ts                 Plan 27：PresetSchema / PromptPreset / ToolPreset zod + TS types（discriminator "kind"）
│  │     ├─ presets/                  静态 registry（无 IO）：`index.ts` 聚合 11 条 + `content/*.ts` + `ecommerce/*.ts`
│  │     ├─ match-presets.ts          `matchPresetsByUrl(url, registry?) → Preset[]`；复用 url-pattern
│  │     ├─ url-pattern.ts            glob → RegExp；`matchesAny(url, patterns)`
│  │     ├─ static-scan.ts            runJS source → severity findings (regex rules)
│  │     ├─ infer-json-schema.ts      Minimal JSON Schema inference for save dialog
│  │     ├─ llm/                      LlmClient interface + LlmStreamEvent union + builtin-tool-defs（Phase 2 起被 background 共用；文档站从 TOOL_DEFS 生成参考页）
│  │     └─ protocol/                 WS protocol：envelope / errors / messages / chat-event（含 self_heal_started/completed/failed 镜像）；ClientToServerSchema、ServerToClientSchema discriminated unions
│  ├─ coordinator/                    参考 WS 服务器（worker registry / session manager / dispatcher / catalog / clock）
│  │  └─ src/                         （仅供测试与本地 smoke；生产部署不在这里）
│  ├─ mcp-server/                     stdio MCP server + LoopbackWSHub（Plan 13；Claude 经 coordinator 驱动浏览器）
│  └─ extension/                      AIPageGo 浏览器扩展（46 LLM tools + sidepanel + in-page widget + LLM agent loop + WS worker）
│     ├─ src/
│     │  ├─ manifest.ts               MV3 manifest (defineManifest)
│     │  ├─ background/               Service worker
│     │  │  ├─ index.ts               Wakeup + RPC listener + tab-watcher + coordinator client lifecycle
│     │  │  ├─ rpc-handlers.ts        Dispatch RpcRequest; runOneStep + injectMainWorld（被 coordinator-exec / bg-tool-runner 复用）
│     │  │  ├─ http-proxy.ts          Cross-origin fetch (omit/include cookie); fetchAsBase64 for uploadFile
│     │  │  ├─ tab-watcher.ts         chrome.tabs / webNavigation → set badge + 推 tabs.recommendations / tabs.spawned / tabs.urlChanged / tabs.removed
│     │  │  ├─ tab-close-archiver.ts  关 tab 时 archive 会话到 IDB（Plan 8）
│     │  │  ├─ coordinator-client.ts  单 WS 实例：HELLO / EXEC / START_CHAT_SESSION 等路由 + chrome.alarms 心跳 + 重连
│     │  │  ├─ coordinator-state.ts   worker_id / token / config / allow_remote_chat 存 chrome.storage.local
│     │  │  ├─ coordinator-hello.ts   HELLO payload 构造（fingerprint / saved_tools / available_tabs）
│     │  │  ├─ coordinator-exec.ts    EXEC → runOneStep 适配 + Result 包装
│     │  │  ├─ coordinator-chat.ts    Plan 12 新增：START_CHAT_SESSION / ABORT_SESSION 入口；BG 端跑 runChatSession（一次一个 session，受 allow_remote_chat gate）
│     │  │  ├─ coordinator-state-bridge.ts   READ_SIDEPANEL_STATE → chrome.runtime ping/pong（500ms 超时）→ SIDEPANEL_STATE_REPLY
│     │  │  ├─ mock-llm-client.ts     Plan 12：脚本化 LlmStreamEvent[][]，每 stream() 取下一轮
│     │  │  ├─ bg-tool-runner.ts      ToolRunner 接口的 background 实现（直接调 runOneStep）
│     │  │  ├─ self-heal.ts           Plan 27：`attemptHeal(ctx, deps)` 纯函数 + DI；zod parse patched Step[] + static-scan gate（严格拒 dangerous）
│     │  │  ├─ self-heal-bridge.ts    Plan 27：BG → sidepanel 借 LLM 的 chrome.runtime.sendMessage 包装（30s timeout → `no_sidepanel`）
│     │  │  └─ storage/{db,tools,runs,export-import,sessions}.ts   IndexedDB (DB_NAME = "aipagego" — do NOT rename)；`runs` 表 record 有 `source: "user" | "coordinator"` 与可选 `healed?: {fromVersion,toVersion,fixedStepIndex}`；`tools` 表带可选 `origin?: {kind:"preset", presetId, presetVersion}`；`materializePreset(id)` 幂等复制 preset 到 IDB；`exportTools()` 跳过未修改的 preset 副本；`importTools()` 剥掉未知 preset origin
│     │  ├─ content/                  Content script (isolated world)
│     │  │  ├─ index.ts               chrome.runtime.onMessage → callTool / injectMain
│     │  │  ├─ element-capture.ts     页面元素圈选：hover 高亮 + click 产 selector，供 sidepanel/widget 作为附件式引用
│     │  │  ├─ runner.ts + ctx.ts     Step Runner with ${var} bindings + timeout
│     │  │  ├─ inject-main.ts         Bridge to BG.scripting.injectMain
│     │  │  ├─ tools/*.ts             One file per BuiltinTool
│     │  │  ├─ tools/page-index/      v0.0.53：页面块索引 / 搜索 / 字段候选 / 分页读取
│     │  │  └─ widget/                页内浮窗入口（Shadow DOM）：mini chat / history / resize / image paste / element capture
│     │  └─ sidepanel/                Full React UI surface; widget is the lightweight in-page companion
│     │     ├─ rpc.ts                 typed wrappers + onTabRecommendations（含 `presets` 字段） + onTabEvents + retry on SW wake；`rpc.listPresets/materializePreset` 走 BG
│     │     ├─ self-heal-host.ts      Plan 27：接 BG selfheal 请求 → 用本地 LlmClient 一次性非流式跑 → 回补丁 steps；BG 侧不持 key
│     │     ├─ chat/
│     │     │  ├─ session-store.ts    zustand: sessionsByTab + currentTabId + per-tab attachedTabs + llmExchanges；`appendHealNote(tabId, text)` 用于 `[自愈]` 系统气泡
│     │     │  ├─ persistence/        Plan 8：sessions IDB store；每 URL ≤20 archived sessions + cascade 删 runs
│     │     │  ├─ approval.ts         Per-tab Approver factory
│     │     │  ├─ severity.ts         classifyTool(name, args) / autoApproves(sev,name,toggle,allowlist)
│     │     │  ├─ tool-runner.ts      ToolRunner 接口；sidepanel 实现 wraps rpc.runOneStep
│     │     │  ├─ run-session.ts      LLM tool-use loop (DI: client/runner/approver/rpc/tabsRpc); emits SessionEvent（含 self_heal_started/completed/failed，18 变体）；continuation guard 总额上限（v0.0.15）
│     │     │  ├─ cross-tab-events.ts Plan 7：tabs.spawned / urlChanged / removed → store mutation + system note（仅当 session 处于 running/streaming 时把 opener-match 算 AI 开 — v0.0.14 修）
│     │     │  ├─ tab-tracker.ts      chrome.tabs events → store actions
│     │     │  ├─ quick-actions.tsx   Plan 23+27：空态 chip；URL 命中的 prompt-form preset 优先展示，不足 3 条以默认 3 条补齐
│     │     │  ├─ empty-suggestions.tsx  Plan 27：命中当前 URL 的 preset 卡片（含推荐场景 banner），tool preset → materialize + 打开工具详情；prompt preset → 填输入
│     │     │  ├─ intervention-store.ts / permission-mode-pill.tsx  Plan 17：会话中断 + 顶部权限模式切换
│     │     │  ├─ ui-store.ts         drawer 栈（DrawerKind 含 tools/settings/scenarios/logs 等）
│     │     │  └─ settings-store.ts   LlmSettings (provider/model/apiKey/endpoint/maxRounds/maxTokens/trustedDangerTools/maxContinuationNudges/defaultChatMode/defaultPermissionMode/theme/**selfHealEnabled/maxSelfHealOutputTokens**)
│     │     ├─ llm/
│     │     │  ├─ types.ts            re-export from @aipagego/shared/llm（兼容存量 import）
│     │     │  ├─ anthropic.ts / openai.ts    SSE parsers（surface stop_reason on message_end）
│     │     │  ├─ recording-client.ts Plan 11：包 LlmClient 捕获 request/response 到 llmExchanges（apiKey 屏蔽）
│     │     │  ├─ http-error.ts       HTTP 错误规范化（含 retry-after 解析）
│     │     │  ├─ truncate.ts         exchange log payload 截断
│     │     │  ├─ client.ts           pickClient(provider)
│     │     │  ├─ tool-schema.ts      re-export TOOL_DEFS；46 个 LLM tools 从 @aipagego/shared/llm 来
│     │     │  ├─ system-prompt.ts    buildSystemPrompt({url,title,savedTools,attachedTabs})；含 tier 选择提示
│     │     │  ├─ summary-step.ts     One-shot 非流式生成 "summary runJS step"（Plan 5）
│     │     │  ├─ self-heal-prompt.ts Plan 27：`buildSelfHealMessages(ctx, maxOutputTokens)` — 允许 step 白名单 + DOM 截断 + 已成功产物摘要
│     │     │  └─ tool-draft-generator.ts   Plan 6：AI 总结对话生成工具草案（提示词或 steps）
│     │     ├─ pages/
│     │     │  ├─ scenarios-page.tsx           Plan 27：场景库 drawer；搜索 / 分类 / 状态角标（NEW/已复制/已升级 vN）；命中 URL 即可「在当前 tab 运行」
│     │     │  └─ coordinator-settings-page.tsx   WS URL/token 配置 + 状态展示 + allow_remote_chat checkbox
│     │     ├─ drawers/
│     │     │  ├─ tool-detail-pane.tsx         替换旧 tool-detail-page；`[让 AI 修复]` 追加 `run.healed` 摘要
│     │     │  ├─ tools-drawer.tsx / scenarios-drawer.tsx / logs-drawer.tsx / settings-drawer.tsx
│     │     │  └─ settings/section-llm.tsx     LLM + `selfHealEnabled` + `maxSelfHealOutputTokens` 输入
│     │     ├─ input/                          input-box / mention-picker / prompt-optimize-button / selected-elements（附件式 selector 引用）
│     │     ├─ lib/xlsx.ts                     v0.0.53：无依赖最小 XLSX writer；`downloadSpreadsheet` meta tool 使用
│     │     ├─ shell/
│     │     │  └─ app-shell.tsx                路由 / 顶部 header / drawer 栈 / heal 事件 listener / tab-tracker mount / coordinator-state-bridge mount
│     │     ├─ coordinator-state-bridge.ts   Plan 12 sidepanel 端：响应 ping.sidepanelState → 读 zustand 拼快照 → pong
│     │     └─ components/            Stateless except where needed (chat-view, step-card, exchange-log, markdown-text, staged-selectors, etc.)
│     ├─ tests/                       Unit + integration（含 background/coordinator-e2e.test.ts：起真 `ws` server 跑 HELLO/EXEC/START_CHAT_SESSION 端到端）
│     ├─ vite.config.ts               Vite 配置含 @crxjs；build 产物在 packages/extension/dist/
│     ├─ tsconfig.json
│     └─ package.json
├─ docs/superpowers/
│  ├─ specs/                          Design docs；见 specs/README.md（已涵盖 Plan 1-30）
│  ├─ plans/                          Implementation plans（每份对应一份 spec）
│  └─ scripts/                        辅助脚本（如 mini-coordinator.mjs：Layer-5 手动 smoke）
└─ docs-site/                         VitePress 中英双语展示站（Plan 26）；`deploy-docs.yml` push to gh-pages；工具参考从 `TOOL_DEFS` 生成
```

## monorepo 开发常用命令

| 命令 | 作用 |
|---|---|
| `pnpm dev` | 跑扩展开发模式（vite + HMR） |
| `pnpm build` | 产 `packages/extension/dist/` |
| `pnpm typecheck` | shared + extension 串跑 tsc --noEmit |
| `pnpm test` | shared + extension 串跑 vitest |
| `pnpm --filter @aipagego/shared test` | 只跑 shared 包测试 |
| `pnpm --filter @aipagego/extension test:watch` | 扩展测试 watch 模式 |

## Workflow conventions

This project follows the **superpowers** workflow. Every non-trivial change
goes through:

1. **brainstorming** — invoke `superpowers:brainstorming`; ask user
   clarifying questions one at a time; present design in sections; get
   approval; write spec to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`.
2. **writing-plans** — invoke `superpowers:writing-plans`; produce a task
   list with bite-sized steps + complete code in each step; save to
   `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
3. **executing-plans** (or `subagent-driven-development`) — execute tasks
   one by one with frequent commits.

Skip this only for: bug fixes, typo / doc edits, the user explicitly asks
"just do X". When unsure, propose a spec.

## Hard rules

- **IDB DB name is `aipagego`** in `packages/extension/src/background/storage/db.ts`. Do not rename
  it again (that would orphan saved tools created after the AIPageGo rename).
- **No new dependencies without asking.** Existing stack covers everything
  we've needed; new deps cost build size and review burden.
- **API key never goes to IDB or to any export bundle.** It lives in
  `chrome.storage.local` (or `chrome.storage.session`).
- **Plan 4 per-tab invariant**: when run-session runs, capture `tabId`
  in the `send()` closure and pass it to every store action / approver
  lookup. Do NOT read `useStore.getState().currentTabId` inside async
  callbacks — the user may have switched tabs and you'll write to the
  wrong session. See `packages/extension/src/sidepanel/pages/chat-page.tsx`'s `stepFromCard` and the
  `tool_use_input_delta` case as the canonical pattern.
- **Severity gating signature is 4-arg**:
  `autoApproves(severity, toolName, approveAllSafe, dangerousAllowlist)`.
  Every callsite must pass all four — `tabId-aware` settings come from
  `useSettings().autoApproveDangerous`.
- **Static scan never blocks**. It only labels. Users can override and
  run dangerous code (Plan 5 summary step uses the same convention).
- **Content script may be missing**: BG `runOneStep` already retries
  with `chrome.scripting.executeScript` injection + `retryUntilReady`
  backoff. Don't bypass that.
- **`runChatSession` is a pure function (DI)**. The sidepanel and
  `CoordinatorChatHost` both call it with different `client` / `runner`
  / `approver` / `rpc`. Don't reach into `useStore` from inside it.
  Adding new state should go through the `onEvent` callback so both
  callers benefit.
- **Continuation guard is session-total, not since-progress** (v0.0.15
  fix). `nudgesSinceProgress` was renamed `totalNudges` and the reset
  on tool use was removed. Don't reintroduce per-progress reset — it
  causes "AI 确认完成" 死循环 when the model alternates text-only with
  one verification tool.
- **Cross-tab opener match needs session.status == running|streaming**
  (v0.0.14 fix). `tabs.spawned` with `openerTabId` covers BOTH user
  Ctrl+click AND AI's in-page click. The session-status gate is the
  only thing distinguishing them. Don't auto-attach on idle.
- **`allow_remote_chat=false` blocks ONLY `START_CHAT_SESSION`** (Plan
  12 spec). Existing EXEC behavior (incl. dangerous tools) is
  intentionally unchanged — that contract was set in Phase 2 and
  changing it on upgrade would break already-connected coordinators.
- **Coordinator chat sessions use `AutoApprover` (not `Approver`)**.
  Inside the BG-driven path the user has already opted in via the
  flag; plain `Approver.request()` would never resolve for dangerous
  tools and hang the session. See `coordinator-chat.ts`.
- **RunRecord.source is REQUIRED on new records, backfilled on read**
  for legacy. Don't make it optional in the type. Coordinator-driven
  sessions set `source: "coordinator"`; user sessions get `"user"` (or
  backfilled to `"user"` if a pre-v0.0.16 record is read back).
- **`LlmStreamEvent` / `LlmClient` live in `@aipagego/shared/llm`**
  (Plan 12). Extension still has a re-export shim at
  `sidepanel/llm/types.ts` for back-compat — keep it; new code should
  import from `@aipagego/shared/llm` directly.
- **BG never holds the API key.** Self-heal (Plan 27) needs an LLM but
  runs BG-side; the bridge in `background/self-heal-bridge.ts` posts the
  `HealContext` to sidepanel via `chrome.runtime.sendMessage`, and
  `sidepanel/self-heal-host.ts` runs the one-shot call with the key from
  `useSettings()`. Do NOT add BG-side LLM paths that read the key
  directly — the sidepanel-borrow-key contract is the only sanctioned
  route.
- **Self-heal is single-shot per run.** `healApplied` flips true after
  the first successful heal in a `runTool` iteration; a second failure
  in the same run falls into the normal error path (and emits
  `self_heal_failed { reason: "step_still_fails" }` when `healApplied`
  is already true). Do not add cascading retries — that's how a bad
  patch burns unbounded tokens.
- **Self-heal patches are static-scan-gated STRICTLY.** User-triggered
  `[让 AI 修复]` runs through the chat loop and can generate `dangerous`
  steps that the user then approves. Autonomous self-heal cannot — the
  gate in `attemptHeal` rejects any patch containing a `dangerous` step
  as `static_scan_reject`. Do not weaken this — the trust model is that
  autonomous LLM output is less trusted than user-initiated chat.
- **`Tool.origin` is optional and load-bearing.** Presets are copied
  from the static `PRESETS` registry into IDB via `materializePreset`,
  carrying `origin: {kind:"preset", presetId, presetVersion}`. Export
  filter skips `origin.kind === "preset" && versions.length === 1`
  (unmodified preset copies shouldn't ship in export bundles). Import
  strips `origin` when the referenced preset id is not in the current
  registry. Don't make `origin` required.
- **Coordinator EXEC path does NOT self-heal.** `bg-tool-runner.ts` +
  `coordinator-chat.ts` bypass `rpc-handlers.runTool`'s heal branch;
  even if they went through it, `runTool` skips heal when
  `req.target.kind !== "tool"` or the sidepanel isn't reachable
  (`no_sidepanel` reason). Remote-driven sessions must fail loudly and
  let the coordinator side see the error, not silently self-repair.
- **Preset registry is a pure module.** `packages/shared/src/presets/`
  is a static array with no IO. Never introduce dynamic import, fetch,
  or IDB read at registry time — the `matchPresetsByUrl` call runs
  hundreds of times per session. Adding remote refresh is a spec-level
  decision (see Plan 27 §15).
- **`SessionEvent` union uses `type` as discriminator, not `kind`.**
  All 18 variants (`tool_running` / `session_end` / … /
  `self_heal_started` etc.) key on `.type`. The `chat-event.ts` zod
  mirror is `z.discriminatedUnion("type", …)`. If a plan brief snippet
  writes `kind: "self_heal_started"`, that's a spec typo — use `type`.
- **Broad page understanding goes through Page Context Index first.**
  For product/article/table/form extraction, prefer
  `createPageIndex` → `extractPageFields` / `searchPageIndex` →
  targeted `readPageBlock`. Avoid `extractText({selector:"body"})`
  and full-DOM reads unless there is a narrow reason.
- **Page-index truncation is structured, not prose.** Use `hasMore`,
  `nextOffset`, `recommendedNext`, and `truncation.ref`; do not encode
  missing content as prefix/suffix strings and ask the model to infer it.
- **Visual evidence is targeted.** `screenshot` can receive
  `{blockId,indexId}` from page-index or `{selector}`. It scrolls and
  highlights the target before `captureVisibleTab`. Keep no-arg
  screenshot as viewport capture, but do not regress the targeted path.
- **`downloadSpreadsheet` is a sidepanel-only generated download.** It
  creates `.xlsx` via `sidepanel/lib/xlsx.ts` and uses `chrome.downloads`.
  It is intentionally excluded from replayable saved tool steps until a
  background-safe download path is designed.
- **Image attachments are inline base64 multimodal parts.** Supported
  user attachments are png/jpeg/gif/webp, max 5 MB each, max 5 per turn.
  ChatView must render array user content with `text` / `image` parts,
  while still hiding internal `tool_result` plumbing.
- **Widget and sidepanel share session snapshots via `_rev`.** Session
  mutations broadcast full snapshots. Receivers ignore stale revisions.
  When adding session state, ensure both sidepanel and content-widget
  entry points converge.

## Common tasks

### Add a new BuiltinTool

1. `packages/shared/src/types.ts` — add to `BuiltinTool` union
2. `packages/shared/src/messages.ts` — add to `StepSchema` enum
3. `packages/extension/src/content/tools/<tool>.ts` — implement `(args: Json) => Promise<Json>`
4. `packages/extension/src/content/tools/index.ts` — register in `TOOLS`
5. `packages/shared/src/llm/builtin-tool-defs.ts` — add `LlmTool` def with JSON Schema (`sidepanel/llm/tool-schema.ts` only re-exports)
6. `packages/extension/src/sidepanel/chat/severity.ts` — classify in safe / caution / dangerous
7. `packages/extension/tests/content/tools/<tool>.test.ts` — happy-dom unit tests
8. `packages/extension/tests/sidepanel/chat/severity.test.ts` — add a classification case

Tools that need `chrome.*` rather than the DOM do not get a content tool
implementation. Since Plan 32 they live in `packages/extension/src/background/bg-tools/`
and are registered in `background/meta-tool-router.ts`, which `runOneStep`
consults *before* the content-script hop — that is what makes them reachable
from the coordinator / MCP `EXEC` path. The side panel delegates to the same
handlers through `sidepanel/lib/meta-tools.ts`. Exclude them from
`ReplayableTool` when their result is session-scoped, and test the Chrome API
wrapper separately with a faked `globalThis.chrome`.

Also required for every new tool: `packages/shared/src/capability/tool-mapping.ts`
(an exhaustive switch — TypeScript will not compile until you add an arm) and
`packages/shared/src/capability/catalog.ts` if it needs a new capability.

### Multi-session pairing (Plan 33)

The MCP server process is the WS **server**; the extension is the **client** —
an MV3 service worker cannot listen on a port. Everything else follows from
that: ports collide because every server binds one, and discovery must be
extension-initiated because a server cannot address the browser first.

- `mcp-server/src/ensure-hub.ts` binds lazily, on the first tool that needs a
  worker. `Deps.peek()` exists so `tools/list` never triggers a bind.
- `mcp-server/src/identity.ts` holds the install-level identity and the
  remembered port. Trust is per install, never per directory — see the spec for
  why directory scoping is presentation rather than protection.
- `content/pairing-relay.ts` renders the approval overlay. The served page is a
  carrier only; never move the Allow button onto it.
- `background/coordinator-pool.ts` holds one `CoordinatorClient` per session.
  `background/tab-ownership.ts` + `tabs-broadcast.ts` keep each connection's
  `available_tabs` current and mark other sessions' tabs `busy`.

Reconnection has a terminating condition (`shared/src/pairing/reconnect.ts`).
If you touch the heartbeat alarm, keep it honouring both the pending backoff and
dormancy — it previously reconnected any CLOSED socket on sight, which made the
exponential backoff decorative.

### Page-event recorder (Plan 32)

`console` / `network` / `dialog` are captured by a recorder with two backends
behind one `PageRecorder` interface in `packages/shared/src/recorder/`:

- `content/recorder/main-world.ts` — manifest-declared MAIN-world content
  script at `document_start`. It must be MAIN world to see the page's own
  `console` / `fetch` / `alert`. Drained through the existing one-shot
  `injectMainWorld`, which runs in the same realm.
- `background/recorder/cdp.ts` — opt-in `chrome.debugger`. Attach is
  best-effort and every failure degrades to the MAIN-world backend with a
  `degradedReason` on subsequent reads.

Two invariants worth preserving: the recorder ships **inert** (bodies off,
dialogs passthrough) because it loads on every page the user visits, and
buffers never leave memory. Filtering lives in `shared/src/recorder/filter.ts`
so both backends share one tested implementation.

### Add a new RPC

1. `packages/shared/src/messages.ts` — add to `RpcRequest` discriminatedUnion
2. `packages/extension/src/background/rpc-handlers.ts` — handle in `dispatch` switch
3. `packages/extension/src/sidepanel/rpc.ts` — add typed wrapper

### Add a new WS protocol message

1. `packages/shared/src/protocol/messages.ts` — define new zod schema + extend the right discriminated union (`ClientToServerSchema` / `ServerToClientSchema`); export the inferred TS type at the bottom
2. `packages/shared/tests/protocol/<msg>.test.ts` — round-trip + reject-malformed cases
3. If it carries `SessionEvent` or another extension-side runtime type, mirror as a zod schema in `packages/shared/src/protocol/chat-event.ts` (keep the `chat-event.test.ts` variant round-trip test green)
4. `packages/extension/src/background/coordinator-client.ts` — add a `case` in `handleMessage`'s switch; delegate to the right injected handler (`onChat` / `onReadState` / etc.)
5. `packages/extension/src/background/index.ts` — instantiate / wire any new handler in `startCoordinatorClient`; add disposal in `stopCoordinatorClient` if it owns a listener
6. End-to-end: extend `packages/extension/tests/background/coordinator-e2e.test.ts` with a real-`ws` test that drives the new path

### Add a new tool-use turn event (`SessionEvent`) variant

1. Add to the union in `packages/extension/src/sidepanel/chat/run-session.ts` — use `type` discriminator (matches existing 18 variants)
2. Mirror in `packages/shared/src/protocol/chat-event.ts` (`ChatSessionEventSchema`) and add a round-trip case to `chat-event.test.ts`
3. Sidepanel consumer (chat-page / step-card / app-shell heal listener) handles it via `onEvent` or via the `type: "session.event"` runtime broadcast
4. Don't break the existing 18 variants — extension and shared mirror must stay in sync (the round-trip test guards this)

### Add a new Preset (Plan 27)

1. Create file under `packages/shared/src/presets/content/<slug>.ts` (prompt-form) or `presets/ecommerce/<slug>.ts` (tool-form)
2. Export a single named `Preset` value; `id` must be a stable kebab-case slug and globally unique
3. Wire it into `packages/shared/src/presets/index.ts`'s `PRESETS` array
4. `preset-registry.test.ts` validates all entries via zod + uniqueness — no new test needed
5. Tool-form presets must use only safe + caution steps (no `submitForm`/`uploadFile`/`readStorage`/`httpRequest(withCredentials)`/dangerous `runJS`)
6. If tool-form and you have a stable step sequence: consider adding a fixture `packages/extension/tests/fixtures/presets/<id>-snapshot.json` and an assertion test

### Add a new sidepanel drawer

1. Add a case to `DrawerKind` in `packages/extension/src/sidepanel/chat/ui-store.ts`
2. Create the drawer component under `packages/extension/src/sidepanel/drawers/<name>-drawer.tsx`
3. Register in the switch inside `packages/extension/src/sidepanel/shell/app-shell.tsx`
4. Add a header icon that calls `useUi.getState().open("<kind>")`
5. Do NOT rely on `location.hash` — the sidepanel has no hash router; navigation is Zustand-store-driven

### Working with sessions

- Read current session: `useSession()` returns the `SessionData` for
  `currentTabId` (or `EMPTY_SESSION` sentinel).
- Mutate a specific session: import `appendUserMessage(tabId, text)` /
  `setStatus(tabId, ...)` etc. and pass `tabId` explicitly.
- Background-running sessions: handled correctly by run-session's
  closure-captured `tabId`. Don't rely on `currentTabId` in callbacks.

## Build / test / dev

### Browser verification by coding agents

- When a task requires live-page inspection, UI smoke testing, screenshots,
  responsive-layout checks, DOM interaction, or console/network debugging,
  use the AIPageGo MCP first, including for localhost pages.
- Start with `browser_start`. Do not probe for Playwright, Puppeteer, or Chrome
  remote debugging while AIPageGo is available.
- Fall back only after AIPageGo reports an actual connection or capability
  failure, and state that failure. Pure source-code work that does not require
  observing a live page must not start a browser.

```bash
pnpm install
pnpm typecheck      # pnpm -r typecheck across 4 packages; CI gate
pnpm test           # pnpm -r test; ~853 tests total (656 extension + 124 shared + 45 coordinator + 28 mcp-server)
pnpm test:watch     # extension only (the largest, fastest-iterating slice)
pnpm build          # vite build → packages/extension/dist/
```

Load `packages/extension/dist/` via `chrome://extensions` (developer mode → load unpacked).
After code change: rebuild, then click the reload icon on the extension.
**Reload an open page if content script seems missing** (the BG-side
auto-injection retries up to 2s but a hard refresh is faster).

### Release versioning

- `build-extension.yml` injects the extension version from `v*` tags before
  building release zips.
- `publish-mcp-server.yml` injects `packages/mcp-server/package.json` from
  the same `v*` tag before `npm publish`; do not rely on the checked-in MCP
  package version for tagged publishes.
- Bump root `package.json` manually for the next release commit. Keep
  `packages/mcp-server/package.json` reasonably current as a fallback, but
  tag injection is the release source of truth.

### Coordinator smoke (Plan 12, manual)

```bash
node docs/superpowers/scripts/mini-coordinator.mjs   # 起一个最小 WS server
# 装载 dist/ 后，在 sidepanel 的 Coordinator 设置页填:
#   URL = ws://127.0.0.1:8787/worker
#   token = 任意非空
# 勾上 "允许 coordinator 远程驱动 chat session"，点 Connect
# 脚本会自动发 START_CHAT_SESSION（mock_llm 三轮）→ 应看到 1 个 continuation_nudge + 1 个 session_end(done)
```

## What's been built (state as of v0.0.53)

Read `docs/superpowers/specs/README.md` for the full spec index (Plan 1-30). At a glance:

**Foundations (Plans 1-11)**
- **Plan 1-3** — Executable skeleton, streaming Anthropic+OpenAI, 18 initial tools, per-tool dangerous allowlist, `AIPageGo` rebrand
- **Plan 4** — Per-tab sessions; closed-tab sessions initially 5-min in-memory (later replaced by Plan 8)
- **Plan 5-6** — AI-generated summary step; two tool-save flavors (`prompt` vs `steps`); AI-generated tool draft from conversation
- **Plan 7** — Multi-tab context: `@`-mention, `openTab`, `attachTab`, optional `tabId` on all tools
- **Plan 8** — Sidepanel session persistence: `chat_sessions` IDB store, per-URL ≤20 archived, history drawer
- **Plan 9** — GitHub Actions build + tagged release; version injected from `v*` tag
- **Plan 10** — Remote Coordinator (Phase 1+2): WS protocol + coordinator core + extension worker (`CoordinatorClient` + alarms heartbeat)
- **Plan 11** — Raw LLM exchange log + continuation guard (`maxContinuationNudges`)

**Extension surface expansion (Plans 12-15)**
- **Plan 12** — Remote-testable chat session (v0.0.16): `START_CHAT_SESSION`/`CHAT_EVENT`/`SIDEPANEL_STATE_REPLY`; `CoordinatorChatHost` runs `runChatSession` BG-side; `allow_remote_chat` opt-in; `RunRecord.source` tag
- **Plan 13** — MCP Bridge: `packages/mcp-server` = stdio MCP server + `LoopbackWSHub`; auto-generates 19 `browser_*` tools + 4 control tools from `TOOL_DEFS`
- **Plan 14-15** — Adopt the former product brand; publish its MCP package on npm on `v*` tag (v0.0.19)

**UX overhauls (Plans 16-25)**
- **Plan 16** — AIPex UI refactor: `app-shell.tsx` replaces `app.tsx`; drawer stack; compact chat by default
- **Plan 17-18** — Intervention pill, `@` mention picker, tab quick-switch above input; save-tool dialog, tools drawer per-row actions
- **Plan 19** — LLM strategy Round 5 + 11 tools: 4 tiers (control-plane / visual / UID-based / batch); `system-prompt` guides tier selection
- **Plan 20** — Round 6: `navigate` / `getPageInfo` / `pressKey` / `writeStorage` (dangerous)
- **Plan 21-22** — UX batch (diagnostics export, header version, defensive `rpc.call`); lucide-react icon migration
- **Plan 23** — Quick-actions chips on empty state
- **Plan 24** — Simple / Detailed chat mode (default `compact`)
- **Plan 25** — Prompt-optimize button: LLM rewrites user draft

**Docs + Product (Plans 26-27)**
- **Plan 26** — GitHub Pages VitePress site (`docs-site/`) — zh-CN primary + EN overview; auto-gen tool reference
- **Plan 27** (v0.0.45) — **Scenario Presets + Self-Heal**:
  - 12 built-in presets under `@aipagego/shared/presets` (7 content prompt-form + 5 ecommerce tool-form)
  - Three exposure paths: tab-watcher banner + quick-actions URL override + Scenarios drawer
  - `Tool.origin` (optional preset origin) + `RunRecord.healed` (optional heal metadata)
  - `background/self-heal.ts` pure DI module + `sidepanel/self-heal-host.ts` LLM borrower + `background/self-heal-bridge.ts` BG↔sidepanel bridge
  - `rpc-handlers.runTool` catch-and-heal: single-shot, dangerous-scan-gated, `appendVersion` v(N+1), `[自愈]` system bubbles
  - Coordinator EXEC path opts out; sidepanel unavailable ⇒ `no_sidepanel` reason, no silent fallback

**In-page surface + context efficiency (Plans 28-30)**
- **Plan 28** — In-page Chat Widget: Shadow DOM FAB + mini panel, same `sessionsByTab` as sidepanel, dangerous handoff to sidepanel, per-site hide, settings-backed global toggle
- **Plan 29** (v0.0.52) — Widget Round 2: stop button, sticky status, error banner, preset/quick-actions empty state, image paste/drop, permission pill, history, resize, element capture
- **Plan 30** (v0.0.53) — Page Context Index: `createPageIndex` / `searchPageIndex` / `readPageBlock` / `extractPageFields`, structured truncation metadata, targeted visual evidence via `screenshot({blockId,indexId})`, `downloadSpreadsheet` `.xlsx` export, image-message rendering fixes

### Recent material bug fixes worth remembering

- **v0.0.14** — `tabs.spawned` opener-match handler was attributing user Ctrl+clicks (idle session) to AI. Gated on `session.status ∈ {running, streaming}`. See `packages/extension/src/sidepanel/chat/cross-tab-events.ts`.
- **v0.0.15** — Continuation guard `nudgesSinceProgress` reset on any tool call, allowing infinite "AI 确认完成" loops when the model alternated text-only with a verification tool. Renamed to session-total `totalNudges`; reset removed. See `packages/extension/src/sidepanel/chat/run-session.ts`.
- **v0.0.37+** — Tag-based version injection covers BOTH root `package.json` AND extension `packages/extension/package.json`. Do NOT bump either in a PR commit; push the `v*` tag and CI overrides both. See `.github/workflows/build-extension.yml`.
- **v0.0.45** — `SessionEvent` mirror in `chat-event.ts` uses `type` as discriminator (not `kind`); Plan 27 brief's `kind:` snippets were a spec typo. Also `broadcastSessionEvent({type:"session.event", event})` wraps events in a runtime envelope; the sidepanel listener in `app-shell.tsx` unwraps and forwards to `appendHealNote`.
- **v0.0.52** — Widget became a practical daily entry point: images, history, stop, status/error surfaces, permission mode, resize, save handoff, and selector capture. Keep widget changes Shadow-DOM-safe.
- **v0.0.53** — Large-page extraction moved to page-index first. The known bad pattern is repeated broad `extractText(body)` or giant DOM snapshots; update prompts/tool descriptions instead of raising token limits.

## Anti-patterns to avoid

- Reading `currentTabId` inside async callbacks during a chat session
- Adding business logic to a component (move to `chat/` or shared/`)
- Treating `runJS` errors as `output: null` (BG now wraps + re-throws —
  don't undo)
- Renaming persistent `aipagego` identifiers without an explicit migration
  (IDB, storage keys, export schema, or runtime wire messages)
- Touching `.idea/` or other IDE configs in commits
- Hard-coding `chrome.*` access in `runChatSession` or anything below
  it — go through DI (the `tabsRpc` / `runner` / `client` / `approver`
  injection points). The host running in BG (`CoordinatorChatHost`)
  has no sidepanel and works with stubs in tests.
- Bypassing the wire schema when sending over WS. `CoordinatorClient.send`
  re-validates every outgoing message against `ClientToServerSchema`;
  if a schema mismatch silently drops your message you're missing a
  field — fix the construction site, don't widen the schema.
- Mutating `RunRecord` after `finalizeRun`. The reader path applies
  `withSourceDefault` for legacy records — write a fresh record instead
  of patching one in place.

## Test-driven changes

Most modules in `packages/shared/src/`, `packages/extension/src/sidepanel/llm/`, `packages/extension/src/sidepanel/chat/`
have direct unit-test counterparts in `packages/shared/tests/` and `packages/extension/tests/`. When changing one:

1. Edit the test first to express the new behavior
2. Run failing
3. Implement
4. Run passing
5. Commit (separate test commit and impl commit not required; bundle is fine)
