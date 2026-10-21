import type { Json } from "@aipagego/shared/types";

type SingleArgs = { selector: string; root?: string };
type MultiArgs = { selector: string; root?: string; limit?: number };

function summarizeShallow(el: Element): Json {
  const node: Record<string, Json> = { tag: el.tagName.toLowerCase() };
  if (el.id) node.id = el.id;
  const classes = Array.from(el.classList);
  if (classes.length) node.classes = classes;
  const text = (el.textContent ?? "").trim();
  if (text) node.text = text.length > 500 ? `${text.slice(0, 500)}…` : text;
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
  if (Object.keys(attrs).length) node.attrs = attrs;
  return node;
}

function rootOf(sel?: string): ParentNode {
  return (sel ? document.querySelector(sel) : null) ?? document;
}

export async function querySelector(args: Json): Promise<Json> {
  const { selector, root } = (args ?? {}) as SingleArgs;
  const el = rootOf(root).querySelector(selector);
  return el ? summarizeShallow(el) : null;
}

export async function querySelectorAll(args: Json): Promise<Json> {
  const { selector, root, limit } = (args ?? {}) as MultiArgs;
  const list = Array.from(rootOf(root).querySelectorAll(selector));
  const sliced = typeof limit === "number" ? list.slice(0, limit) : list;
  return sliced.map(summarizeShallow);
}
