import { ConnectorDeliverySchema, type ConnectorDelivery, type ConnectorSource } from "@aipagego/shared/connectors";
import { getDB } from "./db";

type Persisted = ConnectorDelivery & { sourceKey: string };

export function connectorSourceKey(source: ConnectorSource): string {
  if (source.kind === "collection_result") return source.resultId;
  if (source.kind === "run") return source.runId;
  return source.jobRunId;
}

function persisted(delivery: ConnectorDelivery): Persisted {
  return { ...ConnectorDeliverySchema.parse(delivery), sourceKey: connectorSourceKey(delivery.source) };
}

function publicDelivery(row: Persisted | undefined): ConnectorDelivery | undefined {
  if (!row) return undefined;
  const { sourceKey: _sourceKey, ...value } = row;
  return ConnectorDeliverySchema.parse(value);
}

export async function putDelivery(delivery: ConnectorDelivery): Promise<ConnectorDelivery> {
  const db = await getDB();
  await db.put("connector_deliveries", persisted(delivery));
  return delivery;
}

export async function getDelivery(id: string): Promise<ConnectorDelivery | undefined> {
  return publicDelivery(await (await getDB()).get("connector_deliveries", id));
}

export async function listDeliveries(connectorId?: string): Promise<ConnectorDelivery[]> {
  const rows = await (await getDB()).getAll("connector_deliveries");
  return rows
    .filter((row) => connectorId == null || row.connectorId === connectorId)
    .map((row) => publicDelivery(row)!)
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
}

export async function deleteDeliveriesForConnector(connectorId: string): Promise<void> {
  const db = await getDB();
  const rows = (await db.getAll("connector_deliveries")).filter((row) => row.connectorId === connectorId);
  await Promise.all(rows.map((row) => db.delete("connector_deliveries", row.id)));
}

export async function recoverRunningDeliveries(now = Date.now()): Promise<number> {
  const db = await getDB();
  const rows = (await db.getAll("connector_deliveries")).filter((row) => row.status === "running");
  await Promise.all(rows.map((row) => db.put("connector_deliveries", persisted({
    ...publicDelivery(row)!,
    status: "unknown_commit",
    errorCode: "connector_unknown_commit",
    finishedAt: now,
  }))));
  return rows.length;
}

export async function pruneDeliveries(perConnector = 200, global = 2_000): Promise<string[]> {
  const db = await getDB();
  const all = (await db.getAll("connector_deliveries"))
    .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
  const selected = new Map<string, Persisted>();
  const counts = new Map<string, number>();
  for (const row of all) {
    const count = (counts.get(row.connectorId) ?? 0) + 1;
    counts.set(row.connectorId, count);
    if (count > perConnector && row.status !== "running") selected.set(row.id, row);
  }
  for (const row of all.filter((item) => !selected.has(item.id)).slice(global)) {
    if (row.status !== "running") selected.set(row.id, row);
  }
  for (const row of selected.values()) await db.delete("connector_deliveries", row.id);
  return [...selected.keys()];
}
