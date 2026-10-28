import {
  ConnectorDeliveryErrorCodeSchema,
  type ConnectorDelivery,
  type ConnectorDeliveryErrorCode,
  type ConnectorSource,
} from "@aipagego/shared/connectors";
import { connectorService } from "./service";
import { resolveConnectorSource } from "./source";
import { getConnector } from "../storage/connectors";
import {
  getDelivery,
  connectorSourceKey,
  listDeliveries,
  pruneDeliveries,
  putDelivery,
} from "../storage/connector-deliveries";

function safePreflightError(cause: unknown): ConnectorDeliveryErrorCode | undefined {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = message.split(" ", 1)[0];
  const parsed = ConnectorDeliveryErrorCodeSchema.safeParse(code);
  if (!parsed.success || parsed.data === "connector_unknown_commit") return undefined;
  return parsed.data;
}

export class DeliveryService {
  private readonly createFlights = new Map<string, Promise<ConnectorDelivery>>();
  private readonly ensureFlights = new Map<string, Promise<ConnectorDelivery>>();
  private readonly retryFlights = new Map<string, Promise<ConnectorDelivery>>();
  private recovery: Promise<unknown> = Promise.resolve();

  configureRecovery(recovery: Promise<unknown>): void {
    this.recovery = recovery;
  }

  private async awaitRecovery(): Promise<void> {
    try {
      await this.recovery;
    } catch {
      throw new Error("connector_recovery_failed");
    }
  }

  private singleFlight(
    flights: Map<string, Promise<ConnectorDelivery>>,
    key: string,
    operation: () => Promise<ConnectorDelivery>,
  ): Promise<ConnectorDelivery> {
    const active = flights.get(key);
    if (active) return active;
    const pending = operation();
    flights.set(key, pending);
    void pending.then(
      () => { if (flights.get(key) === pending) flights.delete(key); },
      () => { if (flights.get(key) === pending) flights.delete(key); },
    );
    return pending;
  }

  async list(connectorId?: string): Promise<ConnectorDelivery[]> {
    await this.awaitRecovery();
    return listDeliveries(connectorId);
  }

  create(connectorId: string, source: ConnectorSource): Promise<ConnectorDelivery> {
    const key = `${connectorId}:${source.kind}:${connectorSourceKey(source)}`;
    return this.singleFlight(this.createFlights, key, () => this.createNow(connectorId, source));
  }

  ensure(
    id: string,
    connectorId: string,
    source: ConnectorSource,
    expectedConfigHash: string,
  ): Promise<ConnectorDelivery> {
    return this.singleFlight(
      this.ensureFlights,
      id,
      () => this.ensureNow(id, connectorId, source, expectedConfigHash),
    );
  }

  private async ensureNow(
    id: string,
    connectorId: string,
    source: ConnectorSource,
    expectedConfigHash: string,
  ): Promise<ConnectorDelivery> {
    await this.awaitRecovery();
    const existing = await getDelivery(id);
    if (existing) {
      if (
        existing.connectorId !== connectorId ||
        existing.connectorConfigHash !== expectedConfigHash ||
        existing.source.kind !== source.kind ||
        connectorSourceKey(existing.source) !== connectorSourceKey(source)
      ) {
        throw new Error("connector_delivery_conflict");
      }
      return existing.status === "queued" ? this.execute(existing) : existing;
    }
    return this.createWithHash(id, connectorId, source, expectedConfigHash);
  }

  private async createNow(
    connectorId: string,
    source: ConnectorSource,
    id: string = crypto.randomUUID(),
  ): Promise<ConnectorDelivery> {
    await this.awaitRecovery();
    const connector = await getConnector(connectorId);
    if (!connector) throw new Error("connector_not_found");
    return this.createWithHash(id, connectorId, source, connector.configHash);
  }

  private async createWithHash(
    id: string,
    connectorId: string,
    source: ConnectorSource,
    connectorConfigHash: string,
  ): Promise<ConnectorDelivery> {
    const now = Date.now();
    const delivery: ConnectorDelivery = {
      id,
      connectorId,
      connectorConfigHash,
      source,
      status: "queued",
      attempt: 0,
      nextOffset: 0,
      sentCount: 0,
      createdAt: now,
    };
    await putDelivery(delivery);
    await pruneDeliveries();
    return this.execute(delivery);
  }

  async retry(id: string, confirmUnknownCommit = false): Promise<ConnectorDelivery> {
    await this.awaitRecovery();
    const active = this.retryFlights.get(id);
    if (active) return active;
    const delivery = await getDelivery(id);
    const startedWhileReading = this.retryFlights.get(id);
    if (startedWhileReading) return startedWhileReading;
    if (!delivery) throw new Error("connector_delivery_not_found");
    if (delivery.status === "unknown_commit" && !confirmUnknownCommit) {
      throw new Error("connector_unknown_commit_confirmation_required");
    }
    if (!new Set(["error", "partial", "unknown_commit"]).has(delivery.status)) {
      throw new Error("connector_delivery_not_retryable");
    }
    return this.singleFlight(this.retryFlights, id, () => this.execute(delivery));
  }

  private async execute(delivery: ConnectorDelivery): Promise<ConnectorDelivery> {
    const connector = await getConnector(delivery.connectorId);
    if (!connector) return this.finish(delivery, { status: "error", errorCode: "connector_not_found" });
    if (connector.configHash !== delivery.connectorConfigHash) {
      return this.finish(delivery, { status: "error", errorCode: "connector_changed" });
    }
    let source;
    try {
      source = await resolveConnectorSource(delivery.source);
    } catch {
      return this.finish(delivery, { status: "error", errorCode: "connector_source_expired" });
    }
    const running: ConnectorDelivery = {
      ...delivery,
      status: "running",
      attempt: delivery.attempt + 1,
      rowCount: source.rowCount,
      byteSize: source.byteSize,
      startedAt: Date.now(),
      finishedAt: undefined,
      errorCode: undefined,
      httpStatus: undefined,
    };
    await putDelivery(running);
    try {
      if (connector.kind === "webhook") {
        const result = await connectorService.sendWebhookData(
          connector.id,
          running.id,
          running.source.kind,
          source.data,
          running.connectorConfigHash,
        );
        return this.finish(running, result);
      }
      const rows = Array.isArray(source.data) ? source.data : [source.data];
      if (rows.some((row) => row == null || typeof row !== "object" || Array.isArray(row))) {
        return this.finish(running, { status: "error", errorCode: "connector_invalid_payload" });
      }
      const result = await connectorService.sendFeishuRows(
        connector.id,
        rows as Array<Record<string, unknown>>,
        running.connectorConfigHash,
        running.nextOffset,
        async (checkpoint) => {
          await putDelivery({ ...running, ...checkpoint });
        },
      );
      return this.finish(running, result);
    } catch (cause) {
      const errorCode = safePreflightError(cause);
      return this.finish(running, errorCode == null
        ? { status: "unknown_commit", errorCode: "connector_unknown_commit" }
        : { status: "error", errorCode });
    }
  }

  private async finish(
    delivery: ConnectorDelivery,
    patch: Partial<ConnectorDelivery> & { status: ConnectorDelivery["status"] },
  ): Promise<ConnectorDelivery> {
    const result: ConnectorDelivery = { ...delivery, ...patch, finishedAt: Date.now() };
    await putDelivery(result);
    return result;
  }
}

export const deliveryService = new DeliveryService();
