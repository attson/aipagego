import { useEffect, useState } from "react";

const REPO = "attson/aipagego";
const CACHE_KEY = "aipagego.update_check_v1";
const DISMISS_KEY = "aipagego.update_dismissed_v1";
const TTL_MS = 24 * 60 * 60 * 1000;

type CachedCheck = { tag: string; ts: number };

function parseSemver(v: string): number[] {
  return v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
}
function semverGt(a: string, b: string): boolean {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const ai = aa[i] ?? 0;
    const bi = bb[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return false;
}

async function fetchLatestTag(): Promise<string | null> {
  try {
    const cached = (await chrome.storage.local.get(CACHE_KEY))[CACHE_KEY] as CachedCheck | undefined;
    if (cached && Date.now() - cached.ts < TTL_MS) return cached.tag;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!res.ok) return null;
    const j = (await res.json()) as { tag_name?: string };
    if (!j.tag_name) return null;
    await chrome.storage.local.set({ [CACHE_KEY]: { tag: j.tag_name, ts: Date.now() } });
    return j.tag_name;
  } catch {
    return null;
  }
}

export function UpdateBanner() {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const current = __APP_VERSION__;

  useEffect(() => {
    void (async () => {
      const d = (await chrome.storage.local.get(DISMISS_KEY))[DISMISS_KEY] as string | undefined;
      if (d) setDismissed(d);
      const tag = await fetchLatestTag();
      if (tag) setLatest(tag);
    })();
  }, []);

  if (!latest) return null;
  const latestNorm = latest.replace(/^v/, "");
  if (!semverGt(latestNorm, current)) return null;
  if (dismissed === latest) return null;

  function dismiss() {
    void chrome.storage.local.set({ [DISMISS_KEY]: latest });
    setDismissed(latest);
  }

  return (
    <div className="bg-blue-950/60 border-b border-blue-900 px-3 py-1.5 text-[11px] text-blue-100 flex items-center gap-2">
      <span>有新版本 <strong>{latest}</strong>（当前 v{current}）</span>
      <a
        href={`https://github.com/${REPO}/releases/tag/${latest}`}
        target="_blank"
        rel="noreferrer"
        className="text-blue-300 underline hover:text-blue-100"
      >
        查看 release
      </a>
      <button
        type="button"
        className="ml-auto text-blue-300 hover:text-blue-100 text-[11px]"
        onClick={dismiss}
        aria-label="忽略此版本"
      >
        ×
      </button>
    </div>
  );
}
