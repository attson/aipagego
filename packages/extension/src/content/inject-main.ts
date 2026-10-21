import type { Json } from "@aipagego/shared/types";

export async function injectMain(source: string, args: Json): Promise<Json> {
  const res = (await chrome.runtime.sendMessage({
    type: "scripting.injectMain",
    source,
    args
  })) as { ok: true; data: Json } | { ok: false; error: string };
  if (!res.ok) throw new Error(`injectMain: ${res.error}`);
  return res.data;
}
