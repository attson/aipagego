import { ContentRequest } from "@aipagego/shared/messages";
import type { Json } from "@aipagego/shared/types";
import { injectMain } from "./inject-main";
import { callTool } from "./tools";
import { extractCollectionPage, extractCollectionPreview } from "./collection-preview";
import {
  advanceCollectionInfiniteScroll,
  advanceCollectionLoadMore,
  advanceCollectionNext,
} from "./collection-pagination";
let installed = false;

const listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (msg, _sender, sendResponse) => {
  const parsed = ContentRequest.safeParse(msg);
  if (!parsed.success) {
    // Tag the rejection so the caller surfaces an actionable error instead of
    // crashing on `undefined.ok` when the response channel closes silently.
    const m = (msg as { type?: string } | null)?.type;
    if (m && typeof m === "string" && m.startsWith("content.")) {
      sendResponse({
        ok: false,
        error: `content script rejected request: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`
      });
      return false;
    }
    return false;
  }
  handle(parsed.data)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
  return true;
};

export function installContentRunner(): () => void {
  if (installed) return () => {};
  installed = true;
  chrome.runtime.onMessage.addListener(listener);
  return () => {
    if (!installed) return;
    chrome.runtime.onMessage.removeListener(listener);
    installed = false;
  };
}

async function handle(req: import("@aipagego/shared/messages").ContentRequest): Promise<Json> {
  if (req.type === "content.runStep") {
    const { step, bindings } = req;
    if (step.kind === "tool") {
      return callTool(step.tool, step.args as Json);
    }
    return injectMain(step.source, bindings as unknown as Json);
  }
  if (req.type === "content.collectionPreview") {
    return extractCollectionPreview(req.recipe) as unknown as Json;
  }
  if (req.type === "content.collectionExtractPage") {
    return extractCollectionPage(req.recipe) as unknown as Json;
  }
  if (req.type === "content.collectionAdvanceNext") {
    return advanceCollectionNext(req.selector) as unknown as Json;
  }
  if (req.type === "content.collectionAdvanceDynamic") {
    return req.action.kind === "loadMore"
      ? advanceCollectionLoadMore(req.action.selector) as unknown as Json
      : advanceCollectionInfiniteScroll() as unknown as Json;
  }
  throw new Error(`unhandled content request: ${(req as { type: string }).type}`);
}
