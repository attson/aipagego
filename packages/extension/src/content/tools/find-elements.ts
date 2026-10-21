import type { Json } from "@aipagego/shared/types";
import { nextUid, recordUid } from "./uid-cache";
import { INTERACTIVE_SELECTOR, bounds, elName, elRole, elText } from "./element-meta";

const DEFAULT_LIMIT = 20;

/**
 * Text search over interactive elements, returning uids that `clickByUid` and
 * `fillByUid` accept. Unlike `takeSnapshot` this appends to the uid cache
 * instead of resetting it, so a find does not invalidate uids the caller is
 * already holding.
 */
export async function findElements(args: Json): Promise<Json> {
  const opts = (args ?? {}) as { text?: string; regex?: string; limit?: number };
  const hasText = typeof opts.text === "string" && opts.text.length > 0;
  const hasRegex = typeof opts.regex === "string" && opts.regex.length > 0;
  if (!hasText && !hasRegex) throw new Error("findElements: text or regex required");

  let re: RegExp | null = null;
  if (hasRegex) {
    try {
      re = new RegExp(opts.regex as string, "i");
    } catch (e) {
      throw new Error(`findElements: invalid regex — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const needle = hasText ? (opts.text as string).toLowerCase() : null;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

  const matches: Array<{
    uid: string;
    role: string;
    name: string;
    tag: string;
    text: string;
    bounds: { x: number; y: number; w: number; h: number };
  }> = [];

  for (const el of Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))) {
    const name = elName(el);
    const text = elText(el);
    const hit = re
      ? re.test(name) || re.test(text)
      : name.toLowerCase().includes(needle!) || text.toLowerCase().includes(needle!);
    if (!hit) continue;

    const uid = nextUid();
    recordUid(uid, el);
    matches.push({
      uid,
      role: elRole(el),
      name,
      tag: el.tagName.toLowerCase(),
      text,
      bounds: bounds(el),
    });
    if (matches.length >= limit) break;
  }

  return { matches } as unknown as Json;
}
