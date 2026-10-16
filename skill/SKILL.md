# atwebpilot-browser skill

A reusable strategy for agents that drive AtWebPilot's browser extension via
MCP. Inspired by AIPex's [aipex-browser](https://github.com/AIPexStudio/AIPex)
pattern: tool usage flow, common scenarios, safety rails — all in one bundle
so an agent doesn't have to discover them from scratch.

## Capabilities you have

When this skill is loaded, you can drive any open tab through these tools
(exposed by `@attson/atwebpilot-mcp`):

### Control plane

- `pairing_status` — start/check pairing without waiting. When it reports
  `pairing_required`, show `pair_url` once; use it only as a later status check.
- `list_tabs` — on first use, open the pairing page and wait up to 45 seconds
  for browser authorization, normally returning tabs from the same call. Entries carry `busy`
  and `busy_label` when **another** Claude Code session is already driving that
  tab, and `mine` for tabs you hold. This is advisory — nothing blocks you — but
  contending for a tab another agent is typing into is rarely what you want.
  Open your own with `browser_openTab` instead.
- `open_session(tabId)` — pin a tab so subsequent calls target it
- `close_session(sessionId)` — release the tab
- `get_quota(sessionId)` — see remaining requests this minute

### Browser-side built-ins (per session)

All of these are prefixed `browser_` over MCP, e.g. `browser_takeSnapshot`.

**Core — advertised after the browser connects (31):**

| Class | Tools |
|---|---|
| page state（safe） | `takeSnapshot`, `findElements`, `getPageInfo`, `extractText` |
| page index（safe） | `createPageIndex`, `searchPageIndex`, `readPageBlock`, `extractPageFields` |
| interaction（caution） | `clickByUid`, `click`, `fillByUid`, `fillInput`, `fillForm`, `selectOption`, `setCheckbox`, `hover`, `pressKey`, `drag`, `drop`（files ⇒ dangerous）, `uploadFile`（dangerous） |
| navigation / tabs | `navigate`（`action` 取 `back` / `forward` / `reload` / `goto`）, `listTabs`, `openTab`, `closeTab`, `resize`, `scroll` |
| observation | `screenshot`, `waitFor`, `runJS`（static-scanned）, `consoleMessages`, `networkRequests` |

**Discoverable — enable directly with `browser_discoverTools`:**

| Group | Tools |
|---|---|
| `export` | `downloadImage`, `downloadSpreadsheet`（real `.xlsx`, multi-sheet） |
| `network` | `httpRequest`（`withCredentials` ⇒ dangerous）, `networkRequestDetail`（dangerous）, `recorderConfig`, `handleDialog` |
| `storage` | `storage`（`op` 取 `get` / `set`; dangerous） |
| `browser-data` | `searchBookmarks`, `searchHistory` |
| `inspect` | `inspectElement`, `highlight`（`text` or `selector`/`uid`）, `getValue`, `extractFormState` |
| `legacy-dom` | `snapshotDOM`, `querySelector`, `querySelectorAll`, `extractImages`, `focus` |
| `form` | `submitForm`（dangerous） |
| `tabs` | `switchToTab`（只在用户明确要求把 Chrome 切到前台时使用） |

`askUser`, `attachTab` and `detachTab` are **not** exposed: an MCP session has
no human at the side panel, and its tab is already bound by `open_session`.

### Getting more tools

The default list is deliberately small. When a task needs something outside
core — exporting a spreadsheet, calling an API with cookies, reading
localStorage, inspecting a request body, searching history, debugging layout —
do this, in order:

1. If you know the tool, enable it directly with
   `browser_discoverTools({ enable: ["browser_downloadSpreadsheet", ...] })`.
   If you know only the group, use
   `browser_discoverTools({ enableGroups: ["export"] })`.
   To switch the whole process surface explicitly, use
   `browser_discoverTools({ profile: "core" })` or `{ profile: "full" }`.
2. Call `browser_discoverTools({})` only when neither the tool nor group is
   known. Enabled tools join `tools/list` (a `tools/list_changed` notification
   is sent), and the response carries the selected full schemas even if those
   tools were already enabled.
3. Prefer a newly visible native tool. If the MCP host has refreshed
   `tools/list` but the current model turn still has the old snapshot, call the
   selected tool immediately through
   `browser_call({ session_id, tool: "browser_downloadSpreadsheet", args: {...} })`.
   Do not ask the user to reply "continue" just to start another model turn.
   Nested `args` omit `session_id`; the bridge injects the top-level value.

**Do not** rebuild these capabilities with `runJS` (`fetch`, CSV blobs,
`localStorage[...]`). It is slower, loses schema validation, and usually trips
the dangerous-tier review that the purpose-built tool would have avoided.

`ATWEBPILOT_MCP_TOOLS=full` advertises everything from the start for users who
prefer to pay the context cost once. `browser_call` is a current-turn
compatibility path; use the native tool once the host exposes it.

## Recommended flow

1. **先建立连接**：调一次 `list_tabs`；首次配对时它会打开授权页并等待最多 45 秒，授权成功后同一次调用直接返回 tab，不要让用户回复「已连接」。只有超时才会返回 `pairing_required`；此时展示 `pair_url`，稍后用非阻塞的 `pairing_status` 检查，不要轮询 `list_tabs`。
2. **探查先于操作**：每次进入新页面，先 `getPageInfo` 确认位置，再 `takeSnapshot`（要点击/填表）或 `createPageIndex`（要读内容/抽字段）；`snapshotDOM` / `querySelector` 属于 legacy-dom 组，只在需要分析整页结构时通过 `browser_discoverTools` 启用。
3. **最少充分验证**：危险或不可逆操作保持单步；多个独立字段用 `fillForm`。工具已返回 `verified` 或明确后置状态时，不要再用 `runJS` 重复验证。
4. **dangerous 工具会被人工审核**：调用前用 `extractText` 给用户看上下文，让审批更顺。
5. **跑不动了就停下来问**：候选不唯一、缺关键信息、需要二次确认时，把问题写在回复里交给用户，不要瞎猜（MCP 会话没有 `askUser`）。
6. **完成后给一个简洁的总结**：用户希望看到「做了 N 步，最终结果 X」，不希望看流水账。

## Tool usage notes (moved here from the tool descriptions)

- `snapshotDOM`: `{}` (maxDepth 3) / `{ root: '.main', maxDepth: 5 }` / `{ maxDepth: 8 }`. Prefer `takeSnapshot` when you will click or fill afterwards.
- `querySelector` / `querySelectorAll`: `{ selector: 'button[type=submit]' }`, `{ selector: '.comment-item', limit: 50 }`.
- `extractText`: `{ selector: 'h1', single: true }`, `{ selector: 'article p' }`. Never `body` — use `createPageIndex`.
- `extractImages`: `{}` for the page, `{ root: '.product-gallery' }` for a region.
- `scroll`: `{ to: 'bottom', max: 5 }` for lazy loading; `{ to: 'bottom', max: 10, untilSelector: '.item:nth-child(20)' }` to stop once content appears.
- `waitFor`: `{ ms: 500 }` or `{ selector: '.lazy-loaded', timeoutMs: 8000 }`.
- `fillInput`: `{ selector: 'input[name=email]', value: 'a@b.c' }`; `clear: false` appends.
- `fillForm`: `{ fields: [{ selector: 'input[name=name]', value: '张三' }, { uid: 'el_5', value: 'mushroom' }] }` — much cheaper than repeated `fillInput`.
- `pressKey`: `{ selector: 'input[name=q]', key: 'Enter' }` submits a form-less search; `{ key: 'Escape' }` closes a modal.
- `navigate`: `{ action: 'back' }`, `{ action: 'goto', url: 'https://example.com/page' }`.
- `switchToTab`: all tools already target the session-bound tab. Discover and call this only when the user explicitly asks to bring Chrome and that tab to the foreground; never use it as setup for click, wait, runJS, or screenshot.
- `resize`: returns measured `actualViewport`, `devicePixelRatio`, and `verified`; do not follow it with a viewport-only `runJS` probe.
- `screenshot`: the image block is followed by compact capture metadata (backend, dimensions and target when available); use that instead of probing the viewport again.
- `httpRequest`: `{ url: '.../api/comments?page=2' }` (no cookies) vs `{ url, withCredentials: true }` (cookied, reviewed).
- `consoleMessages`: `{ level: 'error', limit: 50 }`; incremental polling with `{ sinceId }`.
- `networkRequestDetail`: arm bodies first with `recorderConfig({ bodies: true })` in main-world mode.
- `drop`: `{ selector: '#dropzone', files: [{ name: 'a.csv', mimeType: 'text/csv', base64: '...' }] }`.
- `downloadSpreadsheet`: `{ filename: 'items', sheets: [{ name: 'Sheet1', rows: [{ title: 'A', price: 12 }], columns: [{ key: 'title', header: '标题' }, { key: 'price' }] }] }`.
- `storage`: `{ op: 'get', store: 'local', key: 'token' }`, `{ op: 'set', store: 'session', key: 'k', value: '{"a":1}' }`.
- `highlight`: `{ text: 'Checkout' }` or `{ selector: '#pay' }` / `{ uid: 'el_3' }`; visual only, 3 s by default.

## Scenarios

### 总结此页

```
createPageIndex({})
extractText({ selector: "main, article, .content" })
→ 文本总结
```

### 填表 + 提交

`submitForm` 属于 form 组，先 `browser_discoverTools({ enable: ["browser_submitForm"] })` 启用。

```
takeSnapshot()  // 找输入框
fillInput({ selector: "#name", value: "张三" })
setCheckbox({ selector: "#agree", checked: true })
selectOption({ selector: "#city", value: "北京" })
→ 在回复中向用户确认「确认提交吗？」
→ submitForm()  // dangerous，用户确认后执行
```

### 翻页采集

`snapshotDOM` 属于 legacy-dom 组，先 `browser_discoverTools({ enable: ["browser_snapshotDOM"] })` 启用。

```
snapshotDOM({ selector: "[data-pagination]" })  // 找翻页结构
extractText({ selector: ".item", multiple: true })
→ 累积到内存
→ click({ selector: ".next" })
waitFor({ selector: ".item:nth-child(N+1)" })
→ 重复
```

### 跨 tab 协作

```
listTabs()
openTab({ url: "https://example.com" })  // 自动 attach
→ 在新 tab 操作
```

## Safety / quota rails

- **Quota**：默认 60 请求/分钟。超过会被拒绝，到 60s 自动恢复。先 `get_quota` 看额度。
- **Dangerous gating**：用户已在 sidepanel 配置了授权模式（read / default / trust / yolo），你不需要预判，调就是了，会被拦下来或自动通过。
- **超时**：默认每步 30s。慢操作（大页面 snapshot、长等待）记得显式传 `timeoutMs`。

## Don'ts

- ❌ 不要在 `runJS` 里直接读 cookie / localStorage（会被静态扫描归 dangerous，每次问审批）
- ❌ 不要循环调 `snapshotDOM`——单次抓全树用 `maxDepth` 而不是多次
- ❌ 不要在回复里频繁向用户确认（每次都要用户手动响应）
- ❌ 不要无视 `attachedTabs`——跨 tab 操作前确认目标 tab 未被其他会话占用（`list_tabs` 的 `busy`）

## When to use

- 用户要你「在网页上做某事」、「抓某站点数据」、「填某表单」
- 用户给了一个 URL 让你看
- 用户问「这页面在讲什么」

## When NOT to use

- 纯文本任务（写代码、改文件）不需要浏览器
- 用户明确说「不要打开浏览器」
- 网页需要复杂登录但用户没在浏览器里登录过

## Reference

- README: https://github.com/attson/atwebpilot
- 工具完整 schema 由 mcp-server 的 `tools/list` 暴露

## Observing a page: console, network, dialogs

These read from a recorder that is running on the page already, so you can ask
about things that happened *before* you called.

**Two backends, and you must check which one you got.** Every result carries
`backend`:

- `main-world` (default) — patches installed in the page's own realm. Cannot
  see messages emitted before the patches installed, browser-level CORS/CSP
  errors, or requests made by a service worker.
- `cdp` — `chrome.debugger`, opt-in from the extension settings. Sees all of
  the above plus real response bodies.

If a result carries `degradedReason`, a CDP session was expected but is gone
(DevTools opened, or another extension took the tab). Treat the data as
incomplete rather than concluding the page did nothing. If it carries
`disabled`, the recorder is not on that page at all.

**Response bodies are off by default.** They cost memory on every page the user
visits, so arm them first and then reproduce:

```
browser_recorderConfig({ bodies: true })   → arm
… trigger the request …
browser_networkRequests({ urlPattern: "/api/" })
browser_networkRequestDetail({ id: <id from above> })
```

Calling `networkRequestDetail` without arming returns metadata plus
`bodyUnavailable` explaining the fix. Note this tool is **dangerous**: response
headers routinely carry `Authorization`, `Set-Cookie`, and bearer tokens.

**`handleDialog` is a pre-set policy on the default backend, not a reaction.**
`alert`, `confirm`, and `prompt` are synchronous, so a patched implementation
cannot pause and ask you. Declare what should happen *before* triggering the
dialog:

```
browser_handleDialog({ accept: true, promptText: "yes", scope: "all" })
… click the thing that opens the dialog …
browser_handleDialog({ accept: true })   → also returns the recorded dialogs
```

Under the CDP backend the dialog genuinely suspends, and a `handleDialog` call
answers the pending one immediately.

Until you arm it, dialogs behave exactly as they would without the extension —
the recorder never silently changes page behaviour.

## Debugging flow

When a page misbehaves, this ordering costs the least context:

1. `browser_consoleMessages({ level: "error" })` — cheap, and already buffered.
2. `browser_networkRequests({ status: 500 })` or `{ urlPattern: "/api/" }` —
   summaries only.
3. `browser_recorderConfig({ bodies: true })`, reproduce, then
   `browser_networkRequestDetail({ id })` for the one request that matters.

Poll incrementally with `sinceId` rather than re-reading the whole buffer. If a
result reports `dropped > 0`, the ring overflowed and you are seeing a window,
not the whole history.

## Multiple sessions share one browser

Several Claude Code sessions can be attached to the same browser at once, each
through its own connection. Two consequences worth knowing:

- **Pairing continues in the same call.** `list_tabs` lazily binds the port,
  opens a confirmation page, and waits up to 45 seconds for the extension's
  `HELLO`. Successful approval returns connected tabs directly; do not ask the
  user to reply just to continue. On timeout it returns `pairing_required` with
  `pair_url`; use non-blocking `pairing_status` for a later check. Never inspect
  the pair-page HTML or poll `list_tabs`. Once approved, later sessions on that
  machine connect silently.
- **Pick a free tab.** `list_tabs` marks tabs held by other sessions as `busy`.
  Prefer an unowned tab, or open your own — two agents typing into one form
  produces failures that look like your own tool calls not working.
