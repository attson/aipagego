import type { JobOutputDiff, JobOutputSnapshot } from "@aipagego/shared/jobs";
import { stableJsonStringify } from "@aipagego/shared/jobs";
import type { Json } from "@aipagego/shared/types";
import { sha256Json } from "./hash";

const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_DIFF_CHANGES = 100;

function byteLength(value: Json): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function compact(value: Json, maxItems: number, maxString: number, depth = 0): Json {
  if (typeof value === "string") {
    return value.length <= maxString ? value : `${value.slice(0, maxString)}…`;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= 8) return Array.isArray(value) ? [] : {};
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((item) => compact(item, maxItems, maxString, depth + 1));
  }
  const result: Record<string, Json> = {};
  for (const key of Object.keys(value).sort().slice(0, maxItems)) {
    result[key] = compact(value[key], maxItems, maxString, depth + 1);
  }
  return result;
}

function boundedPreview(value: Json): { preview: Json; truncated: boolean; originalBytes: number } {
  const originalBytes = new TextEncoder().encode(stableJsonStringify(value)).byteLength;
  if (originalBytes <= MAX_PREVIEW_BYTES) return { preview: value, truncated: false, originalBytes };
  for (const maxItems of [100, 50, 20, 10, 5, 1]) {
    const preview = compact(value, maxItems, 1_024);
    if (byteLength(preview) <= MAX_PREVIEW_BYTES) return { preview, truncated: true, originalBytes };
  }
  return { preview: { __truncated: true }, truncated: true, originalBytes };
}

export async function buildJobOutputSnapshot(value: Json): Promise<JobOutputSnapshot> {
  return { hash: await sha256Json(value), ...boundedPreview(value) };
}

function isRecord(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function diffJobOutputs(before: Json, after: Json): JobOutputDiff {
  const changes: JobOutputDiff["changes"] = [];
  let truncated = false;
  const visit = (left: Json | undefined, right: Json | undefined, path: string): void => {
    if (changes.length >= MAX_DIFF_CHANGES) {
      truncated = true;
      return;
    }
    if (stableJsonStringify(left ?? null) === stableJsonStringify(right ?? null) && left !== undefined && right !== undefined) return;
    if (isRecord(left as Json) && isRecord(right as Json)) {
      const keys = [...new Set([...Object.keys(left as Record<string, Json>), ...Object.keys(right as Record<string, Json>)])].sort();
      for (const key of keys) visit((left as Record<string, Json>)[key], (right as Record<string, Json>)[key], `${path}.${key}`);
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      for (let index = 0; index < length; index++) visit(left[index], right[index], `${path}[${index}]`);
      return;
    }
    changes.push({
      path,
      ...(left === undefined ? {} : { before: left }),
      ...(right === undefined ? {} : { after: right }),
    });
  };
  visit(before, after, "$");
  return { changes, truncated };
}
