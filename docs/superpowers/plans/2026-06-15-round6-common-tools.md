# Round 6 — Common Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 4 new LLM-callable content-script tools — `navigate`, `getPageInfo`, `pressKey`, `writeStorage` — so the model stops falling back to `runJS` for these common operations.

**Architecture:** Each tool lives as a single function in `packages/extension/src/content/tools/<name>.ts`, exposed via three layers: the `BuiltinTool` union (`packages/shared/src/types.ts`), the runtime `TOOLS` map (`packages/extension/src/content/tools/index.ts`), and the LLM-facing schema in `packages/shared/src/llm/builtin-tool-defs.ts`. Severity is set in `packages/extension/src/sidepanel/chat/severity.ts`. Tests use vitest + happy-dom following the existing `read-storage.test.ts` pattern. All 4 tools are replayable so `ReplayableTool` is not touched.

**Tech Stack:** TypeScript, vitest 2.0.5, happy-dom 15, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-15-round6-common-tools-design.md`

---

## File Structure

**New files (4 impl + 4 tests):**

```
packages/extension/src/content/tools/navigate.ts
packages/extension/src/content/tools/get-page-info.ts
packages/extension/src/content/tools/press-key.ts
packages/extension/src/content/tools/write-storage.ts
packages/extension/tests/content/tools/navigate.test.ts
packages/extension/tests/content/tools/get-page-info.test.ts
packages/extension/tests/content/tools/press-key.test.ts
packages/extension/tests/content/tools/write-storage.test.ts
```

**Files to modify (4 in Task 6 — single integration commit):**

```
packages/shared/src/types.ts                                   (Task 1 — types only)
packages/extension/src/content/tools/index.ts                  (Task 6)
packages/shared/src/llm/builtin-tool-defs.ts                   (Task 6)
packages/extension/src/sidepanel/chat/severity.ts              (Task 6)
```

## Task ordering rationale

- **Task 1** expands the `BuiltinTool` union for all 4 names so impl files in Tasks 2-5 can be referenced from index.ts in Task 6 without TS errors when typechecking the full project.
- **Tasks 2-5** are pure per-tool TDD slices — write test, see it fail, implement, see it pass, commit. No shared-file edits, so each task is self-contained and easy to review.
- **Task 6** does all the wiring in one shot (TOOLS map + LLM defs + severity) and runs the full test suite + typecheck before commit.

---

## Task 1: Add 4 names to BuiltinTool union

**Files:**
- Modify: `packages/shared/src/types.ts:46`

- [ ] **Step 1: Read current union end**

Run: `sed -n '40,48p' packages/shared/src/types.ts`

Expected: line 46 is `  | "fillForm";` — the union terminator.

- [ ] **Step 2: Append 4 new names**

Edit `packages/shared/src/types.ts`, replacing:

```ts
  | "fillForm";
```

with:

```ts
  | "fillForm"
  // Round 6 — common helpers
  | "navigate"
  | "getPageInfo"
  | "pressKey"
  | "writeStorage";
```

- [ ] **Step 3: Typecheck the whole repo**

Run: `pnpm -r typecheck`

Expected: PASS. (Adding to the union doesn't break consumers since `TOOLS` is `Partial<Record<BuiltinTool, ToolFn>>` — missing keys are allowed.)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types.ts
git commit -m "feat(types): add 4 round-6 tool names to BuiltinTool union"
```

---

## Task 2: navigate tool

**Files:**
- Create: `packages/extension/src/content/tools/navigate.ts`
- Test: `packages/extension/tests/content/tools/navigate.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/content/tools/navigate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { navigate } from "@/content/tools/navigate";

describe("navigate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls history.back() and returns { ok, action }", async () => {
    const spy = vi.spyOn(window.history, "back").mockImplementation(() => {});
    const r = await navigate({ action: "back" });
    expect(spy).toHaveBeenCalledOnce();
    expect(r).toEqual({ ok: true, action: "back" });
  });

  it("calls history.forward()", async () => {
    const spy = vi.spyOn(window.history, "forward").mockImplementation(() => {});
    const r = await navigate({ action: "forward" });
    expect(spy).toHaveBeenCalledOnce();
    expect(r).toEqual({ ok: true, action: "forward" });
  });

  it("calls location.reload()", async () => {
    const spy = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    const r = await navigate({ action: "reload" });
    expect(spy).toHaveBeenCalledOnce();
    expect(r).toEqual({ ok: true, action: "reload" });
  });

  it("calls location.assign() for goto with https URL", async () => {
    const spy = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    const r = await navigate({ action: "goto", url: "https://example.com/page" });
    expect(spy).toHaveBeenCalledWith("https://example.com/page");
    expect(r).toEqual({ ok: true, action: "goto", url: "https://example.com/page" });
  });

  it("allows http/file/ftp schemes for goto", async () => {
    const spy = vi.spyOn(window.location, "assign").mockImplementation(() => {});
    await navigate({ action: "goto", url: "http://x.test/" });
    await navigate({ action: "goto", url: "file:///tmp/x.html" });
    await navigate({ action: "goto", url: "ftp://x.test/y" });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("throws on goto without url", async () => {
    await expect(navigate({ action: "goto" })).rejects.toThrow(/url required/);
  });

  it("throws on disallowed scheme", async () => {
    await expect(navigate({ action: "goto", url: "javascript:alert(1)" })).rejects.toThrow(
      /scheme not allowed/
    );
    await expect(navigate({ action: "goto", url: "data:text/html,x" })).rejects.toThrow(
      /scheme not allowed/
    );
  });

  it("throws on unknown action", async () => {
    await expect(navigate({ action: "spin" as never })).rejects.toThrow(/unknown action/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- navigate`

Expected: FAIL — `Cannot find module '@/content/tools/navigate'` or similar resolution error (file does not exist yet).

- [ ] **Step 3: Implement navigate**

Create `packages/extension/src/content/tools/navigate.ts`:

```ts
import type { Json } from "@aipagego/shared/types";

type Args = {
  action: "back" | "forward" | "reload" | "goto";
  url?: string;
};

const ALLOWED_SCHEME = /^https?:|^file:|^ftp:/i;

export async function navigate(args: Json): Promise<Json> {
  const { action, url } = (args ?? {}) as Args;
  switch (action) {
    case "back":
      window.history.back();
      return { ok: true, action };
    case "forward":
      window.history.forward();
      return { ok: true, action };
    case "reload":
      window.location.reload();
      return { ok: true, action };
    case "goto": {
      if (typeof url !== "string") {
        throw new Error("navigate: url required for action=goto");
      }
      if (!ALLOWED_SCHEME.test(url)) {
        throw new Error(`navigate: URL scheme not allowed: ${url}`);
      }
      window.location.assign(url);
      return { ok: true, action, url };
    }
    default:
      throw new Error(`navigate: unknown action: ${String(action)}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- navigate`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools/navigate.ts \
        packages/extension/tests/content/tools/navigate.test.ts
git commit -m "feat(tools): add navigate (back/forward/reload/goto)"
```

---

## Task 3: getPageInfo tool

**Files:**
- Create: `packages/extension/src/content/tools/get-page-info.ts`
- Test: `packages/extension/tests/content/tools/get-page-info.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/content/tools/get-page-info.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { getPageInfo } from "@/content/tools/get-page-info";

describe("getPageInfo", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    document.title = "";
    document.documentElement.lang = "";
  });

  it("returns url, title, hostname", async () => {
    document.title = "Hello";
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(typeof r.url).toBe("string");
    expect(r.title).toBe("Hello");
    expect(typeof r.hostname).toBe("string");
  });

  it("returns lang from <html lang>", async () => {
    document.documentElement.lang = "zh-CN";
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.lang).toBe("zh-CN");
  });

  it("returns null lang when missing", async () => {
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.lang).toBeNull();
  });

  it("returns description from <meta name=description>", async () => {
    document.head.innerHTML = `<meta name="description" content="my page">`;
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.description).toBe("my page");
  });

  it("returns null description when missing", async () => {
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.description).toBeNull();
  });

  it("collects og:* meta into ogMeta", async () => {
    document.head.innerHTML = `
      <meta property="og:title" content="OG Title">
      <meta property="og:type" content="article">
      <meta property="og:image" content="https://x.test/i.png">
    `;
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.ogMeta).toEqual({
      title: "OG Title",
      type: "article",
      image: "https://x.test/i.png",
    });
  });

  it("returns {} ogMeta when no og:* tags", async () => {
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect(r.ogMeta).toEqual({});
  });

  it("caps long string values at 200 chars", async () => {
    const longVal = "a".repeat(500);
    document.head.innerHTML = `<meta name="description" content="${longVal}">`;
    const r = (await getPageInfo({})) as Record<string, unknown>;
    expect((r.description as string).length).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- get-page-info`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement getPageInfo**

Create `packages/extension/src/content/tools/get-page-info.ts`:

```ts
import type { Json } from "@aipagego/shared/types";

const OG_KEYS = ["title", "type", "image", "url", "site_name", "description"] as const;
const STR_CAP = 200;

function cap(s: string): string {
  return s.length > STR_CAP ? s.slice(0, STR_CAP) : s;
}

function metaContent(name: string, attr: "name" | "property"): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  const v = el?.getAttribute("content");
  return v ? cap(v) : null;
}

export async function getPageInfo(_args: Json): Promise<Json> {
  const ogMeta: Record<string, string> = {};
  for (const k of OG_KEYS) {
    const v = metaContent(`og:${k}`, "property");
    if (v) ogMeta[k] = v;
  }
  return {
    url: window.location.href,
    title: cap(document.title),
    hostname: window.location.hostname,
    lang: document.documentElement.lang || null,
    description: metaContent("description", "name"),
    ogMeta,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- get-page-info`

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools/get-page-info.ts \
        packages/extension/tests/content/tools/get-page-info.test.ts
git commit -m "feat(tools): add getPageInfo (url/title/hostname/lang/og:*)"
```

---

## Task 4: pressKey tool

**Files:**
- Create: `packages/extension/src/content/tools/press-key.ts`
- Test: `packages/extension/tests/content/tools/press-key.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/content/tools/press-key.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { pressKey } from "@/content/tools/press-key";

describe("pressKey", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("dispatches keydown + keyup to selector target", async () => {
    document.body.innerHTML = `<input id="q" />`;
    const el = document.querySelector<HTMLInputElement>("#q")!;
    const seen: string[] = [];
    el.addEventListener("keydown", (e) => seen.push(`down:${e.key}`));
    el.addEventListener("keyup", (e) => seen.push(`up:${e.key}`));
    const r = await pressKey({ selector: "#q", key: "Enter" });
    expect(seen).toEqual(["down:Enter", "up:Enter"]);
    expect(r).toEqual({ ok: true, key: "Enter", dispatched: true });
  });

  it("dispatches keypress for printable chars", async () => {
    document.body.innerHTML = `<input id="q" />`;
    const el = document.querySelector<HTMLInputElement>("#q")!;
    const seen: string[] = [];
    el.addEventListener("keypress", (e) => seen.push(e.key));
    await pressKey({ selector: "#q", key: "a" });
    expect(seen).toEqual(["a"]);
  });

  it("does NOT dispatch keypress for non-printable keys", async () => {
    document.body.innerHTML = `<input id="q" />`;
    const el = document.querySelector<HTMLInputElement>("#q")!;
    let pressCount = 0;
    el.addEventListener("keypress", () => pressCount++);
    await pressKey({ selector: "#q", key: "Escape" });
    expect(pressCount).toBe(0);
  });

  it("infers KeyboardEvent.code for letters", async () => {
    document.body.innerHTML = `<input id="q" />`;
    const el = document.querySelector<HTMLInputElement>("#q")!;
    let code = "";
    el.addEventListener("keydown", (e) => {
      code = e.code;
    });
    await pressKey({ selector: "#q", key: "a" });
    expect(code).toBe("KeyA");
  });

  it("focuses HTMLElement target before dispatch", async () => {
    document.body.innerHTML = `<input id="q" /><input id="other" />`;
    const el = document.querySelector<HTMLInputElement>("#q")!;
    await pressKey({ selector: "#q", key: "Enter" });
    expect(document.activeElement).toBe(el);
  });

  it("falls back to document.body when no selector and no activeElement", async () => {
    let got = "";
    document.body.addEventListener("keydown", (e) => {
      got = e.key;
    });
    await pressKey({ key: "Escape" });
    expect(got).toBe("Escape");
  });

  it("throws when key is missing", async () => {
    await expect(pressKey({})).rejects.toThrow(/key required/);
  });

  it("throws when key is empty string", async () => {
    await expect(pressKey({ key: "" })).rejects.toThrow(/key required/);
  });

  it("throws when selector not found", async () => {
    await expect(pressKey({ key: "Enter", selector: "#nope" })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- press-key`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement pressKey**

Create `packages/extension/src/content/tools/press-key.ts`:

```ts
import type { Json } from "@aipagego/shared/types";

type Args = {
  key: string;
  selector?: string;
};

function inferCode(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  return key;
}

const PRINTABLE = /^[\x20-\x7e]$/;

export async function pressKey(args: Json): Promise<Json> {
  const { key, selector } = (args ?? {}) as Args;
  if (typeof key !== "string" || key === "") {
    throw new Error("pressKey: key required");
  }

  let target: Element;
  if (selector) {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`pressKey: element not found: ${selector}`);
    target = found;
    if (target instanceof HTMLElement) target.focus();
  } else {
    target = (document.activeElement as Element | null) ?? document.body;
  }

  const code = inferCode(key);
  const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (PRINTABLE.test(key)) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));

  return { ok: true, key, dispatched: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- press-key`

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools/press-key.ts \
        packages/extension/tests/content/tools/press-key.test.ts
git commit -m "feat(tools): add pressKey (keydown/keypress/keyup dispatch)"
```

---

## Task 5: writeStorage tool

**Files:**
- Create: `packages/extension/src/content/tools/write-storage.ts`
- Test: `packages/extension/tests/content/tools/write-storage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/extension/tests/content/tools/write-storage.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { writeStorage } from "@/content/tools/write-storage";

describe("writeStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it("writes to localStorage", async () => {
    const r = await writeStorage({ store: "local", key: "u", value: "alice" });
    expect(localStorage.getItem("u")).toBe("alice");
    expect(r).toEqual({ ok: true, store: "local", key: "u" });
  });

  it("writes to sessionStorage", async () => {
    await writeStorage({ store: "session", key: "t", value: "abc" });
    expect(sessionStorage.getItem("t")).toBe("abc");
  });

  it("overwrites existing key", async () => {
    localStorage.setItem("u", "old");
    await writeStorage({ store: "local", key: "u", value: "new" });
    expect(localStorage.getItem("u")).toBe("new");
  });

  it("throws on bad store", async () => {
    await expect(
      writeStorage({ store: "bogus", key: "k", value: "v" } as unknown as Record<string, string>)
    ).rejects.toThrow(/store must be/);
  });

  it("throws when key is empty", async () => {
    await expect(writeStorage({ store: "local", key: "", value: "v" })).rejects.toThrow(
      /key required/
    );
  });

  it("throws when value is not a string", async () => {
    await expect(
      writeStorage({ store: "local", key: "k", value: 123 as unknown as string })
    ).rejects.toThrow(/string/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/extension && pnpm test -- write-storage`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement writeStorage**

Create `packages/extension/src/content/tools/write-storage.ts`:

```ts
import type { Json } from "@aipagego/shared/types";

type Args = { store: "local" | "session"; key: string; value: string };

export async function writeStorage(args: Json): Promise<Json> {
  const { store, key, value } = (args ?? {}) as Args;
  if (store !== "local" && store !== "session") {
    throw new Error("writeStorage: store must be 'local' or 'session'");
  }
  if (typeof key !== "string" || key === "") {
    throw new Error("writeStorage: key required");
  }
  if (typeof value !== "string") {
    throw new Error("writeStorage: value must be a string");
  }
  const s = store === "local" ? localStorage : sessionStorage;
  s.setItem(key, value);
  return { ok: true, store, key };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/extension && pnpm test -- write-storage`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools/write-storage.ts \
        packages/extension/tests/content/tools/write-storage.test.ts
git commit -m "feat(tools): add writeStorage (local/session setItem)"
```

---

## Task 6: Wire 4 tools into TOOLS map + LLM defs + severity

**Files:**
- Modify: `packages/extension/src/content/tools/index.ts` (imports + TOOLS entries)
- Modify: `packages/shared/src/llm/builtin-tool-defs.ts` (4 schemas appended before closing `];`)
- Modify: `packages/extension/src/sidepanel/chat/severity.ts` (SAFE / CAUTION / DANGEROUS_FIXED sets + classifyTool branch)

- [ ] **Step 1: Register 4 tools in content/tools/index.ts**

Edit `packages/extension/src/content/tools/index.ts`. After the existing `import { waitFor } from "./wait-for";` line, add:

```ts
import { navigate } from "./navigate";
import { getPageInfo } from "./get-page-info";
import { pressKey } from "./press-key";
import { writeStorage } from "./write-storage";
```

Then inside the `TOOLS` object, replace the closing brace line (currently `};` right after `fillForm`) so the final entries become:

```ts
  takeSnapshot,
  clickByUid,
  fillByUid,
  highlightElement,
  highlightText,
  fillForm,
  // Round 6 — common helpers
  navigate,
  getPageInfo,
  pressKey,
  writeStorage
};
```

Note: also add a trailing comma after `fillForm` (currently there isn't one) so the formatter doesn't mind. Final list ends with `writeStorage` having no trailing comma — that matches the existing style for the last entry.

- [ ] **Step 2: Add 4 LLM defs to builtin-tool-defs.ts**

Open `packages/shared/src/llm/builtin-tool-defs.ts`. The array ends at the line `];` (around line 574). Insert the 4 new entries **immediately before** that closing `];`:

```ts
  // ─── Round 6 — common helpers ─────────────────────────────────
  {
    name: "navigate",
    description:
      "[ACT] 页面导航：后退 / 前进 / 重载 / 跳转。**优先**用本工具而不是 runJS('location.href = ...')。\n" +
      "示例：\n" +
      "- 后退一页：{ action: 'back' }\n" +
      "- 跳到新 URL：{ action: 'goto', url: 'https://example.com/page' }",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["back", "forward", "reload", "goto"] },
        url: { type: "string", description: "仅 action=goto 时使用；只允许 http/https/file/ftp" },
        tabId: TAB_ID_FIELD,
      },
      required: ["action"],
    },
  },
  {
    name: "getPageInfo",
    description:
      "[FAST·READ] 读当前页基本信息：URL / title / hostname / 语言 / OpenGraph meta。\n" +
      "多页对话中「我在哪个页面」的首选；比 snapshotDOM 便宜得多。",
    input_schema: {
      type: "object",
      properties: {
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "pressKey",
    description:
      "[ACT] 模拟键盘事件（keydown + 可打印字符 keypress + keyup）。\n" +
      "常用：Enter 提交无 form 的搜索框 / Escape 关 modal / Tab 切焦点。key 用 KeyboardEvent.key 值。\n" +
      "本工具**不**改 input 值——填值仍走 fillInput / fillByUid。\n" +
      "示例：\n" +
      "- 提交搜索：{ selector: 'input[name=q]', key: 'Enter' }\n" +
      "- 关 modal：{ key: 'Escape' }",
    input_schema: {
      type: "object",
      properties: {
        key: { type: "string", description: "如 'Enter' / 'Escape' / 'Tab' / 'ArrowDown' / 'a'" },
        selector: {
          type: "string",
          description: "可选；不传则派发到 document.activeElement 或 document.body",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["key"],
    },
  },
  {
    name: "writeStorage",
    description: "[DANGER] 写 localStorage 或 sessionStorage。改站点状态，需要审阅。",
    input_schema: {
      type: "object",
      properties: {
        store: { type: "string", enum: ["local", "session"] },
        key: { type: "string" },
        value: {
          type: "string",
          description: "字符串值；非字符串请自行 JSON.stringify",
        },
        tabId: TAB_ID_FIELD,
      },
      required: ["store", "key", "value"],
    },
  },
```

- [ ] **Step 3: Update severity.ts**

Edit `packages/extension/src/sidepanel/chat/severity.ts`:

(a) Inside the `SAFE` Set initializer (currently ending with `"highlightText"`), add `"getPageInfo"` so the tail becomes:

```ts
  "takeSnapshot",
  "highlightElement",
  "highlightText",
  // Round 6
  "getPageInfo"
]);
```

(b) Inside the `CAUTION` Set initializer (currently ending with `"downloadImage"`), add `"pressKey"`:

```ts
  "fillForm",
  "downloadImage",
  // Round 6
  "pressKey"
]);
```

(c) Inside the `DANGEROUS_FIXED` Set initializer (currently `"readStorage" / "submitForm" / "uploadFile"`), add `"writeStorage"`:

```ts
const DANGEROUS_FIXED = new Set([
  "readStorage",
  "submitForm",
  "uploadFile",
  // Round 6
  "writeStorage"
]);
```

(d) Inside `classifyTool`, **after** the `if (name === "runJS") { ... }` block and **before** the final `return "dangerous";`, insert:

```ts
  if (name === "navigate") {
    const action = isObject(input) ? (input as Record<string, Json>).action : undefined;
    return action === "goto" ? "caution" : "safe";
  }
```

- [ ] **Step 4: Typecheck + run all tests**

Run: `pnpm -r typecheck && cd packages/extension && pnpm test`

Expected: typecheck PASS; vitest reports all suites pass (the 4 new files contribute ~31 new tests; the rest of the extension test suite must still pass).

If anything fails, fix and re-run before committing.

- [ ] **Step 5: Sanity-check severity branching for navigate**

This is an inline manual check — no test file. Open a node REPL (or just eyeball the code path):

- `classifyTool("navigate", { action: "back" })` → `"safe"`
- `classifyTool("navigate", { action: "forward" })` → `"safe"`
- `classifyTool("navigate", { action: "reload" })` → `"safe"`
- `classifyTool("navigate", { action: "goto", url: "..." })` → `"caution"`
- `classifyTool("navigate", {})` → `"safe"` (action undefined ≠ "goto"; deliberate: bad input gets the lenient classification, the impl will throw on dispatch)

If the last case bothers you, change it — but the impl throws on unknown action so the LLM gets an error tool result either way.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/tools/index.ts \
        packages/shared/src/llm/builtin-tool-defs.ts \
        packages/extension/src/sidepanel/chat/severity.ts
git commit -m "feat(tools): wire navigate/getPageInfo/pressKey/writeStorage into TOOLS, LLM defs, severity"
```

---

## Final verification

- [ ] **Step 1: Run full extension test suite**

Run: `cd packages/extension && pnpm test`

Expected: all suites pass (existing + 4 new files).

- [ ] **Step 2: Run full repo typecheck**

Run: `pnpm -r typecheck`

Expected: PASS across all packages (shared / extension / coordinator / mcp-server).

- [ ] **Step 3: Run a production build**

Run: `pnpm build`

Expected: PASS. `packages/extension/dist/` should regenerate.

- [ ] **Step 4: Review branch state**

Run: `git log --oneline main..HEAD`

Expected: 6 commits in order — types union; navigate; getPageInfo; pressKey; writeStorage; wiring.

At this point the branch is ready for the user to run the `ship-release` skill (PR → merge → tag). Do NOT auto-ship; surface the final state to the user.
