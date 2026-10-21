import { type DBSchema, type IDBPDatabase, openDB } from "idb";
import type { PersistedSession, RunRecord, Tool } from "@aipagego/shared/types";

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
}

const DB_NAME = "aipagego";
const DB_VERSION = 2;

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
      }
    });
  }
  return dbPromise;
}

export function _resetDBForTests() {
  dbPromise = null;
}
