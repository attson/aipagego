import {
  PROTOCOL_VERSION,
  type Hello
} from "@aipagego/shared/protocol";
import { CAPABILITIES } from "@aipagego/shared/capability";
import { TOOLS } from "@/content/tools";
import { META_TOOL_NAMES } from "./meta-tool-router";

export interface BuildHelloInput {
  worker_id: string;
  saved_tools: Hello["saved_tools"];
  labels: string[];
}

function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function detectOs(): string {
  const ua = (globalThis.navigator?.userAgent ?? "").toLowerCase();
  if (ua.includes("mac")) return "darwin";
  if (ua.includes("win")) return "win32";
  if (ua.includes("linux")) return "linux";
  return "unknown";
}

function detectChromeVersion(): string {
  const ua = globalThis.navigator?.userAgent ?? "";
  const m = ua.match(/Chrome\/([\d.]+)/);
  return m?.[1] ?? "unknown";
}

export async function buildHello(input: BuildHelloInput): Promise<Hello> {
  const tabs = await chrome.tabs.query({});
  const available_tabs = tabs
    .filter((t) => t.id != null)
    .map((t) => ({
      tab_id: String(t.id),
      url: t.url ?? "",
      title: t.title ?? ""
    }));

  return {
    type: "HELLO",
    nonce: randomNonce(),
    ts: Date.now(),
    protocol_version: PROTOCOL_VERSION,
    worker_id: input.worker_id,
    fingerprint: {
      ext_hash: chrome.runtime.id ?? "unknown",
      os: detectOs(),
      chrome: detectChromeVersion()
    },
    capabilities: [...CAPABILITIES],
    // Everything this extension build can actually execute: content-script
    // tools, background-routed meta tools, and runJS (a step kind, not a
    // TOOLS entry). The server intersects against this so it never advertises
    // a tool an older extension would reject.
    supported_tools: [...new Set([...Object.keys(TOOLS), ...META_TOOL_NAMES, "runJS"])],
    attended: true,
    available_tabs,
    saved_tools: input.saved_tools,
    labels: input.labels
  };
}
