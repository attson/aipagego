import type { Json } from "@aipagego/shared/types";

const OG_KEYS = ["title", "type", "image", "url", "site_name", "description"] as const;
const STR_CAP = 200;

function cap(s: string): string {
  return s.length > STR_CAP ? s.slice(0, STR_CAP) : s;
}

function metaContent(name: string, attr: "name" | "property"): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[${attr}="${name}"]`);
  const v = el?.getAttribute("content");
  return v ? cap(v) : null;
}

export async function getPageInfo(_args: Json): Promise<Json> {
  const ogMeta: Record<string, string> = {};
  for (const k of OG_KEYS) {
    const v = metaContent(`og:${k}`, "property");
    if (v) ogMeta[k] = v;
  }
  return {
    url: window.location.href,
    title: cap(document.title),
    hostname: window.location.hostname,
    lang: document.documentElement.lang || null,
    description: metaContent("description", "name"),
    ogMeta,
  };
}
