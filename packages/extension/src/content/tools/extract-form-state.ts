import type { Json } from "@aipagego/shared/types";

type Args = { selector?: string };

export async function extractFormState(args: Json): Promise<Json> {
  const { selector = "form" } = (args ?? {}) as Args;
  const form = document.querySelector(selector);
  if (!form) throw new Error(`form not found: ${selector}`);
  if (!(form instanceof HTMLFormElement)) {
    throw new Error(`not a form: ${selector}`);
  }
  const out: Record<string, Json> = {};
  for (const el of Array.from(form.elements)) {
    if (
      !(el instanceof HTMLInputElement) &&
      !(el instanceof HTMLTextAreaElement) &&
      !(el instanceof HTMLSelectElement)
    ) {
      continue;
    }
    const name = el.name;
    if (!name) continue;

    if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) out[name] = el.value;
      continue;
    }
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      if (el.value && el.value !== "on") {
        const prev = out[name];
        if (Array.isArray(prev)) {
          if (el.checked) prev.push(el.value);
        } else {
          out[name] = el.checked ? [el.value] : [];
        }
      } else {
        out[name] = el.checked;
      }
      continue;
    }
    out[name] = el.value;
  }
  return out as Json;
}
