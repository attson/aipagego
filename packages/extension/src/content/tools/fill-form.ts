import type { Json } from "@aipagego/shared/types";
import { fillInput } from "./fill-input";
import { fillByUid } from "./fill-by-uid";

type Field = { selector?: string; uid?: string; value: string };

export async function fillForm(args: Json): Promise<Json> {
  const { fields } = (args ?? {}) as { fields?: Field[] };
  if (!Array.isArray(fields)) throw new Error("fillForm: fields array required");
  let filled = 0;
  const failed: Array<{ at: number; error: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || typeof f.value !== "string") {
      failed.push({ at: i, error: "missing value" });
      continue;
    }
    try {
      if (f.uid) {
        await fillByUid({ uid: f.uid, value: f.value } as unknown as Json);
      } else if (f.selector) {
        await fillInput({ selector: f.selector, value: f.value } as unknown as Json);
      } else {
        throw new Error("missing selector or uid");
      }
      filled += 1;
    } catch (e) {
      failed.push({ at: i, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { filled, failed } as unknown as Json;
}
