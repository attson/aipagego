import type { Json } from "@aipagego/shared/types";
import { bounds, resolveTarget } from "./element-meta";

/**
 * Fires both a pointer sequence and an HTML5 drag sequence over one shared
 * DataTransfer. Real pages split between the two: native `draggable`
 * implementations listen for `dragover`/`drop`, while custom drag UIs track
 * `pointermove`. Sending only one silently no-ops on half the web.
 *
 * `consumed` reports which family the page actually reacted to, so a target
 * that ignores both is diagnosable instead of looking like a success.
 */
export async function drag(args: Json): Promise<Json> {
  const a = (args ?? {}) as Record<string, unknown>;
  const from = resolveTarget(a, { selector: "fromSelector", uid: "fromUid" }, "drag");
  const to = resolveTarget(a, { selector: "toSelector", uid: "toUid" }, "drag");

  const dt = makeDataTransfer();
  const src = center(from);
  const dst = center(to);
  const consumed = { pointer: false, html5: false };

  const pointer = (el: Element, type: string, at: { x: number; y: number }) => {
    const ev = makeMouseEvent(type, at);
    const notCancelled = el.dispatchEvent(ev);
    if (!notCancelled) consumed.pointer = true;
  };

  const html5 = (el: Element, type: string, at: { x: number; y: number }) => {
    const ev = makeDragEvent(type, at, dt);
    const notCancelled = el.dispatchEvent(ev);
    if (!notCancelled) consumed.html5 = true;
  };

  pointer(from, "pointerdown", src);
  pointer(from, "mousedown", src);
  html5(from, "dragstart", src);

  html5(to, "dragenter", dst);
  html5(to, "dragover", dst);
  pointer(to, "pointermove", dst);
  pointer(to, "mousemove", dst);
  html5(to, "drop", dst);

  html5(from, "dragend", src);
  pointer(from, "pointerup", dst);
  pointer(from, "mouseup", dst);

  return { ok: true, consumed } as unknown as Json;
}

function center(el: Element): { x: number; y: number } {
  const b = bounds(el);
  return { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) };
}

/**
 * happy-dom and some older Chrome surfaces lack a constructible DataTransfer.
 * The shim carries the same three members the drag path touches.
 */
export function makeDataTransfer(): DataTransfer {
  try {
    return new DataTransfer();
  } catch {
    const store = new Map<string, string>();
    const files: File[] = [];
    return {
      dropEffect: "none",
      effectAllowed: "all",
      files: files as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
      types: [] as unknown as readonly string[],
      setData: (format: string, data: string) => store.set(format, data),
      getData: (format: string) => store.get(format) ?? "",
      clearData: () => store.clear(),
      setDragImage: () => undefined,
    } as unknown as DataTransfer;
  }
}

function makeMouseEvent(type: string, at: { x: number; y: number }): Event {
  try {
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.x,
      clientY: at.y,
    });
  } catch {
    return new Event(type, { bubbles: true, cancelable: true });
  }
}

export function makeDragEvent(
  type: string,
  at: { x: number; y: number },
  dt: DataTransfer
): Event {
  let ev: Event;
  try {
    ev = new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.x,
      clientY: at.y,
      dataTransfer: dt,
    });
    if ((ev as DragEvent).dataTransfer) return ev;
  } catch {
    ev = new Event(type, { bubbles: true, cancelable: true });
  }
  // No DragEvent constructor, or one that dropped dataTransfer — attach it so
  // page handlers still see the payload.
  Object.defineProperty(ev, "dataTransfer", { value: dt, configurable: true });
  Object.defineProperty(ev, "clientX", { value: at.x, configurable: true });
  Object.defineProperty(ev, "clientY", { value: at.y, configurable: true });
  return ev;
}
