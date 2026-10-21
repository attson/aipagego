import type { Json } from "@aipagego/shared/types";
import { nextUid, recordUid, resetUidCache } from "./uid-cache";
import { INTERACTIVE_SELECTOR, bounds, elName, elRole, elText } from "./element-meta";

export async function takeSnapshot(args: Json): Promise<Json> {
  const opts = (args ?? {}) as { includeAll?: boolean };
  resetUidCache();
  const selector = opts.includeAll
    ? "body *"
    : INTERACTIVE_SELECTOR;
  const nodes = Array.from(document.querySelectorAll(selector));
  const out: Array<{
    uid: string;
    role: string;
    name: string;
    tag: string;
    text: string;
    bounds: { x: number; y: number; w: number; h: number };
  }> = [];
  for (const el of nodes) {
    // Skip elements outside the viewport with zero size (most likely hidden)
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const uid = nextUid();
    recordUid(uid, el);
    out.push({
      uid,
      role: elRole(el),
      name: elName(el),
      tag: el.tagName.toLowerCase(),
      text: elText(el),
      bounds: bounds(el),
    });
    if (out.length >= 500) break; // sanity cap
  }
  return out as unknown as Json;
}
