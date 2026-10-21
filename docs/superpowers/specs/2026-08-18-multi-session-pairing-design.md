# Multi-Session Pairing Design

**Status:** implemented; pairing wait updated by Plan 40.

## Problem

Only one Claude Code session can drive the browser at a time, and the failure
mode is silent.

`packages/mcp-server/src/index.ts:9-14` binds `AIPAGEGO_WS_PORT ?? 8787`
unconditionally at process start. A second session therefore dies immediately
with an unhandled `EADDRINUSE` — `LoopbackWSHub` never attaches an `error`
listener, so `ws` re-throws and Node exits. Claude Code reports only
`-32000: Connection closed`, which does not mention ports at all. Diagnosing it
requires walking the process tree to find the older session still holding 8787.

Fixing the crash is not enough. The extension's `CoordinatorClient`
(`packages/extension/src/background/coordinator-client.ts:23,70`) holds a single
`ws_url` and a single socket, so even with every server on its own port the
browser would attach to exactly one of them. The rest would report "no browser
connected".

Two adjacent defects surface once multiple connections are in play:

- **Reconnection never stops.** `scheduleReconnect` backs off to a 30 s ceiling
  but has no attempt cap, and the 15 s heartbeat alarm
  (`coordinator-client.ts:214`) re-opens any CLOSED socket without consulting
  `reconnectAttempts`. The effective behaviour is a flat 15 s retry forever,
  which the exponential backoff only appears to govern. With one hand-configured
  URL that is defensible; with N auto-paired ephemeral ports it becomes N
  perpetual retry loops for sessions that ended long ago.
- **`list_tabs` is frozen at connect time.** `available_tabs` is built only in
  `coordinator-hello.ts:37`, and `buildHello` runs once per connection
  (`coordinator-client.ts:90`). No protocol message refreshes it. A tab opened
  after the extension connected is invisible to `list_tabs` until reconnect.

## Goals

- Let N Claude Code sessions drive the same browser concurrently, each through
  its own connection.
- Bind a port only when a session actually needs the browser, so sessions that
  never touch a page cost nothing.
- Require explicit user consent before an unknown local process gains browser
  control, and make that consent survive restarts without repeated clicks.
- Give reconnection a terminating condition.
- Make `list_tabs` reflect the browser's current state, including which tabs
  other sessions are already using.

## Non-Goals

- **No Chrome tab groups.** Grouping session-created tabs is a display-layer
  improvement, orthogonal to everything here, and gets its own spec.
- **No playwright-style browser contexts.** An extension cannot create isolated
  cookie jars; the closest equivalents (profiles, incognito) are not
  programmatically controllable. playwright-ext has no contexts either.
- **No cross-session coordination of tool calls.** Tab ownership is advisory.
  Two sessions may deliberately share a tab.
- **No change to the session/capability/quota model** inside a single
  coordinator.

## Decisions Taken

| Decision | Choice |
|---|---|
| Topology | Extension holds N connections; each server sees exactly one worker |
| Port binding | Lazy — on first tool that needs the browser; ephemeral, reusing the last port when free |
| Discovery | Pairing page served by the server on its own port; no port scanning, no port range |
| Trust unit | Install-level identity; `sessionId` + cwd label are display-only |
| Approval UI | Extension-injected shadow-DOM overlay, not a button on the served page |
| Tab conflicts | Surfaced in `list_tabs` as `busy`; advisory, never blocking |
| Tab freshness | Push (`TABS_UPDATE`) on change |

## Architecture

### Why the extension must be the client

The MCP server process is the WebSocket **server**
(`loopback-ws-hub.ts:52`, listening on `127.0.0.1:<port>/worker`); the extension
is the **client** (`coordinator-client.ts:70`). This is not a preference: an MV3
service worker cannot listen on a port. It can only dial out.

Two consequences shape the whole design. Port conflicts exist because every
server must bind something. And discovery can only be extension-initiated,
because a server has no way to address the browser first — which is exactly what
the pairing page solves, by handing the extension a port it could not otherwise
learn.

### Session lifecycle

**Start — nothing happens.** `index.ts` builds only the stdio MCP server.
`tools/list` and `aipagego_skill_read` never touch a port.

**First browser need — `ensureHub()`.** Triggered by `list_tabs`,
`open_session`, or any `browser_*` call:

1. Read `~/.aipagego/identity.json` (mode 0600); create
   `{ installId, secret }` if absent.
2. Bind a port: prefer the recorded `lastPort`, fall back to an ephemeral port
   (`0`). `LoopbackWSHub.ready()` already reads the actual port back via
   `AddressInfo` (`loopback-ws-hub.ts:63`). Persist the bound port as
   `lastPort`.
3. Serve WS and `GET /pair` from one explicit `http.createServer()`, replacing
   the internal server `ws` creates when handed a bare `port`.

**Pairing.** The served page is a *carrier*, not an authority — letting the
requesting party render its own approval button would be asking it to sign its
own permit. So:

- `/pair` posts `{ installId, secret, sessionId, label, pid, port }` via
  `window.postMessage`.
- The existing content script (matched on `<all_urls>`, so already injected on
  `127.0.0.1`) relays it to the service worker.
- The worker decides. Known `installId` with a matching `secret` connects
  straight away and the page reports "already trusted" and closes itself.
  Otherwise the worker injects a shadow-DOM overlay — reusing the machinery in
  `content/widget/` — reading "the session in `~/code/aipagego2` wants to control
  your browser", with Allow and Deny. The page cannot forge that overlay's
  outcome.

The port needs no negotiated convention: the page runs *on* that port, so
`location.port` is self-evidently true.

The server presents the page once per process through MCP URL elicitation, with
the platform opener (`open` / `xdg-open` / `start`) as fallback. A triggering
`list_tabs` call waits up to 45 seconds for the extension's `HELLO`; normal
approval therefore returns connected tabs from that same tool call. This avoids
requiring a second user message merely to resume the model. `pairing_status`
remains an immediate, non-blocking check. If the bounded `list_tabs` wait expires,
it returns `pairing_required` and the URL so the user can open it in the browser
that holds the extension and the agent can check status later.

**Restart.**

| Situation | Behaviour |
|---|---|
| Trusted, `lastPort` still bindable | Extension reconnects to the known endpoint. No page, no click |
| Trusted, port changed | Page opens, recognises a known install, connects and closes itself |
| Unknown install, or trust revoked | Page opens, overlay asks |

Port reuse is what makes silence possible; identity is what makes port reuse
*safe*. Remembering a port alone would happily connect to whatever process
grabbed it next; a mismatched `secret` is what rejects it.

**Shutdown — three layers.**

1. **Graceful.** On stdio close or `SIGTERM` the server sends WS close code
   `4000 server-shutting-down`. The extension drops the endpoint immediately and
   does not retry. Most sessions exit this way, so this covers the common case.
2. **Failure cap.** For kills and sleeping machines: after 10 consecutive
   failures an endpoint goes `dormant`. Retries stop; the trust record stays.
3. **Wake.** A manual reconnect from the settings page, a fresh pairing, or a
   browser restart reactivates a dormant endpoint once.

This also repairs the existing defect where the heartbeat alarm defeats the
backoff. The alarm must consult `reconnectAttempts` and skip dormant endpoints
rather than reconnecting any CLOSED socket on sight.

### Trust model

One identity per installation, in `~/.aipagego/identity.json` (0600):

```jsonc
{ "installId": "inst_9c1e…", "secret": "…" }
```

Each server process additionally generates a per-process `sessionId` and reports
its working directory as `label`. Those two are **display and management only**
and take no part in the trust decision.

Per-directory identities were considered and rejected. Their security benefit is
illusory: the secret sits in the home directory, and any process that can read it
can also claim any `cwd` it likes. What directory scoping actually offered was
user-facing granularity, at the cost of a real defect — git worktrees and renamed
directories become different identities, so the same project re-prompts for no
reason the user can see.

What this protects against: a local process silently taking control of the
browser. Without the secret it must go through the overlay.

What it does not protect against: anything that can read `~/.aipagego/`. Such a
process can already do considerably worse. This is a boundary, not a hole, but it
should be stated rather than implied.

The cost of a single shared secret is that an individual misbehaving session
cannot have its credential revoked on its own. It can be disconnected, but it
will reconnect; cutting it off for good means revoking the install.

### Connection pool

`startCoordinatorClient` manages one client today. It becomes a pool:

```ts
type PoolEntry = {
  endpoint: string;            // ws://127.0.0.1:<port>/worker
  installId: string;
  sessionId: string;
  label: string;               // the server's cwd
  pid: number;
  client: CoordinatorClient;
  status: "connected" | "connecting" | "dormant";
  failures: number;
};
```

`CoordinatorClient` needs little change — it is already shaped as one instance
per URL. The work is the reconnection governance above and instantiating it N
times.

### Tab ownership

`open_session` is server-local; the extension never sees it. The protocol has
`CLOSE_SESSION` (S→C) but no symmetric open notification, so ownership would
otherwise have to be guessed from whichever `EXEC` lands first.

A new S→C `SESSION_OPENED { session_id, tab_id }` makes it exact. The extension
keeps `tabId → { connectionId, sessionId, label, since }`, claiming on
`SESSION_OPENED` and releasing on `CLOSE_SESSION`, connection loss, or tab
closure.

Ownership is **advisory**. Nothing is blocked. An agent that sees a tab is taken
can open its own, and two agents may share a tab on purpose.

### MCP release version visibility

The pairing payload carries an optional `mcpVersion` sourced from the published
MCP package. The extension keeps it on the corresponding connection-pool entry
and shows it in the MCP settings session list. The field remains optional under
pairing payload `v: 1`, so older MCP clients still connect and are displayed as
"MCP 版本未知".

On each pairing request, including an already-trusted install, the extension
compares `mcpVersion` with `chrome.runtime.getManifest().version`. A mismatch is
advisory: the pair page remains open with a recommendation to update the older
side, and the settings page keeps the warning visible beside the affected
session. Matching versions preserve the existing auto-close flow. Version
comparison never changes trust, websocket connectivity, or the separate
`protocol_version` compatibility gate.

### Tab freshness

A new C→S `TABS_UPDATE` fires on tab changes and ownership changes, reusing the
existing `tab-watcher.ts`. Each connection receives a view computed for it:

```jsonc
{ "tab_id": "42", "url": "…", "title": "…",
  "mine": false,
  "busy": true,
  "busy_label": "~/code/wanxin" }
```

The coordinator updates `worker.available_tabs`, so `handleListTabs` keeps
reading a cache and answering synchronously. `TabInfo` and the HELLO /
`TABS_UPDATE` schemas gain the three fields.

### Settings

The Coordinator sub-page replaces its single URL field with two lists:

```
已接入的会话
  ~/code/aipagego2   pid 1234  :51234  ● connected   [断开]
  ~/code/wanxin   pid 5678  :51299  ○ dormant     [重连]

已信任
  本机 (inst_9c1e…)  首次授权 2026-08-18   [撤销]
```

Disconnecting is an operational action and does not revoke trust — the endpoint
will reconnect. Revoking clears the credential, after which every session asks
again.

`AIPAGEGO_WS_PORT` remains as an override for anyone who wants a fixed port.

## Error Handling

- Pairing page opened but ignored: `list_tabs` waits at most 45 seconds, then
  returns `pairing_required`; the agent checks `pairing_status` later rather
  than polling `list_tabs` or asking for a reply solely to continue.
- Extension absent, or the page is a restricted URL where content scripts cannot
  run: the page reports that AIPageGo was not detected and links to install.
- `installId` matches but `secret` does not: treated as unknown and sent through
  the overlay, with a console warning — the likely cause is another process
  having taken the remembered port.
- Repeated pairing for the same `sessionId` (a page refresh) is idempotent and
  adds no second connection.
- `EADDRINUSE` on an explicitly configured `AIPAGEGO_WS_PORT`: reported on
  stderr as an actionable message rather than an unhandled throw, naming the
  variable as the way out.

## Testing

- **shared / coordinator** — trust comparison; ownership map add/remove;
  per-connection view derivation; the backoff-and-dormant state machine;
  `TABS_UPDATE` and `SESSION_OPENED` zod schemas.
- **mcp-server** — `ensureHub` laziness (no port bound until a browser-needing
  tool runs); identity file creation and reuse; `lastPort` preference with
  ephemeral fallback; graceful close code on shutdown.
- **extension** — the content-script postMessage relay and overlay decision
  under happy-dom; pool add/remove/dormant transitions; alarm respecting backoff
  and dormancy.
- **end-to-end** — extend the real-`ws` pattern in
  `tests/background/coordinator-e2e.test.ts` with a two-connection scenario:
  both connected, ownership claimed by one, the other seeing `busy: true`.
- **manual** — two Claude Code sessions in different directories; confirm one
  approval covers the second; confirm closing one leaves the other working.
