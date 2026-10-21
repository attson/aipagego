# Embedded Demo Design

**Status:** in progress.

**Probe result.** The real `AppShell` mounts under the demo shim and renders the
full panel — header, tab pill, quick-action suggestions, input, permission pill.
The demo therefore runs the actual side panel, and the homepage may say so. The
chrome surface it needs turned out to be exactly what the shim already covers
plus `bookmarks.getTree` and `tabs.captureVisibleTab`. Kept as a regression test
at `tests/demo/app-shell-probe.test.tsx` so the demo cannot silently stop
mounting.

## Problem

The docs site has no way to show what AIPageGo does. A browser extension cannot
be "tried online" — it has to be installed — so the homepage currently asks
people to download a zip and configure an API key before they can form any
impression at all.

Screenshots would be the cheap answer, but they go stale silently and they
cannot show the thing that actually distinguishes this project: an agent
reading a page, asking for approval, and visibly changing that page.

## Goals

- Put a working AIPageGo on the homepage that a visitor can watch drive a real
  DOM, with no install and no API key.
- Run the **real** side panel UI and the **real** content tools, not a
  reimplementation — a demo that drifts from the product is worse than none.
- Keep the demo deterministic, so it reads the same way every time and can be
  regression-tested.

## Non-Goals

- **Not an online trial.** The demo operates on one canned page. It cannot visit
  real sites, and the homepage copy must not imply otherwise.
- **No real LLM.** No API key, no network calls to a provider.
- **No persistence.** Nothing the demo does survives a reload.
- **Not every feature.** One scripted scenario, chosen to show the loop; the
  tool reference and guides cover the rest.

## Architecture

### Why not the reference project's approach

`atstarter` mounts its real frontend directly inside VitePress —
`import FrontendApp from '.../frontend/src/App.vue'`. That works because both
are Vue. AIPageGo's side panel is **React**, so a direct mount means
React-in-Vue interop plus both toolchains in the docs build. An iframe sidesteps
that entirely and, for a side panel, is also the more natural frame.

### Document layout

The demo is a self-contained app that the homepage embeds:

```
VitePress homepage
└── <iframe src="/aipagego/demo/">          demo document
     ├── mock product page                    ← the DOM the tools operate on
     ├── <iframe> side panel                  ← the real React app
     └── harness                              ← stands in for the service worker
```

**The side panel goes in a nested iframe on purpose.** The content tools query
`document` directly — `element-meta.ts` calls `document.querySelectorAll`, and
nothing takes a root. If the panel shared a document with the mock page,
`takeSnapshot` would enumerate the panel's own buttons alongside the page's.

Splitting them also happens to mirror production, where the side panel and the
content script genuinely are separate documents, with the service worker
between them. The harness plays that middle role.

### The three seams

Everything the demo needs to fake is already a seam in the product, because the
same seams exist for the deterministic chat tests.

| Seam | Production | Demo |
|---|---|---|
| LLM | `LlmClient` injected into `runChatSession` | `MockLlmClient` (already exists) replaying a scripted round list |
| Tool execution | `ToolRunner` injected | A runner that posts to the harness, which calls the real `callTool` |
| Background RPC | `chrome.runtime.sendMessage(req)` | A shim, `sidepanel/rpc.ts` funnels *every* call through this one function |
| Storage / tabs | `chrome.storage`, `chrome.tabs` | In-memory shim |

`runChatSession` takes `client`, `runner`, `approver`, `rpc`, `metaTools`,
`screenshot`, and `askUser` as parameters, so the demo supplies them rather than
patching anything.

### The chrome shim

Installed on `globalThis` before the app's first module evaluates, in both demo
documents. It covers what the side panel actually uses — 16 files, roughly 93
call sites: `storage` (43), `runtime` (29), `tabs` (15), `bookmarks` (4).

- `storage.local` — a `Map`, seeded with demo settings so the panel starts
  configured and never shows the API-key prompt.
- `runtime.sendMessage` — parses the `RpcRequest` and answers locally. Requests
  that need the page (`runs.runOneStep`, `scripting.injectMain`) are forwarded
  to the parent document over `postMessage`.
- `tabs` — one fake tab describing the mock page.
- `bookmarks` / `history` — empty results.

### The tool bridge

The nested panel and the harness exchange two messages:

```
panel  → harness : { type: "demo.runStep", id, step }
harness → panel  : { type: "demo.runStep.result", id, ok, data | error }
```

The harness resolves it by calling the product's own `callTool(name, args)`
against the demo document. So `fillInput` really writes into the mock form,
`click` really dispatches, `takeSnapshot` really walks the DOM. The visible
change on the left is caused by the same code that runs in a real page.

Meta-plane tools (`screenshot`, `downloadSpreadsheet`, tab operations) are
stubbed with canned results — they need `chrome.tabs.captureVisibleTab` and the
downloads API, which have no meaningful demo equivalent.

### The scenario

One scripted run, chosen because it exercises the whole loop in a few rounds:

1. User prompt is pre-filled: 「采集这个商品的标题、价格和前 3 条评论」
2. `createPageIndex` → `extractPageFields` — safe, runs automatically
3. `takeSnapshot` — shows the uid mechanism
4. `click` on 「展开全部评论」 — **caution**, so the approval bar appears and the
   visitor sees the permission model
5. `extractText` on the revealed comments
6. A summary message with the structured result

The mock page is a plausible product page with a title, price, spec table, and a
collapsed comment list, so step 4 produces a visible change.

Timing is driven by the script, with a short delay between rounds so it reads at
human pace rather than completing instantly.

### Replay control

A small bar under the demo: **重新播放** and a note that this is a canned page,
not a live browser. The note is not decoration — without it the demo implies an
online trial it cannot deliver.

## Build and Deployment

A second Vite config, `packages/extension/vite.demo.config.ts`, builds two
entries — the demo document and the panel document — as a plain web app with no
`@crxjs` plugin, into `docs-site/public/demo/`.

`docs-site/public/` is copied verbatim by VitePress, so the site build needs no
knowledge of the demo beyond the iframe. The gh-pages workflow gains one step:
build the demo before building the site.

Because the demo imports from `sidepanel/` and `content/tools/`, it lives in
`packages/extension/demo/` rather than a new package — the imports stay relative
and no workspace dependency is introduced.

## Error Handling

- If the demo fails to load, the iframe is replaced by a still screenshot and a
  line of text. A broken demo must not leave a blank rectangle on the homepage.
- The harness catches tool errors and surfaces them as normal error tool-cards,
  which is what the product does — a demo that cannot show a failure is
  misleading in a different direction.
- `prefers-reduced-motion` disables the inter-round delays and renders the final
  state directly.

## Testing

- **shim** — `RpcRequest` routing, storage round-trip, unknown request types
  answering with an error rather than hanging.
- **script** — the round list type-checks against `LlmStreamEvent`, and every
  tool it names exists in `TOOL_DEFS`. This is the guard against demo drift: if
  a tool is renamed, the demo fails to build rather than failing in front of a
  visitor.
- **bridge** — request/response pairing, including an error result.
- **scenario** — driving the script through `runChatSession` with the mock
  client and a jsdom mock page asserts the final DOM state, so the demo's
  headline claim is covered by a test rather than by hope.
