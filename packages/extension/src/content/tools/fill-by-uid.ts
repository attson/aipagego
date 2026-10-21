import type { Json } from "@aipagego/shared/types";
import { lookupUid } from "./uid-cache";

function setInputValue(el: Element, value: string, clear: boolean): void {
  // Match the React/Vue-compatible setter used by fillInput
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (clear) setter?.call(el, "");
    setter?.call(el, clear ? value : (el.value ?? "") + value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if ((el as HTMLElement).isContentEditable) {
    if (clear) (el as HTMLElement).innerText = value;
    else (el as HTMLElement).innerText = ((el as HTMLElement).innerText ?? "") + value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  throw new Error("fillByUid: element is not fillable");
}

export async function fillByUid(args: Json): Promise<Json> {
  const { uid, value, clear } = (args ?? {}) as { uid?: string; value?: string; clear?: boolean };
  if (typeof uid !== "string") throw new Error("fillByUid: uid required");
  if (typeof value !== "string") throw new Error("fillByUid: value required");
  const el = lookupUid(uid);
  if (!el) throw new Error(`fillByUid: uid ${uid} not found — call takeSnapshot first`);
  setInputValue(el, value, clear !== false);
  return { ok: true, uid };
}
