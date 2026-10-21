import type { Json } from "@aipagego/shared/types";

type Args = { selector: string };

export async function getValue(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) return null;
  if (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement
  ) {
    return el.value;
  }
  if (el instanceof HTMLElement && isEditable(el)) {
    return el.textContent ?? "";
  }
  return null;
}

function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}
