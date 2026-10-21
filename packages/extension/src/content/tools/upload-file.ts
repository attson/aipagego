import type { Json } from "@aipagego/shared/types";

type Args = {
  selector: string;
  url: string;
  filename?: string;
  mime?: string;
};

export async function uploadFile(args: Json): Promise<Json> {
  const { selector, url, filename, mime } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);
  if (!(el instanceof HTMLInputElement) || el.type !== "file") {
    throw new Error(`not a file input: ${selector}`);
  }

  const res = (await chrome.runtime.sendMessage({
    type: "http.fetchBinary",
    url
  })) as
    | { ok: true; data: { base64: string; mime: string; size: number } }
    | { ok: false; error: string };

  if (!res.ok) throw new Error(`download failed: ${res.error}`);

  const { base64, mime: serverMime } = res.data;
  const bin = atob(base64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  const finalName = filename ?? guessName(url);
  const finalMime = mime ?? serverMime ?? "application/octet-stream";
  const file = new File([buf], finalName, { type: finalMime });

  const dt = new DataTransfer();
  dt.items.add(file);
  Object.defineProperty(el, "files", {
    value: dt.files,
    configurable: true
  });
  el.dispatchEvent(new Event("change", { bubbles: true }));

  return { uploaded: true, name: finalName, mime: finalMime, size: buf.length };
}

function guessName(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last || "upload";
  } catch {
    return "upload";
  }
}
