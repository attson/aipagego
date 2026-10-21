import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cdpRecorderEnabled,
  hasDebuggerPermission,
  removeDebuggerPermission,
  requestDebuggerPermission,
  setCdpRecorderEnabled
} from "@/background/recorder/cdp-permission";

const realChrome = globalThis.chrome;

function fakeChrome(opts: { has?: boolean; grant?: boolean; stored?: boolean }) {
  const store: Record<string, unknown> = { "aipagego.recorder.cdpEnabled": opts.stored ?? false };
  const stub = {
    permissions: {
      contains: vi.fn(async () => opts.has ?? false),
      request: vi.fn(async () => opts.grant ?? false),
      remove: vi.fn(async () => true)
    },
    storage: {
      local: {
        get: vi.fn(async (k: string) => ({ [k]: store[k] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        })
      }
    }
  };
  globalThis.chrome = stub as unknown as typeof chrome;
  return { stub, store };
}

afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("debugger permission", () => {
  it("reports whether the permission is held", async () => {
    fakeChrome({ has: true });
    expect(await hasDebuggerPermission()).toBe(true);
    fakeChrome({ has: false });
    expect(await hasDebuggerPermission()).toBe(false);
  });

  it("returns false rather than throwing when the API is absent", async () => {
    globalThis.chrome = {} as unknown as typeof chrome;
    expect(await hasDebuggerPermission()).toBe(false);
    expect(await requestDebuggerPermission()).toBe(false);
  });
});

describe("cdpRecorderEnabled", () => {
  it("is false while the permission is missing, whatever is stored", async () => {
    fakeChrome({ has: false, stored: true });
    expect(await cdpRecorderEnabled()).toBe(false);
  });

  it("is true only when both the permission and the flag are set", async () => {
    fakeChrome({ has: true, stored: true });
    expect(await cdpRecorderEnabled()).toBe(true);
    fakeChrome({ has: true, stored: false });
    expect(await cdpRecorderEnabled()).toBe(false);
  });
});

describe("setCdpRecorderEnabled", () => {
  it("requests the permission when turning on without it", async () => {
    const { stub, store } = fakeChrome({ has: false, grant: true });
    expect(await setCdpRecorderEnabled(true)).toBe(true);
    expect(stub.permissions.request).toHaveBeenCalled();
    expect(store["aipagego.recorder.cdpEnabled"]).toBe(true);
  });

  it("stays off when the user declines", async () => {
    const { store } = fakeChrome({ has: false, grant: false });
    expect(await setCdpRecorderEnabled(false || true)).toBe(false);
    expect(store["aipagego.recorder.cdpEnabled"]).toBe(false);
  });

  it("turning off does not ask for anything", async () => {
    const { stub, store } = fakeChrome({ has: true, stored: true });
    expect(await setCdpRecorderEnabled(false)).toBe(false);
    expect(stub.permissions.request).not.toHaveBeenCalled();
    expect(store["aipagego.recorder.cdpEnabled"]).toBe(false);
  });

  it("revoking the permission also clears the flag", async () => {
    const { store } = fakeChrome({ has: true, stored: true });
    await removeDebuggerPermission();
    expect(store["aipagego.recorder.cdpEnabled"]).toBe(false);
  });
});
