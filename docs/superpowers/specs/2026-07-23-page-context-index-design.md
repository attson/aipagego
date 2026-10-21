# Page Context Index Design

**Status:** implemented in v0.0.53. The core page-index tools shipped with two
adjacent UX/runtime additions: targeted visual evidence
(`screenshot({blockId,indexId})`) and generated `.xlsx` export
(`downloadSpreadsheet`). Those additions are documented here because they are
part of the same user-facing direction: keep bulky page/file data local, pass
small references or generated artifacts across the model boundary.

## Problem

AIPageGo currently lets the model inspect pages through generic tools such as
`extractText`, `querySelectorAll`, and `snapshotDOM`. On large dynamic pages this
leads to two bad patterns:

- The model asks for broad selectors such as `body`, producing megabyte-scale
  tool outputs that are expensive to store, display, and feed back.
- After context truncation, the model loses stable evidence and compensates with
  many repeated selector probes.

The July 23 Amazon diagnostic run is the reference failure: a product extraction
task finished without a context-window error, but still ran 25 LLM rounds, 77
tool cards, and 72 executed steps. This is a tooling problem, not a prompt-size
problem. The page should be treated as a local searchable data source, and the
model should receive only small evidence slices.

## Goals

- Add a generic page-index layer that works for ecommerce pages, articles,
  tables, forms, dashboards, and other normal webpages.
- Keep full page text and DOM-derived data inside the content script; do not
  send full `body` text or full DOM to the model by default.
- Let the model discover page structure, search for fields, and read local
  blocks by stable ids.
- Make multi-field extraction tasks complete in a small number of tool calls
  when the information is present in visible DOM.
- Preserve existing tools for compatibility, but make the new tools the
  preferred path in LLM tool descriptions and system prompt guidance.
- Let low-confidence extraction use local visual evidence without asking the
  model to inspect a full-page screenshot blindly.
- Let structured collection tasks end in a downloadable `.xlsx` file instead
  of pasting large tables into chat.

## Non-Goals

- No Amazon-specific parser, selector list, or marketplace-specific rule set.
- No external search, remote embedding service, or new dependency.
- No persistent IndexedDB index. The index is per-tab, in-memory, and rebuilt
  after navigation or reload.
- No semantic vector search in the first version. Matching is deterministic
  keyword, label, table, list, and neighborhood scoring.
- No spreadsheet dependency. The initial `.xlsx` writer is a minimal internal
  ZIP/XML generator for generated collection outputs, not a full Excel engine.

## Tool Surface

Four new `BuiltinTool` values are added:

### `createPageIndex`

Builds or refreshes an in-memory index for the target tab.

Input:

```json
{
  "tabId": 123,
  "maxBlocks": 600
}
```

Output:

```json
{
  "ok": true,
  "indexId": "pi_...",
  "url": "https://example.com/item",
  "title": "Example",
  "blockCount": 148,
  "kinds": { "heading": 8, "kv": 34, "table": 11, "list": 42, "form": 6, "text": 47 },
  "summary": [
    { "blockId": "b1", "kind": "heading", "label": "Product information", "text": "Product information" },
    { "blockId": "b2", "kind": "kv", "label": "Price", "text": "$20.99" }
  ],
  "truncated": false
}
```

`summary` is intentionally small. It gives the model a map, not the page.

### `searchPageIndex`

Searches the local index and returns small matching evidence snippets.

Input:

```json
{
  "query": "price rating best sellers rank bought in past month",
  "fields": ["价格", "评分", "排名", "30天销量"],
  "limit": 20,
  "tabId": 123
}
```

Output:

```json
{
  "indexId": "pi_...",
  "matches": [
    {
      "blockId": "b14",
      "kind": "kv",
      "score": 14,
      "label": "Best Sellers Rank",
      "text": "#17,540 in Office Products #76 in Personal Organizers",
      "selectorHint": "#productDetails_expanderSectionTables tr:nth-of-type(5)"
    }
  ]
}
```

### `readPageBlock`

Reads one indexed block, with local pagination for long blocks.

Input:

```json
{
  "blockId": "b14",
  "offset": 0,
  "maxChars": 4000,
  "includeNeighbors": true,
  "tabId": 123
}
```

Output:

```json
{
  "blockId": "b14",
  "kind": "kv",
  "label": "Best Sellers Rank",
  "text": "#17,540 in Office Products #76 in Personal Organizers",
  "offset": 0,
  "hasMore": false,
  "neighbors": [
    { "blockId": "b13", "label": "UPC", "text": "682601598478" },
    { "blockId": "b15", "label": "ASIN", "text": "B09877P9CF" }
  ]
}
```

### `extractPageFields`

Runs deterministic field-candidate extraction over the local index. The model
provides desired fields; the tool returns candidates and evidence.

Input:

```json
{
  "fields": ["Asin", "品牌", "价格", "上架时间", "Ratings", "30天销量"],
  "maxCandidatesPerField": 4,
  "tabId": 123
}
```

Output:

```json
{
  "indexId": "pi_...",
  "fields": [
    {
      "field": "价格",
      "candidates": [
        {
          "value": "$20.99",
          "confidence": 0.86,
          "source": "label-neighbor",
          "blockId": "b2",
          "label": "Price",
          "evidence": "Price $20.99"
        }
      ]
    }
  ],
  "missing": ["上架时间"]
}
```

The tool does not claim final truth. It provides ranked candidates so the model
can resolve conflicts, mark uncertainty, and format the answer.

### `screenshot` targeted evidence extension

`screenshot` keeps its existing no-argument viewport capture behavior, but also
accepts page-index references:

```json
{
  "blockId": "b14",
  "indexId": "pi_...",
  "highlightMs": 1500
}
```

The sidepanel handler resolves the block through `readPageBlock`, scrolls the
block's `selectorHint` into view, applies a temporary highlight, captures the
visible tab, and returns image data plus target metadata. This is intended for
cases where field candidates conflict or visual ownership matters.

### `downloadSpreadsheet`

Collection tasks can produce a real `.xlsx` via the sidepanel meta tool:

```json
{
  "filename": "products.xlsx",
  "sheets": [
    {
      "name": "Products",
      "columns": [
        { "key": "title", "header": "标题" },
        { "key": "price", "header": "价格" }
      ],
      "rows": [
        { "title": "A", "price": 12 }
      ]
    }
  ]
}
```

The implementation is intentionally sidepanel-only and excluded from
replayable saved steps. It uses `chrome.downloads` and `sidepanel/lib/xlsx.ts`;
moving it into replayable background tools requires a separate design.

## Index Model

The index is built from visible DOM plus selected structural metadata:

- Headings: `h1`-`h6`, elements with heading-like role/classes, prominent title
  nodes.
- Key-value rows: table rows, definition lists, product overview rows, settings
  rows, label/value pairs, `th/td`, `dt/dd`, and adjacent text nodes.
- Lists: `li`, repeated cards, bullet sections.
- Tables: row text plus cell-level label/value extraction.
- Forms: labels, placeholders, names, selected values.
- Text blocks: visible paragraphs and section containers after script/style/nav
  noise removal.
- Media hints: image alt/title/src basename only; no binary content.

Each block stores:

- `blockId`
- `kind`
- normalized `text`
- optional `label` and `value`
- selector hint
- DOM path depth and visible order
- nearby heading breadcrumbs
- token-like keywords derived locally

Large blocks are capped internally per block, but the full source element can be
re-read through `readPageBlock` with pagination when needed.

## Truncation and References

The page-index tools must not expose truncation as broken prose. A response like
`abc...[truncated 100000 chars]...xyz` gives the model partial content and
encourages blind follow-up reads. Truncation is represented as structured
metadata instead.

When any indexed block, search match, or field evidence exceeds the response
budget, the tool returns a bounded preview plus a stable reference:

```json
{
  "blockId": "b42",
  "preview": "First relevant snippet...",
  "complete": false,
  "availableChars": 1354006,
  "read": {
    "tool": "readPageBlock",
    "args": { "blockId": "b42", "offset": 0, "maxChars": 4000 }
  },
  "recommendedNext": [
    { "tool": "searchPageIndex", "args": { "query": "Date First Available", "limit": 5 } },
    { "tool": "readPageBlock", "args": { "blockId": "b42", "offset": 4000, "maxChars": 4000 } }
  ]
}
```

Rules:

- The model should see `complete: false`, `availableChars`, and a concrete
  follow-up read path, not a fake complete text.
- Search and field extraction should prefer returning several small evidence
  snippets over one large truncated block.
- `readPageBlock` is the only tool that pages through large content by
  `offset`. Other tools return previews and references.
- When a field candidate comes from a large block, `evidence` is capped and
  accompanied by `blockId` so the model can inspect the source only if needed.
- Existing broad-context truncation in `runChatSession` remains a last-resort
  safety valve. New page-index tools should avoid producing large LLM-facing
  strings in the first place.

Every intentional truncation also emits machine-readable diagnostics in the
tool output:

```json
{
  "truncation": {
    "kind": "preview",
    "originalChars": 1354006,
    "returnedChars": 4000,
    "reason": "block_budget",
    "ref": "b42"
  }
}
```

`truncation.kind` values:

- `none` — no truncation happened.
- `preview` — a long block was represented by a bounded preview and a `blockId`.
- `page` — `readPageBlock` returned one page of a larger block and `hasMore`
  is true.
- `index_budget` — the index skipped lower-signal blocks after reaching
  `maxBlocks`.
- `evidence_budget` — field/search evidence was shortened but remains linked to
  `blockId`.

Diagnostics are duplicated into step logs through the normal tool output path,
so the logs view and exported diagnostic bundle can show why content was
bounded. UI can later render a small "已裁剪，可继续读取" marker from the same
metadata, but the first implementation only needs to preserve the structured
fields in tool output and exports.

## Matching Rules

First version matching is deterministic:

- Normalize case, whitespace, punctuation, full-width/half-width variants, and
  common Chinese/English field aliases.
- Score exact label match highest.
- Score label-neighbor matches above raw text matches.
- Score table and key-value blocks above generic text blocks for field
  extraction.
- Penalize navigation, footer, hidden, script/style text, extension UI, and very
  large generic containers.
- Deduplicate near-identical snippets by normalized text.

Alias groups are generic, not site-specific. Examples:

- `price`, `价格`
- `rating`, `ratings`, `评分`, `评论数量`, `reviews`
- `rank`, `ranking`, `排名`
- `date`, `available`, `上架时间`, `发布日期`
- `stock`, `availability`, `库存`, `开售`
- `brand`, `品牌`

## LLM Guidance

The tool descriptions and system prompt are updated so the model uses this
order for page reading:

1. `createPageIndex`
2. `extractPageFields` or `searchPageIndex`
3. `readPageBlock` for targeted evidence
4. Existing `extractText` / `querySelectorAll` / `snapshotDOM` only when the
   index cannot answer the task

`extractText` remains available but its description will warn against broad
selectors such as `body` for ordinary extraction tasks.

## Error Handling

- `searchPageIndex`, `readPageBlock`, and `extractPageFields` lazily create an
  index if none exists for the current URL.
- If the URL changes, the old index is invalidated and rebuilt.
- Missing `blockId` returns a structured error with the current `indexId`.
- If the page has too many blocks, `createPageIndex` returns `truncated: true`
  and indexes the highest-signal blocks first.
- If no field candidate is found, the field is listed in `missing`; the model
  should not invent a value.

## Data Flow

1. User asks a page extraction question.
2. `runChatSession` presents new tool definitions.
3. Model calls `createPageIndex`.
4. Content script scans DOM and stores index in module memory.
5. Model calls `extractPageFields` for requested fields.
6. Content script returns small ranked candidates with evidence snippets.
7. Model optionally calls `readPageBlock` for ambiguous candidates.
8. Model returns final answer with missing/uncertain fields marked.

The LLM context receives only compact summaries and evidence. The large page
state remains in the content script.

## Testing

Unit tests:

- `createPageIndex` ignores script/style/nav noise and returns bounded summary.
- `searchPageIndex` finds article headings, product-like key-value rows, and
  table cells without returning entire `body`.
- `readPageBlock` paginates long blocks and returns neighbors.
- `extractPageFields` finds fields from table rows, definition lists,
  label/value divs, bullet lists, and form labels.
- Missing fields are reported as missing, not guessed.

Integration tests:

- Builtin tool union, `StepSchema`, tool registry, and LLM `TOOL_DEFS` stay in
  sync.
- `runChatSession` can complete a multi-field extraction by using page-index
  tools rather than `extractText(body)` in a scripted LLM test.

Regression target:

- A product-like fixture with title, price, rating, BSR-like rank, stock,
  social proof, variants, details, and bullets should be answerable with
  `createPageIndex` + `extractPageFields` + at most one `readPageBlock`.

## Rollout

This is additive. Existing saved tools and coordinator EXEC continue to work.
No migration is required.

After implementation, broad-context truncation remains as a safety valve, not as
the primary page-reading strategy.
