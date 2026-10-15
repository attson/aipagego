import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type OpenUrl = (url: string) => void | Promise<void>;

/**
 * Presents the pairing URL through the MCP host when possible. The host owns
 * the desktop session, so it is more reliable than spawning a browser from a
 * sandboxed or environment-filtered stdio child process.
 */
export function createPairingPresenter(
  server: Server,
  fallbackOpenUrl?: OpenUrl
): (url: string) => void {
  let presentedUrl: string | null = null;

  const runFallback = async (url: string): Promise<void> => {
    if (!fallbackOpenUrl) return;
    try {
      await fallbackOpenUrl(url);
    } catch (error) {
      presentedUrl = null;
      console.error(
        `[atwebpilot-mcp] failed to open pairing page ${url}:`,
        error instanceof Error ? error.message : String(error)
      );
    }
  };

  return (url: string): void => {
    if (presentedUrl === url) return;
    presentedUrl = url;

    if (!server.getClientCapabilities()?.elicitation?.url) {
      void runFallback(url);
      return;
    }

    void server.elicitInput({
      mode: "url",
      message: "Open AtWebPilot in the browser to approve this pairing request.",
      url,
      elicitationId: `atwebpilot-pairing-${randomUUID()}`
    }).catch((error) => {
      // A pending elicitation is rejected when the MCP transport closes. The
      // host is going away in that case, so opening a browser would be a
      // surprising shutdown side effect rather than a useful fallback.
      if (!server.transport) return;
      console.error(
        "[atwebpilot-mcp] URL elicitation failed; falling back to the system browser:",
        error instanceof Error ? error.message : String(error)
      );
      return runFallback(url);
    });
  };
}
