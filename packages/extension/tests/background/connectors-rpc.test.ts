import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRpc } from "@/background/rpc-handlers";
import { _resetDBForTests } from "@/background/storage/db";
import { createRun, finalizeRun } from "@/background/storage/runs";

function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}

describe("connector RPC", () => {
  const local = area();
  const session = area();
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    _resetDBForTests();
    for (const key of Object.keys(local.values)) delete local.values[key];
    for (const key of Object.keys(session.values)) delete session.values[key];
    vi.stubGlobal("chrome", { storage: { local, session } });
  });
  afterEach(() => {
    _resetDBForTests();
    vi.unstubAllGlobals();
  });

  it("creates, lists, tests and deletes without returning a secret", async () => {
    const created = await handleRpc({
      type: "connectors.save",
      draft: {
        name: "Orders", kind: "webhook", credentialMode: "persistent",
        secret: {
          action: "replace",
          url: "https://hooks.example.com/private?token=hidden",
          headers: { Authorization: "Bearer hidden" },
        },
      },
    });
    expect(created.ok).toBe(true);
    expect(JSON.stringify(created)).not.toContain("hidden");
    if (!created.ok) return;
    const id = (created.data as unknown as { id: string }).id;
    const listed = await handleRpc({ type: "connectors.list" });
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).not.toContain("hidden");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    expect((await handleRpc({ type: "connectors.test", id })).ok).toBe(true);
    expect((await handleRpc({ type: "connectors.delete", id })).ok).toBe(true);
    const missing = await handleRpc({ type: "connectors.get", id });
    expect(missing).toEqual({ ok: true, data: null });
  });

  it("rejects connector management from a content/widget sender", async () => {
    const response = await handleRpc({ type: "connectors.list" }, { source: "content" });
    expect(response).toEqual({ ok: false, error: "connector_sidepanel_required" });
  });

  it("creates, lists and explicitly confirms unknown delivery retries", async () => {
    const created = await handleRpc({
      type: "connectors.save",
      draft: {
        name: "Orders", kind: "webhook", credentialMode: "persistent",
        secret: { action: "replace", url: "https://hooks.example.com/orders", headers: {} },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const connectorId = (created.data as unknown as { id: string }).id;
    const run = await createRun({ toolId: "tool-1", toolVersion: 1, url: "https://example.com" });
    await finalizeRun(run.id, { status: "ok", output: { order: 7 } });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("network outcome is ambiguous"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await handleRpc({
      type: "deliveries.create",
      connectorId,
      source: { kind: "run", runId: run.id },
    });
    expect(first).toEqual({ ok: true, data: expect.objectContaining({ status: "unknown_commit" }) });
    if (!first.ok) return;
    const deliveryId = (first.data as unknown as { id: string }).id;
    expect(await handleRpc({ type: "deliveries.list", connectorId })).toEqual({
      ok: true,
      data: [expect.objectContaining({ id: deliveryId, source: { kind: "run", runId: run.id } })],
    });
    expect(await handleRpc({ type: "deliveries.retry", id: deliveryId })).toEqual({
      ok: false,
      error: "connector_unknown_commit_confirmation_required",
    });
    expect(await handleRpc({
      type: "deliveries.retry", id: deliveryId, confirmUnknownCommit: true,
    })).toEqual({ ok: true, data: expect.objectContaining({ status: "ok", attempt: 2 }) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects every delivery RPC from a content/widget sender", async () => {
    const requests = [
      { type: "deliveries.create", connectorId: "connector-1", source: { kind: "run", runId: "run-1" } },
      { type: "deliveries.list" },
      { type: "deliveries.retry", id: "delivery-1", confirmUnknownCommit: true },
    ] as const;
    for (const request of requests) {
      expect(await handleRpc(request, { source: "content" }))
        .toEqual({ ok: false, error: "connector_sidepanel_required" });
    }
  });
});
