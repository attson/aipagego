import type { Json } from "@aipagego/shared/types";
import { lookupUid } from "./uid-cache";

export async function clickByUid(args: Json): Promise<Json> {
  const { uid } = (args ?? {}) as { uid?: string };
  if (typeof uid !== "string") throw new Error("clickByUid: uid required");
  const el = lookupUid(uid);
  if (!el) throw new Error(`clickByUid: uid ${uid} not found in current snapshot — call takeSnapshot first`);
  if (typeof (el as HTMLElement).click === "function") {
    (el as HTMLElement).click();
  } else {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }
  return { ok: true, uid };
}
