import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorService } from "@/background/connectors/service";
import { _resetDBForTests } from "@/background/storage/db";

function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}

function draft(region: "feishu" | "lark" = "feishu") {
  return {
    name: "CRM Base",
    kind: "feishu_base" as const,
    credentialMode: "persistent" as const,
    publicConfig: {
      region,
      appToken: "app-token",
      tableId: "table-id",
      fieldMapping: { title: "标题", price: "价格" },
    },
    secret: { action: "replace" as const, appId: "cli_123", appSecret: "app-secret-hidden" },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("Feishu/Lark Base connector", () => {
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

  it("stores only public Base config and tests with read-only metadata", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, data: { table: { name: "CRM" } } }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft());
    expect(created).toMatchObject({
      kind: "feishu_base",
      publicConfig: { region: "feishu", appToken: "app-token", tableId: "table-id" },
    });
    expect(JSON.stringify(created)).not.toContain("app-secret-hidden");
    await expect(service.test(created.id)).resolves.toEqual({ ok: true, status: 200 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://open.feishu.cn/open-apis/bitable/v1/apps/app-token/tables/table-id");
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).method).toBe("GET");
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("batch_create");
    expect(JSON.stringify(local.values)).not.toContain("tenant-hidden");
  });

  it("caches tenant tokens only in memory until expiry", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 }))
      .mockImplementation(async () => jsonResponse({ code: 0, data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft("lark"));
    await service.test(created.id);
    await service.test(created.id);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("tenant_access_token"))).toHaveLength(1);
    expect(JSON.stringify(local.values)).not.toContain("tenant-hidden");
  });

  it("sends mapped records in batches of at most 500 and advances checkpoints", async () => {
    const batchSizes: number[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 });
      }
      const body = JSON.parse(String(init?.body)) as { records: unknown[] };
      batchSizes.push(body.records.length);
      return jsonResponse({ code: 0, data: {} });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft());
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `row-${index}`, price: index, ignored: "x" }));
    await expect(service.sendFeishuRows(created.id, rows, created.configHash)).resolves.toEqual({
      status: "ok", sentCount: 501, nextOffset: 501,
    });
    expect(batchSizes).toEqual([500, 1]);
    const request = fetchMock.mock.calls.find(([url]) => String(url).includes("batch_create"));
    expect(request).toBeTruthy();
    expect(String(request?.[1]?.body)).not.toContain("ignored");
  });

  it("returns partial after a confirmed batch and unknown_commit on an ambiguous next request", async () => {
    let batch = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 });
      }
      batch += 1;
      if (batch === 1) return jsonResponse({ code: 0, data: {} });
      throw new TypeError("network down after send");
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft());
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `${index}`, price: index }));
    await expect(service.sendFeishuRows(created.id, rows, created.configHash)).resolves.toEqual({
      status: "unknown_commit", sentCount: 500, nextOffset: 500, errorCode: "connector_unknown_commit",
    });
    expect(batch).toBe(2);
  });

  it("returns a stable partial error without response-body leakage", async () => {
    let batch = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 });
      }
      batch += 1;
      return batch === 1 ? jsonResponse({ code: 0 }) : new Response("server-secret", { status: 403 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft());
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `${index}`, price: index }));
    const result = await service.sendFeishuRows(created.id, rows, created.configHash);
    expect(result).toEqual({
      status: "partial", sentCount: 500, nextOffset: 500,
      errorCode: "connector_permission_denied", httpStatus: 403,
    });
    expect(JSON.stringify(result)).not.toContain("server-secret");
  });

  it("fails before sending when a mapped row cannot be serialized", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("tenant_access_token")) {
        return jsonResponse({ code: 0, tenant_access_token: "tenant-hidden", expire: 7200 });
      }
      throw new Error("batch request must not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new ConnectorService();
    const created = await service.save(draft());
    await expect(service.sendFeishuRows(created.id, [{ title: 1n, price: 1 }], created.configHash)).resolves.toEqual({
      status: "error", sentCount: 0, nextOffset: 0, errorCode: "connector_invalid_payload",
    });
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("batch_create"))).toHaveLength(0);
    await expect(service.sendFeishuRows(created.id, [], created.configHash, 1)).rejects.toThrow("connector_invalid_checkpoint");
  });
});
