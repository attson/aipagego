import type { Json, RunSource } from "@aipagego/shared/types";
import { screenshot } from "./bg-tools/capture";
import { downloadImage, downloadSpreadsheet } from "./bg-tools/downloads";
import { navigateBack, navigateForward, resize } from "./bg-tools/nav";
import {
  consoleMessages,
  handleDialog,
  networkRequestDetail,
  networkRequests,
  recorderConfig
} from "./bg-tools/recorder-tools";
import { searchBookmarks, searchHistory } from "./bg-tools/search";
import { closeTab, listTabs, openTab, switchToTab } from "./bg-tools/tabs";
import { collectStructuredData } from "./bg-tools/collection";

/**
 * Tools that run in the service worker rather than the content script.
 *
 * Before Plan 32 these lived in the side panel, which meant the coordinator
 * and MCP `EXEC` path — which goes straight from `runOneStep` to the content
 * script — could not reach them at all. Routing them here is what makes "every
 * built-in is exposed over MCP" true rather than aspirational.
 */
export type MetaExecutionContext = {
  timeoutMs?: number;
  source: RunSource;
};

export type MetaHandler = (
  args: Json,
  tabId: number,
  context?: MetaExecutionContext,
) => Promise<Json>;

/**
 * Keyed by tool name rather than `BuiltinTool` because `listTabs` and
 * `openTab` are TOOL_DEFS entries without a `BuiltinTool` member — they are
 * dispatched by name and never appear in a saved Step.
 */
export const META_TOOLS: Record<string, MetaHandler> = {
  // tab plane
  listTabs,
  openTab,
  closeTab,
  switchToTab,
  // browser data
  searchBookmarks,
  searchHistory,
  downloadImage,
  downloadSpreadsheet,
  // visual
  screenshot,
  // Plan 32 — navigation and recorder
  navigateBack,
  navigateForward,
  resize,
  consoleMessages,
  networkRequests,
  networkRequestDetail,
  handleDialog,
  recorderConfig,
  collectStructuredData
};

export function isMetaTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(META_TOOLS, name);
}

export const META_TOOL_NAMES: string[] = Object.keys(META_TOOLS);
