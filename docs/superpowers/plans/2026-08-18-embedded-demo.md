# Embedded Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a working AIPageGo on the docs homepage — the real side panel driving a real DOM through the real content tools, with no install and no API key.

**Architecture:** A standalone Vite app under `packages/extension/demo/`, built into `docs-site/public/demo/` and embedded by the homepage in an iframe. The demo document holds a mock product page; the side panel runs in a nested iframe so the content tools' `document` queries see only the page. A harness in the demo document plays the service worker, resolving tool calls with the product's own `callTool`.

**Tech Stack:** TypeScript, React 18, Vite (no `@crxjs`), VitePress, Vitest + happy-dom.

**Spec:** [`../specs/2026-08-18-embedded-demo-design.md`](../specs/2026-08-18-embedded-demo-design.md)

## Global Constraints

- The demo runs the **real** side panel UI and the **real** content tools. Reimplementing either defeats the purpose.
- No network calls to an LLM provider, no API key, no persistence across reload.
- The homepage must state plainly that this is a canned page, not a live browser. Do not imply an online trial.
- The side panel lives in a nested iframe. Content tools query `document` with no root parameter, so a shared document would let `takeSnapshot` enumerate the panel's own controls.
- Demo sources live in `packages/extension/demo/` so imports from `sidepanel/` and `content/tools/` stay relative.
- Build output goes to `docs-site/public/demo/`, which VitePress copies verbatim.
- `prefers-reduced-motion` skips the inter-round delays.

---

### Task 1: Scenario script and its drift guards

**Files:**
- Create: `packages/extension/demo/scenario.ts`
- Test: `packages/extension/tests/demo/scenario.test.ts`

**Interfaces:**
- Consumes: `LlmStreamEvent` from `@aipagego/shared/llm`, `TOOL_DEFS`.
- Produces: `DEMO_ROUNDS: LlmStreamEvent[][]` — the round list `MockLlmClient` replays; `DEMO_PROMPT: string`; `DEMO_TOOL_NAMES: string[]` derived from the rounds; `ROUND_DELAY_MS = 900`.

The guard matters more than the content: if a tool is renamed the demo must fail to build, not fail in front of a visitor.

- [ ] **Step 1: Write the failing test**

```ts
// packages/extension/tests/demo/scenario.test.ts
import { describe, expect, it } from "vitest";
import { DEMO_PROMPT, DEMO_ROUNDS, DEMO_TOOL_NAMES } from "@/../demo/scenario";
import { TOOL_DEFS } from "@aipagego/shared/llm";

describe("demo scenario", () => {
  it("names only tools that exist", () => {
    const known = new Set(TOOL_DEFS.map((t) => t.name));
    for (const n of DEMO_TOOL_NAMES) expect(known.has(n), n).toBe(true);
  });

  it("exercises the approval path with a caution tool", () => {
    expect(DEMO_TOOL_NAMES).toContain("click");
  });

  it("starts from page-index rather than dumping the body", () => {
    expect(DEMO_TOOL_NAMES[0]).toBe("createPageIndex");
    expect(DEMO_TOOL_NAMES).not.toContain("extractText:body");
  });

  it("ends with a message rather than a dangling tool call", () => {
    const last = DEMO_ROUNDS.at(-1)!;
    expect(last.some((e) => e.type === "message_end")).toBe(true);
  });

  it("has a prompt the panel can prefill", () => {
    expect(DEMO_PROMPT.length).toBeGreaterThan(4);
  });
});
```

- [ ] **Step 2: Run it to verify it fails.** Run: `pnpm -F @aipagego/extension test -- demo/scenario`. Expected: FAIL, module not found.
- [ ] **Step 3: Write `scenario.ts`** — the round list from the spec: `createPageIndex` → `extractPageFields` → `takeSnapshot` → `click` (caution, triggers approval) → `extractText` → summary `message_end`. Derive `DEMO_TOOL_NAMES` from the rounds rather than hand-listing it, so it cannot drift from the script.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): scripted scenario with drift guards"`

### Task 2: chrome shim

**Files:**
- Create: `packages/extension/demo/chrome-shim.ts`
- Test: `packages/extension/tests/demo/chrome-shim.test.ts`

**Interfaces:**
- Consumes: `RpcRequest` from `@aipagego/shared/messages`.
- Produces: `installChromeShim(opts: { onPageStep?: (step: unknown) => Promise<unknown>; seed?: Record<string, unknown> }): void`, assigning `globalThis.chrome`. `storage.local` is a Map seeded so the panel starts configured. `runtime.sendMessage` parses `RpcRequest` and answers locally; `runs.runOneStep` and `scripting.injectMain` delegate to `onPageStep`. `tabs.query` returns one fake tab. Unknown request types resolve `{ok:false,error}` — never hang, because the panel's RPC retries four times on a missing receiver and would stall the demo for seconds.

- [ ] **Step 1: Write the failing test** — storage round-trips and reports seeded settings; `tabs.query` returns exactly one tab with an id and url; a `runs.runOneStep` request reaches `onPageStep` and its result comes back as `{ok:true,data}`; an unrecognised type answers `{ok:false}` rather than hanging; `storage.onChanged` listeners fire on `set`.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the shim.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): chrome API shim for the standalone panel"`

### Task 3: Tool bridge

**Files:**
- Create: `packages/extension/demo/bridge.ts`
- Test: `packages/extension/tests/demo/bridge.test.ts`

**Interfaces:**
- Produces: `createBridgeClient(target: Window): (step: unknown) => Promise<unknown>` for the panel side, and `serveBridge(source: Window, run: (step: unknown) => Promise<unknown>): () => void` for the harness side. Messages are `{type:"demo.runStep", id, step}` and `{type:"demo.runStep.result", id, ok, data|error}`. Ids are monotonic; a result for an unknown id is ignored.

- [ ] **Step 1: Write the failing test** — a request/response pair resolves with the data; two concurrent requests resolve to their own results (pairing by id, not by arrival order); a rejected `run` produces `{ok:false}` and the client rejects; a stray result id is ignored; the returned disposer removes the listener.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement `bridge.ts`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): postMessage bridge between panel and harness"`

### Task 4: Mock page

**Files:**
- Create: `packages/extension/demo/page.html` (fragment) and `packages/extension/demo/page.ts`
- Test: `packages/extension/tests/demo/page.test.ts`

**Interfaces:**
- Produces: `MOCK_PAGE_HTML: string` and `mountMockPage(root: HTMLElement): void`. A product page with a title, price, spec table, and a comment list collapsed behind a 「展开全部评论」 button whose click handler reveals three comments.

The page must be real DOM the tools can work on — the selectors the scenario uses have to resolve, and the collapse has to actually collapse.

- [ ] **Step 1: Write the failing test** — mounting yields a title, a price, and a spec table; the comment list starts hidden; clicking the button reveals exactly three comments; the selectors named in `scenario.ts` all resolve after mount.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement the mock page.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): mock product page"`

### Task 5: Probe — can the real AppShell mount under the shim?

`app-shell.tsx` is 908 lines with 16 `chrome.*` call sites and owns settings, sessions, and IDB. Whether it mounts standalone decides the next task's shape, so find out before building around it.

- [ ] **Step 1: Stand up a throwaway entry** that installs the shim and renders `<AppShell />`, and open it with `vite dev`.
- [ ] **Step 2: Record what breaks.** For each failure, note whether it is a missing shim method (cheap to add) or a structural dependency on the extension runtime (not).
- [ ] **Step 3: Decide and write it down in the spec.**
  - **AppShell mounts** (possibly after adding shim methods) → Task 6 uses it. This is the preferred outcome: the demo shows the real panel, chrome and all.
  - **AppShell is too coupled** → Task 6 mounts `components/chat-view.tsx` with injected props instead, and the spec's "real side panel UI" claim is narrowed to "the real chat view" in both the spec and the homepage copy. Do not leave either claiming more than what shipped.
- [ ] **Step 4: Delete the throwaway entry.**

### Task 6: Panel document

**Files:**
- Create: `packages/extension/demo/panel.tsx`, `packages/extension/demo/panel.html`
- Test: `packages/extension/tests/demo/panel-deps.test.ts`

**Interfaces:**
- Consumes: the shim (Task 2), the bridge client (Task 3), `DEMO_ROUNDS` (Task 1), `MockLlmClient`.
- Produces: `buildDemoDeps(target: Window)` returning the `client` / `runner` / `approver` / `rpc` set that `runChatSession` takes, wired to the mock client and the bridge. The entry installs the shim, builds the deps, and renders whichever component Task 5 settled on.

- [ ] **Step 1: Write the failing test** — `buildDemoDeps` returns a `MockLlmClient`; its `runner.runStep` forwards to the bridge; the approver auto-approves `safe` and pauses on `caution` so the approval bar is visible; the rpc surface satisfies the `SessionRpc` shape `runChatSession` expects.
- [ ] **Step 2: Run it to verify it fails.** Expected: FAIL.
- [ ] **Step 3: Implement `panel.tsx` and `panel.html`.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): panel document wired to mock deps"`

### Task 7: Demo document and harness

**Files:**
- Create: `packages/extension/demo/index.html`, `packages/extension/demo/harness.ts`, `packages/extension/demo/demo.css`

**Interfaces:**
- Consumes: `mountMockPage` (Task 4), `serveBridge` (Task 3), `callTool` from `@/content/tools`.
- Produces: a document that mounts the mock page, serves the bridge by calling the real `callTool` against its own document, embeds `panel.html` in a nested iframe, and renders the replay control and the 「这是预置页面，不是在线试用」 note.

- [ ] **Step 1: Implement the harness**, routing `{kind:"tool"}` steps to `callTool` and meta-plane tools (`screenshot`, `downloadSpreadsheet`, tab operations) to canned results. Tool errors propagate as `{ok:false}` so the panel renders its normal error card.
- [ ] **Step 2: Implement the layout** — page left, panel right, replay bar beneath; single column under 720px.
- [ ] **Step 3: Add the replay control**, which remounts the page and reloads the panel iframe.
- [ ] **Step 4: Honour `prefers-reduced-motion`** by zeroing the round delay.
- [ ] **Step 5: Commit** — `git commit -m "feat(demo): demo document and service-worker harness"`

### Task 8: Build and site embed

**Files:**
- Create: `packages/extension/vite.demo.config.ts`
- Modify: `packages/extension/package.json`, `docs-site/index.md`, `docs-site/.vitepress/theme/` (a component if the homepage needs one)
- Modify: `.github/workflows/deploy-docs.yml`

- [ ] **Step 1: Write the demo Vite config** — two entries (`index.html`, `panel.html`), no `@crxjs`, `base: "/aipagego/demo/"`, `outDir: ../../docs-site/public/demo`, `emptyOutDir: true`.
- [ ] **Step 2: Add `build:demo`** to the extension package scripts.
- [ ] **Step 3: Run it and confirm** `docs-site/public/demo/index.html` and its assets exist, then open the built demo over a static server and watch the scenario play.
- [ ] **Step 4: Embed it on the homepage** above the feature sections, with the note and a `<noscript>` fallback. If the iframe fails to load, swap in a still image — a broken demo must not leave a blank rectangle.
- [ ] **Step 5: Add the demo build to the docs workflow** before the VitePress build.
- [ ] **Step 6: Add `docs-site/public/demo/` to `.gitignore`** — it is a build artifact.
- [ ] **Step 7: Full gate.** Run: `pnpm typecheck && pnpm test && pnpm build && pnpm -F @aipagego/extension build:demo`.
- [ ] **Step 8: Commit** — `git commit -m "feat(demo): build the demo into the site and embed it on the homepage"`

---

## Self-Review Notes

**Spec coverage.** Document layout → Tasks 6, 7. Three seams → Tasks 2, 3, 6. Chrome shim → Task 2. Tool bridge → Task 3. Scenario → Tasks 1, 4. Replay control and the honesty note → Task 7. Build and deployment → Task 8. Error handling → Task 7 (tool errors, reduced motion) and Task 8 (iframe fallback). Testing → per task.

**The probe is deliberately a task.** Task 5 produces no shipped code, but which component the demo mounts changes Task 6 and changes what the homepage may honestly claim. Discovering that after building the harness would mean rewriting both.

**Known risk.** If `AppShell` needs far more shim surface than expected, Task 5's fallback narrows the demo to the chat view. That is a smaller claim, and the spec and homepage copy must both be narrowed with it rather than left overstating.
