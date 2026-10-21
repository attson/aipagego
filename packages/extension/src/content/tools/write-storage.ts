import type { Json } from "@aipagego/shared/types";

type Args = { store: "local" | "session"; key: string; value: string };

export async function writeStorage(args: Json): Promise<Json> {
  const { store, key, value } = (args ?? {}) as Args;
  if (store !== "local" && store !== "session") {
    throw new Error("writeStorage: store must be 'local' or 'session'");
  }
  if (typeof key !== "string" || key === "") {
    throw new Error("writeStorage: key required");
  }
  if (typeof value !== "string") {
    throw new Error("writeStorage: value must be a string");
  }
  const s = store === "local" ? localStorage : sessionStorage;
  s.setItem(key, value);
  return { ok: true, store, key };
}
