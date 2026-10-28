import { ConnectorSchema, type Connector } from "@aipagego/shared/connectors";
import { getDB } from "./db";

export async function putConnector(connector: Connector): Promise<Connector> {
  const parsed = ConnectorSchema.parse(connector) as Connector;
  const db = await getDB();
  await db.put("connectors", parsed);
  return parsed;
}

export async function getConnector(id: string): Promise<Connector | undefined> {
  const db = await getDB();
  const parsed = ConnectorSchema.safeParse(await db.get("connectors", id));
  return parsed.success ? parsed.data as Connector : undefined;
}

export async function listConnectors(): Promise<Connector[]> {
  const db = await getDB();
  return (await db.getAll("connectors"))
    .map((row) => ConnectorSchema.safeParse(row))
    .filter((result): result is { success: true; data: Connector } => result.success)
    .map((result) => result.data)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function deleteConnector(id: string): Promise<void> {
  const db = await getDB();
  await db.delete("connectors", id);
}
