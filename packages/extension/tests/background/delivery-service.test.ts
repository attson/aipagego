import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectorService } from "@/background/connectors/service";
import { DeliveryService } from "@/background/connectors/delivery-service";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import { createRun, finalizeRun, getRun } from "@/background/storage/runs";
import { putJobRun } from "@/background/storage/jobs";
import {
  getDelivery,
  listDeliveries,
  putDelivery,
  pruneDeliveries,
  recoverRunningDeliveries,
} from "@/background/storage/connector-deliveries";
import { removeConnectorSecret } from "@/background/connectors/secrets";

function area() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => { delete values[key]; }),
  };
}

describe("manual connector deliveries", () => {
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

  async function fixture() {
    const connector = await new ConnectorService().save({
      name: "Sink", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://hooks.example.com/private?token=hidden", headers: { Authorization: "Bearer hidden" } },
    });
    const run = await createRun({ toolId: "tool-1", toolVersion: 1, url: "https://example.com" });
    await finalizeRun(run.id, { status: "ok", output: { title: "report" } });
    return { connector, runId: run.id };
  }

  it("sends a fixed webhook envelope and persists only redacted delivery metadata", async () => {
    const { connector, runId } = await fixture();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const delivery = await new DeliveryService().create(connector.id, { kind: "run", runId });
    expect(delivery).toMatchObject({ status: "ok", attempt: 1, source: { kind: "run", runId } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("private?token=hidden");
    expect((init as RequestInit).credentials).toBe("omit");
    expect((init as RequestInit).redirect).toBe("error");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe(`aipagego-${delivery.id}`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      deliveryId: delivery.id,
      sentAt: expect.any(Number),
      source: { kind: "run" },
      data: { title: "report" },
    });
    const raw = await (await getDB()).get("connector_deliveries", delivery.id);
    expect(JSON.stringify(raw)).not.toMatch(/hidden|private|report|Authorization/);
    expect(raw).toMatchObject({ sourceKey: runId, status: "ok" });
  });

  it("retries only delivery and never mutates or reruns the source RunRecord", async () => {
    const { connector, runId } = await fixture();
    const before = await getRun(runId);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new DeliveryService();
    const failed = await service.create(connector.id, { kind: "run", runId });
    expect(failed).toMatchObject({ status: "error", attempt: 1, httpStatus: 503 });
    const retried = await service.retry(failed.id);
    expect(retried).toMatchObject({ status: "ok", attempt: 2 });
    expect(await getRun(runId)).toEqual(before);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent creates for the same connector and source", async () => {
    const { connector, runId } = await fixture();
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => {
      markStarted();
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new DeliveryService();

    const first = service.create(connector.id, { kind: "run", runId });
    const second = service.create(connector.id, { kind: "run", runId });
    await started;
    release(new Response(null, { status: 204 }));
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.id).toBe(secondResult.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ensures a stable automatic delivery exactly once", async () => {
    const { connector, runId } = await fixture();
    let release!: (response: Response) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => {
      markStarted();
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new DeliveryService();
    const source = { kind: "run" as const, runId };

    const firstPending = service.ensure("job-delivery-stable", connector.id, source, connector.configHash);
    const secondPending = service.ensure("job-delivery-stable", connector.id, source, connector.configHash);
    await started;
    release(new Response(null, { status: 204 }));
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first).toMatchObject({ id: "job-delivery-stable", status: "ok" });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("continues a persisted queued automatic delivery without creating a duplicate", async () => {
    const { connector, runId } = await fixture();
    await putDelivery({
      id: "job-delivery-queued",
      connectorId: connector.id,
      connectorConfigHash: connector.configHash,
      source: { kind: "run", runId },
      status: "queued",
      attempt: 0,
      nextOffset: 0,
      sentCount: 0,
      createdAt: 10,
    });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeliveryService().ensure(
      "job-delivery-queued",
      connector.id,
      { kind: "run", runId },
      connector.configHash,
    );

    expect(result).toMatchObject({ id: "job-delivery-queued", status: "ok", attempt: 1 });
    expect(await getDelivery("job-delivery-queued")).toEqual(result);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a stable id collision without sending either source", async () => {
    const { connector, runId } = await fixture();
    await putDelivery({
      id: "job-delivery-conflict",
      connectorId: connector.id,
      connectorConfigHash: connector.configHash,
      source: { kind: "run", runId },
      status: "ok",
      attempt: 1,
      nextOffset: 0,
      createdAt: 10,
      finishedAt: 11,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeliveryService().ensure(
      "job-delivery-conflict",
      "another-connector",
      { kind: "run", runId },
      connector.configHash,
    )).rejects.toThrow("connector_delivery_conflict");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins an automatic delivery to the reviewed connector config hash", async () => {
    const { connector, runId } = await fixture();
    const reviewedHash = connector.configHash;
    await new ConnectorService().save({
      name: "Changed target",
      kind: "webhook",
      credentialMode: "persistent",
      secret: { action: "replace", url: "https://changed.example.com/hook", headers: {} },
    }, connector.id);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await new DeliveryService().ensure(
      "job-delivery-config-pinned",
      connector.id,
      { kind: "run", runId },
      reviewedHash,
    );

    expect(result).toMatchObject({
      status: "error",
      connectorConfigHash: reviewedHash,
      errorCode: "connector_changed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent retries for one delivery while keeping different deliveries parallel", async () => {
    const { connector, runId } = await fixture();
    const secondRun = await createRun({ toolId: "tool-2", toolVersion: 1, url: "https://example.com/2" });
    await finalizeRun(secondRun.id, { status: "ok", output: { title: "second" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new DeliveryService();
    const failedOne = await service.create(connector.id, { kind: "run", runId });
    const failedTwo = await service.create(connector.id, { kind: "run", runId: secondRun.id });

    const releases: Array<(response: Response) => void> = [];
    let startedCount = 0;
    let markBothStarted!: () => void;
    const bothStarted = new Promise<void>((resolve) => { markBothStarted = resolve; });
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => {
      releases.push(resolve);
      startedCount += 1;
      if (startedCount === 2) markBothStarted();
    }));

    const firstRetry = service.retry(failedOne.id);
    const duplicateRetry = service.retry(failedOne.id);
    const otherRetry = service.retry(failedTwo.id);
    await bothStarted;
    expect(releases).toHaveLength(2);
    for (const resolve of releases) resolve(new Response(null, { status: 204 }));
    const [firstResult, duplicateResult, otherResult] = await Promise.all([
      firstRetry, duplicateRetry, otherRetry,
    ]);

    expect(firstResult).toEqual(duplicateResult);
    expect(otherResult.id).toBe(failedTwo.id);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("requires explicit duplicate confirmation before retrying unknown_commit", async () => {
    const { connector, runId } = await fixture();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("ambiguous network failure"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = new DeliveryService();
    const unknown = await service.create(connector.id, { kind: "run", runId });
    expect(unknown.status).toBe("unknown_commit");
    await expect(service.retry(unknown.id)).rejects.toThrow("connector_unknown_commit_confirmation_required");
    await expect(service.retry(unknown.id, true)).resolves.toMatchObject({ status: "ok", attempt: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns source_expired without making an external request", async () => {
    const connector = await new ConnectorService().save({
      name: "Sink", kind: "webhook", credentialMode: "persistent",
      secret: { action: "replace", url: "https://hooks.example.com/hook", headers: {} },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new DeliveryService().create(connector.id, { kind: "collection_result", resultId: "gone" }))
      .resolves.toMatchObject({ status: "error", errorCode: "connector_source_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads every collection row across storage pages without copying rows into delivery metadata", async () => {
    const { connector } = await fixture();
    const rows = Array.from({ length: 501 }, (_, index) => ({ title: `row-${index}` }));
    await (await getDB()).put("collection_results", {
      resultId: "result-501",
      runId: "collection-run-1",
      tabId: 1,
      sourceUrl: "https://example.com/list",
      recipe: {
        version: 1,
        mode: "list",
        itemSelector: ".item",
        fields: [{ id: "title", name: "Title", selector: ".title", valueMode: "text", required: true }],
        pagination: { kind: "single" },
        dedupeBy: [],
        maxRows: 2_000,
        maxBytes: 5 * 1024 * 1024,
      },
      rows,
      status: "completed",
      phase: "completed",
      rowCount: rows.length,
      byteSize: 9_999,
      pageCount: 2,
      duplicateCount: 0,
      missingRequiredCount: 0,
      startedAt: 1,
      finishedAt: 2,
      stopReason: "completed",
      lastAccessedAt: 2,
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(null, { status: JSON.parse(String(init?.body)).data.length === 501 ? 204 : 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const delivery = await new DeliveryService().create(connector.id, {
      kind: "collection_result",
      resultId: "result-501",
    });

    expect(delivery).toMatchObject({ status: "ok", rowCount: 501, byteSize: expect.any(Number) });
    const persisted = await (await getDB()).get("connector_deliveries", delivery.id);
    expect(JSON.stringify(persisted)).not.toContain("row-500");
  });

  it("resolves a JobRun through its successful RunRecord instead of its output preview", async () => {
    const { connector } = await fixture();
    const failedRun = await createRun({ toolId: "tool-job", toolVersion: 1, url: "https://example.com" });
    await finalizeRun(failedRun.id, { status: "error", output: { wrong: true } });
    const successfulRun = await createRun({ toolId: "tool-job", toolVersion: 1, url: "https://example.com" });
    await finalizeRun(successfulRun.id, { status: "ok", output: { full: "run-record-output" } });
    await putJobRun({
      id: "job-run-1",
      jobId: "job-1",
      cause: "manual",
      startedAt: 1,
      finishedAt: 2,
      status: "ok",
      toolId: "tool-job",
      toolVersion: 1,
      attempts: [
        { attempt: 1, startedAt: 1, finishedAt: 1, runId: failedRun.id, status: "error" },
        { attempt: 2, startedAt: 1, finishedAt: 2, runId: successfulRun.id, status: "ok" },
      ],
      tab: { ownership: "created", tabId: 9 },
      output: { hash: "a".repeat(64), preview: { truncated: "must-not-be-sent" }, truncated: true, originalBytes: 70_000 },
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return new Response(null, { status: body.data?.full === "run-record-output" ? 204 : 400 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new DeliveryService().create(connector.id, {
      kind: "job_run",
      jobRunId: "job-run-1",
    })).resolves.toMatchObject({ status: "ok", source: { kind: "job_run", jobRunId: "job-run-1" } });
    expect(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)).not.toContain("must-not-be-sent");
  });

  it("persists a safe preflight failure as error instead of leaving the delivery running", async () => {
    const { connector, runId } = await fixture();
    await removeConnectorSecret(connector.id, connector.credentialMode);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const failed = await new DeliveryService().create(connector.id, { kind: "run", runId });

    expect(failed).toMatchObject({
      status: "error",
      attempt: 1,
      errorCode: "connector_credentials_missing",
    });
    expect((await listDeliveries()).find((item) => item.id === failed.id)).toMatchObject({
      status: "error",
      errorCode: "connector_credentials_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not start a new delivery until startup recovery has completed", async () => {
    const { connector, runId } = await fixture();
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const service = new DeliveryService();
    service.configureRecovery(recovery);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = service.create(connector.id, { kind: "run", runId });
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();

    finishRecovery();
    await expect(pending).resolves.toMatchObject({ status: "ok" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed when startup delivery recovery is unavailable", async () => {
    const { connector, runId } = await fixture();
    const service = new DeliveryService();
    service.configureRecovery(Promise.reject(new Error("idb unavailable")));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(service.create(connector.id, { kind: "run", runId }))
      .rejects.toThrow("connector_recovery_failed");
    await expect(service.list()).rejects.toThrow("connector_recovery_failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recovers running as unknown_commit and enforces per-connector/global retention", async () => {
    const base = {
      connectorConfigHash: "a".repeat(64), source: { kind: "run" as const, runId: "run-1" },
      status: "ok" as const, attempt: 1, nextOffset: 0, createdAt: 1,
    };
    await putDelivery({ ...base, id: "running", connectorId: "a", status: "running", startedAt: 1 });
    expect(await recoverRunningDeliveries(9)).toBe(1);
    expect(await listDeliveries()).toContainEqual(expect.objectContaining({
      id: "running", status: "unknown_commit", errorCode: "connector_unknown_commit", finishedAt: 9,
    }));
    for (let index = 0; index < 5; index++) {
      await putDelivery({ ...base, id: `d-${index}`, connectorId: index < 3 ? "a" : "b", createdAt: 10 + index });
    }
    await pruneDeliveries(2, 999);
    expect((await listDeliveries()).filter((item) => item.connectorId === "a")).toHaveLength(2);
    await pruneDeliveries(200, 3);
    expect(await listDeliveries()).toHaveLength(3);
  });
});
