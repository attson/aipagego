import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "aipagego.llm";
const MIGRATION_KEY = "aipagego.llm._migrated_v1";

function makeStorage() {
  const local: Record<string, unknown> = {};
  const session: Record<string, unknown> = {};
  function get(bag: Record<string, unknown>) {
    return (keys: string | string[] | Record<string, unknown> | null | undefined): Promise<Record<string, unknown>> => {
      const arr: string[] = Array.isArray(keys)
        ? keys
        : typeof keys === "string"
          ? [keys]
          : keys && typeof keys === "object"
            ? Object.keys(keys)
            : Object.keys(bag);
      const out: Record<string, unknown> = {};
      for (const k of arr) {
        if (bag[k] !== undefined) out[k] = bag[k];
      }
      return Promise.resolve(out);
    };
  }
  function set(bag: Record<string, unknown>) {
    return (obj: Record<string, unknown>): Promise<void> => {
      Object.assign(bag, obj);
      return Promise.resolve();
    };
  }
  function remove(bag: Record<string, unknown>) {
    return (k: string | string[]): Promise<void> => {
      const arr = Array.isArray(k) ? k : [k];
      for (const x of arr) delete bag[x];
      return Promise.resolve();
    };
  }
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: { get: vi.fn(get(local)), set: vi.fn(set(local)), remove: vi.fn(remove(local)) },
      session: { get: vi.fn(get(session)), set: vi.fn(set(session)), remove: vi.fn(remove(session)) },
    },
  };
  return { local, session };
}

describe("settings-store migration", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("migrates autoApproveDangerous → trustedDangerTools on first load", async () => {
    const { local } = makeStorage();
    local[KEY] = { autoApproveDangerous: ["submitForm", "uploadFile"] };
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    await useSettings.getState().load();

    expect(useSettings.getState().trustedDangerTools).toEqual(["submitForm", "uploadFile"]);
    const stored = local[KEY] as Record<string, unknown>;
    expect(stored.autoApproveDangerous).toBeUndefined();
    expect(stored.trustedDangerTools).toEqual(["submitForm", "uploadFile"]);
    expect(local[MIGRATION_KEY]).toBe(true);
  });

  it("does not re-migrate when migration flag set (new key wins)", async () => {
    const { local } = makeStorage();
    local[KEY] = { trustedDangerTools: ["submitForm"], autoApproveDangerous: ["uploadFile"] };
    local[MIGRATION_KEY] = true;
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    await useSettings.getState().load();
    expect(useSettings.getState().trustedDangerTools).toEqual(["submitForm"]);
  });

  it("supplies sensible defaults on empty storage", async () => {
    makeStorage();
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    await useSettings.getState().load();
    expect(useSettings.getState().defaultPermissionMode).toBe("default");
    expect(useSettings.getState().trustedDangerTools).toEqual([]);
    expect(useSettings.getState().defaultInjectionMode).toBe("diagnostic");
  });

  it("clamps persisted maxTokens into the supported UI range on load", async () => {
    const { local } = makeStorage();
    local[KEY] = { maxTokens: 40_961_000_000 };
    local[MIGRATION_KEY] = true;
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    await useSettings.getState().load();

    expect(useSettings.getState().maxTokens).toBe(200_000);
  });

  it("clamps maxTokens before saving", async () => {
    const { local } = makeStorage();
    local[MIGRATION_KEY] = true;
    const { useSettings } = await import("@/sidepanel/chat/settings-store");
    await useSettings.getState().load();
    await useSettings.getState().save({ maxTokens: 40_961_000_000 });

    expect(useSettings.getState().maxTokens).toBe(200_000);
    expect((local[KEY] as { maxTokens?: number }).maxTokens).toBe(200_000);
  });
});
