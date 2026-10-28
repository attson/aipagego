import { z } from "zod";
import {
  WebhookSecretSchema,
  FeishuBaseSecretSchema,
  type ConnectorCredentialMode,
  type FeishuBaseSecret,
  type WebhookSecret,
} from "@aipagego/shared/connectors";

export const CONNECTOR_SECRETS_STORAGE_KEY = "aipagego.connectorSecrets";

export type StoredConnectorSecret =
  | { kind: "webhook"; revision: number; value: WebhookSecret }
  | { kind: "feishu_base"; revision: number; value: FeishuBaseSecret };

type SecretMap = Record<string, StoredConnectorSecret>;

const SecretMapSchema = z.record(z.string(), z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("webhook"),
    revision: z.number().int().positive(),
    value: WebhookSecretSchema,
  }).strict(),
  z.object({
    kind: z.literal("feishu_base"),
    revision: z.number().int().positive(),
    value: FeishuBaseSecretSchema,
  }).strict(),
]));

function area(mode: ConnectorCredentialMode): chrome.storage.StorageArea {
  return mode === "persistent" ? chrome.storage.local : chrome.storage.session;
}

async function readMap(mode: ConnectorCredentialMode): Promise<SecretMap> {
  const stored = await area(mode).get(CONNECTOR_SECRETS_STORAGE_KEY);
  const value = stored[CONNECTOR_SECRETS_STORAGE_KEY];
  if (value == null) return {};
  const parsed = SecretMapSchema.safeParse(value);
  if (!parsed.success) throw new Error("connector_secret_store_invalid");
  return parsed.data;
}

export async function readConnectorSecret(
  id: string,
  mode: ConnectorCredentialMode,
): Promise<StoredConnectorSecret | undefined> {
  return (await readMap(mode))[id];
}

export async function writeConnectorSecret(
  id: string,
  mode: ConnectorCredentialMode,
  secret: StoredConnectorSecret,
): Promise<void> {
  const values = await readMap(mode);
  await area(mode).set({ [CONNECTOR_SECRETS_STORAGE_KEY]: { ...values, [id]: secret } });
}

export async function removeConnectorSecret(id: string, mode: ConnectorCredentialMode): Promise<void> {
  const values = await readMap(mode);
  if (!(id in values)) return;
  delete values[id];
  if (Object.keys(values).length === 0) await area(mode).remove(CONNECTOR_SECRETS_STORAGE_KEY);
  else await area(mode).set({ [CONNECTOR_SECRETS_STORAGE_KEY]: values });
}

export async function deleteConnectorSecrets(id: string): Promise<void> {
  await Promise.all([removeConnectorSecret(id, "persistent"), removeConnectorSecret(id, "session")]);
}
