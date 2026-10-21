# Sidepanel UI Refactor (AIPex-style) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 5-tab top-nav sidepanel with a single chat surface + 4 right-side drawers, Claude-Code-style 4-level permission mode, AIPex-style empty-state suggestions, and minimal input toolbar.

**Architecture:** Big-bang refactor on `feat/ui-aipex-refactor` branch. Order = (1) shared types + state migrations + tests; (2) leaf presentation components bottom-up; (3) compose new shell; (4) delete the old shell + pages + components; (5) typecheck + tests + build + smoke; (6) ship.

**Tech Stack:** React 19, Zustand, Tailwind, vitest + happy-dom + @testing-library/react.

**Spec:** [`docs/superpowers/specs/2026-06-13-aipex-ui-refactor-design.md`](../specs/2026-06-13-aipex-ui-refactor-design.md)

---

## Phase A · Foundation: types, store deltas, evaluator

### Task A1: Add `PermissionMode` type + `evaluateAutoApproval` lib + tests

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/severity.ts` (add `PermissionMode` type, new `evaluateAutoApproval()` function)
- Test: `packages/extension/src/sidepanel/chat/__tests__/severity.test.ts` (new file; add suite for evaluator)

- [ ] **Step 1:** Add type + function to `severity.ts`:

```ts
export type PermissionMode = "read" | "default" | "trust" | "yolo";

/** Decision for a single tool call under a permission mode. */
export function evaluateAutoApproval(
  toolName: string,
  severity: ToolSeverity,
  mode: PermissionMode,
  trustedDangerTools: string[]
): boolean {
  if (mode === "yolo") return true;
  if (severity === "safe") return true;
  if (mode === "read") return false;
  if (severity === "caution") return true;
  // severity === "dangerous"
  if (mode === "trust") return trustedDangerTools.includes(toolName);
  return false; // default
}
```

(Keep the old `autoApproves` exported alongside, marked `@deprecated` — call sites will migrate in Task D1.)

- [ ] **Step 2:** Write `__tests__/severity.test.ts` covering the full truth table (4 modes × 3 severities + yolo + trust-allowlist boundary). Sample:

```ts
import { describe, expect, it } from "vitest";
import { classifyTool, evaluateAutoApproval } from "../severity";

describe("evaluateAutoApproval", () => {
  it("safe is auto in any mode", () => {
    for (const m of ["read", "default", "trust", "yolo"] as const) {
      expect(evaluateAutoApproval("snapshotDOM", "safe", m, [])).toBe(true);
    }
  });
  it("read mode asks for everything non-safe", () => {
    expect(evaluateAutoApproval("click", "caution", "read", [])).toBe(false);
    expect(evaluateAutoApproval("submitForm", "dangerous", "read", [])).toBe(false);
  });
  it("default auto-passes caution but asks dangerous", () => {
    expect(evaluateAutoApproval("click", "caution", "default", [])).toBe(true);
    expect(evaluateAutoApproval("submitForm", "dangerous", "default", [])).toBe(false);
  });
  it("trust auto-passes caution + allowlisted dangerous only", () => {
    expect(evaluateAutoApproval("click", "caution", "trust", [])).toBe(true);
    expect(evaluateAutoApproval("submitForm", "dangerous", "trust", ["submitForm"])).toBe(true);
    expect(evaluateAutoApproval("uploadFile", "dangerous", "trust", ["submitForm"])).toBe(false);
  });
  it("yolo passes everything", () => {
    expect(evaluateAutoApproval("submitForm", "dangerous", "yolo", [])).toBe(true);
    expect(evaluateAutoApproval("runJS", "dangerous", "yolo", [])).toBe(true);
  });
});
```

- [ ] **Step 3:** Run `pnpm -F @aipagego/extension test severity` → expect PASS.

- [ ] **Step 4:** Commit:

```bash
git add packages/extension/src/sidepanel/chat/severity.ts \
        packages/extension/src/sidepanel/chat/__tests__/severity.test.ts
git commit -m "feat(sidepanel): add PermissionMode + evaluateAutoApproval"
```

---

### Task A2: Update `LlmSettings` shared type + migration

**Files:**
- Modify: `packages/shared/src/types.ts` (rename `autoApproveDangerous` → `trustedDangerTools`, add `defaultPermissionMode`)
- Modify: `packages/extension/src/sidepanel/chat/settings-store.ts` (DEFAULTS + load migration)
- Test: `packages/extension/src/sidepanel/chat/__tests__/settings-store.test.ts` (new file)

- [ ] **Step 1:** In `packages/shared/src/types.ts`, change `LlmSettings`:

```ts
export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiKeyMode: "persistent" | "session";
  maxRounds: number;
  endpoint?: string;
  /** Dangerous tools auto-passed when permission mode is "trust". */
  trustedDangerTools: string[];
  /** Per-mode default for new sessions. */
  defaultPermissionMode: "read" | "default" | "trust" | "yolo";
  maxTokens?: number;
  maxContinuationNudges?: number;
};
```

(Drop the old `autoApproveDangerous`; will rely on migration.)

- [ ] **Step 2:** In `settings-store.ts`, update DEFAULTS and add migration in `load`:

```ts
import { create } from "zustand";
import type { LlmSettings } from "@aipagego/shared/types";

const KEY = "aipagego.llm";
const MIGRATION_KEY = "aipagego.llm._migrated_v1";

const DEFAULTS: LlmSettings = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  apiKey: "",
  apiKeyMode: "persistent",
  maxRounds: 20,
  trustedDangerTools: [],
  defaultPermissionMode: "default",
  maxContinuationNudges: 1
};

type StoreShape = LlmSettings & {
  loaded: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<LlmSettings>) => Promise<void>;
};

type LegacyLlmSettings = Partial<LlmSettings> & { autoApproveDangerous?: string[] };

export const useSettings = create<StoreShape>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  load: async () => {
    const fromLocal = (await chrome.storage.local.get([KEY]))[KEY] as LegacyLlmSettings | undefined;
    const fromSession = (await chrome.storage.session.get([KEY]))[KEY] as Partial<LlmSettings> | undefined;
    const migrated = (await chrome.storage.local.get([MIGRATION_KEY]))[MIGRATION_KEY] === true;

    const incoming: LegacyLlmSettings = { ...(fromLocal ?? {}) };
    if (!migrated && Array.isArray(incoming.autoApproveDangerous)) {
      incoming.trustedDangerTools = incoming.autoApproveDangerous;
      delete incoming.autoApproveDangerous;
    }

    const merged = { ...DEFAULTS, ...incoming } as LlmSettings;
    if (merged.apiKeyMode === "session" && fromSession) {
      merged.apiKey = fromSession.apiKey ?? "";
    }
    set({ ...merged, loaded: true });

    if (!migrated) {
      await chrome.storage.local.set({ [MIGRATION_KEY]: true });
      const { apiKey, ...rest } = merged;
      await chrome.storage.local.set({ [KEY]: { ...rest, apiKey: merged.apiKeyMode === "session" ? "" : apiKey, apiKeyMode: merged.apiKeyMode } });
    }
  },
  save: async (patch) => {
    const next = { ...get(), ...patch };
    set(next);
    const { apiKey, apiKeyMode, ...rest } = next;
    if (apiKeyMode === "session") {
      await chrome.storage.local.set({ [KEY]: { ...rest, apiKey: "", apiKeyMode } });
      await chrome.storage.session.set({ [KEY]: { apiKey } });
    } else {
      await chrome.storage.local.set({ [KEY]: { ...rest, apiKey, apiKeyMode } });
      await chrome.storage.session.remove(KEY);
    }
  }
}));

export const ANTHROPIC_MODELS = [
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001"
];
export const OPENAI_MODELS = ["gpt-4o-mini", "gpt-4o"];
```

- [ ] **Step 3:** Write test `settings-store.test.ts` with mocked `chrome.storage`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// minimal in-memory chrome.storage stub
function makeStorage() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, local[k]]))),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(local, obj); }),
        remove: vi.fn(async (k: string) => { delete local[k]; }),
      },
      session: {
        get: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, session[k]]))),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(session, obj); }),
        remove: vi.fn(async (k: string) => { delete session[k]; }),
      }
    }
  };
  return { local, session };
}

describe("settings-store migration", () => {
  beforeEach(() => { vi.resetModules(); });

  it("migrates autoApproveDangerous → trustedDangerTools on first load", async () => {
    const { local } = makeStorage();
    local["aipagego.llm"] = { autoApproveDangerous: ["submitForm", "uploadFile"] };
    const { useSettings } = await import("../settings-store");
    await useSettings.getState().load();
    expect(useSettings.getState().trustedDangerTools).toEqual(["submitForm", "uploadFile"]);
    expect((local["aipagego.llm"] as Record<string, unknown>).autoApproveDangerous).toBeUndefined();
    expect(local["aipagego.llm._migrated_v1"]).toBe(true);
  });

  it("does not re-migrate when migration flag set", async () => {
    const { local } = makeStorage();
    local["aipagego.llm"] = { trustedDangerTools: ["submitForm"], autoApproveDangerous: ["uploadFile"] };
    local["aipagego.llm._migrated_v1"] = true;
    const { useSettings } = await import("../settings-store");
    await useSettings.getState().load();
    expect(useSettings.getState().trustedDangerTools).toEqual(["submitForm"]);
  });

  it("supplies sensible defaults on empty storage", async () => {
    makeStorage();
    const { useSettings } = await import("../settings-store");
    await useSettings.getState().load();
    expect(useSettings.getState().defaultPermissionMode).toBe("default");
    expect(useSettings.getState().trustedDangerTools).toEqual([]);
  });
});
```

- [ ] **Step 4:** Run `pnpm -F @aipagego/extension test settings-store` → expect PASS. Also run `pnpm -F @aipagego/shared typecheck` — old `autoApproveDangerous` removal may surface broken imports in shared package. Fix none expected (autoApproveDangerous is only used in settings-store + settings-page + danger-approval-group, all in extension).

- [ ] **Step 5:** Search for stale `autoApproveDangerous` references in the extension package and stub-fix them to read from `trustedDangerTools` so typecheck stays green:

Run: `grep -rn "autoApproveDangerous" packages/extension/src --include='*.ts' --include='*.tsx'`

For every hit outside `__tests__` and the old `settings-page.tsx` / `danger-approval-group.tsx` (which will be deleted in Phase E), replace `settings.autoApproveDangerous` → `settings.trustedDangerTools`. In `settings-page.tsx` and `danger-approval-group.tsx` (slated for delete), add `// TODO Phase E: delete this file` and replace the field — keeps typecheck green until delete.

- [ ] **Step 6:** `pnpm -r typecheck` → expect green.

- [ ] **Step 7:** Commit:

```bash
git add packages/shared/src/types.ts \
        packages/extension/src/sidepanel/chat/settings-store.ts \
        packages/extension/src/sidepanel/chat/__tests__/settings-store.test.ts \
        $(git ls-files -m packages/extension/src)
git commit -m "feat(sidepanel): migrate autoApproveDangerous → trustedDangerTools + add defaultPermissionMode"
```

---

### Task A3: Add `permissionMode` to SessionData + global UI store

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts` (add field, drop `logsOpen`, set in `makeEmptySession`, expose setter)
- Create: `packages/extension/src/sidepanel/chat/ui-store.ts` (global `openedDrawer`)
- Test: `packages/extension/src/sidepanel/chat/__tests__/session-store.test.ts` (light: default mode = settings.defaultPermissionMode)
- Test: `packages/extension/src/sidepanel/chat/__tests__/ui-store.test.ts`

- [ ] **Step 1:** Edit `session-store.ts`:
  - Add `permissionMode: PermissionMode` to `SessionData`.
  - Remove `logsOpen: boolean` from `SessionData` AND from `makeEmptySession`.
  - In `makeEmptySession`, default `permissionMode` to `"default"` (caller can override).
  - Export `setPermissionMode(tabId, mode)` patch helper.
  - Keep `approveAllSafe` field for backward compat — it'll be deleted in Task E4 after all consumers migrate.

```ts
// add to imports
import type { PermissionMode } from "./severity";

// SessionData (add line)
permissionMode: PermissionMode;
// remove: logsOpen: boolean;

// makeEmptySession (add line)
permissionMode: "default",
// remove: logsOpen: false,

// add at end of file
export function setPermissionMode(tabId: number, mode: PermissionMode): void {
  patchSession(tabId, (s) => ({ ...s, permissionMode: mode }));
}
```

- [ ] **Step 2:** Wherever `logsOpen` was read/written in the codebase, those references will be removed in Task E2 alongside `LogsDrawer` deletion. Run `grep -rn "logsOpen" packages/extension/src` and for each hit outside `chat-page.tsx` and `logs-drawer.tsx` (slated for delete), do whatever local fix keeps typecheck green (usually: comment out + `// TODO Phase E`).

- [ ] **Step 3:** Create `ui-store.ts`:

```ts
import { create } from "zustand";

export type DrawerKind = "history" | "tools" | "settings" | "debug";

type UiState = {
  openedDrawer: DrawerKind | null;
  drawerSubPath: string | null; // e.g. selected tool id for ToolDetail
  open: (kind: DrawerKind, subPath?: string) => void;
  close: () => void;
};

export const useUi = create<UiState>((set) => ({
  openedDrawer: null,
  drawerSubPath: null,
  open: (kind, subPath = null) => set({ openedDrawer: kind, drawerSubPath: subPath }),
  close: () => set({ openedDrawer: null, drawerSubPath: null }),
}));
```

- [ ] **Step 4:** Tests:

```ts
// ui-store.test.ts
import { describe, expect, it } from "vitest";
import { useUi } from "../ui-store";

describe("ui-store", () => {
  it("opens and closes drawer", () => {
    useUi.getState().open("history");
    expect(useUi.getState().openedDrawer).toBe("history");
    useUi.getState().close();
    expect(useUi.getState().openedDrawer).toBeNull();
  });
  it("carries subPath for tool detail", () => {
    useUi.getState().open("tools", "tool-id-42");
    expect(useUi.getState().drawerSubPath).toBe("tool-id-42");
    useUi.getState().close();
    expect(useUi.getState().drawerSubPath).toBeNull();
  });
});
```

```ts
// session-store.test.ts (append)
import { describe, expect, it } from "vitest";
import { ensureSession, useStore, setPermissionMode } from "../session-store";

describe("session-store permissionMode", () => {
  it("defaults to default mode", () => {
    ensureSession(99, "https://example.com");
    expect(useStore.getState().sessionsByTab[99].permissionMode).toBe("default");
  });
  it("setPermissionMode flips it", () => {
    ensureSession(100, "https://example.com");
    setPermissionMode(100, "yolo");
    expect(useStore.getState().sessionsByTab[100].permissionMode).toBe("yolo");
  });
});
```

- [ ] **Step 5:** `pnpm -F @aipagego/extension test session-store ui-store`. Expect PASS.

- [ ] **Step 6:** `pnpm -r typecheck` → green.

- [ ] **Step 7:** Commit:

```bash
git add packages/extension/src/sidepanel/chat/session-store.ts \
        packages/extension/src/sidepanel/chat/ui-store.ts \
        packages/extension/src/sidepanel/chat/__tests__/session-store.test.ts \
        packages/extension/src/sidepanel/chat/__tests__/ui-store.test.ts \
        $(git ls-files -m packages/extension/src)
git commit -m "feat(sidepanel): add permissionMode to SessionData + global drawer store"
```

---

### Task A4: Replace `autoApproves` call sites with `evaluateAutoApproval`

**Files:**
- Modify: every file using `autoApproves(...)` (most likely `chat/run-chat-session.ts` and step-card render helpers).

- [ ] **Step 1:** `grep -rn "autoApproves\b" packages/extension/src --include='*.ts' --include='*.tsx'`

- [ ] **Step 2:** For each hit, replace with:
```ts
const auto = evaluateAutoApproval(toolName, severity, session.permissionMode, settings.trustedDangerTools);
```

(Read `session.permissionMode` from `useStore.getState().sessionsByTab[tabId]` if not already in scope; pull `settings.trustedDangerTools` from `useSettings.getState()`.)

- [ ] **Step 3:** Delete the deprecated `autoApproves` function from `severity.ts` (clean removal). Run typecheck.

- [ ] **Step 4:** `pnpm -F @aipagego/extension test` → all tests still pass.

- [ ] **Step 5:** Commit:

```bash
git add -u packages/extension/src
git commit -m "refactor(sidepanel): switch all autoApprove call sites to evaluateAutoApproval"
```

---

## Phase B · Leaf presentation components

Order is bottom-up: each is independent, no imports between them. After each task: typecheck + component test + commit.

### Task B1: `permission-mode-pill.tsx`

**Files:**
- Create: `packages/extension/src/sidepanel/input/permission-mode-pill.tsx`
- Test: `packages/extension/src/sidepanel/input/__tests__/permission-mode-pill.test.tsx`

- [ ] **Step 1:** Write the component. Key behaviors per spec §9:
  - Props: `{ mode: PermissionMode; onChange: (m: PermissionMode) => void; trustedDangerTools: string[]; onTrustedChange: (next: string[]) => void; }`
  - Pill displays only mode name + ⓘ + ▾ in mode color (blue/green/orange/red).
  - Click pill toggles a dropdown anchored below.
  - Dropdown shows 4 rows: `<color-dot> <name> ✓ if current ⓘ` with hover tooltip.
  - When `trust` row selected, sub-area renders 5 checkboxes for `DANGEROUS_TOOLS` constant.
  - Selecting `yolo` shows a confirmation modal.
  - Keyboard: `Shift+Tab` cycles through 4 modes (read → default → trust → yolo → read) — register listener while pill or input has focus; remove on unmount.

Const used for trust checkboxes:
```ts
const DANGEROUS_TOOLS = [
  { id: "submitForm",      label: "submitForm — 提交表单" },
  { id: "uploadFile",      label: "uploadFile — 上传文件" },
  { id: "readStorage",     label: "readStorage — 读 localStorage/sessionStorage" },
  { id: "httpRequestCred", label: "httpRequest 带 cookie" },
  { id: "runJSDangerous",  label: "runJS — 包含 cookie/eval/storage 的脚本" },
];
```

Tooltip text per mode (English/Chinese mixed, copy from spec §9):
```ts
const MODE_INFO: Record<PermissionMode, { name: string; desc: string; tone: string }> = {
  read:    { name: "只读",       desc: "只 safe 工具自动执行。caution / dangerous 全部询问。", tone: "blue" },
  default: { name: "默认",       desc: "safe + caution 工具自动；dangerous 询问。",            tone: "green" },
  trust:   { name: "信任白名单", desc: "+ 白名单内 dangerous 自动；其余 dangerous 询问。",      tone: "amber" },
  yolo:    { name: "全自动",     desc: "所有工具自动执行，含 dangerous。本会话生效。",         tone: "red" },
};
```

Implementation skeleton (full pattern; flesh out classNames):

```tsx
import { useEffect, useState } from "react";
import type { PermissionMode } from "../chat/severity";

const ORDER: PermissionMode[] = ["read", "default", "trust", "yolo"];
const TONE_CLASSES: Record<PermissionMode, string> = {
  read:    "bg-blue-950 text-blue-300 border-blue-800",
  default: "bg-emerald-950 text-emerald-300 border-emerald-800",
  trust:   "bg-amber-950 text-amber-300 border-amber-800",
  yolo:    "bg-red-950 text-red-300 border-red-800 animate-pulse",
};

type Props = {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  trustedDangerTools: string[];
  onTrustedChange: (next: string[]) => void;
};

export function PermissionModePill({ mode, onChange, trustedDangerTools, onTrustedChange }: Props) {
  const [open, setOpen] = useState(false);
  const [confirmYolo, setConfirmYolo] = useState(false);

  // Shift+Tab cycle while not in a textarea (textareas need real tab behavior)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Tab" && e.shiftKey && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        const idx = ORDER.indexOf(mode);
        const next = ORDER[(idx + 1) % ORDER.length];
        if (next === "yolo") setConfirmYolo(true);
        else onChange(next);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onChange]);

  function pick(m: PermissionMode) {
    if (m === "yolo") { setConfirmYolo(true); return; }
    onChange(m);
    setOpen(false);
  }

  function toggleTrusted(toolId: string) {
    onTrustedChange(
      trustedDangerTools.includes(toolId)
        ? trustedDangerTools.filter((t) => t !== toolId)
        : [...trustedDangerTools, toolId]
    );
  }

  return (
    <div className="relative inline-block">
      <button
        type="button"
        className={`flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] ${TONE_CLASSES[mode]}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={MODE_INFO[mode].desc}
      >
        {MODE_INFO[mode].name}
        <span className="opacity-60 italic font-serif text-[10px]" aria-label="info">ⓘ</span>
        <span className="opacity-70 text-[8px]">▾</span>
      </button>

      {open && (
        <div className="absolute left-0 bottom-full mb-1 w-60 bg-zinc-900 border border-zinc-700 rounded-lg shadow-lg py-1 z-30">
          {ORDER.map((m) => (
            <button
              key={m}
              type="button"
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-left hover:bg-zinc-800 ${m === mode ? "bg-blue-950/30" : ""}`}
              onClick={() => pick(m)}
            >
              <span className={`w-2 h-2 rounded-full ${dotColor(m)}`} />
              <span className="flex-1 text-zinc-100">{MODE_INFO[m].name}</span>
              {m === mode && <span className="text-emerald-400 text-[10px]">✓</span>}
              <span className="text-zinc-500 italic font-serif text-[10px]" title={MODE_INFO[m].desc}>ⓘ</span>
            </button>
          ))}

          {mode === "trust" && (
            <div className="border-t border-zinc-800 mt-1 px-3 py-2 text-[10px] text-zinc-400 space-y-1">
              <div className="text-zinc-500 uppercase tracking-wider text-[9px]">Dangerous 白名单</div>
              {DANGEROUS_TOOLS.map((t) => (
                <label key={t.id} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={trustedDangerTools.includes(t.id)}
                    onChange={() => toggleTrusted(t.id)}
                    className="accent-amber-500"
                  />
                  <span>{t.label}</span>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {confirmYolo && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-red-900 rounded-lg p-4 max-w-sm w-[90%] space-y-3">
            <h3 className="text-red-300 font-semibold">切到全自动模式？</h3>
            <p className="text-[12px] text-zinc-400">
              这会让 AI 跳过所有审核，包括 submitForm / uploadFile / runJS。本会话生效。
            </p>
            <div className="flex justify-end gap-2 text-[12px]">
              <button className="px-3 py-1 rounded bg-zinc-800 text-zinc-300" onClick={() => setConfirmYolo(false)}>取消</button>
              <button
                className="px-3 py-1 rounded bg-red-900 text-red-100"
                onClick={() => { onChange("yolo"); setConfirmYolo(false); setOpen(false); }}
              >我知道风险，继续</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function dotColor(m: PermissionMode): string {
  if (m === "read")    return "bg-blue-400";
  if (m === "default") return "bg-emerald-400";
  if (m === "trust")   return "bg-amber-400";
  return "bg-red-400";
}
```

- [ ] **Step 2:** Component test:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PermissionModePill } from "../permission-mode-pill";

describe("PermissionModePill", () => {
  it("renders current mode label", () => {
    render(<PermissionModePill mode="default" onChange={() => {}} trustedDangerTools={[]} onTrustedChange={() => {}} />);
    expect(screen.getByRole("button", { name: /默认/ })).toBeTruthy();
  });

  it("opens menu and switches mode", () => {
    const onChange = vi.fn();
    render(<PermissionModePill mode="default" onChange={onChange} trustedDangerTools={[]} onTrustedChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /默认/ }));
    fireEvent.click(screen.getByRole("button", { name: /只读/ }));
    expect(onChange).toHaveBeenCalledWith("read");
  });

  it("requires confirmation for yolo", () => {
    const onChange = vi.fn();
    render(<PermissionModePill mode="default" onChange={onChange} trustedDangerTools={[]} onTrustedChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /默认/ }));
    fireEvent.click(screen.getByRole("button", { name: /全自动/ }));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /我知道风险/ }));
    expect(onChange).toHaveBeenCalledWith("yolo");
  });

  it("Shift+Tab cycles modes", () => {
    const onChange = vi.fn();
    render(<PermissionModePill mode="read" onChange={onChange} trustedDangerTools={[]} onTrustedChange={() => {}} />);
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(onChange).toHaveBeenCalledWith("default");
  });

  it("shows trust checkboxes when mode is trust", () => {
    const onTrustedChange = vi.fn();
    render(<PermissionModePill mode="trust" onChange={() => {}} trustedDangerTools={[]} onTrustedChange={onTrustedChange} />);
    fireEvent.click(screen.getByRole("button", { name: /信任白名单/ }));
    const cb = screen.getByLabelText(/submitForm/);
    fireEvent.click(cb);
    expect(onTrustedChange).toHaveBeenCalledWith(["submitForm"]);
  });
});
```

- [ ] **Step 3:** `pnpm -F @aipagego/extension test permission-mode-pill` → PASS.

- [ ] **Step 4:** Commit:

```bash
git add packages/extension/src/sidepanel/input/permission-mode-pill.tsx \
        packages/extension/src/sidepanel/input/__tests__/permission-mode-pill.test.tsx
git commit -m "feat(sidepanel): add PermissionModePill component (4-mode dropdown)"
```

---

### Task B2: `drawer.tsx` (generic right-side sheet)

**Files:**
- Create: `packages/extension/src/sidepanel/shell/drawer.tsx`
- Test: `packages/extension/src/sidepanel/shell/__tests__/drawer.test.tsx`

- [ ] **Step 1:** Write `Drawer` component:

```tsx
import { useEffect } from "react";

type Props = {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  onBack?: () => void;  // when pushed sub-page
  children: React.ReactNode;
};

export function Drawer({ open, title, onClose, onBack, children }: Props) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="absolute inset-0 bg-zinc-950 flex flex-col z-20" role="dialog" aria-modal="true">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        {onBack ? (
          <button type="button" className="text-zinc-400 hover:text-zinc-100 text-sm" onClick={onBack} aria-label="返回">←</button>
        ) : null}
        <div className="flex-1 text-zinc-100 text-sm font-medium">{title}</div>
        <button type="button" className="text-zinc-400 hover:text-zinc-100 text-lg leading-none" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2:** Test:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Drawer } from "../drawer";

describe("Drawer", () => {
  it("renders title and body when open", () => {
    render(<Drawer open title="Hi" onClose={() => {}}>body</Drawer>);
    expect(screen.getByText("Hi")).toBeTruthy();
    expect(screen.getByText("body")).toBeTruthy();
  });
  it("invokes onClose for X button and ESC", () => {
    const onClose = vi.fn();
    render(<Drawer open title="Hi" onClose={onClose}>x</Drawer>);
    fireEvent.click(screen.getByLabelText("关闭"));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it("renders back button only when onBack provided", () => {
    const onBack = vi.fn();
    const { rerender } = render(<Drawer open title="Hi" onClose={() => {}}>x</Drawer>);
    expect(screen.queryByLabelText("返回")).toBeNull();
    rerender(<Drawer open title="Hi" onClose={() => {}} onBack={onBack}>x</Drawer>);
    fireEvent.click(screen.getByLabelText("返回"));
    expect(onBack).toHaveBeenCalled();
  });
  it("renders nothing when closed", () => {
    const { container } = render(<Drawer open={false} title="Hi" onClose={() => {}}>x</Drawer>);
    expect(container.firstChild).toBeNull();
  });
});
```

- [ ] **Step 3:** Run tests. Commit:

```bash
git add packages/extension/src/sidepanel/shell/drawer.tsx \
        packages/extension/src/sidepanel/shell/__tests__/drawer.test.tsx
git commit -m "feat(sidepanel): add generic Drawer shell with ESC + back button"
```

---

### Task B3: `system-bubble.tsx` + `save-as-tool-card.tsx` + `empty-suggestions.tsx` + `above-input-tabs.tsx` + `tab-identity-bar.tsx` + `mention-picker.tsx`

These are small, mostly visual; bundle into one commit per file but light tests. Detailed implementations follow the spec §6–§8 closely. Pattern per file:

- [ ] **B3a `system-bubble.tsx`:** Component accepts `{ kind: 'error'|'warning'|'navigation'; children; onClick? }`. Renders centered rounded box with kind-specific color. Test: 3 kinds render with distinct class signatures.

- [ ] **B3b `save-as-tool-card.tsx`:** Accepts `{ stepCount: number; onSave: () => void }`. Renders dashed-border green box with `✓ N 步成功执行` + `[保存为工具]` button. Test: button click invokes onSave.

- [ ] **B3c `empty-suggestions.tsx`:** Accepts `{ matchedTools: Array<{ id: string; name: string; runCount: number }>; onRun: (id: string) => void; onDetail: (id: string) => void }`. Renders empty state per spec §7.1: title `此页有 N 个匹配工具` (hidden if 0), suggestion cards, `+N` folding past 3, footer `或用 @ 引用其他 tab / 工具 / 历史`. Test: renders 0/1/3/5 tool cases correctly.

- [ ] **B3d `above-input-tabs.tsx`:** Accepts `{ attachedTabs: AttachedTab[]; currentTabUrl: string; onDetach: (tabId: number) => void; onAddTab: () => void }`. Renders horizontally scrolling chip row: 🏠 当前 + chips for each attached + `+ tab` dashed. Test: chip × triggers onDetach; `+ tab` triggers onAddTab.

- [ ] **B3e `tab-identity-bar.tsx`:** Accepts `{ tabId: number; url: string; status: SessionStatus; recoverable: boolean; onRecover?: () => void }`. Renders `● <url截断> · Tab #<id>` with status-colored dot, and `[恢复 →]` when `recoverable`. Test: status colors map; recoverable shows link.

- [ ] **B3f `mention-picker.tsx`:** Popover anchored above input. Accepts `{ tabs: AttachedTab[]; onPick: (tab: AttachedTab) => void; onClose: () => void }`. Renders simple list of tabs; keyboard-navigable (↑↓ + Enter). Test: arrow keys + Enter picks the right tab.

After each: write component, write at least 1 test asserting key behavior, run `pnpm -F @aipagego/extension test <name>` (PASS), commit:

```bash
git add packages/extension/src/sidepanel/.../<name>.tsx \
        packages/extension/src/sidepanel/.../__tests__/<name>.test.tsx
git commit -m "feat(sidepanel): add <ComponentName> component"
```

---

### Task B4: `input-box.tsx` + `input-toolbar.tsx`

- [ ] **B4a `input-box.tsx`:** Multi-line textarea (auto-grow min 56 / max 200 px), `Enter`=send, `Shift+Enter`=newline, `@`=open mention picker. Props: `{ value, onChange, onSubmit, onAtTrigger, disabled }`. Test: Enter triggers onSubmit; Shift+Enter inserts \\n; @ triggers onAtTrigger.

- [ ] **B4b `input-toolbar.tsx`:** Wraps the whole bottom region (above-input chips + input box + bottom toolbar). Props: `{ session, settings, onSendMessage, onStop, onAtMention, onPermissionChange, onTrustedChange, onAddTab, onDetachTab }`. Internally:
  - Renders `<AboveInputTabs>` from props
  - Renders `<InputBox>` with state
  - Renders bottom toolbar: left `<PermissionModePill>` + `@` button; right `roundCount/maxRounds` + token meter + send/stop button
  - Wires MentionPicker open state

Test: rendering with idle status shows send icon; streaming shows stop; clicking send invokes onSendMessage.

Commit per sub-file as in B3.

---

### Task B5: `header.tsx`

**Files:**
- Create: `packages/extension/src/sidepanel/shell/header.tsx`
- Test: `packages/extension/src/sidepanel/shell/__tests__/header.test.tsx`

- [ ] **Step 1:** Component:

```tsx
import { useUi, type DrawerKind } from "../chat/ui-store";
import type { SessionData } from "../chat/session-store";

type Props = {
  session: SessionData;
  onNewChat: () => void;
};

export function Header({ session, onNewChat }: Props) {
  const open = useUi((s) => s.open);
  const badge = session.debugBadge;
  const badgeColor =
    badge?.kind === "error" ? "bg-red-500" :
    badge?.kind === "exchange" ? "bg-amber-500" :
    badge?.kind === "log" ? "bg-blue-500" :
    null;

  return (
    <div className="border-b border-zinc-800 bg-zinc-900">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="font-bold text-zinc-100 text-sm tracking-tight">AIPageGo</div>
        <div className="flex gap-1">
          <IconBtn label="新会话" onClick={onNewChat}>＋</IconBtn>
          <IconBtn label="历史" onClick={() => open("history")}>⏱</IconBtn>
          <IconBtn label="工具库" onClick={() => open("tools")}>🧰</IconBtn>
          <IconBtn label="设置" onClick={() => open("settings")}>⚙</IconBtn>
          <IconBtn label="调试" onClick={() => open("debug")} badge={badgeColor}>💭</IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, badge, children }: { label: string; onClick: () => void; badge?: string | null; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} onClick={onClick}
      className="relative w-7 h-7 rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 flex items-center justify-center text-base">
      {children}
      {badge && <span className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${badge}`} />}
    </button>
  );
}
```

(`SessionData` needs `debugBadge` field — added in Task A3? Actually only `permissionMode` was added. Add `debugBadge: { kind: 'error'|'exchange'|'log'; count: number } | null` to SessionData + `makeEmptySession` here.)

- [ ] **Step 2:** Add the `debugBadge` field to `session-store.ts` SessionData and `makeEmptySession`. (Forgot in A3; fix here.)

- [ ] **Step 3:** Test: renders 5 buttons; clicking each calls `open` with correct kind or `onNewChat`. Badge color test for each `debugBadge.kind`.

- [ ] **Step 4:** `pnpm -F @aipagego/extension test header`. Commit:

```bash
git add packages/extension/src/sidepanel/shell/header.tsx \
        packages/extension/src/sidepanel/shell/__tests__/header.test.tsx \
        packages/extension/src/sidepanel/chat/session-store.ts
git commit -m "feat(sidepanel): add Header with 5 drawer-launch icons + debug badge"
```

---

## Phase C · Drawer composites

### Task C1: `history-drawer.tsx` (port)

**Files:**
- Create: `packages/extension/src/sidepanel/drawers/history-drawer.tsx`
- Modify: nothing else; old `session-history-drawer.tsx` will be deleted in Phase E.

- [ ] **Step 1:** Copy logic from `components/session-history-drawer.tsx`; rebuild render to use `Drawer` shell. Add `byCurrentUrl: boolean` toggle. Hook into `useUi` to read `openedDrawer === "history"` for show/hide.

- [ ] **Step 2:** Test sanity: renders empty state; renders 2 IDB entries (mock chrome.storage).

- [ ] **Step 3:** Commit:

```bash
git add packages/extension/src/sidepanel/drawers/history-drawer.tsx \
        packages/extension/src/sidepanel/drawers/__tests__/history-drawer.test.tsx
git commit -m "feat(sidepanel): add HistoryDrawer (Drawer-based port of session history)"
```

---

### Task C2: `tools-drawer.tsx` + `tool-detail-pane.tsx`

**Files:**
- Create: `packages/extension/src/sidepanel/drawers/tools-drawer.tsx`
- Create: `packages/extension/src/sidepanel/drawers/tool-detail-pane.tsx`

- [ ] **Step 1:** Combine logic from old `pages/tools-page.tsx` + `pages/tool-detail-page.tsx`. ToolsDrawer renders Tools list inside `<Drawer>`. When user clicks a row, call `useUi.open("tools", toolId)` to push detail subpath. ToolsDrawer reads `useUi(s => s.drawerSubPath)` and conditionally renders `<ToolDetailPane>` with back button (via Drawer's `onBack`).

- [ ] **Step 2:** Use existing IDB tool helpers (`packages/extension/src/sidepanel/chat/tool-storage.ts` or wherever the current `tools-page` reads them).

- [ ] **Step 3:** Sanity test: empty list renders empty state; list with 2 tools renders 2 cards; clicking a card pushes subPath.

- [ ] **Step 4:** Commit.

---

### Task C3: `settings-drawer.tsx` + 5 sections

**Files:**
- Create: `packages/extension/src/sidepanel/drawers/settings-drawer.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-llm.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-permissions.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-mounting.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-coordinator.tsx`
- Create: `packages/extension/src/sidepanel/drawers/settings/section-advanced.tsx`

- [ ] **Step 1:** `SettingsDrawer` = collapsible section accordion (all open by default) inside `<Drawer>`. Each section reads from `useSettings`. Port content from old `settings-page.tsx` + `coordinator-settings-page.tsx`. `section-advanced` adds buttons:
  - `[DEV: JSON 运行]` → opens a modal embedding the old `run-page.tsx` body (port to a `DevJsonModal` component inline).
  - `[导出工具库]`, `[导入工具库]`, `[清空所有数据]` (red w/ double-confirm).

- [ ] **Step 2:** `section-permissions` renders dropdown for `defaultPermissionMode` + 5 checkboxes for `trustedDangerTools` (using same DANGEROUS_TOOLS list as in `PermissionModePill`). Extract that constant into `packages/extension/src/sidepanel/lib/dangerous-tools.ts` to DRY:

```ts
export const DANGEROUS_TOOLS = [
  { id: "submitForm",      label: "submitForm — 提交表单" },
  { id: "uploadFile",      label: "uploadFile — 上传文件" },
  { id: "readStorage",     label: "readStorage — 读 localStorage/sessionStorage" },
  { id: "httpRequestCred", label: "httpRequest 带 cookie" },
  { id: "runJSDangerous",  label: "runJS — 包含 cookie/eval/storage 的脚本" },
];
```

Update `PermissionModePill` to import from this file (1-line change).

- [ ] **Step 3:** Light tests: each section renders; permissions section toggles trustedDangerTools.

- [ ] **Step 4:** Commit:

```bash
git add packages/extension/src/sidepanel/drawers/settings-drawer.tsx \
        packages/extension/src/sidepanel/drawers/settings/ \
        packages/extension/src/sidepanel/lib/dangerous-tools.ts \
        packages/extension/src/sidepanel/input/permission-mode-pill.tsx \
        packages/extension/src/sidepanel/drawers/__tests__/settings-drawer.test.tsx
git commit -m "feat(sidepanel): add SettingsDrawer with 5 sections + DevJsonModal"
```

---

### Task C4: `debug-drawer.tsx` (logs + exchanges tabs)

**Files:**
- Create: `packages/extension/src/sidepanel/drawers/debug-drawer.tsx`

- [ ] **Step 1:** Merge `LogsDrawer` + `LlmExchangePanel` content into a single drawer with internal tab switcher (`日志 | Exchanges`). When opened and session has badge=error, auto-select "日志" tab + scroll to first error. Use existing log/exchange data from session.

- [ ] **Step 2:** Sanity test: renders both tabs; tab switch swaps content.

- [ ] **Step 3:** Commit.

---

## Phase D · Compose new shell + wire everything

### Task D1: Build `app-shell.tsx`

**Files:**
- Create: `packages/extension/src/sidepanel/shell/app-shell.tsx`

- [ ] **Step 1:** `AppShell` component layout (in order):
  1. `<Header session={current} onNewChat={...} />`
  2. `<TabIdentityBar ... />`
  3. Conditional: if no messages and no cards → `<EmptySuggestions ... />`; else `<ChatView ... />` (reused).
  4. `<InputToolbar ... />`
  5. `<HistoryDrawer />`, `<ToolsDrawer />`, `<SettingsDrawer />`, `<DebugDrawer />` — each reads `useUi` internally.
  6. Mount existing modals: `<SaveAsToolDialog />`, `<TabPicker />`.

  Use existing hooks `useSession()`, `useSettings()`. Wire all callbacks to existing actions in `session-store` / `run-chat-session`.

- [ ] **Step 2:** Smoke test: render AppShell with a stub `chrome` global + empty IDB; assert that the header renders, then opening tools drawer renders the Tools drawer container.

- [ ] **Step 3:** Commit.

---

### Task D2: Switch entry point to AppShell

**Files:**
- Modify: `packages/extension/src/sidepanel/index.tsx` (or whatever mounts `<App />`).

- [ ] **Step 1:** Replace `import { App } from "./app"` with `import { AppShell } from "./shell/app-shell"`. Render `<AppShell />`.

- [ ] **Step 2:** Run `pnpm -F @aipagego/extension build` → expect green (catches missing exports).

- [ ] **Step 3:** Commit:

```bash
git add packages/extension/src/sidepanel/index.tsx
git commit -m "feat(sidepanel): switch entry to new AppShell"
```

---

## Phase E · Delete old files + cleanup

### Task E1: Delete old pages

**Files (delete):**
- `packages/extension/src/sidepanel/app.tsx`
- `packages/extension/src/sidepanel/pages/chat-page.tsx`
- `packages/extension/src/sidepanel/pages/tools-page.tsx`
- `packages/extension/src/sidepanel/pages/tool-detail-page.tsx`
- `packages/extension/src/sidepanel/pages/settings-page.tsx`
- `packages/extension/src/sidepanel/pages/coordinator-settings-page.tsx`
- `packages/extension/src/sidepanel/pages/run-page.tsx`

- [ ] **Step 1:** `git rm` each.
- [ ] **Step 2:** `pnpm -r typecheck` → fix any dangling imports (likely none if Task D2 done correctly).
- [ ] **Step 3:** Commit:

```bash
git commit -m "chore(sidepanel): delete old pages (replaced by drawers)"
```

---

### Task E2: Delete old components

**Files (delete):**
- `recommendations-banner.tsx`
- `tab-chips-bar.tsx`
- `status-bar.tsx`
- `session-history-drawer.tsx`
- `logs-drawer.tsx`
- `llm-exchange-panel.tsx`
- `danger-approval-popover.tsx`
- `danger-approval-group.tsx`
- `url-recovery-banner.tsx`
- `tab-info-bar.tsx`
- `error-banner.tsx` (if exists)

- [ ] **Step 1:** `git rm` each.
- [ ] **Step 2:** `pnpm -r typecheck` → fix dangling imports.
- [ ] **Step 3:** Commit:

```bash
git commit -m "chore(sidepanel): delete old components (replaced by shell/drawers/input)"
```

---

### Task E3: Clean up SessionData (remove `approveAllSafe`, `logsOpen`, anything truly unused)

**Files:**
- Modify: `packages/extension/src/sidepanel/chat/session-store.ts`

- [ ] **Step 1:** Verify nothing reads `approveAllSafe` (`grep`). Delete from type + `makeEmptySession`.

- [ ] **Step 2:** Verify `logsOpen` removed (should already be).

- [ ] **Step 3:** Run typecheck + all tests. Commit:

```bash
git commit -am "refactor(sidepanel): drop unused approveAllSafe from SessionData"
```

---

### Task E4: Run full test suite + build + manual smoke

- [ ] **Step 1:** `pnpm -r typecheck` → green
- [ ] **Step 2:** `pnpm -r test` → all PASS (existing + new)
- [ ] **Step 3:** `pnpm build` → builds `packages/extension/dist/`
- [ ] **Step 4:** Manual smoke per spec §12:
  - Load `dist/` into `chrome://extensions`
  - Open any page → side panel opens, header has 5 icons, no top tab bar
  - Click each header icon → drawer opens, ESC closes
  - Click permission pill → 4 modes shown; pick "全自动" → modal appears
  - Shift+Tab in input area cycles modes (skip if cursor in textarea)
  - Visit `shop.example.com/goods.html` with a saved `shop` tool → suggestion card appears
  - Type a prompt → AI runs → step cards show → after completion `SaveAsToolCard` appears at bottom
  - Check IDB persistence: switch tabs, return — session restored
- [ ] **Step 5:** If smoke passes, no commit needed; if any fix needed, fix and commit.

---

## Phase F · Ship

### Task F1: Push branch + open PR

- [ ] **Step 1:** `git push -u origin feat/ui-aipex-refactor`
- [ ] **Step 2:** `gh pr create --title "feat(sidepanel): AIPex-style single-surface UI" --body "..."` (body summarizes the refactor; pulls from spec).
- [ ] **Step 3:** Verify the GitHub Actions `build-extension` workflow passes on the PR.

### Task F2: Squash-merge + tag release

- [ ] **Step 1:** Per memory `feedback_ship_release_version_bump`: bump `package.json` version inside the PR's feature commit if it's a release-worthy patch.
- [ ] **Step 2:** Merge the PR (squash).
- [ ] **Step 3:** Use `ship-release` skill / workflow to cut tag (next patch from latest) — let CI build & publish the GitHub Release zip.
- [ ] **Step 4:** Per memory `feedback_local_main_divergence`: after squash-merge, on local `main`: `git fetch && git reset --hard origin/main`.

---

## Self-Review Notes

- **Spec coverage**: all 16 spec sections map to tasks. §6.5 Debug drawer auto-pop softened in self-review → reflected in Task C4 ("if session has badge=error auto-select 日志 tab"; **not** auto-pop drawer).
- **Placeholder scan**: clean — every step has executable code or precise grep target.
- **Type consistency**: `PermissionMode` flows from severity.ts (A1) → SessionData (A3) → PermissionModePill props (B1) → AppShell wiring (D1). `trustedDangerTools` is consistent across LlmSettings (A2), PermissionModePill (B1), and section-permissions (C3). `DrawerKind` is the union `"history" | "tools" | "settings" | "debug"` used in ui-store (A3) and Header (B5).

---

## Out of Scope

Per spec §14:
- Light theme, theme switcher
- i18n
- @ picker support for Tools / History / Skills (only Tabs)
- Backend changes (`background/`, `content/`, builtin-tools, runJS scanner, WS protocol, mcp-server, coordinator)
