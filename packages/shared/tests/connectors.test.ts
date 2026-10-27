import { describe, expect, it } from "vitest";
import {
  ConnectorSchema,
  ConnectorDeliverySchema,
  FeishuBaseConnectorDraftSchema,
  WebhookConnectorDraftSchema,
  connectorConfigHashMaterial,
  connectorProviderOrigin,
  parseFeishuBaseSecret,
  parseWebhookSecret,
} from "../src/connectors";

describe("connector contracts", () => {
  it("accepts a redacted webhook connector and rejects secret-shaped public config", () => {
    const connector = ConnectorSchema.parse({
      id: "connector-1",
      name: "Orders",
      kind: "webhook",
      publicConfig: {
        kind: "webhook",
        method: "POST",
        endpointOrigin: "https://hooks.example.com",
        headerCount: 2,
      },
      credentialMode: "persistent",
      credentialConfigured: true,
      status: "ready",
      configHash: "a".repeat(64),
      createdAt: 1,
      updatedAt: 2,
    });
    expect(connector.publicConfig).not.toHaveProperty("url");
    expect(ConnectorSchema.safeParse({
      ...connector,
      publicConfig: { ...connector.publicConfig, url: "https://hooks.example.com/private?token=x" },
    }).success).toBe(false);
  });

  it.each([
    "https://hooks.example.com/a?opaque=1",
    "http://127.0.0.1:8787/hook",
    "http://localhost:8787/hook",
  ])("allows a supported webhook URL: %s", (url) => {
    expect(parseWebhookSecret({ url, headers: { Authorization: "Bearer hidden" } }).url).toBe(url);
  });

  it.each([
    "http://hooks.example.com/a",
    "ftp://hooks.example.com/a",
    "https://user:pass@hooks.example.com/a",
  ])("rejects an unsafe webhook URL: %s", (url) => {
    expect(() => parseWebhookSecret({ url, headers: {} })).toThrow("connector_invalid_url");
  });

  it.each(["Host", "origin", "Referer", "COOKIE", "Content-Length", "Idempotency-Key"])(
    "rejects forbidden webhook header %s",
    (name) => {
      expect(() => parseWebhookSecret({ url: "https://hooks.example.com/a", headers: { [name]: "x" } }))
        .toThrow("connector_forbidden_header");
    },
  );

  it("uses public config and secret revision—not secret text—as config-hash material", () => {
    const publicConfig = {
      kind: "webhook" as const,
      method: "POST" as const,
      endpointOrigin: "https://hooks.example.com",
      headerCount: 1,
    };
    const first = connectorConfigHashMaterial(publicConfig, 7);
    const second = connectorConfigHashMaterial(publicConfig, 8);
    expect(first).toEqual({ publicConfig, secretRevision: 7 });
    expect(JSON.stringify(first)).not.toContain("Bearer");
    expect(second).not.toEqual(first);
  });

  it("requires explicit replace or keep semantics for write-only credentials", () => {
    expect(WebhookConnectorDraftSchema.safeParse({
      name: "Orders",
      kind: "webhook",
      credentialMode: "session",
      secret: { action: "keep" },
    }).success).toBe(true);
    expect(WebhookConnectorDraftSchema.safeParse({
      name: "Orders",
      kind: "webhook",
      credentialMode: "persistent",
      secret: { action: "replace", url: "https://hooks.example.com/a", headers: {} },
    }).success).toBe(true);
  });

  it("validates Feishu/Lark public config, credentials and fixed provider origins", () => {
    const draft = {
      name: "CRM Base",
      kind: "feishu_base" as const,
      credentialMode: "persistent" as const,
      publicConfig: {
        region: "feishu" as const,
        appToken: "app-token",
        tableId: "table-id",
        fieldMapping: { title: "标题", price: "价格" },
      },
      secret: { action: "replace" as const, appId: "cli_123", appSecret: "hidden" },
    };
    expect(FeishuBaseConnectorDraftSchema.safeParse(draft).success).toBe(true);
    expect(parseFeishuBaseSecret({ appId: "cli_123", appSecret: "hidden" })).toEqual({ appId: "cli_123", appSecret: "hidden" });
    expect(connectorProviderOrigin("feishu")).toBe("https://open.feishu.cn");
    expect(connectorProviderOrigin("lark")).toBe("https://open.larksuite.com");
  });

  it("rejects duplicate Base targets and field maps over 100 entries", () => {
    const base = {
      name: "CRM Base",
      kind: "feishu_base" as const,
      credentialMode: "persistent" as const,
      publicConfig: {
        region: "lark" as const,
        appToken: "app-token",
        tableId: "table-id",
        fieldMapping: { title: "Name", price: "Name" },
      },
      secret: { action: "replace" as const, appId: "cli_123", appSecret: "hidden" },
    };
    expect(FeishuBaseConnectorDraftSchema.safeParse(base).success).toBe(false);
    expect(FeishuBaseConnectorDraftSchema.safeParse({
      ...base,
      publicConfig: {
        ...base.publicConfig,
        fieldMapping: Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`source-${index}`, `target-${index}`])),
      },
    }).success).toBe(false);
  });

  it("allows only the delivery error-code whitelist", () => {
    const delivery = {
      id: "delivery-1",
      connectorId: "connector-1",
      connectorConfigHash: "a".repeat(64),
      source: { kind: "run" as const, runId: "run-1" },
      status: "error" as const,
      attempt: 1,
      nextOffset: 0,
      errorCode: "connector_network_failed",
      createdAt: 1,
    };
    expect(ConnectorDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(ConnectorDeliverySchema.safeParse({
      ...delivery,
      errorCode: "connector_leaked_remote_message",
    }).success).toBe(false);
  });
});
