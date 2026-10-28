import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorService } from "@/background/connectors/service";
import { _resetDBForTests } from "@/background/storage/db";

function storageArea() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}

describe("webhook connectors", () => {
  const local = storageArea();
  const session = storageArea();

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    for (const key of Object.keys(local.values)) delete local.values[key];
    for (const key of Object.keys(session.values)) delete session.values[key];
    vi.stubGlobal("chrome", { storage: { local, session } });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetDBForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stores only redacted config in IDB and partitions write-only secrets by lifetime", async () => {
    const service = new ConnectorService();
    const created = await service.save({
      name: "Orders",
      kind: "webhook",
      credentialMode: "persistent",
      secret: {
        action: "replace",
        url: "https://hooks.example.com/private?token=hidden",
        headers: { Authorization: "Bearer hidden" },
      },
    });
    expect(created).toMatchObject({
      name: "Orders",
      credentialMode: "persistent",
      credentialConfigured: true,
      status: "ready",
      publicConfig: { endpointOrigin: "https://hooks.example.com", headerCount: 1 },
    });
    expect(JSON.stringify(created)).not.toContain("hidden");
    expect(JSON.stringify(local.values)).toContain("hidden");
    expect(JSON.stringify(session.values)).not.toContain("hidden");

    const edited = await service.save({
      name: "Orders session",
      kind: "webhook",
      credentialMode: "session",
      secret: { action: "keep" },
    }, created.id);
    expect(edited.credentialMode).toBe("session");
    expect(JSON.stringify(local.values)).not.toContain("hidden");
    expect(JSON.stringify(session.values)).toContain("hidden");
    expect(edited.configHash).not.toBe(created.configHash);
  });

  it("reports a lost session credential without exposing or reading it back", async () => {
    const service = new ConnectorService();
    const created = await service.save({
      name: "Ephemeral",
      kind: "webhook",
      credentialMode: "session",
      secret: { action: "replace", url: "https://example.com/hook", headers: {} },
    });
    delete session.values["aipagego.connectorSecrets"];
    expect(await service.get(created.id)).toMatchObject({
      credentialConfigured: false,
      status: "needs_credentials",
    });

    const replaced = await service.save({
      name: "Ephemeral",
      kind: "webhook",
      credentialMode: "session",
      secret: { action: "replace", url: "https://example.com/hook", headers: {} },
    }, created.id);
    expect(replaced.configHash).not.toBe(created.configHash);
  });

  it("sends only a synthetic POST with omitted credentials and rejected redirects", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save({
      name: "Test",
      kind: "webhook",
      credentialMode: "persistent",
      secret: {
        action: "replace",
        url: "https://example.com/private?token=hidden",
        headers: { Authorization: "Bearer hidden" },
      },
    });
    await expect(service.test(created.id)).resolves.toEqual({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/private?token=hidden",
      expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error" }),
    );
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ type: "aipagego.connection_test" });
  });

  it("normalizes HTTP and network failures without target or response-body leakage", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("server-secret", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save({
      name: "Test",
      kind: "webhook",
      credentialMode: "persistent",
      secret: { action: "replace", url: "https://example.com/private?token=hidden", headers: {} },
    });
    await expect(service.test(created.id)).rejects.toThrow("connector_auth_failed");
    await expect(service.test(created.id)).rejects.not.toThrow(/hidden|server-secret|private/);
    expect(await service.get(created.id)).toMatchObject({ status: "needs_attention" });
  });

  it("refuses to send when the connector changed after delivery confirmation", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save({
      name: "Original", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://original.example/hook", headers: {} },
    });
    await service.save({
      name: "Changed", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://changed.example/hook", headers: {} },
    }, created.id);

    await expect(service.sendWebhookData(
      created.id,
      "delivery-1",
      "run",
      { report: true },
      created.configHash,
    )).rejects.toThrow("connector_changed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a synthetic test that exceeds its network budget", async () => {
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        fetchStarted();
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save({
      name: "Timeout", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://example.com/hook", headers: {} },
    });
    vi.useFakeTimers();
    const testing = service.test(created.id);
    await started;
    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    await expect(testing).rejects.toThrow("connector_network_failed");
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
  });

  it("serializes concurrent writes to the shared secret map without dropping either connector", async () => {
    const values: Record<string, unknown> = {};
    let firstGetSeen!: () => void;
    let releaseFirstGet!: () => void;
    const firstSeen = new Promise<void>((resolve) => { firstGetSeen = resolve; });
    const firstGate = new Promise<void>((resolve) => { releaseFirstGet = resolve; });
    let gets = 0;
    const racingLocal = {
      values,
      get: vi.fn(async (key: string) => {
        gets += 1;
        if (gets === 1) {
          firstGetSeen();
          await firstGate;
        }
        return { [key]: structuredClone(values[key]) };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, structuredClone(items))),
      remove: vi.fn(async (key: string) => { delete values[key]; }),
    };
    vi.stubGlobal("chrome", { storage: { local: racingLocal, session } });
    const service = new ConnectorService();
    const first = service.save({
      name: "A", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://a.example/hook", headers: {} },
    });
    await firstSeen;
    const second = service.save({
      name: "B", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://b.example/hook", headers: {} },
    });
    await Promise.resolve();
    releaseFirstGet();
    const connectors = await Promise.all([first, second]);
    const stored = values["aipagego.connectorSecrets"] as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(connectors.map((item) => item.id).sort());
  });

  it("releases the mutation queue after a storage failure so the next save can succeed", async () => {
    local.set.mockRejectedValueOnce(new Error("storage unavailable"));
    const service = new ConnectorService();
    await expect(service.save({
      name: "Fails", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://fail.example/hook", headers: {} },
    })).rejects.toThrow("connector_secret_storage_failed");
    await expect(service.save({
      name: "Works", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://works.example/hook", headers: {} },
    })).resolves.toMatchObject({ name: "Works", status: "ready" });
  });

  it("rolls back a save when stale-secret cleanup fails after the public write", async () => {
    session.get.mockRejectedValueOnce(new Error("session storage unavailable"));
    const service = new ConnectorService();
    await expect(service.save({
      name: "Rollback", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://rollback.example/hook", headers: {} },
    })).rejects.toThrow("connector_secret_cleanup_failed");
    await expect(service.list()).resolves.toEqual([]);
    expect(JSON.stringify(local.values)).not.toContain("rollback.example");
  });

  it("keeps the public record recoverable when secret deletion fails", async () => {
    const service = new ConnectorService();
    const created = await service.save({
      name: "Recoverable", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://example.com/hook", headers: {} },
    });
    local.remove.mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(service.delete(created.id)).rejects.toThrow("connector_secret_storage_failed");
    await expect(service.get(created.id)).resolves.toMatchObject({ id: created.id });
  });

  it("deletes public config and both secret partitions", async () => {
    const service = new ConnectorService();
    const created = await service.save({
      name: "Delete me", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://example.com/hook", headers: {} },
    });
    await service.delete(created.id);
    expect(await service.get(created.id)).toBeNull();
    expect(local.remove).toHaveBeenCalled();
    expect(JSON.stringify(session.values)).not.toContain(created.id);
  });
});
