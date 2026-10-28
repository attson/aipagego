import { beforeEach, describe, expect, it } from "vitest";
import type { CollectionRecipeV1 } from "@aipagego/shared/collection";
import { extractCollectionPage, extractCollectionPreview } from "@/content/collection-preview";

function recipe(overrides: Partial<CollectionRecipeV1> = {}): CollectionRecipeV1 {
  return {
    version: 1,
    mode: "list",
    itemSelector: ".product",
    fields: [
      { id: "title", name: "标题", selector: ".title", valueMode: "text", required: true },
      { id: "url", name: "链接", selector: "a", valueMode: "href", required: true },
      { id: "image", name: "主图", selector: "img", valueMode: "src", required: true },
      { id: "sku", name: "SKU", selector: "[data-sku]", valueMode: "attribute", attribute: "data-sku", required: false },
    ],
    pagination: { kind: "single" },
    dedupeBy: ["url", "sku"],
    maxRows: 2_000,
    maxBytes: 5 * 1024 * 1024,
    ...overrides,
  };
}

describe("extractCollectionPreview", () => {
  beforeEach(() => {
    document.head.innerHTML = '<base href="https://shop.example/products/">';
    document.body.innerHTML = `
      <article class="product"><h2 class="title">  降噪   耳机  </h2><a href="/p/1">详情</a><img src="img/1.webp"><span data-sku="A-1"></span></article>
      <article class="product"><h2 class="title">机械键盘</h2><a href="/p/2">详情</a><span data-sku="A-2"></span></article>
      <article class="product"><h2 class="title">机械键盘副本</h2><a href="/p/2">详情</a><img src="img/2.webp"><span data-sku="A-2"></span></article>
    `;
  });

  it("extracts list rows and reports missing and duplicate samples", () => {
    const preview = extractCollectionPreview(recipe());

    expect(preview).toMatchObject({
      matchedCount: 3,
      returnedCount: 3,
      uniqueCount: 2,
      duplicateCount: 1,
      missingRequiredCount: 1,
      truncated: false,
    });
    expect(preview.rows[0]).toEqual({
      values: {
        title: "降噪 耳机",
        url: "https://shop.example/p/1",
        image: "https://shop.example/products/img/1.webp",
        sku: "A-1",
      },
      missingRequired: [],
      duplicate: false,
    });
    expect(preview.rows[1].missingRequired).toEqual(["image"]);
    expect(preview.rows[2].duplicate).toBe(true);
  });

  it("extracts one detail record relative to the document", () => {
    document.body.innerHTML = '<main><h1 class="title">详情标题</h1></main>';
    const detail = recipe({
      mode: "single",
      itemSelector: undefined,
      fields: [{ id: "title", name: "标题", selector: ".title", valueMode: "text", required: true }],
      dedupeBy: [],
    });

    const preview = extractCollectionPreview(detail);

    expect(preview.rows).toEqual([{
      values: { title: "详情标题" },
      missingRequired: [],
      duplicate: false,
    }]);
  });

  it("deduplicates full-page rows before applying result limits", () => {
    const page = extractCollectionPage(recipe());

    expect(page.matchedCount).toBe(3);
    expect(page.rows).toHaveLength(2);
    expect(page.duplicateCount).toBe(1);
    expect(page.rows[0].values.title).toBe("降噪 耳机");
    expect(page.rows[1].values.title).toBe("机械键盘");
  });

  it("returns at most twenty sample rows with structured truncation", () => {
    document.body.innerHTML = Array.from(
      { length: 23 },
      (_, index) => `<article class="product"><span class="title">P${index}</span><a href="/p/${index}"></a><img src="/${index}.png"><i data-sku="${index}"></i></article>`
    ).join("");

    const preview = extractCollectionPreview(recipe());

    expect(preview.matchedCount).toBe(23);
    expect(preview.returnedCount).toBe(20);
    expect(preview.rows).toHaveLength(20);
    expect(preview.truncated).toBe(true);
  });

  it("extracts more than the preview limit for a bounded collection run", () => {
    document.body.innerHTML = Array.from(
      { length: 23 },
      (_, index) => `<article class="product"><span class="title">P${index}</span><a href="/p/${index}"></a><img src="/${index}.png"><i data-sku="${index}"></i></article>`
    ).join("");

    const page = extractCollectionPage(recipe());

    expect(page.rows).toHaveLength(23);
    expect(page.matchedCount).toBe(23);
    expect(page.truncatedBy).toBeNull();
    expect(page.pageUrl).toBe("http://localhost:3000/");
    expect(page.fingerprint).toMatch(/^fnv1a:/);
  });

  it("reports a structured hard-limit stop without returning oversized rows", () => {
    document.body.innerHTML = Array.from(
      { length: 3 },
      (_, index) => `<article class="product"><span class="title">P${index}</span><a href="/p/${index}"></a><img src="/${index}.png"><i data-sku="${index}"></i></article>`
    ).join("");

    const page = extractCollectionPage(recipe({ maxRows: 2 }));

    expect(page.rows).toHaveLength(2);
    expect(page.matchedCount).toBe(3);
    expect(page.truncatedBy).toBe("max_rows");
  });
});
