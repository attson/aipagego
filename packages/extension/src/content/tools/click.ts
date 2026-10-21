import type { Json } from "@aipagego/shared/types";

type Modifier = "Alt" | "Control" | "Meta" | "Shift";

type Args = {
  selector: string;
  required?: boolean;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Modifier[];
};

const BUTTON_CODE = { left: 0, middle: 1, right: 2 } as const;

export async function click(args: Json): Promise<Json> {
  const {
    selector,
    required = true,
    doubleClick = false,
    button = "left",
    modifiers = []
  } = (args ?? {}) as Args;

  const el = document.querySelector<HTMLElement>(selector);
  if (!el) {
    if (required) throw new Error(`click: selector not found: ${selector}`);
    return { clicked: false };
  }

  // The plain path stays on el.click(): it is what frameworks and
  // accessibility tooling expect, and it activates links and submits.
  if (!doubleClick && button === "left" && modifiers.length === 0) {
    el.click();
    return { clicked: true };
  }

  const init = mouseInit(button, modifiers);
  if (button === "right") {
    dispatch(el, "pointerdown", init);
    dispatch(el, "mousedown", init);
    dispatch(el, "pointerup", init);
    dispatch(el, "mouseup", init);
    dispatch(el, "contextmenu", init);
    return { clicked: true, button, modifiers };
  }

  dispatch(el, "pointerdown", init);
  dispatch(el, "mousedown", init);
  dispatch(el, "pointerup", init);
  dispatch(el, "mouseup", init);
  dispatch(el, "click", init);

  if (doubleClick) {
    dispatch(el, "pointerdown", init);
    dispatch(el, "mousedown", init);
    dispatch(el, "pointerup", init);
    dispatch(el, "mouseup", init);
    dispatch(el, "click", { ...init, detail: 2 });
    dispatch(el, "dblclick", { ...init, detail: 2 });
  }

  return { clicked: true, ...(doubleClick ? { doubleClick: true } : {}), button, modifiers };
}

function mouseInit(button: Args["button"], modifiers: Modifier[]): MouseEventInit {
  const set = new Set(modifiers);
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    detail: 1,
    button: BUTTON_CODE[button ?? "left"],
    altKey: set.has("Alt"),
    ctrlKey: set.has("Control"),
    metaKey: set.has("Meta"),
    shiftKey: set.has("Shift")
  };
}

function dispatch(el: Element, type: string, init: MouseEventInit): void {
  let ev: Event;
  try {
    ev = new MouseEvent(type, init);
  } catch {
    ev = new Event(type, { bubbles: true, cancelable: true });
  }
  el.dispatchEvent(ev);
}
