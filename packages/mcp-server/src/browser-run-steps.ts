import type { Json, JsonSchema } from "@atwebpilot/shared/types";
import { handleBrowserTool, prepareBrowserTool, type Deps } from "./handlers";
import type { GeneratedTool } from "./tool-gen";

export const BROWSER_RUN_STEPS_TOOL = {
  name: "browser_runSteps",
  description:
    "Run 1-20 enabled safe/caution browser tools sequentially in one MCP call. " +
    "Supports ${binding} references and returns only the final result plus requested bindings.",
  inputSchema: {
    type: "object",
    required: ["session_id", "steps"],
    properties: {
      session_id: { type: "string", description: "Session id from open_session" },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          required: ["tool", "args"],
          properties: {
            tool: {
              type: "string",
              description: "Enabled browser tool name; browser_ prefix is optional"
            },
            args: {
              type: "object",
              description: "Tool arguments excluding session_id; may reference earlier ${bindings}",
              additionalProperties: true
            },
            bind_result_to: {
              type: "string",
              pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$"
            }
          },
          additionalProperties: false
        }
      },
      return_bindings: {
        type: "array",
        items: {
          type: "string",
          pattern: "^[A-Za-z_][A-Za-z0-9_]{0,63}$"
        },
        uniqueItems: true
      }
    },
    additionalProperties: false
  } as JsonSchema
};

type RunStep = {
  tool: string;
  args: Record<string, unknown>;
  bind_result_to?: string;
};

const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const BLOCKED_BATCH_TOOLS = new Set([
  "browser_downloadImage",
  "browser_downloadSpreadsheet",
  "browser_openTab",
  "browser_closeTab",
  "browser_switchToTab"
]);
const CAPABILITY_SENSITIVE_FIELDS = new Map<string, readonly string[]>([
  ["browser_httpRequest", ["withCredentials"]],
  ["browser_drop", ["files"]],
  ["browser_recorderConfig", ["bodies"]]
]);

export type RunStepsContext = {
  tools: ReadonlyMap<string, GeneratedTool>;
  advertised: ReadonlySet<string>;
  supported?: ReadonlySet<string>;
};

export type RunStepsSuccess = {
  ok: true;
  completed: number;
  result: Json;
  bindings: Record<string, Json>;
};

export type RunStepsFailure = {
  ok: false;
  phase: "preflight" | "execution";
  completed: number;
  failed_step?: { index: number; tool: string };
  error: { message: string };
  bindings: Record<string, Json>;
};

export type RunStepsResult = RunStepsSuccess | RunStepsFailure;

export function runStepsPreflightError(message: string): RunStepsFailure {
  return {
    ok: false,
    phase: "preflight",
    completed: 0,
    error: { message },
    bindings: {}
  };
}

export async function handleBrowserRunSteps(
  deps: Deps,
  args: Record<string, unknown>,
  context: RunStepsContext
): Promise<RunStepsResult> {
  const sessionId = typeof args.session_id === "string" ? args.session_id : "";
  if (!sessionId) throw new Error("InvalidArgs: browser_runSteps requires session_id");
  if (!Array.isArray(args.steps) || args.steps.length < 1 || args.steps.length > 20) {
    throw new Error("InvalidArgs: browser_runSteps requires 1-20 steps");
  }

  const steps = args.steps.map(parseStep);
  const requested = parseReturnBindings(args.return_bindings);
  const bindings: Record<string, Json> = Object.create(null) as Record<string, Json>;
  let result: Json = null;

  const bindingIssue = validateBindingPlan(steps, requested);
  if (bindingIssue) {
    return preflightFailure(steps, bindingIssue.index, bindingIssue.message);
  }

  const { coordinator } = await deps.ensure();
  const quota = coordinator.quotaFor(sessionId);
  if (!quota) throw new Error(`session ${sessionId} not found`);
  const remainingSteps = quota.max_steps - quota.steps_used;
  if (steps.length > remainingSteps) {
    const failedIndex = Math.max(0, remainingSteps);
    return preflightFailure(
      steps,
      failedIndex,
      `Session has only ${remainingSteps} steps remaining; batch requires ${steps.length}`
    );
  }

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const name = browserToolName(step.tool);
    const generated = context.tools.get(name);
    try {
      assertAvailable(name, step.tool, generated, context);
      if (
        generated.stepKind === "js" ||
        generated.resultKind === "image" ||
        BLOCKED_BATCH_TOOLS.has(name)
      ) {
        throw new Error(`Tool ${name} is not allowed in browser_runSteps`);
      }
      for (const field of CAPABILITY_SENSITIVE_FIELDS.get(name) ?? []) {
        if (bindingReferences(step.args[field]).length > 0) {
          throw new Error(
            `Capability-sensitive field ${field} cannot reference bindings in browser_runSteps`
          );
        }
      }
      const prepared = await prepareBrowserTool(deps, generated!, {
        ...step.args,
        session_id: sessionId
      });
      if (prepared.dangerous) {
        throw new Error("Dangerous tool is not allowed in browser_runSteps");
      }
    } catch (error) {
      return {
        ok: false,
        phase: "preflight",
        completed: 0,
        failed_step: { index, tool: name },
        error: { message: error instanceof Error ? error.message : String(error) },
        bindings: {}
      };
    }
  }

  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const name = browserToolName(step.tool);
    const generated = context.tools.get(name);
    assertAvailable(name, step.tool, generated, context);

    const resolvedArgs = resolveBindings(step.args, bindings) as Record<string, unknown>;
    try {
      result = await handleBrowserTool(deps, generated, { ...resolvedArgs, session_id: sessionId });
    } catch (error) {
      return {
        ok: false,
        phase: "execution",
        completed: index,
        failed_step: { index, tool: name },
        error: { message: error instanceof Error ? error.message : String(error) },
        bindings: selectBindings(requested, bindings, false)
      };
    }
    if (step.bind_result_to) bindings[step.bind_result_to] = result;
  }

  return {
    ok: true,
    completed: steps.length,
    result,
    bindings: selectBindings(requested, bindings, true)
  };
}

function preflightFailure(steps: RunStep[], index: number, message: string): RunStepsFailure {
  const boundedIndex = Math.min(Math.max(index, 0), steps.length - 1);
  return {
    ok: false,
    phase: "preflight",
    completed: 0,
    failed_step: {
      index: boundedIndex,
      tool: browserToolName(steps[boundedIndex].tool)
    },
    error: { message },
    bindings: {}
  };
}

function parseReturnBindings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) {
    throw new Error("InvalidArgs: return_bindings must be an array of binding names");
  }
  return value as string[];
}

function validateBindingPlan(
  steps: RunStep[],
  requested: string[]
): { index: number; message: string } | null {
  const declared = new Set<string>();
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    for (const name of bindingReferences(step.args)) {
      if (!declared.has(name)) {
        return {
          index,
          message: `InvalidArgs: binding ${name} must be declared by an earlier step`
        };
      }
    }
    if (step.bind_result_to) {
      if (!BINDING_NAME.test(step.bind_result_to)) {
        return { index, message: `InvalidArgs: invalid binding name ${step.bind_result_to}` };
      }
      if (declared.has(step.bind_result_to)) {
        return { index, message: `InvalidArgs: duplicate binding ${step.bind_result_to}` };
      }
      declared.add(step.bind_result_to);
    }
  }

  const seenRequested = new Set<string>();
  for (const name of requested) {
    if (!BINDING_NAME.test(name)) {
      return { index: 0, message: `InvalidArgs: invalid return binding ${name}` };
    }
    if (seenRequested.has(name)) {
      return { index: 0, message: `InvalidArgs: duplicate return binding ${name}` };
    }
    if (!declared.has(name)) {
      return { index: 0, message: `InvalidArgs: unknown return binding ${name}` };
    }
    seenRequested.add(name);
  }
  return null;
}

function bindingReferences(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{([^}]+)\}/g)].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap(bindingReferences);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(bindingReferences);
  }
  return [];
}

function assertAvailable(
  name: string,
  rawName: string,
  generated: GeneratedTool | undefined,
  context: RunStepsContext
): asserts generated is GeneratedTool {
  if (!generated) throw new Error(`Unknown browser tool: ${rawName}`);
  if (!context.advertised.has(name)) {
    throw new Error(`${name} is not enabled; call browser_discoverTools first`);
  }
  if (context.supported && !generated.builtinTools.every((tool) => context.supported!.has(tool))) {
    throw new Error(`${name} is not supported by the connected browser extension`);
  }
}

function parseStep(value: unknown): RunStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("InvalidArgs: each browser_runSteps step must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.tool !== "string" || raw.tool.trim() === "") {
    throw new Error("InvalidArgs: each browser_runSteps step requires tool");
  }
  if (!raw.args || typeof raw.args !== "object" || Array.isArray(raw.args)) {
    throw new Error("InvalidArgs: each browser_runSteps step requires object args");
  }
  if (raw.bind_result_to !== undefined && typeof raw.bind_result_to !== "string") {
    throw new Error("InvalidArgs: bind_result_to must be a binding name");
  }
  return {
    tool: raw.tool,
    args: raw.args as Record<string, unknown>,
    ...(typeof raw.bind_result_to === "string" ? { bind_result_to: raw.bind_result_to } : {})
  };
}

function browserToolName(raw: string): string {
  const name = raw.trim();
  return name.startsWith("browser_") ? name : `browser_${name}`;
}

function resolveBindings(value: unknown, bindings: Record<string, Json>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\$\{([^}]+)\}$/);
    if (exact) return requireBinding(exact[1], bindings);
    return value.replace(/\$\{([^}]+)\}/g, (_match, name: string) => {
      const bound = requireBinding(name, bindings);
      return typeof bound === "string" ? bound : JSON.stringify(bound);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveBindings(item, bindings));
  if (value && typeof value === "object") {
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveBindings(item, bindings);
    }
    return resolved;
  }
  return value;
}

function requireBinding(name: string, bindings: Record<string, Json>): Json {
  if (!(name in bindings)) throw new Error(`InvalidArgs: binding ${name} is not available`);
  return bindings[name];
}

function selectBindings(
  requested: string[],
  bindings: Record<string, Json>,
  requireAll: boolean
): Record<string, Json> {
  const selected: Record<string, Json> = {};
  for (const name of requested) {
    if (!(name in bindings)) {
      if (requireAll) throw new Error(`InvalidArgs: unknown return binding ${name}`);
      continue;
    }
    selected[name] = bindings[name];
  }
  return selected;
}
