import type { Json } from "@aipagego/shared/types";

type Args = { root?: string; includeBg?: boolean };
type ImageRef = { url: string; via: "src" | "data-src" | "data-original" | "srcset" | "bg" };

export async function extractImages(args: Json): Promise<Json> {
  const { root, includeBg = false } = (args ?? {}) as Args;
  const scope: ParentNode = (root ? document.querySelector(root) : null) ?? document;
  const seen = new Set<string>();
  const out: ImageRef[] = [];

  const push = (raw: string | null | undefined, via: ImageRef["via"]) => {
    if (!raw) return;
    let abs: string;
    try {
      abs = new URL(raw, location.href).href;
    } catch {
      return;
    }
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push({ url: abs, via });
  };

  for (const img of Array.from(scope.querySelectorAll<HTMLImageElement>("img"))) {
    push(img.getAttribute("src"), "src");
    push(img.getAttribute("data-src"), "data-src");
    push(img.getAttribute("data-original"), "data-original");
    const srcset = img.getAttribute("srcset");
    if (srcset) {
      for (const part of srcset.split(",")) {
        const url = part.trim().split(/\s+/)[0];
        push(url, "srcset");
      }
    }
  }

  if (includeBg) {
    for (const el of Array.from(scope.querySelectorAll<HTMLElement>("[style*=background]"))) {
      const m = el.style.backgroundImage.match(/url\((['"]?)([^'")]+)\1\)/);
      if (m) push(m[2], "bg");
    }
  }

  return out as unknown as Json;
}
