import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

export type OpenUrl = (url: string) => void | Promise<void>;

function isCodexClient(server: Server): boolean {
  return server.getClientVersion?.()?.name.toLowerCase().includes("codex") ?? false;
}

/**
 * Presents the pairing URL through the MCP host when possible. Codex is the
 * exception: some Codex frontends advertise URL elicitation without surfacing
 * it, so its local browser opener is attempted first.
 */
export function createPairingPresenter(
  server: Server,
  fallbackOpenUrl?: OpenUrl
): (url: string) => void {
  let presentedUrl: string | null = null;

  const runFallback = async (url: string): Promise<boolean> => {
    if (!fallbackOpenUrl) return false;
    try {
      await fallbackOpenUrl(url);
      return true;
    } catch (error) {
      console.error(
        `[atwebpilot-mcp] failed to open pairing page ${url}:`,
        error instanceof Error ? error.message : String(error)
      );
      return false;
    }
  };

  const requestHostPresentation = (url: string, fallbackOnFailure: boolean): void => {
    void server.elicitInput({
      mode: "url",
      message: "Open AtWebPilot in the browser to approve this pairing request.",
      url,
      elicitationId: `atwebpilot-pairing-${randomUUID()}`
    }).catch(async (error) => {
      // A pending elicitation is rejected when the MCP transport closes. The
      // host is going away in that case, so opening a browser would be a
      // surprising shutdown side effect rather than a useful fallback.
      if (!server.transport) return;
      console.error(
        fallbackOnFailure
          ? "[atwebpilot-mcp] URL elicitation failed; falling back to the system browser:"
          : "[atwebpilot-mcp] URL elicitation failed:",
        error instanceof Error ? error.message : String(error)
      );
      if (fallbackOnFailure && await runFallback(url)) return;
      presentedUrl = null;
    });
  };

  return (url: string): void => {
    if (presentedUrl === url) return;
    presentedUrl = url;

    const supportsUrlElicitation = Boolean(server.getClientCapabilities()?.elicitation?.url);

    if (isCodexClient(server)) {
      void runFallback(url).then((opened) => {
        if (opened || !server.transport) return;
        if (supportsUrlElicitation) requestHostPresentation(url, false);
        else presentedUrl = null;
      });
      return;
    }

    if (supportsUrlElicitation) {
      requestHostPresentation(url, true);
      return;
    }

    void runFallback(url).then((opened) => {
      if (!opened) presentedUrl = null;
    });
  };
}
