import { describe, expect, it, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { createPairingPresenter } from "../src/pairing-presenter";

describe("createPairingPresenter", () => {
  it("does not bypass an explicit host decline with the fallback opener", async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: "decline" });
    const server = {
      getClientCapabilities: () => ({ elicitation: { url: {} } }),
      elicitInput,
      transport: {}
    } as unknown as Server;
    const fallbackOpenUrl = vi.fn();

    createPairingPresenter(server, fallbackOpenUrl)("http://127.0.0.1:8787/pair");

    await vi.waitFor(() => expect(elicitInput).toHaveBeenCalledOnce());
    expect(fallbackOpenUrl).not.toHaveBeenCalled();
  });

  it("opens the system browser first for Codex even when URL elicitation is advertised", async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: "accept" });
    const server = {
      getClientVersion: () => ({ name: "codex-mcp-client", version: "0.162.1" }),
      getClientCapabilities: () => ({ elicitation: { url: {} } }),
      elicitInput,
      transport: {}
    } as unknown as Server;
    const fallbackOpenUrl = vi.fn().mockResolvedValue(undefined);

    createPairingPresenter(server, fallbackOpenUrl)("http://127.0.0.1:8787/pair");

    await vi.waitFor(() => expect(fallbackOpenUrl).toHaveBeenCalledOnce());
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("uses URL elicitation when the Codex system browser opener fails", async () => {
    const elicitInput = vi.fn().mockResolvedValue({ action: "accept" });
    const server = {
      getClientVersion: () => ({ name: "codex", version: "0.162.1" }),
      getClientCapabilities: () => ({ elicitation: { url: {} } }),
      elicitInput,
      transport: {}
    } as unknown as Server;
    const fallbackOpenUrl = vi.fn().mockRejectedValue(new Error("no desktop"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    createPairingPresenter(server, fallbackOpenUrl)("http://127.0.0.1:8787/pair");

    await vi.waitFor(() => expect(elicitInput).toHaveBeenCalledOnce());
    consoleError.mockRestore();
  });
});
