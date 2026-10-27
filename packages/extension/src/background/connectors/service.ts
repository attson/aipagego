import {
  ConnectorDraftSchema,
  connectorConfigHashMaterial,
  connectorProviderOrigin,
  parseFeishuBaseSecret,
  parseWebhookSecret,
  type Connector,
  type ConnectorDeliveryErrorCode,
  type ConnectorDraft,
  type FeishuBasePublicConfig,
  type WebhookPublicConfig,
} from "@aipagego/shared/connectors";
import { sha256Json } from "../jobs/hash";
import {
  deleteConnector as deleteConnectorRecord,
  getConnector,
  listConnectors,
  putConnector,
} from "../storage/connectors";
import { deleteDeliveriesForConnector } from "../storage/connector-deliveries";
import {
  deleteConnectorSecrets,
  readConnectorSecret,
  removeConnectorSecret,
  writeConnectorSecret,
} from "./secrets";

const WEBHOOK_TEST_TIMEOUT_MS = 15_000;
const FEISHU_BATCH_SIZE = 500;
let mutationTail: Promise<void> = Promise.resolve();

function runMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(() => undefined, () => undefined);
  return result;
}

function connectorError(code: string, status?: number): Error {
  return new Error(status == null ? code : `${code} (HTTP ${status})`);
}

function codeForStatus(status: number): ConnectorDeliveryErrorCode {
  if (status === 401) return "connector_auth_failed";
  if (status === 403) return "connector_permission_denied";
  if (status === 404) return "connector_target_not_found";
  if (status === 429) return "connector_rate_limited";
  return "connector_http_error";
}

function codeForFeishuBody(code: unknown): ConnectorDeliveryErrorCode {
  if ([99991663, 99991664, 99991665].includes(Number(code))) return "connector_auth_failed";
  if ([99991668, 99991669, 1254303].includes(Number(code))) return "connector_permission_denied";
  if ([1254040, 1254041, 1254043, 1254044].includes(Number(code))) return "connector_target_not_found";
  if ([1254290, 1254291, 99991429].includes(Number(code))) return "connector_rate_limited";
  return "connector_http_error";
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

type TenantToken = { value: string; expiresAt: number };
export type FeishuSendResult = {
  status: "ok" | "error" | "partial" | "unknown_commit";
  sentCount: number;
  nextOffset: number;
  errorCode?: ConnectorDeliveryErrorCode;
  httpStatus?: number;
};
export type WebhookSendResult = {
  status: "ok" | "error" | "unknown_commit";
  byteSize: number;
  errorCode?: ConnectorDeliveryErrorCode;
  httpStatus?: number;
};

async function hydrated(connector: Connector): Promise<Connector> {
  const secret = await readConnectorSecret(connector.id, connector.credentialMode);
  const configured = secret?.kind === connector.kind;
  return {
    ...connector,
    credentialConfigured: configured,
    status: configured ? connector.status === "needs_credentials" ? "ready" : connector.status : "needs_credentials",
  };
}

async function deliveryConnectorSnapshot(id: string, expectedConfigHash: string) {
  const connector = await getConnector(id);
  if (!connector) throw connectorError("connector_not_found");
  if (connector.configHash !== expectedConfigHash) throw connectorError("connector_changed");
  const stored = await readConnectorSecret(id, connector.credentialMode);
  if (!stored || stored.kind !== connector.kind) throw connectorError("connector_credentials_missing");
  const snapshotHash = await sha256Json(connectorConfigHashMaterial(
    connector.publicConfig,
    stored.revision,
  ));
  const current = await getConnector(id);
  if (snapshotHash !== expectedConfigHash || current?.configHash !== expectedConfigHash) {
    throw connectorError("connector_changed");
  }
  return { connector, stored };
}

export class ConnectorService {
  private readonly tenantTokens = new Map<string, TenantToken>();

  async list(): Promise<Connector[]> {
    return Promise.all((await listConnectors()).map(hydrated));
  }

  async get(id: string): Promise<Connector | null> {
    const connector = await getConnector(id);
    return connector ? hydrated(connector) : null;
  }

  async save(input: ConnectorDraft, id?: string): Promise<Connector> {
    return runMutation(() => this.saveNow(input, id));
  }

  private async saveNow(input: ConnectorDraft, id?: string): Promise<Connector> {
    const draft = ConnectorDraftSchema.parse(input) as ConnectorDraft;
    const existing = id == null ? undefined : await getConnector(id);
    if (id != null && !existing) throw connectorError("connector_not_found");

    const existingSecret = existing == null
      ? undefined
      : await readConnectorSecret(existing.id, existing.credentialMode);
    const updatedAt = Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1);

    let storedSecret;
    if (draft.secret.action === "replace") {
      const revision = Math.max(updatedAt, (existingSecret?.revision ?? 0) + 1);
      storedSecret = draft.kind === "webhook"
        ? {
          kind: "webhook" as const,
          revision,
          value: parseWebhookSecret({ url: draft.secret.url, headers: draft.secret.headers }),
        }
        : {
          kind: "feishu_base" as const,
          revision,
          value: parseFeishuBaseSecret({ appId: draft.secret.appId, appSecret: draft.secret.appSecret }),
        };
    } else {
      if (!existing) throw connectorError("connector_credentials_missing");
      const previous = existingSecret;
      if (!previous || previous.kind !== draft.kind) throw connectorError("connector_credentials_missing");
      storedSecret = existing.credentialMode === draft.credentialMode
        ? previous
        : { ...previous, revision: Math.max(updatedAt, previous.revision + 1) };
    }

    const publicConfig: WebhookPublicConfig | FeishuBasePublicConfig = draft.kind === "webhook"
      ? {
        kind: "webhook",
        method: "POST",
        endpointOrigin: new URL((storedSecret as Extract<typeof storedSecret, { kind: "webhook" }>).value.url).origin,
        headerCount: Object.keys((storedSecret as Extract<typeof storedSecret, { kind: "webhook" }>).value.headers).length,
      }
      : { kind: "feishu_base", ...draft.publicConfig };
    const connectorId = existing?.id ?? crypto.randomUUID();
    const connector: Connector = {
      id: connectorId,
      name: draft.name,
      kind: draft.kind,
      publicConfig,
      credentialMode: draft.credentialMode,
      credentialConfigured: true,
      status: "ready",
      configHash: await sha256Json(connectorConfigHashMaterial(publicConfig, storedSecret.revision)),
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };

    const previousAtTarget = await readConnectorSecret(connectorId, draft.credentialMode);
    try {
      await writeConnectorSecret(connectorId, draft.credentialMode, storedSecret);
    } catch {
      throw connectorError("connector_secret_storage_failed");
    }
    let saved: Connector;
    try {
      saved = await putConnector(connector);
    } catch {
      try {
        if (previousAtTarget) {
          await writeConnectorSecret(connectorId, draft.credentialMode, previousAtTarget);
        } else {
          await removeConnectorSecret(connectorId, draft.credentialMode);
        }
      } catch {
        throw connectorError("connector_storage_rollback_failed");
      }
      throw connectorError("connector_storage_failed");
    }
    const opposite = draft.credentialMode === "persistent" ? "session" : "persistent";
    try {
      await removeConnectorSecret(connectorId, opposite);
    } catch {
      try {
        if (existing) await putConnector(existing);
        else await deleteConnectorRecord(connectorId);
        if (previousAtTarget) {
          await writeConnectorSecret(connectorId, draft.credentialMode, previousAtTarget);
        } else {
          await removeConnectorSecret(connectorId, draft.credentialMode);
        }
      } catch {
        throw connectorError("connector_storage_rollback_failed");
      }
      throw connectorError("connector_secret_cleanup_failed");
    }
    for (const key of this.tenantTokens.keys()) {
      if (key.startsWith(`${connectorId}:`) && key !== `${connectorId}:${saved.configHash}`) {
        this.tenantTokens.delete(key);
      }
    }
    return saved;
  }

  async delete(id: string): Promise<void> {
    return runMutation(async () => {
      if (!(await getConnector(id))) throw connectorError("connector_not_found");
      try {
        await deleteConnectorSecrets(id);
      } catch {
        throw connectorError("connector_secret_storage_failed");
      }
      try {
        await deleteDeliveriesForConnector(id);
        await deleteConnectorRecord(id);
        for (const key of this.tenantTokens.keys()) {
          if (key.startsWith(`${id}:`)) this.tenantTokens.delete(key);
        }
      } catch {
        throw connectorError("connector_storage_failed");
      }
    });
  }

  async test(id: string): Promise<{ ok: true; status: number }> {
    const connector = await getConnector(id);
    if (!connector) throw connectorError("connector_not_found");
    const stored = await readConnectorSecret(id, connector.credentialMode);
    if (!stored || stored.kind !== connector.kind) throw connectorError("connector_credentials_missing");
    if (connector.kind === "feishu_base" && stored.kind === "feishu_base") {
      return this.testFeishu(connector, stored.value);
    }
    if (stored.kind !== "webhook") throw connectorError("connector_credentials_missing");
    const secret = parseWebhookSecret(stored.value);
    let response: Response;
    try {
      response = await fetchWithTimeout(secret.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...secret.headers },
        body: JSON.stringify({ type: "aipagego.connection_test" }),
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError("connector_network_failed");
    }
    if (!response.ok) {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError(codeForStatus(response.status), response.status);
    }
    if (connector.status !== "ready") {
      await this.updateTestStatus(connector, "ready");
    }
    return { ok: true, status: response.status };
  }

  private async tenantToken(
    connector: Connector & { publicConfig: FeishuBasePublicConfig },
    secretInput: unknown,
  ): Promise<string> {
    const cacheKey = `${connector.id}:${connector.configHash}`;
    const cached = this.tenantTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
    const secret = parseFeishuBaseSecret(secretInput);
    const origin = connectorProviderOrigin(connector.publicConfig.region);
    let response: Response;
    try {
      response = await fetchWithTimeout(`${origin}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: secret.appId, app_secret: secret.appSecret }),
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      throw connectorError("connector_network_failed");
    }
    if (!response.ok) throw connectorError(codeForStatus(response.status), response.status);
    let body: unknown;
    try { body = await response.json(); } catch { throw connectorError("connector_auth_failed"); }
    const tokenBody = body as { code?: unknown; tenant_access_token?: unknown; expire?: unknown };
    if (tokenBody.code !== 0 || typeof tokenBody.tenant_access_token !== "string") {
      throw connectorError("connector_auth_failed");
    }
    const ttlSeconds = typeof tokenBody.expire === "number" ? Math.max(60, tokenBody.expire) : 3600;
    this.tenantTokens.set(cacheKey, {
      value: tokenBody.tenant_access_token,
      expiresAt: Date.now() + Math.max(1, ttlSeconds - 60) * 1000,
    });
    return tokenBody.tenant_access_token;
  }

  private async testFeishu(
    connector: Connector,
    secret: unknown,
  ): Promise<{ ok: true; status: number }> {
    if (connector.publicConfig.kind !== "feishu_base") throw connectorError("connector_kind_mismatch");
    const typed = connector as Connector & { publicConfig: FeishuBasePublicConfig };
    let token: string;
    try {
      token = await this.tenantToken(typed, secret);
    } catch (cause) {
      await this.updateTestStatus(connector, "needs_attention");
      throw cause;
    }
    const origin = connectorProviderOrigin(typed.publicConfig.region);
    const url = `${origin}/open-apis/bitable/v1/apps/${encodeURIComponent(typed.publicConfig.appToken)}/tables/${encodeURIComponent(typed.publicConfig.tableId)}`;
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError("connector_network_failed");
    }
    if (!response.ok) {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError(codeForStatus(response.status), response.status);
    }
    let body: unknown;
    try { body = await response.json(); } catch {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError("connector_http_error");
    }
    const responseCode = (body as { code?: unknown }).code;
    if (responseCode !== 0) {
      await this.updateTestStatus(connector, "needs_attention");
      throw connectorError(codeForFeishuBody(responseCode));
    }
    await this.updateTestStatus(connector, "ready");
    return { ok: true, status: response.status };
  }

  async sendFeishuRows(
    id: string,
    rows: Array<Record<string, unknown>>,
    expectedConfigHash: string,
    startOffset = 0,
    onCheckpoint?: (checkpoint: { sentCount: number; nextOffset: number }) => Promise<void>,
  ): Promise<FeishuSendResult> {
    const snapshot = await deliveryConnectorSnapshot(id, expectedConfigHash);
    const connector = snapshot.connector;
    if (!connector || connector.kind !== "feishu_base" || connector.publicConfig.kind !== "feishu_base") {
      throw connectorError("connector_not_found");
    }
    if (!Number.isInteger(startOffset) || startOffset < 0 || startOffset > rows.length) {
      throw connectorError("connector_invalid_checkpoint");
    }
    const stored = snapshot.stored;
    if (stored.kind !== "feishu_base") throw connectorError("connector_credentials_missing");
    const typed = connector as Connector & { publicConfig: FeishuBasePublicConfig };
    const token = await this.tenantToken(typed, stored.value);
    const origin = connectorProviderOrigin(typed.publicConfig.region);
    const url = `${origin}/open-apis/bitable/v1/apps/${encodeURIComponent(typed.publicConfig.appToken)}/tables/${encodeURIComponent(typed.publicConfig.tableId)}/records/batch_create`;
    let nextOffset = startOffset;
    let sentCount = nextOffset;
    while (nextOffset < rows.length) {
      const batch = rows.slice(nextOffset, nextOffset + FEISHU_BATCH_SIZE);
      const records = batch.map((row) => ({
        fields: Object.fromEntries(Object.entries(typed.publicConfig.fieldMapping)
          .filter(([source]) => Object.prototype.hasOwnProperty.call(row, source))
          .map(([source, target]) => [target, row[source]])),
      }));
      let requestBody: string;
      try {
        requestBody = JSON.stringify({ records });
      } catch {
        return {
          status: sentCount > startOffset ? "partial" : "error",
          sentCount,
          nextOffset,
          errorCode: "connector_invalid_payload",
        };
      }
      let response: Response;
      try {
        response = await fetchWithTimeout(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: requestBody,
          credentials: "omit",
          redirect: "error",
        });
      } catch {
        return { status: "unknown_commit", sentCount, nextOffset, errorCode: "connector_unknown_commit" };
      }
      if (!response.ok) {
        return {
          status: sentCount > startOffset ? "partial" : "error",
          sentCount,
          nextOffset,
          errorCode: codeForStatus(response.status),
          httpStatus: response.status,
        };
      }
      let body: unknown;
      try { body = await response.json(); } catch {
        return { status: "unknown_commit", sentCount, nextOffset, errorCode: "connector_unknown_commit" };
      }
      const responseCode = (body as { code?: unknown }).code;
      if (responseCode !== 0) {
        return { status: sentCount > startOffset ? "partial" : "error", sentCount, nextOffset, errorCode: codeForFeishuBody(responseCode) };
      }
      nextOffset += batch.length;
      sentCount = nextOffset;
      await onCheckpoint?.({ sentCount, nextOffset });
    }
    return { status: "ok", sentCount, nextOffset };
  }

  async sendWebhookData(
    id: string,
    deliveryId: string,
    sourceKind: "collection_result" | "run" | "job_run",
    data: unknown,
    expectedConfigHash: string,
  ): Promise<WebhookSendResult> {
    const snapshot = await deliveryConnectorSnapshot(id, expectedConfigHash);
    const connector = snapshot.connector;
    if (!connector || connector.kind !== "webhook") throw connectorError("connector_not_found");
    const stored = snapshot.stored;
    if (!stored || stored.kind !== "webhook") throw connectorError("connector_credentials_missing");
    const secret = parseWebhookSecret(stored.value);
    let body: string;
    try {
      body = JSON.stringify({ deliveryId, sentAt: Date.now(), source: { kind: sourceKind }, data });
    } catch {
      throw connectorError("connector_invalid_payload");
    }
    const byteSize = new TextEncoder().encode(body).byteLength;
    if (byteSize > 5 * 1024 * 1024) throw connectorError("connector_payload_too_large");
    let response: Response;
    try {
      response = await fetchWithTimeout(secret.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...secret.headers,
          "Idempotency-Key": `aipagego-${deliveryId}`,
        },
        body,
        credentials: "omit",
        redirect: "error",
      });
    } catch {
      return { status: "unknown_commit", byteSize, errorCode: "connector_unknown_commit" };
    }
    if (!response.ok) {
      return { status: "error", byteSize, errorCode: codeForStatus(response.status), httpStatus: response.status };
    }
    return { status: "ok", byteSize };
  }

  private async updateTestStatus(connector: Connector, status: Connector["status"]): Promise<void> {
    await runMutation(async () => {
      const current = await getConnector(connector.id);
      if (!current || current.configHash !== connector.configHash) return;
      await putConnector({
        ...current,
        status,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      });
    });
  }
}

export const connectorService = new ConnectorService();
