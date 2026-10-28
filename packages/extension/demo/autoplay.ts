/**
 * Demo-only glue: types the prompt into the real panel and presses send.
 *
 * It drives the panel through its own UI rather than calling `runChatSession`
 * directly, so what a visitor watches is the same path a user takes — including
 * the input, the send button, and the approval bar.
 *
 * Polls because the panel mounts asynchronously; gives up rather than spinning
 * forever, so a UI change turns into a quiet no-op instead of a busy loop.
 */

const POLL_MS = 120;
const MAX_TRIES = 60;

export function startAutoplay(prompt: string, doc: Document = document): void {
  let tries = 0;
  const timer = setInterval(() => {
    if (++tries > MAX_TRIES) {
      clearInterval(timer);
      return;
    }
    const input = findInput(doc);
    if (!input) return;

    clearInterval(timer);
    setValue(input, prompt);
    // Let React flush the controlled value before the click reads it back.
    setTimeout(() => findSend(doc)?.click(), 60);
  }, POLL_MS);
}

function findInput(doc: Document): HTMLTextAreaElement | HTMLInputElement | null {
  return doc.querySelector<HTMLTextAreaElement>("textarea") ?? null;
}

/**
 * The real send button is an icon with `aria-label="发送"` and no matching text
 * content, so the label check has to come first — matching on textContent alone
 * finds nothing and the demo sits idle.
 */
function findSend(doc: Document): HTMLButtonElement | null {
  const buttons = [...doc.querySelectorAll<HTMLButtonElement>("button")].filter(
    (b) => !b.disabled
  );
  return (
    buttons.find((b) => (b.getAttribute("aria-label") ?? "").trim() === "发送") ??
    buttons.find((b) => (b.textContent ?? "").includes("发送")) ??
    buttons.find((b) => b.type === "submit") ??
    null
  );
}

/**
 * React tracks the last value it wrote on the DOM node; assigning `.value`
 * directly bypasses that tracker and the change is dropped. Same reason
 * `fillInput` calls the native setter.
 */
function setValue(el: HTMLTextAreaElement | HTMLInputElement, next: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, next);
  else el.value = next;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
