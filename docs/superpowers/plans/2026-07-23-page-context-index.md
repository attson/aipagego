# Page Context Index Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic local page-index layer so the model can search and read small evidence slices instead of sending full page text or DOM into LLM context.

**Architecture:** The content script owns an in-memory per-tab page index with stable block ids. New content tools create/search/read that index and extract ranked field candidates; the LLM sees bounded previews, references, and truncation diagnostics. Existing broad tools remain available as fallback, with tool descriptions steering the model toward the index tools first.

**Tech Stack:** TypeScript 5, Vite MV3 extension, zod wire schemas, vitest + happy-dom, existing content tool registry and shared `TOOL_DEFS`.

---

## File Map

- Modify `packages/shared/src/types.ts`: add four `BuiltinTool` values and decide replayability.
- Modify `packages/shared/src/messages.ts`: allow new tools in `StepSchema`.
- Modify `packages/shared/tests/messages.test.ts`: schema coverage for new tools.
- Create `packages/extension/src/content/tools/page-index/types.ts`: local index types and constants.
- Create `packages/extension/src/content/tools/page-index/text.ts`: normalization, text cleanup, truncation metadata helpers.
- Create `packages/extension/src/content/tools/page-index/build.ts`: DOM scanner and block extraction.
- Create `packages/extension/src/content/tools/page-index/store.ts`: in-memory index cache keyed by URL.
- Create `packages/extension/src/content/tools/page-index/search.ts`: deterministic scoring and field candidate extraction.
- Create `packages/extension/src/content/tools/page-index.ts`: exported tool handlers.
- Modify `packages/extension/src/content/tools/index.ts`: register four new tools.
- Modify `packages/shared/src/llm/builtin-tool-defs.ts`: expose tool schemas and discourage broad `extractText(body)`.
- Modify `packages/extension/src/sidepanel/llm/system-prompt.ts`: recommend page-index workflow for read/collect extraction.
- Add tests under `packages/extension/tests/content/tools/page-index*.test.ts`.
- Extend `packages/extension/tests/sidepanel/chat/run-session.test.ts`: scripted regression proving page-index tools can complete a multi-field task without `extractText(body)`.

---

### Task 1: Shared Tool Schema

**Files:**
- Modify: `packages/shared/src/types.ts`
- Modify: `packages/shared/src/messages.ts`
- Test: `packages/shared/tests/messages.test.ts`

- [ ] **Step 1: Write failing schema test**

Add this test to `packages/shared/tests/messages.test.ts`:

```ts
describe("page index tool schemas", () => {
  it("accepts page-index tools in replayable steps", () => {
    const tools = [
      "createPageIndex",
      "searchPageIndex",
      "readPageBlock",
      "extractPageFields"
    ];

    for (const tool of tools) {
      expect(
        RpcRequest.safeParse({
          type: "runs.runOneStep",
          tabId: 1,
          step: { kind: "tool", tool, args: {} }
        }).success
      ).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/shared test -- tests/messages.test.ts
```

Expected: FAIL because `StepSchema` does not accept the new tool names.

- [ ] **Step 3: Add tool names to shared types**

In `packages/shared/src/types.ts`, extend `BuiltinTool` after `writeStorage`:

```ts
  | "writeStorage"
  // Page Context Index — generic local page understanding helpers
  | "createPageIndex"
  | "searchPageIndex"
  | "readPageBlock"
  | "extractPageFields";
```

Keep these tools replayable. They read page state deterministically and are safe to store in step tools.

- [ ] **Step 4: Add tool names to StepSchema**

In `packages/shared/src/messages.ts`, extend the `tool: z.enum([...])` list after `"writeStorage"`:

```ts
      "writeStorage",
      // Page Context Index — generic local page understanding helpers
      "createPageIndex",
      "searchPageIndex",
      "readPageBlock",
      "extractPageFields"
```

- [ ] **Step 5: Run shared tests**

Run:

```bash
pnpm --filter @aipagego/shared test -- tests/messages.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/types.ts packages/shared/src/messages.ts packages/shared/tests/messages.test.ts
git commit -m "feat(shared): add page index tool schemas"
```

---

### Task 2: Page Index Text and Types

**Files:**
- Create: `packages/extension/src/content/tools/page-index/types.ts`
- Create: `packages/extension/src/content/tools/page-index/text.ts`
- Test: `packages/extension/tests/content/tools/page-index-text.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/extension/tests/content/tools/page-index-text.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { makePreview, normalizeText, tokenizeQuery } from "@/content/tools/page-index/text";

describe("page-index text helpers", () => {
  it("normalizes whitespace and punctuation without losing CJK text", () => {
    expect(normalizeText("  Price：   $20.99\n品牌\tHotcinfin  ")).toBe("price $20.99 品牌 hotcinfin");
  });

  it("tokenizes mixed Chinese and English queries", () => {
    expect(tokenizeQuery("Best Sellers Rank 价格 30天销量")).toEqual([
      "best",
      "sellers",
      "rank",
      "价格",
      "30天销量"
    ]);
  });

  it("returns structured truncation metadata instead of broken prose", () => {
    const result = makePreview("a".repeat(1200), 100, "b1", "block_budget");
    expect(result.text).toHaveLength(100);
    expect(result.complete).toBe(false);
    expect(result.availableChars).toBe(1200);
    expect(result.truncation).toEqual({
      kind: "preview",
      originalChars: 1200,
      returnedChars: 100,
      reason: "block_budget",
      ref: "b1"
    });
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-text.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add page-index types**

Create `packages/extension/src/content/tools/page-index/types.ts`:

```ts
import type { Json } from "@aipagego/shared/types";

export type PageBlockKind = "heading" | "kv" | "table" | "list" | "form" | "text" | "media";

export type TruncationKind = "none" | "preview" | "page" | "index_budget" | "evidence_budget";

export type TruncationInfo = {
  kind: TruncationKind;
  originalChars: number;
  returnedChars: number;
  reason: string;
  ref?: string;
};

export type PageBlock = {
  blockId: string;
  kind: PageBlockKind;
  text: string;
  label?: string;
  value?: string;
  selectorHint?: string;
  headingPath: string[];
  order: number;
  keywords: string[];
};

export type PageIndex = {
  indexId: string;
  url: string;
  title: string;
  createdAt: number;
  blocks: PageBlock[];
  truncated: boolean;
  truncation?: TruncationInfo;
};

export type Preview = {
  text: string;
  complete: boolean;
  availableChars: number;
  truncation: TruncationInfo;
};

export type JsonRecord = Record<string, Json>;

export const DEFAULT_MAX_BLOCKS = 600;
export const DEFAULT_SUMMARY_LIMIT = 40;
export const DEFAULT_MATCH_LIMIT = 20;
export const SEARCH_SNIPPET_CHARS = 800;
export const FIELD_EVIDENCE_CHARS = 600;
export const DEFAULT_READ_CHARS = 4000;
export const MAX_READ_CHARS = 12000;
```

- [ ] **Step 4: Add text helpers**

Create `packages/extension/src/content/tools/page-index/text.ts`:

```ts
import type { Preview, TruncationInfo } from "./types";

export function visibleText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function normalizeText(s: string): string {
  return visibleText(s)
    .toLowerCase()
    .replace(/[：:|｜,，;；()[\]{}<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeQuery(input: string | string[] | undefined): string[] {
  const joined = Array.isArray(input) ? input.join(" ") : input ?? "";
  const normalized = normalizeText(joined);
  const tokens = normalized.match(/[a-z0-9]+(?:\.[a-z0-9]+)?|[\u4e00-\u9fa5]+[a-z0-9]*|[0-9]+[\u4e00-\u9fa5]+/g);
  return Array.from(new Set(tokens ?? []));
}

export function makePreview(
  text: string,
  maxChars: number,
  ref: string,
  reason: string,
  kind: TruncationInfo["kind"] = "preview"
): Preview {
  const clean = visibleText(text);
  if (clean.length <= maxChars) {
    return {
      text: clean,
      complete: true,
      availableChars: clean.length,
      truncation: {
        kind: "none",
        originalChars: clean.length,
        returnedChars: clean.length,
        reason: "none",
        ref
      }
    };
  }
  const returned = clean.slice(0, maxChars);
  return {
    text: returned,
    complete: false,
    availableChars: clean.length,
    truncation: {
      kind,
      originalChars: clean.length,
      returnedChars: returned.length,
      reason,
      ref
    }
  };
}
```

- [ ] **Step 5: Run test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-text.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/tools/page-index/types.ts packages/extension/src/content/tools/page-index/text.ts packages/extension/tests/content/tools/page-index-text.test.ts
git commit -m "feat(extension): add page index text helpers"
```

---

### Task 3: Build Local Page Index

**Files:**
- Create: `packages/extension/src/content/tools/page-index/build.ts`
- Test: `packages/extension/tests/content/tools/page-index-build.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/extension/tests/content/tools/page-index-build.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { buildPageIndex } from "@/content/tools/page-index/build";

describe("buildPageIndex", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav>Home Search Account Cart</nav>
      <script>window.big = "noise"</script>
      <h1>Leather Bound Journal</h1>
      <section>
        <h2>Product information</h2>
        <table>
          <tr><th>Brand Name</th><td>Hotcinfin</td></tr>
          <tr><th>Best Sellers Rank</th><td>#17,540 in Office Products</td></tr>
        </table>
      </section>
      <dl><dt>Price</dt><dd>$20.99</dd></dl>
      <ul id="bullets"><li>240 pages</li><li>Genuine leather cover</li></ul>
      <form><label for="email">Email</label><input id="email" placeholder="name@example.com" /></form>
    `;
  });

  it("builds bounded blocks from visible page structure", () => {
    const index = buildPageIndex({ maxBlocks: 100 });
    expect(index.url).toBe(location.href);
    expect(index.blocks.some((b) => b.kind === "heading" && b.text === "Leather Bound Journal")).toBe(true);
    expect(index.blocks).toContainEqual(expect.objectContaining({
      kind: "kv",
      label: "Brand Name",
      value: "Hotcinfin"
    }));
    expect(index.blocks.some((b) => b.text.includes("window.big"))).toBe(false);
    expect(index.blocks.some((b) => b.text.includes("Home Search Account"))).toBe(false);
  });

  it("marks index_budget when maxBlocks is reached", () => {
    const index = buildPageIndex({ maxBlocks: 2 });
    expect(index.truncated).toBe(true);
    expect(index.truncation?.kind).toBe("index_budget");
    expect(index.blocks).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-build.test.ts
```

Expected: FAIL because `build.ts` does not exist.

- [ ] **Step 3: Implement DOM scanner**

Create `packages/extension/src/content/tools/page-index/build.ts`:

```ts
import { DEFAULT_MAX_BLOCKS, type PageBlock, type PageBlockKind, type PageIndex } from "./types";
import { normalizeText, visibleText } from "./text";

type BuildArgs = { maxBlocks?: number };

const SKIP_SELECTOR = "script,style,noscript,svg,canvas,iframe,nav,footer,[hidden],[aria-hidden='true'],aipagego-widget";

function makeId(n: number): string {
  return `b${n}`;
}

function cssHint(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${CSS.escape(c)}`).join("");
  return `${el.tagName.toLowerCase()}${cls}`;
}

function headingPathFor(el: Element): string[] {
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"));
  const before = headings.filter((h) => {
    const pos = h.compareDocumentPosition(el);
    return h === el || Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  return before.slice(-3).map((h) => visibleText(h.textContent ?? "")).filter(Boolean);
}

function blockFrom(el: Element, kind: PageBlockKind, text: string, order: number, label?: string, value?: string): PageBlock {
  const clean = visibleText(text);
  return {
    blockId: makeId(order + 1),
    kind,
    text: clean,
    ...(label ? { label: visibleText(label) } : {}),
    ...(value ? { value: visibleText(value) } : {}),
    selectorHint: cssHint(el),
    headingPath: headingPathFor(el),
    order,
    keywords: Array.from(new Set(normalizeText([label, value, clean].filter(Boolean).join(" ")).split(" ").filter(Boolean)))
  };
}

function isSkippable(el: Element): boolean {
  return Boolean(el.closest(SKIP_SELECTOR));
}

function addBlock(blocks: PageBlock[], seen: Set<string>, block: PageBlock): void {
  if (!block.text) return;
  const key = `${block.kind}:${normalizeText(block.label ?? "")}:${normalizeText(block.text)}`;
  if (seen.has(key)) return;
  seen.add(key);
  blocks.push({ ...block, blockId: makeId(blocks.length + 1), order: blocks.length });
}

function collectKvBlocks(blocks: PageBlock[], seen: Set<string>): void {
  for (const tr of Array.from(document.querySelectorAll("tr"))) {
    if (isSkippable(tr)) continue;
    const cells = Array.from(tr.querySelectorAll("th,td"));
    if (cells.length < 2) continue;
    const label = visibleText(cells[0].textContent ?? "");
    const value = visibleText(cells.slice(1).map((c) => c.textContent ?? "").join(" "));
    if (label && value) addBlock(blocks, seen, blockFrom(tr, "kv", `${label} ${value}`, blocks.length, label, value));
  }

  for (const dt of Array.from(document.querySelectorAll("dt"))) {
    if (isSkippable(dt)) continue;
    const dd = dt.nextElementSibling;
    if (!dd || dd.tagName.toLowerCase() !== "dd") continue;
    const label = visibleText(dt.textContent ?? "");
    const value = visibleText(dd.textContent ?? "");
    if (label && value) addBlock(blocks, seen, blockFrom(dt, "kv", `${label} ${value}`, blocks.length, label, value));
  }

  for (const el of Array.from(document.querySelectorAll("[class*='po-'],[class*='field'],[class*='detail']"))) {
    if (isSkippable(el)) continue;
    const text = visibleText(el.textContent ?? "");
    const parts = text.split(/\s{2,}|\n/).map(visibleText).filter(Boolean);
    if (parts.length >= 2) addBlock(blocks, seen, blockFrom(el, "kv", text, blocks.length, parts[0], parts.slice(1).join(" ")));
  }
}

function collectGeneralBlocks(blocks: PageBlock[], seen: Set<string>): void {
  for (const el of Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))) {
    if (!isSkippable(el)) addBlock(blocks, seen, blockFrom(el, "heading", el.textContent ?? "", blocks.length));
  }
  for (const el of Array.from(document.querySelectorAll("li"))) {
    if (!isSkippable(el)) addBlock(blocks, seen, blockFrom(el, "list", el.textContent ?? "", blocks.length));
  }
  for (const el of Array.from(document.querySelectorAll("p,article,section,main"))) {
    if (isSkippable(el)) continue;
    const text = visibleText(el.textContent ?? "");
    if (text.length >= 30 && text.length <= 5000) addBlock(blocks, seen, blockFrom(el, "text", text, blocks.length));
  }
  for (const input of Array.from(document.querySelectorAll("input,textarea,select"))) {
    if (isSkippable(input)) continue;
    const id = input.getAttribute("id");
    const label = id ? visibleText(document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? "") : "";
    const placeholder = input.getAttribute("placeholder") ?? "";
    const name = input.getAttribute("name") ?? "";
    const text = [label, placeholder, name].filter(Boolean).join(" ");
    if (text) addBlock(blocks, seen, blockFrom(input, "form", text, blocks.length, label || name, placeholder));
  }
}

export function buildPageIndex(args: BuildArgs = {}): PageIndex {
  const maxBlocks = Math.max(1, args.maxBlocks ?? DEFAULT_MAX_BLOCKS);
  const allBlocks: PageBlock[] = [];
  const seen = new Set<string>();
  collectKvBlocks(allBlocks, seen);
  collectGeneralBlocks(allBlocks, seen);

  const blocks = allBlocks.slice(0, maxBlocks);
  const truncated = allBlocks.length > maxBlocks;
  return {
    indexId: `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url: location.href,
    title: document.title,
    createdAt: Date.now(),
    blocks,
    truncated,
    ...(truncated
      ? {
          truncation: {
            kind: "index_budget" as const,
            originalChars: allBlocks.length,
            returnedChars: blocks.length,
            reason: "maxBlocks",
            ref: "index"
          }
        }
      : {})
  };
}
```

- [ ] **Step 4: Run build tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-build.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/src/content/tools/page-index/build.ts packages/extension/tests/content/tools/page-index-build.test.ts
git commit -m "feat(extension): build local page index"
```

---

### Task 4: Index Store, Search, and Field Extraction

**Files:**
- Create: `packages/extension/src/content/tools/page-index/store.ts`
- Create: `packages/extension/src/content/tools/page-index/search.ts`
- Test: `packages/extension/tests/content/tools/page-index-search.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/extension/tests/content/tools/page-index-search.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { buildPageIndex } from "@/content/tools/page-index/build";
import { extractFields, searchIndex } from "@/content/tools/page-index/search";

describe("page-index search", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <h1>Leather Bound Journal</h1>
      <table>
        <tr><th>Brand Name</th><td>Hotcinfin</td></tr>
        <tr><th>Best Sellers Rank</th><td>#17,540 in Office Products</td></tr>
        <tr><th>ASIN</th><td>B09877P9CF</td></tr>
      </table>
      <div class="price-row"><span>Price</span><span>$20.99</span></div>
      <div id="social-proofing-faceout-title-tk_bought">300+ bought in past month</div>
      <ul><li>240 pages</li><li>Soft genuine leather cover</li></ul>
    `;
  });

  it("searches index with bounded snippets and block ids", () => {
    const index = buildPageIndex();
    const result = searchIndex(index, { query: "Best Sellers Rank", limit: 5 });
    expect(result.matches[0]).toEqual(expect.objectContaining({
      blockId: expect.stringMatching(/^b/),
      label: "Best Sellers Rank"
    }));
    expect(result.matches[0].text.length).toBeLessThanOrEqual(800);
  });

  it("extracts generic field candidates with evidence", () => {
    const index = buildPageIndex();
    const result = extractFields(index, {
      fields: ["Asin", "品牌", "价格", "排名", "30天销量"],
      maxCandidatesPerField: 3
    });
    const byField = Object.fromEntries(result.fields.map((f) => [f.field, f]));
    expect(byField.Asin.candidates[0].value).toBe("B09877P9CF");
    expect(byField["品牌"].candidates[0].value).toBe("Hotcinfin");
    expect(byField["排名"].candidates[0].evidence).toContain("#17,540");
    expect(byField["30天销量"].candidates[0].evidence).toContain("300+ bought");
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-search.test.ts
```

Expected: FAIL because `search.ts` does not exist.

- [ ] **Step 3: Implement store**

Create `packages/extension/src/content/tools/page-index/store.ts`:

```ts
import { buildPageIndex } from "./build";
import { DEFAULT_MAX_BLOCKS, type PageIndex } from "./types";

let current: PageIndex | null = null;

export function getPageIndex(args: { maxBlocks?: number; refresh?: boolean } = {}): PageIndex {
  if (!current || current.url !== location.href || args.refresh) {
    current = buildPageIndex({ maxBlocks: args.maxBlocks ?? DEFAULT_MAX_BLOCKS });
  }
  return current;
}

export function findBlock(blockId: string): { index: PageIndex; block: PageIndex["blocks"][number] | null } {
  const index = getPageIndex();
  return { index, block: index.blocks.find((b) => b.blockId === blockId) ?? null };
}

export function clearPageIndexForTests(): void {
  current = null;
}
```

- [ ] **Step 4: Implement search and extraction**

Create `packages/extension/src/content/tools/page-index/search.ts`:

```ts
import { FIELD_EVIDENCE_CHARS, SEARCH_SNIPPET_CHARS, type PageBlock, type PageIndex } from "./types";
import { makePreview, normalizeText, tokenizeQuery } from "./text";

type SearchArgs = { query?: string; fields?: string[]; limit?: number };
type ExtractArgs = { fields: string[]; maxCandidatesPerField?: number };

const FIELD_ALIASES: Record<string, string[]> = {
  asin: ["asin", "ASIN"],
  "品牌": ["品牌", "brand", "brand name", "manufacturer"],
  brand: ["brand", "brand name", "manufacturer", "品牌"],
  "价格": ["价格", "price", "$"],
  price: ["price", "$", "价格"],
  "评分": ["rating", "ratings", "reviews", "customer reviews", "评分", "评论"],
  ratings: ["rating", "ratings", "reviews", "customer reviews", "评分", "评论"],
  "排名": ["rank", "ranking", "best sellers rank", "排名"],
  rank: ["rank", "ranking", "best sellers rank", "排名"],
  "30天销量": ["bought in past month", "past month", "30天销量", "销量"],
  "上架时间": ["date first available", "available", "发布日期", "上架时间"],
  "库存": ["stock", "availability", "in stock", "库存", "开售"]
};

function aliasesFor(field: string): string[] {
  const normalized = normalizeText(field);
  return FIELD_ALIASES[field] ?? FIELD_ALIASES[normalized] ?? [field];
}

function scoreBlock(block: PageBlock, tokens: string[]): number {
  const haystack = normalizeText([block.label, block.value, block.text, ...block.headingPath].filter(Boolean).join(" "));
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (normalizeText(block.label ?? "") === token) score += 12;
    if (haystack.includes(token)) score += block.kind === "kv" ? 8 : 3;
  }
  if (block.kind === "kv") score += 4;
  if (block.kind === "heading") score += 1;
  return score;
}

function toMatch(block: PageBlock, score: number) {
  const preview = makePreview(block.text, SEARCH_SNIPPET_CHARS, block.blockId, "search_match");
  return {
    blockId: block.blockId,
    kind: block.kind,
    score,
    ...(block.label ? { label: block.label } : {}),
    text: preview.text,
    complete: preview.complete,
    availableChars: preview.availableChars,
    selectorHint: block.selectorHint,
    truncation: preview.truncation
  };
}

export function searchIndex(index: PageIndex, args: SearchArgs) {
  const tokens = tokenizeQuery([args.query ?? "", ...(args.fields ?? [])]);
  const scored = index.blocks
    .map((block) => ({ block, score: scoreBlock(block, tokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.block.order - b.block.order)
    .slice(0, args.limit ?? 20)
    .map((item) => toMatch(item.block, item.score));

  return { indexId: index.indexId, matches: scored };
}

function valueFor(block: PageBlock, field: string): string {
  if (block.value) return block.value;
  const label = block.label ? normalizeText(block.label) : "";
  const text = block.text;
  if (label && normalizeText(text).startsWith(label)) {
    return text.slice(block.label!.length).trim();
  }
  if (/price|价格/i.test(field)) {
    const price = text.match(/\$[0-9]+(?:\.[0-9]{2})?/);
    if (price) return price[0];
  }
  if (/asin/i.test(field)) {
    const asin = text.match(/\b[A-Z0-9]{10}\b/);
    if (asin) return asin[0];
  }
  return text;
}

export function extractFields(index: PageIndex, args: ExtractArgs) {
  const max = args.maxCandidatesPerField ?? 4;
  const fields = args.fields.map((field) => {
    const tokens = tokenizeQuery(aliasesFor(field));
    const candidates = index.blocks
      .map((block) => ({ block, score: scoreBlock(block, tokens) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.block.order - b.block.order)
      .slice(0, max)
      .map(({ block, score }) => {
        const preview = makePreview(block.text, FIELD_EVIDENCE_CHARS, block.blockId, "field_evidence", "evidence_budget");
        return {
          value: valueFor(block, field),
          confidence: Math.min(0.95, 0.45 + score / 40),
          source: block.kind === "kv" ? "label-neighbor" : "text-match",
          blockId: block.blockId,
          ...(block.label ? { label: block.label } : {}),
          evidence: preview.text,
          complete: preview.complete,
          truncation: preview.truncation
        };
      });
    return { field, candidates };
  });

  return {
    indexId: index.indexId,
    fields,
    missing: fields.filter((f) => f.candidates.length === 0).map((f) => f.field)
  };
}
```

- [ ] **Step 5: Run search tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-search.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/tools/page-index/store.ts packages/extension/src/content/tools/page-index/search.ts packages/extension/tests/content/tools/page-index-search.test.ts
git commit -m "feat(extension): search page index fields"
```

---

### Task 5: Content Tool Handlers and Registry

**Files:**
- Create: `packages/extension/src/content/tools/page-index.ts`
- Modify: `packages/extension/src/content/tools/index.ts`
- Test: `packages/extension/tests/content/tools/page-index.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/extension/tests/content/tools/page-index.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { callTool } from "@/content/tools";
import { clearPageIndexForTests } from "@/content/tools/page-index/store";

describe("page-index content tools", () => {
  beforeEach(() => {
    clearPageIndexForTests();
    document.body.innerHTML = `
      <h1>Leather Bound Journal</h1>
      <table>
        <tr><th>ASIN</th><td>B09877P9CF</td></tr>
        <tr><th>Brand Name</th><td>Hotcinfin</td></tr>
      </table>
      <p>${"Long evidence ".repeat(1000)}</p>
    `;
  });

  it("creates, searches, reads, and extracts through the registry", async () => {
    const created = await callTool("createPageIndex", { maxBlocks: 100 }) as Record<string, unknown>;
    expect(created.ok).toBe(true);
    expect(created.blockCount).toBeGreaterThan(0);

    const searched = await callTool("searchPageIndex", { query: "ASIN", limit: 5 }) as { matches: Array<{ blockId: string; text: string }> };
    expect(searched.matches[0].text).toContain("B09877P9CF");

    const read = await callTool("readPageBlock", { blockId: searched.matches[0].blockId, maxChars: 20 }) as Record<string, unknown>;
    expect(read.blockId).toBe(searched.matches[0].blockId);
    expect(read.truncation).toBeTruthy();

    const fields = await callTool("extractPageFields", { fields: ["Asin", "品牌"] }) as { fields: Array<{ field: string; candidates: Array<{ value: string }> }> };
    expect(fields.fields.find((f) => f.field === "Asin")?.candidates[0].value).toBe("B09877P9CF");
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index.test.ts
```

Expected: FAIL because handlers are not registered.

- [ ] **Step 3: Implement tool handlers**

Create `packages/extension/src/content/tools/page-index.ts`:

```ts
import type { Json } from "@aipagego/shared/types";
import { getPageIndex, findBlock } from "./page-index/store";
import { extractFields, searchIndex } from "./page-index/search";
import { DEFAULT_MATCH_LIMIT, DEFAULT_READ_CHARS, DEFAULT_SUMMARY_LIMIT, MAX_READ_CHARS } from "./page-index/types";
import { makePreview } from "./page-index/text";

type CreateArgs = { maxBlocks?: number; refresh?: boolean; summaryLimit?: number };
type SearchArgs = { query?: string; fields?: string[]; limit?: number; maxBlocks?: number };
type ReadArgs = { blockId: string; offset?: number; maxChars?: number; includeNeighbors?: boolean };
type ExtractArgs = { fields: string[]; maxCandidatesPerField?: number; maxBlocks?: number };

function kindCounts(index: ReturnType<typeof getPageIndex>): Record<string, number> {
  return index.blocks.reduce<Record<string, number>>((acc, block) => {
    acc[block.kind] = (acc[block.kind] ?? 0) + 1;
    return acc;
  }, {});
}

export async function createPageIndex(args: Json): Promise<Json> {
  const input = (args ?? {}) as CreateArgs;
  const index = getPageIndex({ maxBlocks: input.maxBlocks, refresh: input.refresh });
  const summaryLimit = input.summaryLimit ?? DEFAULT_SUMMARY_LIMIT;
  return {
    ok: true,
    indexId: index.indexId,
    url: index.url,
    title: index.title,
    blockCount: index.blocks.length,
    kinds: kindCounts(index),
    summary: index.blocks.slice(0, summaryLimit).map((block) => ({
      blockId: block.blockId,
      kind: block.kind,
      ...(block.label ? { label: block.label } : {}),
      text: makePreview(block.text, 240, block.blockId, "summary").text
    })),
    truncated: index.truncated,
    truncation: index.truncation ?? {
      kind: "none",
      originalChars: index.blocks.length,
      returnedChars: index.blocks.length,
      reason: "none",
      ref: "index"
    }
  };
}

export async function searchPageIndex(args: Json): Promise<Json> {
  const input = (args ?? {}) as SearchArgs;
  const index = getPageIndex({ maxBlocks: input.maxBlocks });
  return searchIndex(index, { query: input.query, fields: input.fields, limit: input.limit ?? DEFAULT_MATCH_LIMIT });
}

export async function readPageBlock(args: Json): Promise<Json> {
  const input = (args ?? {}) as ReadArgs;
  const { index, block } = findBlock(input.blockId);
  if (!block) {
    return { error: "block_not_found", indexId: index.indexId, blockId: input.blockId };
  }
  const offset = Math.max(0, input.offset ?? 0);
  const maxChars = Math.min(MAX_READ_CHARS, Math.max(1, input.maxChars ?? DEFAULT_READ_CHARS));
  const text = block.text.slice(offset, offset + maxChars);
  const hasMore = offset + maxChars < block.text.length;
  const neighbors = input.includeNeighbors
    ? index.blocks
        .filter((b) => Math.abs(b.order - block.order) <= 1 && b.blockId !== block.blockId)
        .map((b) => ({ blockId: b.blockId, ...(b.label ? { label: b.label } : {}), text: makePreview(b.text, 240, b.blockId, "neighbor").text }))
    : undefined;
  return {
    blockId: block.blockId,
    kind: block.kind,
    ...(block.label ? { label: block.label } : {}),
    text,
    offset,
    hasMore,
    ...(neighbors ? { neighbors } : {}),
    truncation: {
      kind: hasMore ? "page" : "none",
      originalChars: block.text.length,
      returnedChars: text.length,
      reason: hasMore ? "readPageBlock.maxChars" : "none",
      ref: block.blockId
    }
  };
}

export async function extractPageFields(args: Json): Promise<Json> {
  const input = (args ?? {}) as ExtractArgs;
  const index = getPageIndex({ maxBlocks: input.maxBlocks });
  return extractFields(index, { fields: input.fields ?? [], maxCandidatesPerField: input.maxCandidatesPerField });
}
```

- [ ] **Step 4: Register tools**

Modify `packages/extension/src/content/tools/index.ts`:

```ts
import { createPageIndex, extractPageFields, readPageBlock, searchPageIndex } from "./page-index";
```

Add to `TOOLS` after `writeStorage`:

```ts
  writeStorage,
  // Page Context Index
  createPageIndex,
  searchPageIndex,
  readPageBlock,
  extractPageFields
```

- [ ] **Step 5: Run registry tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/src/content/tools/page-index.ts packages/extension/src/content/tools/index.ts packages/extension/tests/content/tools/page-index.test.ts
git commit -m "feat(extension): register page index tools"
```

---

### Task 6: LLM Tool Definitions and Prompt Guidance

**Files:**
- Modify: `packages/shared/src/llm/builtin-tool-defs.ts`
- Modify: `packages/extension/src/sidepanel/llm/system-prompt.ts`
- Test: `packages/extension/tests/sidepanel/llm/tool-schema.test.ts` if present; otherwise create `packages/extension/tests/sidepanel/llm/page-index-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/extension/tests/sidepanel/llm/page-index-tools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { TOOL_DEFS } from "@/sidepanel/llm/tool-schema";
import { buildSystemPrompt } from "@/sidepanel/llm/system-prompt";

describe("page index LLM guidance", () => {
  it("exposes page-index tools to the model", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "createPageIndex",
      "searchPageIndex",
      "readPageBlock",
      "extractPageFields"
    ]));
  });

  it("discourages broad extractText body reads", () => {
    const extract = TOOL_DEFS.find((t) => t.name === "extractText");
    expect(extract?.description).toContain("不要优先读取 body");
  });

  it("system prompt recommends page-index workflow for extraction", () => {
    const prompt = buildSystemPrompt({ url: "https://x.test", title: "X", savedTools: [], attachedTabs: [] });
    expect(prompt).toContain("createPageIndex");
    expect(prompt).toContain("extractPageFields");
  });
});
```

- [ ] **Step 2: Run failing test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/llm/page-index-tools.test.ts
```

Expected: FAIL because tools and prompt guidance are missing.

- [ ] **Step 3: Add four tool definitions**

In `packages/shared/src/llm/builtin-tool-defs.ts`, insert the following after `extractText`:

```ts
  {
    name: "createPageIndex",
    description:
      "[PAGE-INDEX][READ-FIRST] 为当前页面创建本地轻量索引，返回页面结构摘要和 blockId，不返回全文。用于网页阅读、字段提取、采集任务的首选入口。",
    input_schema: {
      type: "object",
      properties: {
        maxBlocks: { type: "integer", default: 600, description: "最多索引多少个高信号块" },
        refresh: { type: "boolean", default: false, description: "强制重建索引" },
        summaryLimit: { type: "integer", default: 40 },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "searchPageIndex",
    description:
      "[PAGE-INDEX] 在本地页面索引中搜索关键词/字段，返回小证据片段、blockId、truncation 元数据。不要用 extractText(body) 来搜索大页面。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        fields: { type: "array", items: { type: "string" } },
        limit: { type: "integer", default: 20 },
        maxBlocks: { type: "integer", default: 600 },
        tabId: TAB_ID_FIELD,
      },
    },
  },
  {
    name: "readPageBlock",
    description:
      "[PAGE-INDEX] 按 blockId 读取局部内容；长内容按 offset/maxChars 分页，返回 hasMore 和 truncation 日志。只在 searchPageIndex/extractPageFields 证据不足时使用。",
    input_schema: {
      type: "object",
      properties: {
        blockId: { type: "string" },
        offset: { type: "integer", default: 0 },
        maxChars: { type: "integer", default: 4000 },
        includeNeighbors: { type: "boolean", default: false },
        tabId: TAB_ID_FIELD,
      },
      required: ["blockId"],
    },
  },
  {
    name: "extractPageFields",
    description:
      "[PAGE-INDEX][FIELD-FIRST] 通用字段候选提取：输入字段名数组，返回 value candidates、confidence、evidence、blockId、truncation。适合商品信息、文章元信息、表格详情、表单字段等结构化提取。",
    input_schema: {
      type: "object",
      properties: {
        fields: { type: "array", items: { type: "string" } },
        maxCandidatesPerField: { type: "integer", default: 4 },
        maxBlocks: { type: "integer", default: 600 },
        tabId: TAB_ID_FIELD,
      },
      required: ["fields"],
    },
  },
```

Also update the `extractText` description by appending:

```ts
      "普通网页理解/字段提取时，不要优先读取 body；先用 createPageIndex + extractPageFields/searchPageIndex。"
```

- [ ] **Step 4: Update system prompt**

In `packages/extension/src/sidepanel/llm/system-prompt.ts`, add guidance near the tool-selection section:

```ts
const PAGE_INDEX_GUIDANCE = [
  "页面阅读/采集策略：",
  "- 对普通网页理解、字段提取、商品信息、文章信息、表格信息，优先使用 createPageIndex。",
  "- 已有索引后，用 extractPageFields 一次性提取用户要求的字段；用 searchPageIndex 找关键词证据；必要时 readPageBlock 读取局部 block。",
  "- 不要把 extractText({selector:'body'}) 或大范围 snapshotDOM 作为首选；它们只作为页面索引无法回答时的最后手段。",
  "- 如果工具返回 truncation/hasMore，优先根据 blockId、query、offset 定向读取，不要盲目重复读取整页。"
].join("\n");
```

Include `${PAGE_INDEX_GUIDANCE}` in the returned system prompt.

- [ ] **Step 5: Run LLM guidance tests**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/llm/page-index-tools.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/llm/builtin-tool-defs.ts packages/extension/src/sidepanel/llm/system-prompt.ts packages/extension/tests/sidepanel/llm/page-index-tools.test.ts
git commit -m "feat(llm): prefer page index tools"
```

---

### Task 7: Chat Regression for Efficient Extraction

**Files:**
- Modify: `packages/extension/tests/sidepanel/chat/run-session.test.ts`

- [ ] **Step 1: Write failing regression test**

Add this test near the existing `runChatSession` tests:

```ts
it("can complete multi-field page extraction through page-index tools without broad body reads", async () => {
  const streamCalls: unknown[] = [];
  const client = makeCapturingClient(
    [
      [
        { type: "tool_use_start", id: "idx", name: "createPageIndex" },
        { type: "tool_use_input_delta", id: "idx", partial_json: "{}" },
        { type: "tool_use_end", id: "idx", input: {} },
        { type: "tool_use_start", id: "fields", name: "extractPageFields" },
        { type: "tool_use_input_delta", id: "fields", partial_json: "{\"fields\":[\"Asin\",\"品牌\",\"价格\",\"排名\"]}" },
        { type: "tool_use_end", id: "fields", input: { fields: ["Asin", "品牌", "价格", "排名"] } },
        { type: "message_end" }
      ],
      [
        { type: "text_delta", text: "最终结果：ASIN B09877P9CF，品牌 Hotcinfin，价格 $20.99，排名 #17,540。" },
        { type: "message_end" }
      ]
    ],
    streamCalls
  );
  const runner = makeRunner(async (step) => {
    if (step.kind === "tool" && step.tool === "createPageIndex") {
      return { ok: true, indexId: "pi_1", blockCount: 12, summary: [] };
    }
    if (step.kind === "tool" && step.tool === "extractPageFields") {
      return {
        indexId: "pi_1",
        fields: [
          { field: "Asin", candidates: [{ value: "B09877P9CF", blockId: "b1", evidence: "ASIN B09877P9CF" }] }
        ],
        missing: []
      };
    }
    throw new Error(`unexpected tool: ${step.kind === "tool" ? step.tool : "js"}`);
  });
  const result = await runChatSession({
    client,
    runner,
    approver: new Approver(),
    rpc: {
      startSession: vi.fn().mockResolvedValue({ id: "r" }),
      appendStepLog: vi.fn().mockResolvedValue(null),
      finalizeSession: vi.fn().mockResolvedValue(null)
    },
    input: { userPrompt: "提取商品字段", tabId: 1, url: "u" },
    settings: { provider: "anthropic", model: "m", apiKey: "k", apiKeyMode: "session", maxRounds: 5, trustedDangerTools: [], defaultPermissionMode: "default", theme: "dark", selfHealEnabled: true, maxSelfHealOutputTokens: 4096, widgetEnabled: true },
    systemPrompt: "sys",
    tools: [],
    permissionMode: "default"
  });

  expect(result.status).toBe("done");
  expect(result.executedSteps.map((s) => s.kind === "tool" ? s.tool : "js")).toEqual([
    "createPageIndex",
    "extractPageFields"
  ]);
  expect(JSON.stringify(streamCalls)).not.toContain("\"selector\":\"body\"");
});
```

- [ ] **Step 2: Run regression test**

Run:

```bash
pnpm --filter @aipagego/extension test -- tests/sidepanel/chat/run-session.test.ts
```

Expected: PASS after Tasks 1-6; if it fails, fix only the mismatch exposed by the test.

- [ ] **Step 3: Commit**

```bash
git add packages/extension/tests/sidepanel/chat/run-session.test.ts
git commit -m "test(chat): cover page index extraction path"
```

---

### Task 8: Verification and Build

**Files:**
- No planned source edits.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --filter @aipagego/shared test -- tests/messages.test.ts
pnpm --filter @aipagego/extension test -- tests/content/tools/page-index-text.test.ts tests/content/tools/page-index-build.test.ts tests/content/tools/page-index-search.test.ts tests/content/tools/page-index.test.ts tests/sidepanel/llm/page-index-tools.test.ts tests/sidepanel/chat/run-session.test.ts
```

Expected: all tests PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: all four workspace packages pass `tsc --noEmit`.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm build
```

Expected: Vite builds `packages/extension/dist/` successfully.

- [ ] **Step 4: Commit any verification-only fixes**

Only if Steps 1-3 required small fixes:

```bash
git add <changed-files>
git commit -m "fix: stabilize page index implementation"
```

---

## Self-Review

- Spec coverage: The plan covers all four tools, in-memory local index, deterministic matching, structured references, truncation diagnostics, LLM guidance, and regression tests. The fallback `runChatSession` truncation remains unchanged.
- Scope: The plan stays generic and does not include Amazon-specific selectors or marketplace logic.
- Placeholder scan: No `TBD`, `TODO`, or "implement later" placeholders are used in task instructions.
- Type consistency: Tool names match the spec exactly: `createPageIndex`, `searchPageIndex`, `readPageBlock`, `extractPageFields`. Truncation fields use `kind`, `originalChars`, `returnedChars`, `reason`, and `ref`.
