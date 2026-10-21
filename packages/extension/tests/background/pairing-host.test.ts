import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approve,
  decidePairing,
  listTrusted,
  revokeTrust
} from "@/background/pairing-host";
import type { PairPayload } from "@aipagego/shared/pairing";

const realChrome = globalThis.chrome;

const payload: PairPayload = {
  v: 1,
  installId: "inst_abc",
  secret: "s3cr3t",
  sessionId: "sess_1",
  label: "~/code/aipagego",
  pid: 1,
  port: 51234
};

beforeEach(() => {
  const store: Record<string, unknown> = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: vi.fn(async (k: string) => ({ [k]: store[k] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
        })
      }
    }
  } as unknown as typeof chrome;
});

afterEach(() => {
  globalThis.chrome = realChrome;
  vi.restoreAllMocks();
});

describe("decidePairing", () => {
  it("asks about an unknown install", async () => {
    expect(await decidePairing(payload)).toBe("ask");
  });

  it("trusts an install once approved", async () => {
    await approve(payload);
    expect(await decidePairing(payload)).toBe("trusted");
  });

  it("trusts a different session from the same install", async () => {
    await approve(payload);
    const other = { ...payload, sessionId: "sess_2", label: "~/code/wanxin", port: 51299 };
    expect(await decidePairing(other)).toBe("trusted");
  });

  it("asks when the secret does not match", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await approve(payload);
    expect(await decidePairing({ ...payload, secret: "wrong!!" })).toBe("ask");
    expect(warn).toHaveBeenCalled();
  });

  it("asks when the secret is the right length but different", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await approve(payload);
    // same length as "s3cr3t", one character different
    expect(await decidePairing({ ...payload, secret: "S3cr3t" })).toBe("ask");
  });

  it("survives storage failures by asking", async () => {
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => { throw new Error("nope"); }), set: vi.fn() } }
    } as unknown as typeof chrome;
    expect(await decidePairing(payload)).toBe("ask");
  });
});

describe("trust management", () => {
  it("records the approval time", async () => {
    await approve(payload);
    const [rec] = await listTrusted();
    expect(rec.installId).toBe("inst_abc");
    expect(rec.approvedAt).toBeGreaterThan(0);
  });

  it("does not duplicate an install on re-approval", async () => {
    await approve(payload);
    await approve(payload);
    expect(await listTrusted()).toHaveLength(1);
  });

  it("revoking returns the install to asking", async () => {
    await approve(payload);
    await revokeTrust(payload.installId);
    expect(await listTrusted()).toEqual([]);
    expect(await decidePairing(payload)).toBe("ask");
  });

  it("revoking one install leaves others alone", async () => {
    await approve(payload);
    await approve({ ...payload, installId: "inst_other", secret: "zzz" });
    await revokeTrust("inst_other");
    expect((await listTrusted()).map((r) => r.installId)).toEqual(["inst_abc"]);
  });
});
