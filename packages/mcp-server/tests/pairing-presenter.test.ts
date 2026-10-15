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
});
