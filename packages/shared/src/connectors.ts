import { z } from "zod";

export const ConnectorKindSchema = z.enum(["webhook", "feishu_base"]);
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;

export const ConnectorCredentialModeSchema = z.enum(["persistent", "session"]);
export type ConnectorCredentialMode = z.infer<typeof ConnectorCredentialModeSchema>;

export const ConnectorStatusSchema = z.enum(["ready", "needs_credentials", "needs_attention"]);
export type ConnectorStatus = z.infer<typeof ConnectorStatusSchema>;

export const WebhookPublicConfigSchema = z.object({
  kind: z.literal("webhook"),
  method: z.literal("POST"),
  endpointOrigin: z.string().url(),
  headerCount: z.number().int().min(0).max(100),
}).strict();
export type WebhookPublicConfig = z.infer<typeof WebhookPublicConfigSchema>;

const FieldMappingSchema = z.record(
  z.string().min(1).max(120),
  z.string().min(1).max(120),
).superRefine((mapping, ctx) => {
  const entries = Object.entries(mapping);
  if (entries.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "connector_field_mapping_required" });
  }
  if (entries.length > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "connector_field_mapping_too_large" });
  }
  if (new Set(entries.map(([, target]) => target)).size !== entries.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "connector_duplicate_target_field" });
  }
});

export const FeishuBasePublicConfigSchema = z.object({
  kind: z.literal("feishu_base"),
  region: z.enum(["feishu", "lark"]),
  appToken: z.string().min(1).max(120),
  tableId: z.string().min(1).max(120),
  fieldMapping: FieldMappingSchema,
}).strict();
export type FeishuBasePublicConfig = z.infer<typeof FeishuBasePublicConfigSchema>;

export const ConnectorSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  kind: ConnectorKindSchema,
  publicConfig: z.discriminatedUnion("kind", [WebhookPublicConfigSchema, FeishuBasePublicConfigSchema]),
  credentialMode: ConnectorCredentialModeSchema,
  credentialConfigured: z.boolean(),
  status: ConnectorStatusSchema,
  configHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if (value.kind !== value.publicConfig.kind) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "connector_kind_mismatch" });
  }
});
export type Connector = z.infer<typeof ConnectorSchema>;

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_WEBHOOK_HEADERS = new Set([
  "host", "origin", "referer", "cookie", "content-length", "idempotency-key",
]);

export const WebhookSecretSchema = z.object({
  url: z.string().min(1).max(4096),
  headers: z.record(z.string(), z.string().max(8192)).default({}),
}).strict().superRefine((value, ctx) => {
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "connector_invalid_url" });
    return;
  }
  const localHttp = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "connector_invalid_url" });
  }
  const names = Object.keys(value.headers);
  if (names.length > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "connector_too_many_headers" });
  }
  for (const name of names) {
    if (!HEADER_NAME.test(name)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "connector_invalid_header" });
    } else if (FORBIDDEN_WEBHOOK_HEADERS.has(name.toLowerCase())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["headers"], message: "connector_forbidden_header" });
    }
  }
});
export type WebhookSecret = z.infer<typeof WebhookSecretSchema>;

export function parseWebhookSecret(input: unknown): WebhookSecret {
  const parsed = WebhookSecretSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((candidate) => candidate.message.startsWith("connector_"));
    throw new Error(issue?.message ?? "connector_invalid_secret");
  }
  return parsed.data;
}

export const WebhookConnectorDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.literal("webhook"),
  credentialMode: ConnectorCredentialModeSchema,
  secret: z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({
      action: z.literal("replace"),
      url: z.string().min(1).max(4096),
      headers: z.record(z.string(), z.string()).default({}),
    }).strict(),
  ]),
}).strict();
export type WebhookConnectorDraft = z.infer<typeof WebhookConnectorDraftSchema>;

export const FeishuBaseSecretSchema = z.object({
  appId: z.string().trim().min(1).max(256),
  appSecret: z.string().min(1).max(1024),
}).strict();
export type FeishuBaseSecret = z.infer<typeof FeishuBaseSecretSchema>;

export function parseFeishuBaseSecret(input: unknown): FeishuBaseSecret {
  const parsed = FeishuBaseSecretSchema.safeParse(input);
  if (!parsed.success) throw new Error("connector_invalid_secret");
  return parsed.data;
}

export function connectorProviderOrigin(region: "feishu" | "lark"): string {
  return region === "feishu" ? "https://open.feishu.cn" : "https://open.larksuite.com";
}

export const FeishuBaseConnectorDraftSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.literal("feishu_base"),
  credentialMode: ConnectorCredentialModeSchema,
  publicConfig: z.object({
    region: z.enum(["feishu", "lark"]),
    appToken: z.string().trim().min(1).max(120),
    tableId: z.string().trim().min(1).max(120),
    fieldMapping: FieldMappingSchema,
  }).strict(),
  secret: z.discriminatedUnion("action", [
    z.object({ action: z.literal("keep") }).strict(),
    z.object({
      action: z.literal("replace"),
      appId: z.string().trim().min(1).max(256),
      appSecret: z.string().min(1).max(1024),
    }).strict(),
  ]),
}).strict();
export type FeishuBaseConnectorDraft = z.infer<typeof FeishuBaseConnectorDraftSchema>;

export const ConnectorDraftSchema = z.discriminatedUnion("kind", [
  WebhookConnectorDraftSchema,
  FeishuBaseConnectorDraftSchema,
]);
export type ConnectorDraft = z.infer<typeof ConnectorDraftSchema>;

export function connectorConfigHashMaterial(
  publicConfig: WebhookPublicConfig | FeishuBasePublicConfig,
  secretRevision: number,
): { publicConfig: WebhookPublicConfig | FeishuBasePublicConfig; secretRevision: number } {
  return { publicConfig, secretRevision };
}

export const ConnectorSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection_result"), resultId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("run"), runId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("job_run"), jobRunId: z.string().min(1) }).strict(),
]);
export type ConnectorSource = z.infer<typeof ConnectorSourceSchema>;

export const ConnectorDeliveryStatusSchema = z.enum([
  "queued", "running", "ok", "error", "partial", "unknown_commit",
]);

export const ConnectorDeliveryErrorCodeSchema = z.enum([
  "connector_not_found",
  "connector_changed",
  "connector_source_expired",
  "connector_credentials_missing",
  "connector_invalid_payload",
  "connector_payload_too_large",
  "connector_invalid_checkpoint",
  "connector_network_failed",
  "connector_auth_failed",
  "connector_permission_denied",
  "connector_target_not_found",
  "connector_rate_limited",
  "connector_http_error",
  "connector_unknown_commit",
]);
export type ConnectorDeliveryErrorCode = z.infer<typeof ConnectorDeliveryErrorCodeSchema>;

export const ConnectorDeliverySchema = z.object({
  id: z.string().min(1),
  connectorId: z.string().min(1),
  connectorConfigHash: z.string().regex(/^[a-f0-9]{64}$/),
  source: ConnectorSourceSchema,
  status: ConnectorDeliveryStatusSchema,
  attempt: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative().optional(),
  sentCount: z.number().int().nonnegative().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  errorCode: ConnectorDeliveryErrorCodeSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  createdAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().optional(),
  finishedAt: z.number().int().nonnegative().optional(),
}).strict();
export type ConnectorDelivery = z.infer<typeof ConnectorDeliverySchema>;
