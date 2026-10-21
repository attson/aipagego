import type { Json } from "@aipagego/shared/types";

type Args = { selector: string };

export async function hover(args: Json): Promise<Json> {
  const { selector } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  for (const type of ["mouseenter", "mouseover", "mousemove"]) {
    el.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, view: window })
    );
  }
  return { hovered: true };
}
