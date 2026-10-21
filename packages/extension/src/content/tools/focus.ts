import type { Json } from "@aipagego/shared/types";

type Args = { selector: string };

export async function focus(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (el instanceof HTMLElement) {
    el.focus({ preventScroll: false });
  }
  return { focused: true };
}
