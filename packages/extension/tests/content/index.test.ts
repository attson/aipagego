import { afterEach, describe, expect, it, vi } from "vitest";
import { installContentRunner } from "@/content/index";

describe("content runStep boundary", () => {
  let dispose: (() => void) | undefined;

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    document.body.innerHTML = "";
  });

  it("executes background-resolved args without interpolating them a second time", async () => {
    let listener: Parameters<typeof chrome.runtime.onMessage.addListener>[0] | undefined;
    vi.stubGlobal("chrome", {
      runtime: {
        onMessage: {
          addListener: vi.fn((value) => { listener = value; }),
          removeListener: vi.fn()
        }
      }
    });
    dispose = installContentRunner();
    document.body.innerHTML = '<input id="q" />';

    const response = await new Promise<{ ok: boolean; data?: unknown; error?: string }>((resolve) => {
      listener?.({
        type: "content.runStep",
        step: {
          kind: "tool",
          tool: "fillInput",
          args: { selector: "#q", value: "keep ${literal}" }
        },
        bindings: { literal: "rewritten" }
      }, {} as chrome.runtime.MessageSender, resolve);
    });

    expect(response).toMatchObject({ ok: true });
    expect((document.querySelector("#q") as HTMLInputElement).value).toBe("keep ${literal}");
  });
});
