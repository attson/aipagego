import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { PersistedSession, RunRecord, Tool } from "@aipagego/shared/types";
import type { CollectionResultRecord } from "@aipagego/shared/collection";
import type { Job, JobRun } from "@aipagego/shared/jobs";
import type { Connector, ConnectorDelivery, ConnectorSource } from "@aipagego/shared/connectors";

type PersistedConnectorDelivery = ConnectorDelivery & { sourceKey: string };

export interface AIPageGoDB extends DBSchema {
  tools: {
    key: string;
    value: Tool;
    indexes: { byUpdatedAt: number };
  };
  runs: {
    key: string;
    value: RunRecord;
    indexes: { byToolId: string; byStartedAt: number };
  };
  chat_sessions: {
    key: string;
    value: PersistedSession;
    indexes: {
      by_url_status: [string, "active" | "archived"];
      by_lastTabId_status: [number, "active" | "archived"];
      by_url_updatedAt: [string, number];
    };
  };
  collection_results: {
    key: string;
    value: CollectionResultRecord;
    indexes: { by_runId: string; by_lastAccessedAt: number };
  };
  jobs: {
    key: string;
    value: Job;
    indexes: {
      byStatus: Job["status"];
      byNextRunAt: number;
      byToolId: string;
    };
  };
  job_runs: {
    key: string;
    value: JobRun;
    indexes: {
      byJobIdStartedAt: [string, number];
      byStatus: JobRun["status"];
    };
  };
  connectors: {
    key: string;
    value: Connector;
    indexes: {
      byKind: Connector["kind"];
      byStatus: Connector["status"];
      byUpdatedAt: number;
    };
  };
  connector_deliveries: {
    key: string;
    value: PersistedConnectorDelivery;
    indexes: {
      byConnectorCreatedAt: [string, number];
      byStatus: ConnectorDelivery["status"];
      bySource: [ConnectorSource["kind"], string];
    };
  };
}

const DB_NAME = "aipagego";
const DB_VERSION = 5;

let dbPromise: Promise<IDBPDatabase<AIPageGoDB>> | null = null;

export function getDB(): Promise<IDBPDatabase<AIPageGoDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AIPageGoDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const tools = db.createObjectStore("tools", { keyPath: "id" });
          tools.createIndex("byUpdatedAt", "updatedAt");
          const runs = db.createObjectStore("runs", { keyPath: "id" });
          runs.createIndex("byToolId", "toolId");
          runs.createIndex("byStartedAt", "startedAt");
        }
        if (oldVersion < 2) {
          const sessions = db.createObjectStore("chat_sessions", { keyPath: "id" });
          sessions.createIndex("by_url_status", ["url", "status"]);
          sessions.createIndex("by_lastTabId_status", ["lastTabId", "status"]);
          sessions.createIndex("by_url_updatedAt", ["url", "updatedAt"]);
        }
        if (oldVersion < 3) {
          const results = db.createObjectStore("collection_results", { keyPath: "resultId" });
          results.createIndex("by_runId", "runId", { unique: true });
          results.createIndex("by_lastAccessedAt", "lastAccessedAt");
        }
        if (oldVersion < 4) {
          const jobs = db.createObjectStore("jobs", { keyPath: "id" });
          jobs.createIndex("byStatus", "status");
          jobs.createIndex("byNextRunAt", "nextRunAt");
          jobs.createIndex("byToolId", "toolId");
          const jobRuns = db.createObjectStore("job_runs", { keyPath: "id" });
          jobRuns.createIndex("byJobIdStartedAt", ["jobId", "startedAt"]);
          jobRuns.createIndex("byStatus", "status");
        }
        if (oldVersion < 5) {
          const connectors = db.createObjectStore("connectors", { keyPath: "id" });
          connectors.createIndex("byKind", "kind");
          connectors.createIndex("byStatus", "status");
          connectors.createIndex("byUpdatedAt", "updatedAt");
          const deliveries = db.createObjectStore("connector_deliveries", { keyPath: "id" });
          deliveries.createIndex("byConnectorCreatedAt", ["connectorId", "createdAt"]);
          deliveries.createIndex("byStatus", "status");
          deliveries.createIndex("bySource", ["source.kind", "sourceKey"]);
        }
      }
    });
  }
  return dbPromise;
}

export function _resetDBForTests() {
  dbPromise = null;
}
