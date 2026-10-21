import type { Json } from "@aipagego/shared/types";

type Args = { store: "local" | "session"; key: string };

export async function readStorage(args: Json): Promise<Json> {
  const { store, key } = (args ?? {}) as Args;
  const s = store === "local" ? localStorage : sessionStorage;
  return s.getItem(key);
}
