import type {
  Json,
  Step,
  StepsTool,
  StepsToolVersion,
  ToolParameter,
} from "./types";

export type WorkflowBindingErrorCode =
  | "invalid_binding_path"
  | "unsafe_binding_path"
  | "binding_path_not_found";

export class WorkflowBindingError extends Error {
  constructor(
    public readonly code: WorkflowBindingErrorCode,
    public readonly path: string,
  ) {
    super(`${code}: ${path}`);
    this.name = "WorkflowBindingError";
  }
}

export type WorkflowInputErrorCode =
  | "unknown_input"
  | "missing_required_input"
  | "input_type_mismatch";

export class WorkflowInputError extends Error {
  constructor(
    public readonly code: WorkflowInputErrorCode,
    public readonly key: string,
  ) {
    super(`${code}: ${key}`);
    this.name = "WorkflowInputError";
  }
}

const ROOT_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH_KEY = /^(?:[A-Za-z_][A-Za-z0-9_]*|\d+)$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const EXACT_REFERENCE = /^\$\{([^{}]+)\}$/;
const EMBEDDED_REFERENCE = /\$\{([^{}]+)\}/g;

export type WorkflowIssueCode =
  | "invalid_binding_name"
  | "duplicate_binding"
  | "unknown_binding"
  | "invalid_binding_path"
  | "unsafe_binding_path"
  | "output_binding_not_found";

export type WorkflowIssue = {
  code: WorkflowIssueCode;
  binding: string;
  stepIndex?: number;
  path?: string;
};

export type WorkflowDefinition = {
  parameters: ToolParameter[];
  steps: Step[];
  outputBinding?: string;
};

export type WorkflowAnalysis = {
  issues: WorkflowIssue[];
  taintedStepIndexes: number[];
  taintedBindings: string[];
};

export type ActiveStepsToolVersion = Omit<StepsToolVersion, "parameters"> & {
  parameters: ToolParameter[];
};

export function getActiveStepsVersion(tool: StepsTool): ActiveStepsToolVersion {
  const highestVersion = Math.max(...tool.versions.map((version) => version.version));
  const activeVersion = tool.activeVersion ?? highestVersion;
  const snapshot = tool.versions.find((version) => version.version === activeVersion);
  if (!snapshot) {
    throw new Error(`active_workflow_version_not_found: ${activeVersion}`);
  }
  return { ...snapshot, parameters: snapshot.parameters ?? [] };
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every(isJson);
}

function inputMatchesParameter(value: unknown, parameter: ToolParameter): value is Json {
  if (parameter.type === "json") return isJson(value);
  return typeof value === parameter.type &&
    (parameter.type !== "number" || Number.isFinite(value));
}

export function prepareWorkflowInputs(
  parameters: ToolParameter[],
  inputs: Record<string, unknown>,
): { bindings: Record<string, Json>; sensitiveBindings: string[] } {
  const byKey = new Map(parameters.map((parameter) => [parameter.key, parameter]));
  for (const key of Object.keys(inputs)) {
    if (!byKey.has(key)) throw new WorkflowInputError("unknown_input", key);
  }

  const bindings: Record<string, Json> = {};
  const sensitiveBindings: string[] = [];
  for (const parameter of parameters) {
    if (parameter.sensitive) sensitiveBindings.push(parameter.key);
    const supplied = Object.hasOwn(inputs, parameter.key);
    const value = supplied ? inputs[parameter.key] : parameter.defaultValue;
    if (value === undefined) {
      if (parameter.required) {
        throw new WorkflowInputError("missing_required_input", parameter.key);
      }
      bindings[parameter.key] = null;
      continue;
    }
    if (!inputMatchesParameter(value, parameter)) {
      throw new WorkflowInputError("input_type_mismatch", parameter.key);
    }
    bindings[parameter.key] = value;
  }
  return { bindings, sensitiveBindings };
}

function parsePath(path: string): string[] {
  const parts = path.split(".");
  if (!ROOT_KEY.test(parts[0] ?? "") || parts.some((part) => !PATH_KEY.test(part))) {
    throw new WorkflowBindingError("invalid_binding_path", path);
  }
  if (parts.some((part) => UNSAFE_KEYS.has(part))) {
    throw new WorkflowBindingError("unsafe_binding_path", path);
  }
  return parts;
}

function readPath(path: string, bindings: Record<string, Json>): Json {
  const parts = parsePath(path);
  let current: unknown = bindings;

  for (const part of parts) {
    if (current === null || typeof current !== "object") {
      throw new WorkflowBindingError("binding_path_not_found", path);
    }
    if (Array.isArray(current) && !/^\d+$/.test(part)) {
      throw new WorkflowBindingError("binding_path_not_found", path);
    }
    const descriptor = Object.getOwnPropertyDescriptor(current, part);
    if (!descriptor) throw new WorkflowBindingError("binding_path_not_found", path);
    if (descriptor.get || descriptor.set) {
      throw new WorkflowBindingError("unsafe_binding_path", path);
    }
    current = descriptor.value;
  }

  return current as Json;
}

function interpolate(value: string, bindings: Record<string, Json>): Json {
  const exact = value.match(EXACT_REFERENCE);
  if (exact) return readPath(exact[1], bindings);

  return value.replace(EMBEDDED_REFERENCE, (_, path: string) => {
    const resolved = readPath(path, bindings);
    if (resolved === null) return "";
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

export function resolveWorkflowValue(
  value: Json,
  bindings: Record<string, Json>,
): Json {
  if (typeof value === "string") return interpolate(value, bindings);
  if (Array.isArray(value)) {
    return value.map((item) => resolveWorkflowValue(item, bindings));
  }
  if (value !== null && typeof value === "object") {
    const resolved: Record<string, Json> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) {
        throw new WorkflowBindingError("unsafe_binding_path", key);
      }
      resolved[key] = resolveWorkflowValue(descriptor.value as Json, bindings);
    }
    return resolved;
  }
  return value;
}

function bindingReferences(value: Json): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(new RegExp(EMBEDDED_REFERENCE.source, "g"))].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap(bindingReferences);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(bindingReferences);
  }
  return [];
}

export function analyzeWorkflow(definition: WorkflowDefinition): WorkflowAnalysis {
  const issues: WorkflowIssue[] = [];
  const available = new Set<string>();
  const tainted = new Set<string>();
  const taintedStepIndexes: number[] = [];

  for (const parameter of definition.parameters) {
    if (!ROOT_KEY.test(parameter.key)) {
      issues.push({ code: "invalid_binding_name", binding: parameter.key });
      continue;
    }
    if (available.has(parameter.key)) {
      issues.push({ code: "duplicate_binding", binding: parameter.key });
      continue;
    }
    available.add(parameter.key);
    if (parameter.sensitive) tainted.add(parameter.key);
  }

  definition.steps.forEach((step, stepIndex) => {
    const references = step.kind === "tool" ? bindingReferences(step.args) : [];
    let stepIsTainted = step.kind === "js" && tainted.size > 0;

    for (const path of references) {
      let parts: string[];
      try {
        parts = parsePath(path);
      } catch (error) {
        if (error instanceof WorkflowBindingError) {
          const code: WorkflowIssueCode =
            error.code === "unsafe_binding_path"
              ? "unsafe_binding_path"
              : "invalid_binding_path";
          issues.push({
            code,
            binding: path.split(".")[0] ?? path,
            stepIndex,
            path,
          });
          continue;
        }
        throw error;
      }
      const root = parts[0];
      if (!available.has(root)) {
        issues.push({ code: "unknown_binding", binding: root, stepIndex, path });
      }
      if (tainted.has(root)) stepIsTainted = true;
    }

    if (stepIsTainted) taintedStepIndexes.push(stepIndex);
    if (!step.bindResultTo) return;
    if (!ROOT_KEY.test(step.bindResultTo)) {
      issues.push({
        code: "invalid_binding_name",
        binding: step.bindResultTo,
        stepIndex,
      });
      return;
    }
    if (available.has(step.bindResultTo)) {
      issues.push({ code: "duplicate_binding", binding: step.bindResultTo, stepIndex });
      return;
    }
    available.add(step.bindResultTo);
    if (stepIsTainted) tainted.add(step.bindResultTo);
  });

  if (definition.outputBinding && !available.has(definition.outputBinding)) {
    issues.push({
      code: "output_binding_not_found",
      binding: definition.outputBinding,
    });
  }

  return {
    issues,
    taintedStepIndexes,
    taintedBindings: [...tainted],
  };
}

export type WorkflowSnapshot = WorkflowDefinition & { outputSchema: Json };

export type WorkflowParameterChange = {
  kind: "added" | "removed" | "modified";
  key: string;
  before?: ToolParameter;
  after?: ToolParameter;
};

export type WorkflowStepChange = {
  kind: "added" | "removed" | "modified" | "moved";
  fromIndex?: number;
  toIndex?: number;
  before?: Step;
  after?: Step;
};

export type WorkflowOutputChange = {
  kind: "unchanged" | "modified";
  before: { outputBinding?: string; outputSchema: Json };
  after: { outputBinding?: string; outputSchema: Json };
};

export type WorkflowDefinitionDiff = {
  parameters: WorkflowParameterChange[];
  steps: WorkflowStepChange[];
  output: WorkflowOutputChange;
};

/**
 * Structural workflow diff used by Workflow Studio. Steps have no stable id,
 * so moves are reported only for an exact semantic value that occurs once on
 * both sides. Duplicate values deliberately degrade to remove + add.
 */
export function diffWorkflowDefinitions(
  before: WorkflowSnapshot,
  after: WorkflowSnapshot,
): WorkflowDefinitionDiff {
  const parameters: WorkflowParameterChange[] = [];
  const beforeParameters = new Map(before.parameters.map((parameter) => [parameter.key, parameter]));
  const afterParameters = new Map(after.parameters.map((parameter) => [parameter.key, parameter]));
  for (const parameter of before.parameters) {
    const next = afterParameters.get(parameter.key);
    if (!next) {
      parameters.push({ kind: "removed", key: parameter.key, before: parameter });
    } else if (!jsonEqual(parameter as unknown as Json, next as unknown as Json)) {
      parameters.push({ kind: "modified", key: parameter.key, before: parameter, after: next });
    }
  }
  for (const parameter of after.parameters) {
    if (!beforeParameters.has(parameter.key)) {
      parameters.push({ kind: "added", key: parameter.key, after: parameter });
    }
  }

  const steps: WorkflowStepChange[] = [];
  const matchedBefore = new Set<number>();
  const matchedAfter = new Set<number>();
  const beforeSignatures = before.steps.map((step) => stableJson(step as unknown as Json));
  const afterSignatures = after.steps.map((step) => stableJson(step as unknown as Json));
  const beforeCounts = countValues(beforeSignatures);
  const afterCounts = countValues(afterSignatures);

  for (let fromIndex = 0; fromIndex < before.steps.length; fromIndex++) {
    const signature = beforeSignatures[fromIndex];
    if (beforeCounts.get(signature) !== 1 || afterCounts.get(signature) !== 1) continue;
    const toIndex = afterSignatures.indexOf(signature);
    if (toIndex < 0) continue;
    matchedBefore.add(fromIndex);
    matchedAfter.add(toIndex);
    if (fromIndex !== toIndex) {
      steps.push({
        kind: "moved",
        fromIndex,
        toIndex,
        before: before.steps[fromIndex],
        after: after.steps[toIndex],
      });
    }
  }

  const remainingBefore = before.steps
    .map((step, index) => ({ step, index, key: stepSemanticKey(step) }))
    .filter(({ index }) => !matchedBefore.has(index));
  const remainingAfter = after.steps
    .map((step, index) => ({ step, index, key: stepSemanticKey(step) }))
    .filter(({ index }) => !matchedAfter.has(index));
  const beforeSemanticCounts = countValues(remainingBefore.map(({ key }) => key));
  const afterSemanticCounts = countValues(remainingAfter.map(({ key }) => key));

  for (const candidate of remainingBefore) {
    if (
      beforeSemanticCounts.get(candidate.key) !== 1 ||
      afterSemanticCounts.get(candidate.key) !== 1
    ) continue;
    const next = remainingAfter.find(({ key, index }) =>
      key === candidate.key && !matchedAfter.has(index)
    );
    if (!next) continue;
    matchedBefore.add(candidate.index);
    matchedAfter.add(next.index);
    steps.push({
      kind: "modified",
      fromIndex: candidate.index,
      toIndex: next.index,
      before: candidate.step,
      after: next.step,
    });
  }

  before.steps.forEach((step, fromIndex) => {
    if (!matchedBefore.has(fromIndex)) steps.push({ kind: "removed", fromIndex, before: step });
  });
  after.steps.forEach((step, toIndex) => {
    if (!matchedAfter.has(toIndex)) steps.push({ kind: "added", toIndex, after: step });
  });

  const beforeOutput = {
    ...(before.outputBinding === undefined ? {} : { outputBinding: before.outputBinding }),
    outputSchema: before.outputSchema,
  };
  const afterOutput = {
    ...(after.outputBinding === undefined ? {} : { outputBinding: after.outputBinding }),
    outputSchema: after.outputSchema,
  };
  return {
    parameters,
    steps,
    output: {
      kind: jsonEqual(beforeOutput, afterOutput) ? "unchanged" : "modified",
      before: beforeOutput,
      after: afterOutput,
    },
  };
}

function stepSemanticKey(step: Step): string {
  return step.kind === "tool"
    ? `tool:${step.tool}:${step.bindResultTo ?? ""}`
    : `js:${step.bindResultTo ?? ""}`;
}

function countValues(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function jsonEqual(left: Json, right: Json): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(",")}}`;
}
