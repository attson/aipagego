import type { Json } from "@aipagego/shared/types";

type Args = {
  key: string;
  selector?: string;
};

function inferCode(key: string): string {
  if (key.length === 1 && /[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
  if (key.length === 1 && /[0-9]/.test(key)) return `Digit${key}`;
  return key;
}

const PRINTABLE = /^[\x20-\x7e]$/;

export async function pressKey(args: Json): Promise<Json> {
  const { key, selector } = (args ?? {}) as Args;
  if (typeof key !== "string" || key === "") {
    throw new Error("pressKey: key required");
  }

  let target: Element;
  if (selector) {
    const found = document.querySelector(selector);
    if (!found) throw new Error(`pressKey: element not found: ${selector}`);
    target = found;
    if (target instanceof HTMLElement) target.focus();
  } else {
    target = (document.activeElement as Element | null) ?? document.body;
  }

  const code = inferCode(key);
  const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (PRINTABLE.test(key)) target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));

  return { ok: true, key, dispatched: true };
}
