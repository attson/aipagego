import { DEFAULT_MAX_BLOCKS, MAX_INDEX_BLOCKS, type PageBlock, type PageBlockKind, type PageIndex } from "./types";
import { normalizeText, visibleText } from "./text";

type BuildArgs = {
  maxBlocks?: number;
};

const SKIP_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "nav",
  "footer",
  "[hidden]",
  "[aria-hidden='true']",
  "aipagego-widget"
].join(",");

const CANDIDATE_SELECTOR = [
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "tr",
  "dt",
  "li",
  "div",
  "span",
  "p",
  "article",
  "section",
  "main",
  "input",
  "textarea",
  "select"
].join(",");

function escapeCss(value: string): string {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(value) : value.replace(/["\\#.:,[\]>+~\s]/g, "\\$&");
}

function makeId(n: number): string {
  return `b${n}`;
}

function cssHint(el: Element): string {
  const segments: string[] = [];
  for (let current: Element | null = el; current && current !== document.body; current = current.parentElement) {
    if (current.id) {
      segments.unshift(`#${escapeCss(current.id)}`);
      break;
    }

    const tag = current.tagName.toLowerCase();
    const classes = Array.from(current.classList)
      .slice(0, 2)
      .map((className) => `.${escapeCss(className)}`)
      .join("");
    const siblingsOfType = current.parentElement
      ? Array.from(current.parentElement.children).filter((sibling) => sibling.tagName === current.tagName)
      : [];
    const nth = siblingsOfType.length > 1 ? `:nth-of-type(${siblingsOfType.indexOf(current) + 1})` : "";
    segments.unshift(`${tag}${classes}${nth}`);
  }

  return segments.length > 0 ? `body > ${segments.join(" > ")}` : "body";
}

function isHiddenByStyle(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.style.display === "none" || htmlEl.style.visibility === "hidden") return true;
  const style = globalThis.getComputedStyle?.(el);
  return style?.display === "none" || style?.visibility === "hidden";
}

function isSkippable(el: Element): boolean {
  if (el.closest(SKIP_SELECTOR)) return true;
  if (el instanceof HTMLInputElement && el.type === "hidden") return true;

  for (let current: Element | null = el; current; current = current.parentElement) {
    if (isHiddenByStyle(current)) return true;
  }

  return false;
}

function headingPathFor(el: Element, headings: Element[]): string[] {
  return headings
    .filter((heading) => heading === el || Boolean(heading.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
    .slice(-3)
    .map((heading) => visibleText(heading.textContent ?? ""))
    .filter(Boolean);
}

function keywordsFor(...parts: Array<string | undefined>): string[] {
  const normalized = normalizeText(parts.filter(Boolean).join(" "));
  return Array.from(new Set(normalized.split(" ").filter(Boolean)));
}

function makeBlock(
  headings: Element[],
  el: Element,
  kind: PageBlockKind,
  text: string,
  label?: string,
  value?: string
): PageBlock | undefined {
  const cleanText = visibleText(text);
  if (!cleanText) return undefined;

  return {
    blockId: "",
    kind,
    text: cleanText,
    ...(label ? { label: visibleText(label) } : {}),
    ...(value ? { value: visibleText(value) } : {}),
    selectorHint: cssHint(el),
    headingPath: headingPathFor(el, headings),
    order: 0,
    keywords: keywordsFor(label, value, cleanText)
  };
}

function dedupeKey(block: PageBlock): string {
  return [block.kind, normalizeText(block.label ?? ""), normalizeText(block.text)].join(":");
}

function addBlock(blocks: PageBlock[], seen: Set<string>, block: PageBlock | undefined): void {
  if (!block) return;
  const key = dedupeKey(block);
  if (seen.has(key)) return;

  seen.add(key);
  const order = blocks.length;
  blocks.push({ ...block, blockId: makeId(order + 1), order });
}

function blockFromTableRow(headings: Element[], row: HTMLTableRowElement): PageBlock | undefined {
  const cells = Array.from(row.querySelectorAll("th,td"));
  if (cells.length < 2) return undefined;

  const label = visibleText(cells[0].textContent ?? "");
  const value = visibleText(cells.slice(1).map((cell) => cell.textContent ?? "").join(" "));
  if (!label || !value) return undefined;

  return makeBlock(headings, row, "kv", `${label} ${value}`, label, value);
}

function blockFromDefinitionTerm(headings: Element[], dt: HTMLElement): PageBlock | undefined {
  const dd = dt.nextElementSibling;
  if (!dd || dd.tagName.toLowerCase() !== "dd") return undefined;

  const label = visibleText(dt.textContent ?? "");
  const value = visibleText(dd.textContent ?? "");
  if (!label || !value) return undefined;

  return makeBlock(headings, dt, "kv", `${label} ${value}`, label, value);
}

function labelForControl(el: Element): string {
  const id = el.getAttribute("id");
  if (id) {
    const label = Array.from(document.querySelectorAll("label")).find((candidate) => {
      return (candidate as HTMLLabelElement).htmlFor === id;
    });
    const text = visibleText(label?.textContent ?? "");
    if (text) return text;
  }

  return visibleText(el.closest("label")?.textContent ?? "");
}

function blockFromControl(headings: Element[], el: Element): PageBlock | undefined {
  const label = labelForControl(el) || el.getAttribute("aria-label") || el.getAttribute("name") || "";
  const value = valueForControl(el);
  const text = [label, value].filter(Boolean).join(" ");
  if (!text) return undefined;

  return makeBlock(headings, el, "form", text, label, value);
}

function valueForControl(el: Element): string {
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "checked" : "unchecked";
    return el.value || el.getAttribute("value") || el.getAttribute("placeholder") || "";
  }
  if (el instanceof HTMLTextAreaElement) {
    return el.value || el.getAttribute("placeholder") || "";
  }
  if (el instanceof HTMLSelectElement) {
    const selected = el.selectedOptions[0];
    return visibleText(selected?.textContent ?? "") || el.value;
  }
  return el.getAttribute("placeholder") || el.getAttribute("value") || "";
}

function visibleChildTexts(el: Element): string[] {
  return Array.from(el.children)
    .filter((child) => !isSkippable(child))
    .map((child) => visibleText(child.textContent ?? ""))
    .filter(Boolean);
}

function isMostlyContainerText(el: Element): boolean {
  return visibleChildTexts(el).length > 0;
}

function blockFromGenericKeyValue(headings: Element[], el: Element): PageBlock | undefined {
  if (el.querySelector("input,textarea,select,button,table,dl,ul,ol")) return undefined;

  const parts = visibleChildTexts(el);
  if (parts.length !== 2) return undefined;

  const [label, value] = parts;
  if (!label || !value || label.length > 80 || value.length > 1200) return undefined;

  const fullText = visibleText(el.textContent ?? "");
  const joined = visibleText(`${label} ${value}`);
  if (!fullText || !fullText.includes(label) || !fullText.includes(value)) return undefined;

  return makeBlock(headings, el, "kv", joined, label, value);
}

function blockFromGenericText(headings: Element[], el: Element): PageBlock | undefined {
  if (el.querySelector("input,textarea,select,button,table,dl,ul,ol")) return undefined;
  const text = visibleText(el.textContent ?? "");
  if (text.length < 20 || text.length > 5000) return undefined;

  const childTexts = visibleChildTexts(el);
  if (childTexts.length > 1) return undefined;
  if (childTexts.length === 1 && childTexts[0] !== text) return undefined;

  return makeBlock(headings, el, "text", text);
}

function blockFromElement(headings: Element[], el: Element): PageBlock | undefined {
  const tagName = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tagName)) return makeBlock(headings, el, "heading", el.textContent ?? "");
  if (tagName === "tr") return blockFromTableRow(headings, el as HTMLTableRowElement);
  if (tagName === "dt") return blockFromDefinitionTerm(headings, el as HTMLElement);
  if (tagName === "li") return makeBlock(headings, el, "list", el.textContent ?? "");
  if (tagName === "div" || tagName === "span") {
    return blockFromGenericKeyValue(headings, el) ?? blockFromGenericText(headings, el);
  }
  if (tagName === "input" || tagName === "textarea" || tagName === "select") return blockFromControl(headings, el);
  if (tagName === "p" || tagName === "article" || tagName === "section" || tagName === "main") {
    const text = visibleText(el.textContent ?? "");
    if (text.length < 20 || (tagName !== "p" && isMostlyContainerText(el))) return undefined;
    return makeBlock(headings, el, "text", text);
  }

  return undefined;
}

function textChars(blocks: PageBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.text.length, 0);
}

export function buildPageIndex(args: BuildArgs = {}): PageIndex {
  const maxBlocks = Math.min(MAX_INDEX_BLOCKS, Math.max(1, Math.floor(args.maxBlocks ?? DEFAULT_MAX_BLOCKS)));
  const allBlocks: PageBlock[] = [];
  const seen = new Set<string>();
  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter((heading) => !isSkippable(heading));

  for (const el of Array.from(document.body.querySelectorAll(CANDIDATE_SELECTOR))) {
    if (isSkippable(el)) continue;
    addBlock(allBlocks, seen, blockFromElement(headings, el));
  }

  const blocks = allBlocks.slice(0, maxBlocks);
  const truncated = allBlocks.length > blocks.length;

  return {
    indexId: `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    url: location.href,
    title: document.title,
    createdAt: Date.now(),
    maxBlocks,
    blocks,
    truncated,
    ...(truncated
      ? {
          truncation: {
            kind: "index_budget",
            originalChars: textChars(allBlocks),
            returnedChars: textChars(blocks),
            reason: "maxBlocks",
            ref: "index"
          }
        }
      : {})
  };
}
