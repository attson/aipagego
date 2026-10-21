import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetDBForTests, getDB } from "@/background/storage/db";
import type { RunRecord } from "@aipagego/shared/types";
import { createRun, finalizeRun, getRun, listRuns } from "@/background/storage/runs";

describe("runs storage", () => {
  beforeEach(() => {
    _resetDBForTests();
    indexedDB = new IDBFactory();
  });
  afterEach(() => {
    _resetDBForTests();
  });

  it("createRun then finalizeRun ok", async () => {
    const run = await createRun({ toolId: null, toolVersion: null, url: "u" });
    expect(run.status).toBe("running");
    const final = await finalizeRun(run.id, { status: "ok", output: { a: 1 } });
    expect(final.status).toBe("ok");
    expect(final.output).toEqual({ a: 1 });
    expect(final.finishedAt).toBeGreaterThanOrEqual(final.startedAt);
  });

  it("listRuns returns runs sorted desc by startedAt", async () => {
    const r1 = await createRun({ toolId: "t1", toolVersion: 1, url: "u1" });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await createRun({ toolId: "t1", toolVersion: 1, url: "u2" });
    const list = await listRuns({ toolId: "t1" });
    expect(list[0].id).toBe(r2.id);
    expect(list[1].id).toBe(r1.id);
  });

  it("getRun returns saved run", async () => {
    const r = await createRun({ toolId: null, toolVersion: null, url: "u" });
    const got = await getRun(r.id);
    expect(got?.id).toBe(r.id);
  });

  it("createRun defaults source to user when omitted", async () => {
    const run = await createRun({ toolId: null, toolVersion: null, url: "u" });
    expect(run.source).toBe("user");
  });

  it("createRun preserves source when given", async () => {
    const run = await createRun({ toolId: null, toolVersion: null, url: "u", source: "coordinator" });
    expect(run.source).toBe("coordinator");
  });

  it("getRun backfills source on a raw record that lacks the field", async () => {
    const db = await getDB();
    const raw = {
      id: "legacy-1",
      toolId: null,
      toolVersion: null,
      url: "u",
      startedAt: 0,
      status: "ok",
      stepLog: []
    } as unknown as RunRecord;
    await db.put("runs", raw);
    const read = await getRun("legacy-1");
    expect(read?.source).toBe("user");
  });

  it("listRuns backfills source on raw records that lack the field", async () => {
    const db = await getDB();
    const raw = {
      id: "legacy-2",
      toolId: null,
      toolVersion: null,
      url: "u",
      startedAt: 0,
      status: "ok",
      stepLog: []
    } as unknown as RunRecord;
    await db.put("runs", raw);
    const all = await listRuns();
    const found = all.find((r) => r.id === "legacy-2");
    expect(found?.source).toBe("user");
  });
});
