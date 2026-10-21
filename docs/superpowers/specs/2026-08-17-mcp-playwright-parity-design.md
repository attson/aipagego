# MCP Playwright Parity Design

**Status:** implemented. Deviations found during execution are folded into the
text below rather than left as aspirations — see Backend 1 on why the MAIN-world
script is manifest-declared, and the tool-count note under "Allow-list becomes a
block-list".

## Problem

`@playwright/mcp --extension` (referred to below as *playwright-ext*) and
AIPageGo's MCP bridge solve the same shape of problem: let an external agent
such as Claude Code drive a real browser tab through a Chrome extension. Today
a user who wants both AIPageGo's strengths (page-index, saved replayable
tools, `.xlsx` export, self-heal) and playwright-ext's strengths (console
capture, network capture, dialog handling, arbitrary JS, drag/drop, resize)
must run both MCP servers.

Two separate gaps cause this.

**Gap A — capability exists but is not exposed.** The extension implements 45
built-in tools. `packages/mcp-server/src/tool-gen.ts` allow-lists only 19 of
them. `takeSnapshot` plus `uid-cache.ts` is already an equivalent of
playwright's accessibility-snapshot-plus-ref mechanism, and `clickByUid`,
`fillByUid`, `fillForm`, `navigate`, `pressKey`, `screenshot`, `runJS`,
`openTab`, `closeTab`, `switchToTab`, `downloadSpreadsheet` and the whole
page-index family are all implemented and unreachable from MCP. External
agents therefore see a strictly weaker AIPageGo than the side panel does.

**Gap B — capability does not exist.** The extension has no equivalent of
`browser_console_messages`, `browser_network_requests`,
`browser_network_request`, `browser_handle_dialog`, `browser_drag`,
`browser_drop`, `browser_resize`, or `browser_navigate_back`. The first four
are the hard ones: in an MV3 isolated world the page's `console`, `fetch`,
`XMLHttpRequest`, and `window.alert` are all unreachable.

## Goals

- Make AIPageGo a functional replacement for playwright-ext: every
  playwright-ext capability has an AIPageGo equivalent reachable over MCP.
- Expose the full built-in tool set over MCP rather than a hand-maintained
  subset, so future built-ins reach external agents without a second edit.
- Add page-event recording (console, network, dialog) with a default posture
  that does not change page behaviour and does not retain data.
- Offer full-fidelity recording through `chrome.debugger` for users who opt in,
  with automatic, visible degradation when CDP is unavailable.
- Keep the existing session, capability, and quota model intact.

## Non-Goals

- No name-level drop-in compatibility with playwright-ext. Tools keep the
  `browser_<builtinName>` convention, so prompts that hard-code
  `browser_snapshot` still need editing. Agents that read `tools/list` are
  unaffected.
- No change to the session model. `open_session` still binds a tab explicitly
  and `session_id` stays required on every `browser_*` call.
- No change to the MCP session permission posture. MCP sessions continue to
  receive the full capability scope; Claude Code's own tool-approval prompt is
  the approval layer.
- No cross-frame recording. Version 1 records the top frame only.
- No persistence of recorded console/network/dialog data.

## Decisions Taken

| Decision | Choice |
|---|---|
| Console / network / dialog mechanism | MAIN-world injection by default, `chrome.debugger` as an opt-in switch |
| MCP tool surface | Full mechanical exposure of every built-in as `browser_<builtinName>` |
| Session model | Unchanged — explicit `open_session`, required `session_id` |
| MCP permission posture | Unchanged — full capability scope, Claude Code approves |
| Delivery scope | Single spec covering MAIN-world *and* CDP |

## Architecture

### The `page-recorder` subsystem

One new subsystem. Everything else in this spec is additive work on the
existing tool plumbing.

A `PageRecorder` interface lives in `packages/shared/src/recorder/`:

```ts
type RecorderBackend = "main-world" | "cdp";

interface PageRecorder {
  backend: RecorderBackend;
  degradedReason?: string;
  readConsole(o: {level?: ConsoleLevel; limit?: number; sinceId?: number}): ConsoleReadResult;
  readNetwork(o: {urlPattern?: string; method?: string; status?: number;
                  includeStatic?: boolean; limit?: number; sinceId?: number}): NetworkReadResult;
  readNetworkDetail(o: {id: number; part?: NetworkPart}): NetworkDetailResult;
  setDialogPolicy(o: {accept: boolean; promptText?: string; scope: "next" | "all"}): DialogReadResult;
  readDialogs(o: {limit?: number}): DialogReadResult;
  configure(o: RecorderConfig): RecorderConfig;
}
```

Every read result carries `backend` and, when degraded, `degradedReason`. An
agent must be able to distinguish "this page issued no requests" from "the
recorder could not observe requests".

### Backend 1 — `MainWorldRecorder` (default)

Declared statically in the manifest as a second `content_scripts` entry with
`world: "MAIN"`, `run_at: "document_start"`, `matches: ["<all_urls>"]`.

Dynamic registration via `chrome.scripting.registerContentScripts` was the
original intent, because it would let the settings-page privacy toggle actually
`unregisterContentScripts`. It does not work here: crxjs copies
`web_accessible_resources` entries verbatim without transpiling, so a
dynamically-registered `.ts` reaches `dist/` as raw TypeScript and never runs.
Verified by build probe — source and emitted asset were byte-identical at
13559 B.

Consequently the master switch means "uninstall the patches and stop draining",
not "the script never loads". The recorder exposes `uninstall()`, which restores
every patched global and clears the buffers; the host pushes it to open tabs
when the switch is turned off, and to each new tab on its first drain. The gap
is a `document_start`-to-first-drain window on a fresh page load while the
switch is off, during which the two cheap buffers fill and are then discarded.
The settings copy states this.

The recorder installs `window.__AIPAGEGO_REC__`, holding three ring buffers.
Reads reuse the existing one-shot `injectMainWorld`
(`packages/extension/src/background/rpc-handlers.ts:497`): the drain script runs
in the same MAIN world and shares the global, so no new message channel is
needed.

- **console** — patches `log`, `info`, `warn`, `error`, `debug`, `trace`, and
  listens for `error` and `unhandledrejection`. Arguments are serialised with a
  depth limit, cycle detection, and a 2 KB per-argument cap. `Error` values
  keep `name`, `message`, and `stack`. Ring size 500.
- **network** — wraps `window.fetch` and
  `XMLHttpRequest.prototype.open`/`send`, and adds a
  `PerformanceObserver('resource')` to cover static resources the wrappers
  cannot see. Observer-sourced entries carry `observed: true` and have timing
  and transfer size but no body. Ring size 300.
- **dialog** — patches `alert`, `confirm`, and `prompt`.

The recorder is tampering-visible: the page shares the MAIN world and can
overwrite the patches. This is accepted and documented; CDP is the answer for
adversarial pages.

#### Default posture

The recorder loads on every page the user visits, so its defaults are a product
decision, not just a performance one.

| Channel | Default | Rationale |
|---|---|---|
| console buffer | on | Cheap, and events that predate the agent's question are exactly the ones worth having |
| network metadata | on | URL, method, status, timing only; no body touched |
| network response body | **off** | Requires `res.clone().text()`; enabled only when armed, then capped by content-type and 256 KB |
| dialog | **passthrough** | Calls the original `alert`/`confirm`/`prompt`. Until armed, page behaviour is byte-for-byte unchanged |

Buffers are in-memory only. They are never written to IndexedDB, never included
in "export tool library", and never leave the page unless a tool call drains
them.

Overflow drops oldest and increments a `dropped` counter returned on every
read, so the agent can tell truncation from absence.

### Backend 2 — `CdpRecorder` (opt-in)

`debugger` goes in `optional_permissions`, not `permissions`. The settings page
requests it with `chrome.permissions.request()` behind a user gesture. Putting
it in `permissions` would show every user an install-time "debug your browser"
warning even if they never enable the feature.

When enabled, the background worker calls `chrome.debugger.attach(tabId, "1.3")`
and fills the same buffer shapes from:

- `Runtime.consoleAPICalled` and `Log.entryAdded` — including browser-level
  CORS/CSP errors and messages emitted before any script injection.
- `Network.requestWillBeSent` / `responseReceived` plus
  `Network.getResponseBody` — real response bodies, static resources included.
- `Page.javascriptDialogOpening` and `Page.handleJavaScriptDialog` — genuine
  dialog suspension. Under CDP, `handleDialog` becomes reactive like
  playwright's, instead of a pre-set policy.
- `Emulation.setDeviceMetricsOverride` — exact viewport for `resize`.

#### Degradation is mandatory

`chrome.debugger.attach` fails when DevTools is open or another extension —
playwright-ext itself, for instance — already holds the target. `onDetach` can
fire at any time. Both cases fall back to `MainWorldRecorder` automatically and
set `backend: "main-world"` plus a `degradedReason` string on subsequent reads.
Failing to attach is never a hard error for a tool call.

## Tool Surface

### New built-ins

Eleven new `BuiltinTool` values.

| Tool | Runs in | Contract |
|---|---|---|
| `consoleMessages` | recorder drain | `{level?, limit?, sinceId?}` → `{backend, dropped, messages[]}` |
| `networkRequests` | recorder drain | `{urlPattern?, method?, status?, includeStatic?, limit?, sinceId?}` → summaries |
| `networkRequestDetail` | recorder drain | `{id, part?}` → headers and bodies. MAIN-world requires body capture armed; CDP serves directly |
| `handleDialog` | recorder | `{accept, promptText?, scope}` → sets policy and returns recorded dialogs. Under CDP, also answers a pending dialog immediately |
| `recorderConfig` | recorder | Arms/disarms body capture and dialog policy mode; clears buffers |
| `navigateBack` | background | `chrome.tabs.goBack` |
| `navigateForward` | background | `chrome.tabs.goForward` |
| `resize` | background | Derives chrome size from `outerWidth - innerWidth`, sets the outer frame so the viewport lands exactly; CDP uses `Emulation.setDeviceMetricsOverride` |
| `drag` | content | `{from, to}` by selector or uid. Emits a pointer sequence *and* HTML5 `DragEvent`s over a shared `DataTransfer`, covering both native DnD and pointer-based custom DnD |
| `drop` | content | `{target, files?, data?}` synthesises an external drop |
| `findElements` | content | `{text? \| regex?, limit?}` → uid, role, name, bounds. The `browser_find` equivalent, but with no page-index prerequisite; reuses `INTERACTIVE_SELECTOR` from `take-snapshot.ts` |

### Extended built-ins

- `click` — add `doubleClick`, `button`, `modifiers`.
- `fillInput` — add `slowly` (per-character key events, for controlled
  components) and `submit`.
- `screenshot` — add `fullPage` (scroll-and-stitch on a content-script canvas;
  CDP uses `captureBeyondViewport` for a single clean capture), `format`,
  `scale`.
- `waitFor` — add `text` and `textGone`. Today it supports only `ms` and
  `selector` (`packages/shared/src/llm/builtin-tool-defs.ts:193`).

### Semantic differences from playwright

Two behaviours cannot be reproduced exactly on the MAIN-world backend, and the
tool descriptions must say so.

**`handleDialog` is a pre-set policy, not a reaction.** `alert`, `confirm`, and
`prompt` are synchronous; a patched implementation cannot await a round trip to
the agent. On the MAIN-world backend the agent declares in advance whether the
next dialog — or all dialogs — should be accepted or dismissed and what text a
`prompt` receives, then reads what happened afterwards. On the CDP backend the
dialog genuinely suspends and the tool behaves like playwright's.

**`resize` moves the window, not a virtual viewport.** The compensation
arithmetic makes the resulting viewport exact, but the user's actual window
changes size. CDP's device-metrics override does not.

## Capability Model

`capabilityForTool` is an exhaustive switch, so TypeScript refuses to compile
until every new tool is classified. Three capabilities join the catalog:

| Capability | Tier | Tools |
|---|---|---|
| `read:console` | safe — joins `IMPLICIT_CAPABILITIES` | `consoleMessages` |
| `read:network` | caution | `networkRequests`, `recorderConfig` |
| `read:network-body` | **dangerous** | `networkRequestDetail` headers and bodies |

`read:network-body` must be dangerous because response headers carry
`Authorization`, `Set-Cookie`, and bearer tokens. This does not weaken the
"MCP sessions get everything" decision: MCP sessions still open with the full
scope. The tier constrains the extension's *own* side-panel AI, whose user is
an ordinary person clicking through an approval sheet.

`drop` is dual-tier the way `httpRequest` already is: with `files` it needs
`upload:file` (dangerous), without them `interact:form`. `recorderConfig`
validates `read:network-body` when the call arms body capture. The existing
`capabilityForTool(tool, opts)` signature carries the disambiguation.

Remaining assignments: `navigateBack`, `navigateForward`, `resize` → `nav:tab`;
`drag`, `handleDialog` → `interact:form`; `findElements` → `read:dom`.

## MCP Layer Changes

### Allow-list becomes a block-list

`EXEC_TOOL_NAMES` in `packages/mcp-server/src/tool-gen.ts` is replaced by a
block-list over the full `TOOL_DEFS`. Three tools stay out:

- `askUser` — an MCP session has no human at a side panel to answer.
- `attachTab`, `detachTab` — side-panel multi-tab bookkeeping; an MCP session
  already has its tab bound by `open_session`.

The resulting surface is 46 + 11 − 3 = **54** `browser_*` tools, plus four
control-plane tools and the skill tool, for 59 total. (The count is over
`TOOL_DEFS`, which has 46 entries, not the `BuiltinTool` union's 45 — `runJS`
is a `TOOL_DEFS` entry without a union member because it is a distinct step
kind.) playwright-ext exposes 24. The schemas cost roughly 20 KB of context on
every request.

### The `AIPAGEGO_MCP_TOOLS` knob

An environment variable with two values. `full` is the default and produces all
53. `parity` produces the smaller set whose capabilities cover playwright-ext's
24 tools one-for-one — still under AIPageGo names — for users who would rather
have the context back. Default behaviour is unchanged by this knob's existence.

### Image results

`CallResult` hard-codes `{type: "text"}`
(`packages/mcp-server/src/mcp-server.ts:12`), which cannot carry a screenshot.
`GeneratedTool` gains `resultKind: "json" | "image"`, and the `ok()` helper
branches to `{type: "image", data, mimeType}` for image-returning tools.

### Version negotiation

`HELLO` carries `capabilities` (capability strings) but no tool-name list
(`packages/shared/src/protocol/messages.ts:23`). A new MCP server paired with an
older extension would advertise `browser_drag` and fail at call time with
"unknown tool".

`HELLO` gains `supported_tools: string[]`. The MCP server intersects its
generated list with what the worker reports before answering `tools/list`. When
the field is absent — an extension predating this change — the server falls
back to the current 19-tool list.

### Skill bundle

`skill/SKILL.md` is updated with the new tools, the recorder's arming model, and
the backend-fidelity distinction, since `aipagego_skill_read` is how agents
learn the intended flow.

## Error Handling

- Recorder reads never throw for backend reasons. A failed CDP attach degrades
  to MAIN-world; a disabled recorder returns an empty result with an explicit
  `disabled` reason rather than an error.
- `networkRequestDetail` on the MAIN-world backend with body capture disarmed
  returns the metadata it has plus a `bodyUnavailable` reason naming
  `recorderConfig` as the fix.
- `drag` and `drop` report which event families the target actually consumed, so
  a no-op on a custom DnD implementation is diagnosable rather than silent.
- Tools absent from the connected extension are filtered out of `tools/list`
  entirely, so an agent never sees a tool it cannot call.

## Testing

Existing suite is ~853 tests with no Playwright; UI smoke is manual. This work
follows the same shape.

- **shared** — serialiser depth/cycle/cap behaviour; ring-buffer overflow and
  `dropped` accounting; capability mapping for all 11 new tools including the
  dual-tier `drop` and `recorderConfig` paths; `supported_tools` intersection.
- **extension** — one happy-dom group per new content tool (`drag`, `drop`,
  `findElements`); MAIN-world recorder patches under a simulated page
  (console capture, fetch and XHR capture, dialog passthrough versus armed
  policy); `screenshot` full-page stitching; `waitFor` text and textGone;
  `fillInput` slowly and submit.
- **mcp-server** — block-list generation, `parity` versus `full` selection,
  image `CallResult` shape, `tools/list` intersection against a worker that
  reports an older `supported_tools`.
- **manual smoke** — CDP opt-in: enable in settings, confirm attach, open
  DevTools to force a detach, confirm automatic degradation and the
  `degradedReason` surfacing in a subsequent `consoleMessages` call.
