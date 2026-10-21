import type { Json } from "@aipagego/shared/types";

type Args = { selector?: string };

export async function submitForm(args: Json): Promise<Json> {
  const { selector = "form" } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`form not found: ${selector}`);
  if (!(el instanceof HTMLFormElement)) {
    throw new Error(`not a form: ${selector}`);
  }
  const ev = new Event("submit", { bubbles: true, cancelable: true });
  const allowed = el.dispatchEvent(ev);
  if (allowed) el.submit();
  return { submitted: true, defaultPrevented: !allowed };
}
