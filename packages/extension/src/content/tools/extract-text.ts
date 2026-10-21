import type { Json } from "@aipagego/shared/types";

type Args = { selector: string; root?: string; single?: boolean };

export async function extractText(args: Json): Promise<Json> {
  const { selector, root, single } = (args ?? {}) as Args;
  const parent: ParentNode = (root ? document.querySelector(root) : null) ?? document;
  if (single) {
    const el = parent.querySelector(selector);
    return el ? (el.textContent ?? "").trim() : null;
  }
  return Array.from(parent.querySelectorAll(selector)).map((el) =>
    (el.textContent ?? "").trim()
  );
}
