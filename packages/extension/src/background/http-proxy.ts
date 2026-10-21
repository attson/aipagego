import type { Json } from "@aipagego/shared/types";

export type HttpRequestInput = {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  headers?: Record<string, string>;
  body?: string;
  withCredentials: boolean;
};

export type HttpRequestOutput = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export async function httpRequest(input: HttpRequestInput): Promise<HttpRequestOutput> {
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    credentials: input.withCredentials ? "include" : "omit"
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, body: await res.text() };
}

export function asJson(out: HttpRequestOutput): Json {
  return out as unknown as Json;
}

export async function fetchAsBase64(
  url: string
): Promise<{ base64: string; mime: string; size: number }> {
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const blob = await res.blob();
  const arr = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(arr.subarray(i, i + chunk)));
  }
  return {
    base64: btoa(bin),
    mime: blob.type || "application/octet-stream",
    size: arr.length
  };
}
