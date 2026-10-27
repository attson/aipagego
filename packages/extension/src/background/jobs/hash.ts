import { stableJsonStringify } from "@aipagego/shared/jobs";
import type { Json } from "@aipagego/shared/types";

export async function sha256Json(value: unknown): Promise<string> {
  const json = JSON.parse(JSON.stringify(value)) as Json;
  const bytes = new TextEncoder().encode(stableJsonStringify(json));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
