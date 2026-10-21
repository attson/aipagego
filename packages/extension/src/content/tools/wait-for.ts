import type { Json } from "@aipagego/shared/types";

type Args = {
  ms?: number;
  selector?: string;
  text?: string;
  textGone?: string;
  timeoutMs?: number;
};

export async function waitFor(args: Json): Promise<Json> {
  const { ms, selector, text, textGone, timeoutMs = 5000 } = (args ?? {}) as Args;

  if (typeof ms === "number" && !selector && !text && !textGone) {
    await sleep(ms);
    return { reason: "ms" };
  }

  if (selector) {
    return until(() => document.querySelector(selector) != null, "selector", timeoutMs);
  }

  if (text) {
    return until(() => pageText().includes(text), "text", timeoutMs);
  }

  if (textGone) {
    return until(() => !pageText().includes(textGone), "textGone", timeoutMs);
  }

  return { reason: "noop" };
}

function pageText(): string {
  return document.body?.innerText ?? document.body?.textContent ?? "";
}

/**
 * Resolves as soon as the predicate holds, re-checking on DOM mutations.
 * Text predicates also poll, because `innerText` changes with layout and CSS
 * without necessarily producing a mutation record.
 */
function until(
  predicate: () => boolean,
  reason: string,
  timeoutMs: number
): Promise<Json> {
  if (predicate()) return Promise.resolve({ reason } as unknown as Json);

  return new Promise((resolve) => {
    let done = false;
    const finish = (r: string) => {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(poll);
      clearTimeout(timer);
      resolve({ reason: r } as unknown as Json);
    };

    const check = () => {
      if (predicate()) finish(reason);
    };

    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
  });
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
