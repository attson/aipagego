import type { Json } from "@aipagego/shared/types";

type Args = {
  selector: string;
  value: string;
  clear?: boolean;
  slowly?: boolean;
  submit?: boolean;
};

export async function fillInput(args: Json): Promise<Json> {
  const { selector, value, clear = true, slowly = false, submit = false } = (args ?? {}) as Args;
  const el = document.querySelector(selector);
  if (!el) throw new Error(`selector miss: ${selector}`);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    if (slowly) {
      el.focus();
      if (clear) setValue(el, "");
      for (const ch of value) {
        key(el, "keydown", ch);
        key(el, "keypress", ch);
        setValue(el, el.value + ch);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        key(el, "keyup", ch);
      }
    } else {
      setValue(el, clear ? value : el.value + value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (submit) pressEnter(el);
    return { filled: true, kind: el.tagName.toLowerCase(), ...(slowly ? { slowly: true } : {}) };
  }

  if (el instanceof HTMLElement && isEditable(el)) {
    if (slowly) {
      el.focus();
      if (clear) el.textContent = "";
      for (const ch of value) {
        key(el, "keydown", ch);
        key(el, "keypress", ch);
        el.textContent = (el.textContent ?? "") + ch;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        key(el, "keyup", ch);
      }
    } else {
      el.textContent = clear ? value : (el.textContent ?? "") + value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (submit) pressEnter(el);
    return { filled: true, kind: "contenteditable", ...(slowly ? { slowly: true } : {}) };
  }

  throw new Error(`not an input/textarea/contenteditable: ${selector}`);
}

/**
 * React and Vue install a value setter on the element's prototype and track
 * the last value they wrote. Assigning `el.value` directly bypasses that
 * tracker, so the framework decides nothing changed and drops the input event.
 * Calling the native setter keeps the tracker in sync.
 */
function setValue(el: HTMLInputElement | HTMLTextAreaElement, next: string): void {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  if (desc?.set) desc.set.call(el, next);
  else el.value = next;
}

function key(el: Element, type: string, ch: string): void {
  let ev: Event;
  try {
    ev = new KeyboardEvent(type, { key: ch, bubbles: true, cancelable: true, composed: true });
  } catch {
    ev = new Event(type, { bubbles: true, cancelable: true });
  }
  el.dispatchEvent(ev);
}

function pressEnter(el: Element): void {
  for (const type of ["keydown", "keypress", "keyup"]) {
    let ev: Event;
    try {
      ev = new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        bubbles: true,
        cancelable: true,
        composed: true
      } as KeyboardEventInit);
    } catch {
      ev = new Event(type, { bubbles: true, cancelable: true });
    }
    el.dispatchEvent(ev);
  }
}

function isEditable(el: HTMLElement): boolean {
  if (el.isContentEditable) return true;
  const attr = el.getAttribute("contenteditable");
  return attr === "" || attr === "true" || attr === "plaintext-only";
}
