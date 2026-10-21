import type { Json } from "@aipagego/shared/types";
import { bounds, resolveTarget } from "./element-meta";
import { makeDataTransfer, makeDragEvent } from "./drag";

type DroppedFile = { name: string; mimeType?: string; base64: string };

/**
 * Simulates a drop originating outside the browser — files from the desktop,
 * or typed data from another application. With `files` this is an upload in
 * disguise, which is why the capability layer maps it to `upload:file`.
 */
export async function drop(args: Json): Promise<Json> {
  const a = (args ?? {}) as Record<string, unknown>;
  const target = resolveTarget(a, { selector: "selector", uid: "uid" }, "drop");

  const dt = makeDataTransfer();
  const files = Array.isArray(a.files) ? (a.files as DroppedFile[]) : [];
  const data = (a.data ?? {}) as Record<string, string>;

  for (const [mime, value] of Object.entries(data)) {
    if (typeof value === "string") dt.setData(mime, value);
  }

  const built: File[] = [];
  for (const f of files) {
    if (!f || typeof f.name !== "string" || typeof f.base64 !== "string") {
      throw new Error("drop: each file needs a name and base64");
    }
    built.push(toFile(f));
  }
  if (built.length) attachFiles(dt, built);

  const b = bounds(target);
  const at = { x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) };
  const consumed = { html5: false };

  for (const type of ["dragenter", "dragover", "drop"]) {
    const notCancelled = target.dispatchEvent(makeDragEvent(type, at, dt));
    if (!notCancelled) consumed.html5 = true;
  }

  return { ok: true, fileCount: built.length, consumed } as unknown as Json;
}

function toFile(f: DroppedFile): File {
  let bytes: Uint8Array;
  try {
    const bin = atob(f.base64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (e) {
    throw new Error(`drop: ${f.name} has invalid base64 — ${e instanceof Error ? e.message : String(e)}`);
  }
  const type = f.mimeType || "application/octet-stream";
  return new File([bytes as unknown as BlobPart], f.name, { type });
}

/**
 * `DataTransfer.files` is read-only, and `items.add` is missing in happy-dom.
 * Try the real API first, then fall back to defining the property.
 */
function attachFiles(dt: DataTransfer, files: File[]): void {
  try {
    if (dt.items && typeof dt.items.add === "function") {
      for (const f of files) dt.items.add(f);
      if (dt.files && dt.files.length === files.length) return;
    }
  } catch {
    // fall through to the property definition
  }
  const list = files as unknown as FileList & { item?: (i: number) => File | null };
  list.item = (i: number) => files[i] ?? null;
  Object.defineProperty(dt, "files", { value: list, configurable: true });
}
