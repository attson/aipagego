import type { Json } from "@aipagego/shared/types";

type Args = {
  action: "back" | "forward" | "reload" | "goto";
  url?: string;
};

const ALLOWED_SCHEME = /^https?:|^file:|^ftp:/i;

export async function navigate(args: Json): Promise<Json> {
  const { action, url } = (args ?? {}) as Args;
  switch (action) {
    case "back":
      window.history.back();
      return { ok: true, action };
    case "forward":
      window.history.forward();
      return { ok: true, action };
    case "reload":
      window.location.reload();
      return { ok: true, action };
    case "goto": {
      if (typeof url !== "string") {
        throw new Error("navigate: url required for action=goto");
      }
      if (!ALLOWED_SCHEME.test(url)) {
        throw new Error(`navigate: URL scheme not allowed: ${url}`);
      }
      window.location.assign(url);
      return { ok: true, action, url };
    }
    default:
      throw new Error(`navigate: unknown action: ${String(action)}`);
  }
}
