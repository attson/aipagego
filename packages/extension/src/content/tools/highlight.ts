import type { Json } from "@aipagego/shared/types";
import { lookupUid } from "./uid-cache";

const ELEMENT_CLASS = "aipagego-highlight-el";
const TEXT_CLASS = "aipagego-highlight-text";

function ensureStyles(): void {
  if (document.getElementById("aipagego-highlight-style")) return;
  const s = document.createElement("style");
  s.id = "aipagego-highlight-style";
  s.textContent = `
    .${ELEMENT_CLASS} {
      outline: 2px dashed #ef4444 !important;
      outline-offset: 2px !important;
      transition: outline-color 200ms ease-out;
    }
    .${TEXT_CLASS} {
      background-color: #fde68a !important;
      color: inherit !important;
    }
  `;
  (document.head || document.documentElement).appendChild(s);
}

export async function highlightElement(args: Json): Promise<Json> {
  const { selector, uid, ms } = (args ?? {}) as { selector?: string; uid?: string; ms?: number };
  ensureStyles();
  let el: Element | null = null;
  if (uid) el = lookupUid(uid);
  if (!el && selector) el = document.querySelector(selector);
  if (!el) throw new Error("highlightElement: no matching element (uid or selector)");
  el.classList.add(ELEMENT_CLASS);
  const duration = typeof ms === "number" && ms > 0 ? ms : 3000;
  setTimeout(() => el?.classList.remove(ELEMENT_CLASS), duration);
  return { ok: true };
}

function findTextNode(target: string): { node: Text; index: number } | null {
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.nodeValue && n.nodeValue.includes(target)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT,
  });
  const node = tw.nextNode() as Text | null;
  if (!node || !node.nodeValue) return null;
  return { node, index: node.nodeValue.indexOf(target) };
}

export async function highlightText(args: Json): Promise<Json> {
  const { text, ms } = (args ?? {}) as { text?: string; ms?: number };
  if (typeof text !== "string" || text.length === 0) throw new Error("highlightText: text required");
  ensureStyles();
  const found = findTextNode(text);
  if (!found) throw new Error(`highlightText: text not found in page`);
  const { node, index } = found;
  const before = node.nodeValue!.slice(0, index);
  const match = node.nodeValue!.slice(index, index + text.length);
  const after = node.nodeValue!.slice(index + text.length);
  const span = document.createElement("mark");
  span.className = TEXT_CLASS;
  span.textContent = match;
  const parent = node.parentNode;
  if (!parent) throw new Error("highlightText: orphan text node");
  parent.insertBefore(document.createTextNode(before), node);
  parent.insertBefore(span, node);
  parent.insertBefore(document.createTextNode(after), node);
  parent.removeChild(node);
  const duration = typeof ms === "number" && ms > 0 ? ms : 3000;
  setTimeout(() => {
    const txt = document.createTextNode(match);
    span.parentNode?.replaceChild(txt, span);
  }, duration);
  return { ok: true };
}
