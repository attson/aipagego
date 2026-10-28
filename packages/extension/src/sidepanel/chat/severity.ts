import { highestSeverity, runStaticScan } from "@aipagego/shared/static-scan";
import type { Json } from "@aipagego/shared/types";

export type ToolSeverity = "safe" | "caution" | "dangerous";

export type PermissionMode = "read" | "default" | "trust" | "yolo";

const SAFE = new Set([
  "snapshotDOM",
  "querySelector",
  "querySelectorAll",
  "extractText",
  "extractImages",
  "scroll",
  "waitFor",
  "hover",
  "focus",
  "getValue",
  "extractFormState",
  "detachTab",
  "askUser",
  "screenshot",
  // Round 5 — meta + visual
  "searchBookmarks",
  "searchHistory",
  "switchToTab",
  "closeTab",
  "takeSnapshot",
  "highlightElement",
  "highlightText",
  // Round 6
  "getPageInfo",
  // Page Context Index — local read-only helpers
  "createPageIndex",
  "searchPageIndex",
  "readPageBlock",
  "extractPageFields",
  // Plan 32 — read-only observation
  "consoleMessages",
  "findElements",
  "inspectElement"
]);

const CAUTION = new Set([
  "click",
  "fillInput",
  "setCheckbox",
  "selectOption",
  "listTabs",
  "openTab",
  "attachTab",
  // Round 5 — write actions
  "clickByUid",
  "fillByUid",
  "fillForm",
  "downloadImage",
  "downloadSpreadsheet",
  "collectStructuredData",
  // Round 6
  "pressKey",
  // Plan 32
  "networkRequests",
  "recorderConfig",
  "handleDialog",
  "drag",
  "navigateBack",
  "navigateForward",
  "resize"
]);

const DANGEROUS_FIXED = new Set([
  "readStorage",
  "submitForm",
  "uploadFile",
  // Round 6
  "writeStorage",
  // Plan 32 — response headers routinely carry Authorization / Set-Cookie
  "networkRequestDetail"
]);

export function classifyTool(name: string, input: Json): ToolSeverity {
  if (SAFE.has(name)) return "safe";
  if (CAUTION.has(name)) return "caution";
  if (DANGEROUS_FIXED.has(name)) return "dangerous";
  if (name === "httpRequest") {
    const withCred = isObject(input) && (input as Record<string, Json>).withCredentials === true;
    return withCred ? "dangerous" : "caution";
  }
  if (name === "runJS") {
    const source = isObject(input) ? ((input as Record<string, Json>).source as string | undefined) : undefined;
    if (!source) return "caution";
    const sev = highestSeverity(runStaticScan(source));
    if (sev === "dangerous") return "dangerous";
    return "caution";
  }
  // drop carrying files is an upload in disguise
  if (name === "drop") {
    const files = isObject(input) ? (input as Record<string, Json>).files : undefined;
    return Array.isArray(files) && files.length > 0 ? "dangerous" : "caution";
  }
  if (name === "navigate") {
    const action = isObject(input) ? (input as Record<string, Json>).action : undefined;
    return action === "goto" ? "caution" : "safe";
  }
  return "dangerous";
}

/** Decide whether a tool call auto-runs under a given permission mode. */
export function evaluateAutoApproval(
  toolName: string,
  severity: ToolSeverity,
  mode: PermissionMode,
  trustedDangerTools: string[]
): boolean {
  if (mode === "yolo") return true;
  if (severity === "safe") return true;
  if (mode === "read") return false;
  if (severity === "caution") return true;
  // severity === "dangerous"
  if (mode === "trust") return trustedDangerTools.includes(toolName);
  return false; // default
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
