import { z } from "zod";
import { PermissionRequiredSchema } from "./optional-permissions";
import { CollectionRecipeSchema } from "./collection";
import { analyzeWorkflow } from "./workflow";
import type { Step, ToolParameter } from "./types";
import { JobDraftSchema } from "./jobs";
import { ConnectorDraftSchema, ConnectorSourceSchema } from "./connectors";

export const StepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    tool: z.enum([
      "snapshotDOM",
      "querySelector",
      "querySelectorAll",
      "extractImages",
      "extractText",
      "scroll",
      "waitFor",
      "click",
      "httpRequest",
      "readStorage",
      "fillInput",
      "setCheckbox",
      "selectOption",
      "submitForm",
      "hover",
      "focus",
      "uploadFile",
      "getValue",
      "extractFormState",
      // Round 5 — content-script-routable additions (some are replayable as Steps;
      // the UID-based + visual ones aren't kept by save-as-tool but the runtime
      // still needs to pass them through to the content script).
      "closeTab",
      "switchToTab",
      "downloadImage",
      "fillForm",
      "takeSnapshot",
      "clickByUid",
      "fillByUid",
      "highlightElement",
      "highlightText",
      // Round 6 — common helpers
      "navigate",
      "getPageInfo",
      "pressKey",
      "writeStorage",
      "createPageIndex",
      "searchPageIndex",
      "readPageBlock",
      "extractPageFields",
      "collectStructuredData",
      // Plan 32 — playwright parity. The recorder tools are not kept by
      // save-as-tool (they're excluded from ReplayableTool), but the runtime
      // still transports them as Steps to reach the background router.
      "consoleMessages",
      "networkRequests",
      "networkRequestDetail",
      "handleDialog",
      "recorderConfig",
      "navigateBack",
      "navigateForward",
      "resize",
      "drag",
      "drop",
      "findElements",
      "inspectElement"
    ]),
    args: z.unknown(),
    bindResultTo: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({
    kind: z.literal("js"),
    source: z.string(),
    bindResultTo: z.string().optional(),
    timeoutMs: z.number().int().positive().optional()
  })
]);

const ToolStatsSchema = z.object({
  runs: z.number().int().min(0),
  lastRunAt: z.number().optional(),
  lastRunOk: z.boolean().optional()
});

export const ToolOriginSchema = z.object({
  kind: z.literal("preset"),
  presetId: z.string().min(1),
  presetVersion: z.number().int().min(1)
});

const PARAMETER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export const ToolParameterSchema = z.object({
  key: z.string().regex(PARAMETER_KEY),
  label: z.string().min(1).max(80),
  type: z.enum(["string", "number", "boolean", "json"]),
  required: z.boolean(),
  description: z.string().max(500).optional(),
  defaultValue: z.unknown().optional(),
  sensitive: z.boolean().optional()
}).superRefine((parameter, ctx) => {
  if (parameter.sensitive && parameter.defaultValue !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultValue"],
      message: "sensitive parameters cannot have default values"
    });
  }
  if (parameter.defaultValue === undefined) return;
  const matches =
    parameter.type === "json"
      ? isJsonValue(parameter.defaultValue)
      : typeof parameter.defaultValue === parameter.type &&
        (parameter.type !== "number" || Number.isFinite(parameter.defaultValue));
  if (!matches) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["defaultValue"],
      message: `default value must match ${parameter.type}`
    });
  }
});

const MAX_STEP_BYTES = 64 * 1024;
const MAX_WORKFLOW_VERSION_BYTES = 1024 * 1024;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function jsonByteLength(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function validateWorkflowSize(
  workflow: { steps: unknown[] },
  ctx: z.RefinementCtx,
): void {
  workflow.steps.forEach((step, index) => {
    if (jsonByteLength(step) > MAX_STEP_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_STEP_BYTES,
        inclusive: true,
        exact: false,
        path: ["steps", index],
        message: `step exceeds ${MAX_STEP_BYTES} bytes`,
      });
    }
  });
  if (jsonByteLength(workflow) > MAX_WORKFLOW_VERSION_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      type: "array",
      maximum: MAX_WORKFLOW_VERSION_BYTES,
      inclusive: true,
      exact: false,
      message: `workflow version exceeds ${MAX_WORKFLOW_VERSION_BYTES} bytes`,
    });
  }
}

export const StepsToolDraftSchema = z.object({
  kind: z.literal("steps"),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  parameters: z.array(ToolParameterSchema).max(50).optional(),
  steps: z.array(StepSchema).min(1).max(200),
  outputBinding: z.string().optional(),
  outputSchema: z.unknown().default({})
}).superRefine(validateWorkflowSize);

export const PromptToolDraftSchema = z.object({
  kind: z.literal("prompt"),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  prompt: z.string().min(1)
});

export const ToolDraftSchema = z.union([
  StepsToolDraftSchema,
  PromptToolDraftSchema
]);

const StepsToolVersionShape = {
  version: z.number().int().positive(),
  kind: z.literal("steps"),
  steps: z.array(StepSchema).min(1).max(200),
  outputBinding: z.string().optional(),
  outputSchema: z.unknown().default({}),
  createdAt: z.number(),
  note: z.string().optional(),
  basedOnVersion: z.number().int().positive().optional()
} as const;

const StepsToolVersionSchema = z.object({
  ...StepsToolVersionShape,
  parameters: z.array(ToolParameterSchema).max(50).default([]),
}).superRefine(validateWorkflowSize);

const CanonicalStepsToolVersionSchema = z.object({
  ...StepsToolVersionShape,
  parameters: z.array(ToolParameterSchema).max(50),
}).strict().superRefine(validateWorkflowSize);

const PromptToolVersionSchema = z.object({
  version: z.number().int().positive(),
  kind: z.literal("prompt"),
  prompt: z.string().min(1),
  createdAt: z.number(),
  note: z.string().optional()
});

const StepsToolBaseShape = {
  kind: z.literal("steps"),
  id: z.string().min(1),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  createdAt: z.number(),
  updatedAt: z.number(),
  stats: ToolStatsSchema,
  origin: ToolOriginSchema.optional()
} as const;

function validateCanonicalStepsTool(
  tool: {
    activeVersion: number;
    versions: Array<z.infer<typeof CanonicalStepsToolVersionSchema>>;
  },
  ctx: z.RefinementCtx,
): void {
  const versions = new Set<number>();
  for (let index = 0; index < tool.versions.length; index++) {
    const snapshot = tool.versions[index];
    if (versions.has(snapshot.version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions", index, "version"],
        message: `duplicate workflow version ${snapshot.version}`
      });
    }
    versions.add(snapshot.version);
    const analysis = analyzeWorkflow({
      parameters: snapshot.parameters as ToolParameter[],
      steps: snapshot.steps as Step[],
      outputBinding: snapshot.outputBinding,
    });
    for (const issue of analysis.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions", index, issue.stepIndex === undefined ? "outputBinding" : "steps", ...(issue.stepIndex === undefined ? [] : [issue.stepIndex])],
        message: `invalid workflow reference: ${issue.code}:${issue.binding}`,
      });
    }
  }
  if (!versions.has(tool.activeVersion)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["activeVersion"],
      message: `active workflow version ${tool.activeVersion} does not exist`
    });
  }
  for (let index = 0; index < tool.versions.length; index++) {
    const basedOnVersion = tool.versions[index].basedOnVersion;
    if (basedOnVersion !== undefined && !versions.has(basedOnVersion)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions", index, "basedOnVersion"],
        message: `base workflow version ${basedOnVersion} does not exist`,
      });
    }
  }
}

export const CanonicalStepsToolSchema = z.object({
  ...StepsToolBaseShape,
  activeVersion: z.number().int().positive(),
  versions: z.array(CanonicalStepsToolVersionSchema).min(1),
}).strict().superRefine(validateCanonicalStepsTool);

const LegacyStepsToolObjectSchema = z.object({
  ...StepsToolBaseShape,
  steps: z.array(StepSchema).min(1).optional(),
  outputSchema: z.unknown().default({}),
  activeVersion: z.number().int().positive().optional(),
  versions: z.array(StepsToolVersionSchema).default([]),
}).superRefine((tool, ctx) => {
  if (tool.versions.length === 0 && !tool.steps) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["versions"],
      message: "legacy steps tool needs a version or top-level steps",
    });
  }
});

export const StepsToolSchema = LegacyStepsToolObjectSchema.transform((tool) => {
  const versions = tool.versions.length > 0
    ? tool.versions
    : [{
        version: 1,
        kind: "steps" as const,
        parameters: [],
        steps: tool.steps!,
        outputSchema: tool.outputSchema,
        createdAt: tool.createdAt,
      }];
  const { steps: _steps, outputSchema: _outputSchema, ...metadata } = tool;
  return {
    ...metadata,
    activeVersion: tool.activeVersion ?? Math.max(...versions.map((version) => version.version)),
    versions,
  };
}).pipe(CanonicalStepsToolSchema);

export const PromptToolSchema = z.object({
  kind: z.literal("prompt"),
  id: z.string().min(1),
  name: z.string().min(1),
  urlPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().default(""),
  prompt: z.string().min(1),
  createdAt: z.number(),
  updatedAt: z.number(),
  versions: z.array(PromptToolVersionSchema).min(1),
  stats: ToolStatsSchema,
  origin: ToolOriginSchema.optional()
});

export const ToolSchema = z.union([StepsToolSchema, PromptToolSchema]);
export const CanonicalToolSchema = z.union([
  CanonicalStepsToolSchema,
  PromptToolSchema.strict(),
]);

export const RpcRequest = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tools.list") }),
  z.object({ type: z.literal("tools.get"), id: z.string() }),
  z.object({ type: z.literal("tools.save"), draft: ToolDraftSchema }),
  z.object({ type: z.literal("tools.delete"), id: z.string() }),
  z.object({ type: z.literal("tools.matching"), url: z.string() }),
  z.object({ type: z.literal("tools.export") }),
  z.object({
    type: z.literal("tools.share.export"),
    toolIds: z.array(z.string().min(1)).min(1).refine(
      (ids) => new Set(ids).size === ids.length,
      "toolIds must be unique",
    ),
    name: z.string().min(1),
    description: z.string().optional(),
  }),
  z.object({ type: z.literal("tools.import"), bundle: z.unknown() }),
  z.object({ type: z.literal("tools.import.preview"), bundle: z.unknown() }),
  z.object({
    type: z.literal("tools.import.commit"),
    bundle: z.unknown(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    decisions: z.array(z.object({
      index: z.number().int().nonnegative(),
      action: z.enum(["copy", "skip", "overwrite"]),
    }).strict()).default([]),
    approveDangerous: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("workflows.publish"),
    id: z.string().min(1),
    basedOnVersion: z.number().int().positive(),
    parameters: z.array(ToolParameterSchema).max(50),
    steps: z.array(StepSchema).min(1).max(200),
    outputBinding: z.string().optional(),
    outputSchema: z.unknown(),
    note: z.string().max(500).optional()
  }),
  z.object({
    type: z.literal("workflows.activate"),
    id: z.string().min(1),
    version: z.number().int().positive()
  }),
  z.object({
    type: z.literal("runs.start"),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("draft"), draft: ToolDraftSchema }),
      z.object({
        kind: z.literal("tool"),
        id: z.string(),
        version: z.number().int().positive().optional(),
      })
    ]),
    tabId: z.number(),
    inputs: z.record(z.unknown()).optional()
  }),
  z.object({ type: z.literal("runs.list"), toolId: z.string().optional() }),
  z.object({ type: z.literal("runs.get"), id: z.string() }),
  z.object({ type: z.literal("jobs.list") }),
  z.object({ type: z.literal("jobs.get"), id: z.string().min(1) }),
  z.object({
    type: z.literal("jobs.save"),
    id: z.string().min(1).optional(),
    draft: JobDraftSchema,
    acknowledgeCaution: z.boolean().optional(),
  }),
  z.object({ type: z.literal("jobs.pause"), id: z.string().min(1) }),
  z.object({ type: z.literal("jobs.resume"), id: z.string().min(1) }),
  z.object({ type: z.literal("jobs.delete"), id: z.string().min(1) }),
  z.object({
    type: z.literal("jobs.runNow"),
    id: z.string().min(1),
    inputs: z.record(z.unknown()).optional(),
    approveDangerousOnce: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("jobs.upgrade"),
    id: z.string().min(1),
    toolVersion: z.number().int().positive(),
    acknowledgeCaution: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("jobRuns.list"),
    jobId: z.string().min(1),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  z.object({ type: z.literal("jobRuns.get"), id: z.string().min(1) }),
  z.object({ type: z.literal("connectors.list") }),
  z.object({ type: z.literal("connectors.get"), id: z.string().min(1) }),
  z.object({
    type: z.literal("connectors.save"),
    id: z.string().min(1).optional(),
    draft: ConnectorDraftSchema,
  }),
  z.object({ type: z.literal("connectors.delete"), id: z.string().min(1) }),
  z.object({ type: z.literal("connectors.test"), id: z.string().min(1) }),
  z.object({
    type: z.literal("deliveries.create"),
    connectorId: z.string().min(1),
    source: ConnectorSourceSchema,
  }),
  z.object({
    type: z.literal("deliveries.list"),
    connectorId: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal("deliveries.retry"),
    id: z.string().min(1),
    confirmUnknownCommit: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("http.request"),
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    withCredentials: z.boolean().default(false)
  }),
  z.object({
    type: z.literal("scripting.injectMain"),
    tabId: z.number().optional(),
    source: z.string(),
    args: z.unknown()
  }),

  // chat session
  z.object({ type: z.literal("chat.session.start"), url: z.string() }),
  z.object({
    type: z.literal("chat.session.appendLog"),
    runId: z.string(),
    entry: z.object({
      stepIndex: z.number().int().min(0),
      input: z.unknown(),
      output: z.unknown(),
      ms: z.number().int().min(0),
      error: z.string().optional()
    })
  }),
  z.object({
    type: z.literal("chat.session.end"),
    runId: z.string(),
    status: z.enum(["ok", "error", "aborted"]),
    output: z.unknown().optional()
  }),

  // single step (for sidepanel-driven session loop)
  z.object({
    type: z.literal("runs.runOneStep"),
    step: StepSchema,
    tabId: z.number(),
    attachedTabIds: z.array(z.number()).default([]),
    bindings: z.record(z.unknown()).default({})
  }),

  z.object({
    type: z.literal("tabs.list"),
    windowId: z.number().int().optional()
  }),
  z.object({
    type: z.literal("tabs.open"),
    url: z.string().url(),
    active: z.boolean().optional()
  }),

  // binary fetch (for uploadFile)
  z.object({
    type: z.literal("http.fetchBinary"),
    url: z.string().url()
  }),

  z.object({
    type: z.literal("elementCapture.start"),
    tabId: z.number().int()
  }),

  z.object({
    type: z.literal("collections.preview"),
    tabId: z.number().int().positive(),
    recipe: CollectionRecipeSchema
  }),
  z.object({
    type: z.literal("collections.start"),
    tabId: z.number().int().positive(),
    recipe: CollectionRecipeSchema
  }),
  z.object({
    type: z.literal("collections.runs.get"),
    runId: z.string().min(1)
  }),
  z.object({
    type: z.literal("collections.cancel"),
    runId: z.string().min(1)
  }),
  z.object({
    type: z.literal("collections.results.read"),
    resultId: z.string().min(1),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(500)
  }),

  // presets
  z.object({ type: z.literal("presets.list") }),
  z.object({ type: z.literal("presets.materialize"), presetId: z.string().min(1) }),

  // widget RPCs
  z.object({
    type: z.literal("widget.openSidepanel"),
    tabId: z.number().int(),
    pendingApprovalId: z.string().optional(),
    pendingPermission: PermissionRequiredSchema.extend({
      toolUseId: z.string().min(1),
    }).optional()
  }),
  z.object({
    type: z.literal("widget.openSidepanelWithSave"),
    tabId: z.number().int()
  }),
  z.object({
    type: z.literal("widget.markHostHidden"),
    host: z.string().min(1)
  })
]);

export type RpcRequest = z.infer<typeof RpcRequest>;

export type RpcOk<T> = { ok: true; data: T };
export type RpcErr = { ok: false; error: string };
export type RpcResult<T> = RpcOk<T> | RpcErr;

export const ContentRequest = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("content.runStep"),
    step: StepSchema,
    bindings: z.record(z.unknown())
  }),
  z.object({
    type: z.literal("content.collectionPreview"),
    recipe: CollectionRecipeSchema
  }),
  z.object({
    type: z.literal("content.collectionExtractPage"),
    recipe: CollectionRecipeSchema
  }),
  z.object({
    type: z.literal("content.collectionAdvanceNext"),
    selector: z.string().trim().min(1)
  }),
  z.object({
    type: z.literal("content.collectionAdvanceDynamic"),
    action: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("loadMore"),
        selector: z.string().trim().min(1)
      }),
      z.object({ kind: z.literal("infiniteScroll") })
    ])
  })
]);
export type ContentRequest = z.infer<typeof ContentRequest>;
