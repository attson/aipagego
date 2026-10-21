import type { Json } from "@aipagego/shared/types";

type Args = {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  withCredentials?: boolean;
};

export async function httpRequestBridge(args: Json): Promise<Json> {
  const { url, method = "GET", headers, body, withCredentials = false } = (args ?? {}) as Args;
  const res = (await chrome.runtime.sendMessage({
    type: "http.request",
    url,
    method,
    headers,
    body,
    withCredentials
  })) as { ok: true; data: Json } | { ok: false; error: string };
  if (!res.ok) throw new Error(`httpRequest: ${res.error}`);
  return res.data;
}
