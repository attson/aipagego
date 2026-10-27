import type {
  CollectionField,
  CollectionPageExtraction,
  CollectionPreview,
  CollectionPreviewRow,
  CollectionRecipeV1,
} from "@aipagego/shared/collection";

const MAX_PREVIEW_ROWS = 20;
const encoder = new TextEncoder();

function compactText(value: string): string | null {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact || null;
}

function absoluteUrl(raw: string | null): string | null {
  const compact = compactText(raw ?? "");
  if (!compact) return null;
  try {
    return new URL(compact, document.baseURI).href;
  } catch {
    return null;
  }
}

function readField(root: ParentNode, field: CollectionField): string | null {
  const element = root.querySelector(field.selector);
  if (!element) return null;

  switch (field.valueMode) {
    case "text":
      return compactText(element.textContent ?? "");
    case "href":
      return absoluteUrl(element.getAttribute("href"));
    case "src":
      return absoluteUrl(element.getAttribute("src"));
    case "attribute":
      return compactText(element.getAttribute(field.attribute!) ?? "");
  }
}

function fingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}`;
}

function matchedRoots(recipe: CollectionRecipeV1, root: Document): ArrayLike<ParentNode> {
  return recipe.mode === "single"
    ? [root as ParentNode]
    : root.querySelectorAll(recipe.itemSelector!);
}

function extractRow(recipe: CollectionRecipeV1, sampleRoot: ParentNode) {
  const values: Record<string, string | null> = {};
  const missingRequired: string[] = [];
  for (const field of recipe.fields) {
    const value = readField(sampleRoot, field);
    values[field.id] = value;
    if (field.required && value == null) missingRequired.push(field.id);
  }
  return { values, missingRequired };
}

function dedupeKey(valuesByField: Record<string, string | null>, dedupeBy: string[]): string | null {
  if (dedupeBy.length === 0) return null;
  const values = dedupeBy.map((fieldId) => valuesByField[fieldId]);
  if (values.some((value) => value == null || value === "")) return null;
  return JSON.stringify(values);
}

export function extractCollectionPreview(
  recipe: CollectionRecipeV1,
  root: Document = document
): CollectionPreview {
  const matched = matchedRoots(recipe, root);
  const seen = new Set<string>();
  let duplicateCount = 0;
  let missingRequiredCount = 0;

  const rows: CollectionPreviewRow[] = [];
  const sampleCount = Math.min(matched.length, MAX_PREVIEW_ROWS);
  for (let index = 0; index < sampleCount; index++) {
    const { values, missingRequired } = extractRow(recipe, matched[index]);
    if (missingRequired.length > 0) missingRequiredCount += 1;

    const row: CollectionPreviewRow = { values, missingRequired, duplicate: false };
    const key = dedupeKey(values, recipe.dedupeBy);
    if (key != null) {
      row.duplicate = seen.has(key);
      if (row.duplicate) duplicateCount += 1;
      else seen.add(key);
    }
    rows.push(row);
  }

  return {
    rows,
    matchedCount: matched.length,
    returnedCount: rows.length,
    uniqueCount: rows.length - duplicateCount,
    duplicateCount,
    missingRequiredCount,
    truncated: matched.length > rows.length,
  };
}

export function extractCollectionPage(
  recipe: CollectionRecipeV1,
  root: Document = document
): CollectionPageExtraction {
  const matched = matchedRoots(recipe, root);
  const rows: CollectionPageExtraction["rows"] = [];
  const seen = new Set<string>();
  let byteSize = 0;
  let duplicateCount = 0;
  let truncatedBy: CollectionPageExtraction["truncatedBy"] = null;

  for (let index = 0; index < matched.length; index++) {
    const row = extractRow(recipe, matched[index]);
    const key = dedupeKey(row.values, recipe.dedupeBy);
    if (key != null && seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    if (rows.length >= recipe.maxRows) {
      truncatedBy = "max_rows";
      break;
    }
    const rowBytes = encoder.encode(JSON.stringify(row.values)).byteLength;
    const nextBytes = byteSize + rowBytes;
    if (nextBytes > recipe.maxBytes) {
      truncatedBy = "max_bytes";
      break;
    }
    if (key != null) seen.add(key);
    rows.push(row);
    byteSize = nextBytes;
  }

  const pageUrl = root.location?.href ?? document.location.href;
  return {
    rows,
    pageUrl,
    fingerprint: fingerprint(JSON.stringify({
      pageUrl,
      matchedCount: matched.length,
      rows: rows.slice(0, 20).map((row) => row.values),
    })),
    matchedCount: matched.length,
    duplicateCount,
    truncatedBy,
  };
}
