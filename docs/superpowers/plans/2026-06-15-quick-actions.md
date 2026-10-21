# Quick Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a row of 3 hardcoded "quick action" chips (`总结网页` / `抽取重点` / `抽评论`) to the sidepanel's empty conversation state that send a preset prompt when clicked.

**Architecture:** A single new presentational React component (`QuickActions`) with a hardcoded array of `{id, label, prompt}`. It's mounted in `app-shell.tsx`'s `emptyState` branch above `EmptySuggestions`, sharing a new outer wrapper so layout stays aligned. Click handler delegates to the existing `send(prompt: string) => Promise<void>` callback — same path as user-typed input.

**Tech Stack:** React 18, vitest 2 + happy-dom (existing pattern). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-15-quick-actions-design.md`

---

## File Structure

**New files:**

```
packages/extension/src/sidepanel/chat/quick-actions.tsx          (~30 lines)
packages/extension/tests/sidepanel/chat/quick-actions.test.tsx   (~50 lines)
```

**Files to modify:**

```
packages/extension/src/sidepanel/shell/app-shell.tsx             (Task 2)
packages/extension/src/sidepanel/chat/empty-suggestions.tsx      (Task 2)
```

## Task ordering rationale

- **Task 1** builds the new component standalone with its tests — works in isolation, no integration risk.
- **Task 2** does the integration: wires `QuickActions` into the emptyState branch and refactors the EmptySuggestions wrapper className so both components share one max-width container without visual stacking issues.
- **Task 3** runs the full repo verification (typecheck / tests / build) before commit and shipping.

---

## Task 1: QuickActions component + tests

**Files:**
- Create: `packages/extension/src/sidepanel/chat/quick-actions.tsx`
- Test: `packages/extension/tests/sidepanel/chat/quick-actions.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/sidepanel/chat/quick-actions.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QuickActions } from "@/sidepanel/chat/quick-actions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(node: React.ReactNode) {
  const c = document.createElement("div");
  document.body.appendChild(c);
  const r = createRoot(c);
  act(() => r.render(node));
  return {
    c,
    cleanup: () => {
      act(() => r.unmount());
      c.remove();
    },
  };
}

describe("QuickActions", () => {
  it("renders 3 chips with expected labels in order", () => {
    const { c, cleanup } = mount(<QuickActions onPick={() => {}} />);
    const buttons = c.querySelectorAll("button");
    expect(buttons.length).toBe(3);
    expect([...buttons].map((b) => b.textContent)).toEqual([
      "总结网页",
      "抽取重点",
      "抽评论",
    ]);
    cleanup();
  });

  it("calls onPick with the summarize prompt", () => {
    const onPick = vi.fn();
    const { c, cleanup } = mount(<QuickActions onPick={onPick} />);
    const btn = c.querySelectorAll("button")[0] as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    expect(onPick).toHaveBeenCalledOnce();
    expect(onPick.mock.calls[0][0] as string).toContain("总结");
    cleanup();
  });

  it("calls onPick with the key-points prompt mentioning 5 items", () => {
    const onPick = vi.fn();
    const { c, cleanup } = mount(<QuickActions onPick={onPick} />);
    const btn = c.querySelectorAll("button")[1] as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    const arg = onPick.mock.calls[0][0] as string;
    expect(arg).toContain("关键");
    expect(arg).toContain("5");
    cleanup();
  });

  it("calls onPick with the extract-comments prompt mentioning pagination", () => {
    const onPick = vi.fn();
    const { c, cleanup } = mount(<QuickActions onPick={onPick} />);
    const btn = c.querySelectorAll("button")[2] as HTMLButtonElement;
    act(() => {
      btn.click();
    });
    const arg = onPick.mock.calls[0][0] as string;
    expect(arg).toContain("评论");
    expect(arg).toMatch(/翻页|滚动/);
    cleanup();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- quick-actions`

Expected: FAIL — module not found at `@/sidepanel/chat/quick-actions`.

- [ ] **Step 3: Implement QuickActions**

Create `packages/extension/src/sidepanel/chat/quick-actions.tsx`:

```tsx
type Action = { id: string; label: string; prompt: string };

const ACTIONS: Action[] = [
  {
    id: "summarize",
    label: "总结网页",
    prompt: "总结一下当前网页的主要内容。",
  },
  {
    id: "key-points",
    label: "抽取重点",
    prompt: "把这个网页的关键信息抽出成 5 条。",
  },
  {
    id: "extract-comments",
    label: "抽评论",
    prompt:
      "把本页所有评论 / 回复抽下来，完整拉取不要省略。" +
      "如果存在分页或下拉懒加载，请翻页 / 滚动到底，直到拿全所有评论再返回。",
  },
];

type Props = { onPick: (prompt: string) => void };

export function QuickActions({ onPick }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5 justify-center mb-3">
      {ACTIONS.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onPick(a.prompt)}
          className="px-2.5 py-1 rounded-full border border-zinc-700 bg-zinc-900 text-zinc-300 text-[11px] hover:bg-zinc-800 hover:border-zinc-600"
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- quick-actions`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/sidepanel/chat/quick-actions.tsx \
        packages/extension/tests/sidepanel/chat/quick-actions.test.tsx
git commit -m "feat(sidepanel): add QuickActions component (3 preset chips)"
```

---

## Task 2: Wire QuickActions into app-shell + EmptySuggestions className refactor

**Files:**
- Modify: `packages/extension/src/sidepanel/shell/app-shell.tsx` (add import; wrap emptyState branch)
- Modify: `packages/extension/src/sidepanel/chat/empty-suggestions.tsx:32` (drop duplicate width classes)

- [ ] **Step 1: Refactor EmptySuggestions outer wrapper**

Open `packages/extension/src/sidepanel/chat/empty-suggestions.tsx`. The component's root `<div>` (line 32) is currently:

```tsx
    <div className="m-auto max-w-[280px] text-center">
```

Change it to:

```tsx
    <div className="text-center">
```

(Removes `m-auto max-w-[280px]` — these will live on the new outer wrapper in app-shell so QuickActions and EmptySuggestions share one centered column.)

- [ ] **Step 2: Update empty-suggestions tests if they depend on the removed classes**

Run: `cd packages/extension && pnpm test -- empty-suggestions`

Expected: PASS — the existing tests assert on text content and structure, not on these utility classes. If they unexpectedly fail, inspect and fix only the className-coupled assertions; don't change behavior. If they pass, proceed.

- [ ] **Step 3: Add QuickActions import in app-shell.tsx**

Open `packages/extension/src/sidepanel/shell/app-shell.tsx`. Locate the existing import:

```tsx
import { EmptySuggestions, type SuggestedTool } from "@/sidepanel/chat/empty-suggestions";
```

Immediately after it, add:

```tsx
import { QuickActions } from "@/sidepanel/chat/quick-actions";
```

- [ ] **Step 4: Wrap the emptyState branch with shared centered container**

In `app-shell.tsx` find the emptyState JSX (around line 575):

```tsx
        {emptyState ? (
          <EmptySuggestions
            matchedTools={toSuggested(recommendations)}
            onRun={(id) => ui.open("tools", id)}
            onDetail={openToolDetail}
          />
        ) : (
```

Change it to:

```tsx
        {emptyState ? (
          <div className="m-auto max-w-[280px]">
            <QuickActions onPick={(prompt) => void send(prompt)} />
            <EmptySuggestions
              matchedTools={toSuggested(recommendations)}
              onRun={(id) => ui.open("tools", id)}
              onDetail={openToolDetail}
            />
          </div>
        ) : (
```

The new outer `<div>` carries the `m-auto max-w-[280px]` that previously lived on EmptySuggestions' inner div. `text-center` stays on EmptySuggestions' inner div (so its own text continues to center) while QuickActions uses its own `justify-center` from Task 1.

- [ ] **Step 5: Repo typecheck + extension tests**

Run from `/Users/attson/code/aipagego2`:

```bash
pnpm -r typecheck && cd packages/extension && pnpm test
```

Expected: typecheck clean across all 4 packages; vitest 100% pass (existing + 4 new QuickActions tests + unaffected empty-suggestions tests).

If typecheck fails on `app-shell.tsx`: most likely `send` has a different signature than `(prompt: string) => Promise<void>`. Verify by reading `app-shell.tsx:273-275`. The expected signature is:

```tsx
const send = useCallback(
  async (prompt: string) => { ... },
  [...]
);
```

`(prompt) => void send(prompt)` correctly fires-and-forgets the promise. If `send` actually takes more arguments (it shouldn't), stop and report — that's a spec mismatch.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/sidepanel/shell/app-shell.tsx \
        packages/extension/src/sidepanel/chat/empty-suggestions.tsx
git commit -m "feat(sidepanel): wire QuickActions above EmptySuggestions in empty state"
```

---

## Task 3: Final verification (typecheck / tests / build)

**No file changes.** Pure verification before shipping.

- [ ] **Step 1: Full repo typecheck**

Run from `/Users/attson/code/aipagego2`: `pnpm -r typecheck`

Expected: 4 packages PASS (shared, extension, coordinator, mcp-server).

- [ ] **Step 2: Full extension test suite**

Run: `cd packages/extension && pnpm test`

Expected: all suites pass (existing + 4 new QuickActions tests). Confirm test count went up by 4 vs the baseline (`469 + 4 = 473`, or similar — exact baseline depends on what's on main right now).

- [ ] **Step 3: Production build**

Run from `/Users/attson/code/aipagego2`: `pnpm build`

Expected: PASS. `packages/extension/dist/` regenerates without warnings.

- [ ] **Step 4: Branch state review**

Run: `git log --oneline main..HEAD`

Expected: 3 commits ahead of main:
- `docs: quick-actions spec — 3 内置快捷 chip on empty state` (already exists on branch from brainstorm)
- `feat(sidepanel): add QuickActions component (3 preset chips)` (Task 1)
- `feat(sidepanel): wire QuickActions above EmptySuggestions in empty state` (Task 2)

If commit count differs, investigate before proceeding to ship-release.

- [ ] **Step 5: Hand off to ship-release**

No commit at this task; verification only. Once these steps pass cleanly, the branch is ready for the `ship-release` skill to push, open the PR, squash-merge, and tag the next patch version.
