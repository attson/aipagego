import type { Json } from "@aipagego/shared/types";

type Args = { maxDepth?: number; root?: string };

export async function snapshotDOM(args: Json): Promise<Json> {
  const { maxDepth = 3, root } = (args ?? {}) as Args;
  const rootEl = (root ? document.querySelector(root) : null) ?? document.documentElement;
  return summarize(rootEl, maxDepth);
}

function summarize(el: Element, depth: number): Json {
  const node: Record<string, Json> = { tag: el.tagName.toLowerCase() };
  if (el.id) node.id = el.id;
  const classList = Array.from(el.classList);
  if (classList.length) node.classes = classList;
  const direct = directText(el);
  if (direct) node.text = truncate(direct, 200);
  if (depth > 0 && el.children.length) {
    node.children = Array.from(el.children).map((c) => summarize(c, depth - 1));
  }
  return node;
}

function directText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent ?? "")
    .join(" ")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
