# Lucide Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 9 emoji / text-glyph icons in the sidepanel UI with lucide-react SVG icons for a consistent, professional look.

**Architecture:** Add `lucide-react` as a runtime dependency of `@aipagego/extension`. In three view files (header / input-toolbar / mention-picker), swap the emoji/glyph strings for lucide React components at a fixed pixel size (14 in header/toolbar, 12 in the compact mention-picker row). No new components, no wrapper abstraction, no behavior change. Existing tests are unaffected because they all assert on `aria-label` / `data-testid`, never on emoji text.

**Tech Stack:** React 18.3, lucide-react ^0.460, vitest 2 + happy-dom (existing pattern).

**Spec:** `docs/superpowers/specs/2026-06-15-lucide-icons-design.md`

---

## File Structure

**Files to modify:**

```
packages/extension/package.json                                   (Task 1 — add dep)
packages/extension/src/sidepanel/shell/header.tsx                 (Task 2 — 5 icons)
packages/extension/src/sidepanel/input/input-toolbar.tsx          (Task 3 — 2 icons)
packages/extension/src/sidepanel/input/mention-picker.tsx         (Task 4 — 2 icons)
```

No new files. No new tests (existing tests cover the click/aria behavior and don't assert on glyph text — verified by inspection of `tests/sidepanel/shell/header.test.tsx`, `tests/sidepanel/input/input-toolbar.test.tsx`, `tests/sidepanel/input/mention-picker.test.tsx`).

## Task ordering rationale

- **Task 1** installs the dep first so subsequent tasks compile.
- **Tasks 2-4** are independent per-file edits. Order is reading order in the UI (header → input toolbar → mention picker overlay).
- **Task 5** runs final verification across all 4 packages and confirms bundle stays sane.

---

## Task 1: Add lucide-react dependency

**Files:**
- Modify: `packages/extension/package.json`

- [ ] **Step 1: Add dependency entry**

Open `packages/extension/package.json`. Inside the `"dependencies"` object, after `"idb": "^8.0.0",`, add:

```json
    "lucide-react": "^0.460.0",
```

Final fragment should read:

```json
  "dependencies": {
    "@aipagego/shared": "workspace:*",
    "idb": "^8.0.0",
    "lucide-react": "^0.460.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    ...
  },
```

- [ ] **Step 2: Install**

Run from `/Users/attson/code/aipagego2`:

```bash
pnpm install
```

Expected: lucide-react resolved and added to `pnpm-lock.yaml`. No peer-dep warnings about React (lucide-react has loose peerDep on react ^16 || ^17 || ^18).

- [ ] **Step 3: Sanity import**

Run:

```bash
cd packages/extension && node -e "import('lucide-react').then(m => console.log(typeof m.Plus, typeof m.Settings))"
```

Expected output: `function function`

(If this fails because of ESM / module resolution, that's fine — the actual build/typecheck in later tasks is the authoritative check. Skip and proceed.)

- [ ] **Step 4: Typecheck**

Run from `/Users/attson/code/aipagego2`: `pnpm -r typecheck`

Expected: PASS (adding a dep without using it shouldn't break anything).

- [ ] **Step 5: Commit**

```bash
git add packages/extension/package.json /Users/attson/code/aipagego2/pnpm-lock.yaml
git commit -m "chore(deps): add lucide-react ^0.460.0 to extension"
```

---

## Task 2: Replace 5 icons in header.tsx

**Files:**
- Modify: `packages/extension/src/sidepanel/shell/header.tsx` (top imports + lines 30-34)

- [ ] **Step 1: Add lucide import**

Open `packages/extension/src/sidepanel/shell/header.tsx`. After the existing imports at the top, add:

```ts
import { Plus, History, Wrench, Settings, Bug } from "lucide-react";
```

Final import block should read:

```ts
import { useUi, type DrawerKind } from "../chat/ui-store";
import type { DebugBadge } from "../chat/session-store";
import { Plus, History, Wrench, Settings, Bug } from "lucide-react";
```

- [ ] **Step 2: Replace 5 IconBtn children**

Lines 30-34 currently read:

```tsx
          <IconBtn label="新会话" onClick={onNewChat}>＋</IconBtn>
          <IconBtn label="历史" onClick={() => open("history")}>⏱</IconBtn>
          <IconBtn label="工具库" onClick={() => open("tools")}>🧰</IconBtn>
          <IconBtn label="设置" onClick={() => open("settings")}>⚙</IconBtn>
          <IconBtn label="调试" onClick={() => open("debug")} badge={dot}>💭</IconBtn>
```

Replace with:

```tsx
          <IconBtn label="新会话" onClick={onNewChat}><Plus size={14} /></IconBtn>
          <IconBtn label="历史" onClick={() => open("history")}><History size={14} /></IconBtn>
          <IconBtn label="工具库" onClick={() => open("tools")}><Wrench size={14} /></IconBtn>
          <IconBtn label="设置" onClick={() => open("settings")}><Settings size={14} /></IconBtn>
          <IconBtn label="调试" onClick={() => open("debug")} badge={dot}><Bug size={14} /></IconBtn>
```

- [ ] **Step 3: Typecheck + run header tests**

Run from `/Users/attson/code/aipagego2`:

```bash
pnpm -r typecheck && cd packages/extension && pnpm test -- header
```

Expected: typecheck clean; header test suite passes (it selects buttons by `aria-label`, so SVG vs text content is irrelevant).

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/sidepanel/shell/header.tsx
git commit -m "feat(sidepanel): swap header emoji glyphs for lucide icons (Plus/History/Wrench/Settings/Bug)"
```

---

## Task 3: Replace 2 icons in input-toolbar.tsx

**Files:**
- Modify: `packages/extension/src/sidepanel/input/input-toolbar.tsx` (top imports + lines 111 and 120)

- [ ] **Step 1: Add lucide import**

Open `packages/extension/src/sidepanel/input/input-toolbar.tsx`. At the top of the file with the other imports, add:

```ts
import { Paperclip, Crosshair } from "lucide-react";
```

(Place it after the last existing `import` line — exact position doesn't matter as long as it's in the import block at the top.)

- [ ] **Step 2: Replace paperclip emoji (line 111)**

The current button at line 107-113:

```tsx
            <button
              type="button"
              aria-label="加图片"
              className="px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 text-[11px]"
              onClick={() => fileRef.current?.click()}
            >
              📎
            </button>
```

Change line 111 from `              📎` to:

```tsx
              <Paperclip size={14} />
```

- [ ] **Step 3: Replace bullseye emoji (line 120)**

The current button at line 114-122:

```tsx
            <button
              type="button"
              aria-label="选元素"
              title="点页面任意元素，selector 自动回填"
              className="px-2 py-1 rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 text-[11px]"
              onClick={props.onStartCapture}
            >
              🎯
            </button>
```

Change line 120 from `              🎯` to:

```tsx
              <Crosshair size={14} />
```

- [ ] **Step 4: Typecheck + run input-toolbar tests**

Run from `/Users/attson/code/aipagego2`:

```bash
pnpm -r typecheck && cd packages/extension && pnpm test -- input-toolbar
```

Expected: typecheck clean; input-toolbar test suite passes.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/input/input-toolbar.tsx
git commit -m "feat(sidepanel): swap input-toolbar emoji for lucide icons (Paperclip/Crosshair)"
```

---

## Task 4: Replace 2 icons in mention-picker.tsx

**Files:**
- Modify: `packages/extension/src/sidepanel/input/mention-picker.tsx` (top imports + line 173)

- [ ] **Step 1: Add lucide import**

Open `packages/extension/src/sidepanel/input/mention-picker.tsx`. At the top of the file with the other imports, add:

```ts
import { Sparkles, Wrench } from "lucide-react";
```

- [ ] **Step 2: Replace the conditional emoji**

Line 173 currently reads:

```tsx
                  <span>{it.v.matchesCurrentUrl ? "✨" : "🧰"}</span>
```

Change to:

```tsx
                  <span>{it.v.matchesCurrentUrl ? <Sparkles size={12} /> : <Wrench size={12} />}</span>
```

(Size is 12 here, not 14, because mention-picker rows are tighter — see spec §4.)

- [ ] **Step 3: Typecheck + run mention-picker tests**

Run from `/Users/attson/code/aipagego2`:

```bash
pnpm -r typecheck && cd packages/extension && pnpm test -- mention-picker
```

Expected: typecheck clean; mention-picker test suite passes (selectors are all `data-testid` based).

- [ ] **Step 4: Commit**

```bash
git add packages/extension/src/sidepanel/input/mention-picker.tsx
git commit -m "feat(sidepanel): swap mention-picker emoji for lucide icons (Sparkles/Wrench)"
```

---

## Task 5: Final verification (typecheck / tests / build / bundle delta)

**No file changes.** Pure verification before shipping.

- [ ] **Step 1: Full repo typecheck**

Run from `/Users/attson/code/aipagego2`: `pnpm -r typecheck`

Expected: 4 packages PASS.

- [ ] **Step 2: Full extension test suite**

Run: `cd packages/extension && pnpm test`

Expected: 87 files / 473 tests PASS (same baseline as quick-actions ship; this PR adds no tests, only modifies existing icons).

- [ ] **Step 3: Production build**

Run from `/Users/attson/code/aipagego2`: `pnpm build`

Expected: PASS, no warnings.

- [ ] **Step 4: Bundle size sanity check**

Compare the size of `packages/extension/dist/assets/index.html-*.js` (the largest chunk) before and after. The pre-change size from the last ship was `267.21 kB / gzip: 86.18 kB`. After this PR, expect gzip to grow by ~3-5KB (9 lucide icons) — anywhere from `86 → 91 kB` is sane. If gzip increase exceeds 15KB, investigate whether lucide-react's barrel import broke tree-shaking. Otherwise proceed.

To check, look at the last few lines of the `pnpm build` output:

```bash
pnpm build 2>&1 | grep "index.html-" | tail -1
```

- [ ] **Step 5: Branch state review**

Run: `git log --oneline main..HEAD`

Expected: 5 commits ahead of main:
- `docs: lucide-icons spec — replace 9 emoji/text-glyph UI icons` (already on branch from brainstorm)
- `chore(deps): add lucide-react ^0.460.0 to extension` (Task 1)
- `feat(sidepanel): swap header emoji glyphs for lucide icons (Plus/History/Wrench/Settings/Bug)` (Task 2)
- `feat(sidepanel): swap input-toolbar emoji for lucide icons (Paperclip/Crosshair)` (Task 3)
- `feat(sidepanel): swap mention-picker emoji for lucide icons (Sparkles/Wrench)` (Task 4)

If commits don't match, investigate before ship-release.

- [ ] **Step 6: Hand off to ship-release**

No commit at this task. Once these steps pass cleanly, the branch is ready for the `ship-release` skill to push, open the PR, squash-merge, and tag the next patch version.
