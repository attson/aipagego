import type { Json } from "@aipagego/shared/types";

type Args = { selector: string; checked: boolean };

export async function setCheckbox(args: Json): Promise<Json> {
  const { selector, checked } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLInputElement) || el.type !== "checkbox") {
    throw new Error(`not a checkbox: ${selector}`);
  }
  if (el.checked === checked) return { checked, changed: false };
  el.checked = checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { checked, changed: true };
}
