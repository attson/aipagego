/**
 * Side-panel entry point for the meta-plane tools (closeTab / switchToTab /
 * searchBookmarks / searchHistory / downloadImage / downloadSpreadsheet).
 *
 * The implementations live in `background/bg-tools/*` and are shared with the
 * coordinator / MCP `EXEC` path through `meta-tool-router`. Before Plan 32 they
 * lived here, which meant an external agent could not reach them at all. This
 * module now only supplies the side panel's notion of which tabs are in scope.
 */

import type { Json } from "@aipagego/shared/types";
import { META_TOOLS } from "@/background/meta-tool-router";

export type MetaHandler = (input: unknown) => Promise<unknown>;

const SIDEPANEL_META_TOOLS = [
  "closeTab",
  "switchToTab",
  "searchBookmarks",
  "searchHistory",
  "downloadImage",
  "downloadSpreadsheet"
] as const;

export function buildMetaTools(opts: {
  attachedTabIds: () => number[];
  mainTabId: number;
}): Record<string, MetaHandler> {
  const out: Record<string, MetaHandler> = {};
  for (const name of SIDEPANEL_META_TOOLS) {
    const handler = META_TOOLS[name];
    if (!handler) continue;
    out[name] = (input: unknown) => {
      const args = {
        ...((input ?? {}) as Record<string, unknown>),
        allowedTabIds: [opts.mainTabId, ...opts.attachedTabIds()]
      } as unknown as Json;
      return handler(args, opts.mainTabId) as Promise<unknown>;
    };
  }
  return out;
}
