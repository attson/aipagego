import type { Json } from "@aipagego/shared/types";

type Args = { selector: string; value?: string; label?: string };

export async function selectOption(args: Json): Promise<Json> {
  const { selector, value, label } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLSelectElement)) {
    throw new Error(`not a select: ${selector}`);
  }
  let target: HTMLOptionElement | null = null;
  for (const opt of Array.from(el.options)) {
    if (value !== undefined && opt.value === value) {
      target = opt;
      break;
    }
  }
  if (!target && label !== undefined) {
    for (const opt of Array.from(el.options)) {
      if (opt.text === label) {
        target = opt;
        break;
      }
    }
  }
  if (!target) {
    throw new Error(`option not found: value=${value ?? "?"} label=${label ?? "?"}`);
  }
  el.value = target.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { value: target.value, label: target.text };
}
