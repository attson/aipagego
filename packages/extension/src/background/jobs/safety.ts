import type { JobSeverity } from "@aipagego/shared/jobs";
import type { Json, StepsToolVersion } from "@aipagego/shared/types";
import { prepareWorkflowInputs, resolveWorkflowValue } from "@aipagego/shared/workflow";
import { classifyTool } from "@/sidepanel/chat/severity";

function bindingReferences(value: Json): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{([^{}]+)\}/g)].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap(bindingReferences);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(bindingReferences);
  }
  return [];
}

function isObject(value: Json): value is Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function maxSeverity(left: JobSeverity, right: JobSeverity): JobSeverity {
  if (left === "dangerous" || right === "dangerous") return "dangerous";
  if (left === "caution" || right === "caution") return "caution";
  return "safe";
}

export function classifyJobWorkflow(
  snapshot: StepsToolVersion,
  inputs: Record<string, Json>,
): JobSeverity {
  const prepared = prepareWorkflowInputs(snapshot.parameters, inputs);
  let result: JobSeverity = "safe";

  for (const step of snapshot.steps) {
    if (step.kind === "js") {
      result = maxSeverity(result, classifyTool("runJS", { source: step.source }));
      continue;
    }

    let args = step.args;
    let fullyResolved = true;
    try {
      args = resolveWorkflowValue(step.args, prepared.bindings);
    } catch {
      fullyResolved = false;
      // Outputs from earlier steps do not exist during preflight. Fields that
      // can elevate risk are checked on their unresolved source below.
    }
    let severity = classifyTool(step.tool, args);
    const raw = isObject(step.args) ? step.args : {};
    if (
      step.tool === "httpRequest" &&
      !fullyResolved &&
      bindingReferences(raw.withCredentials ?? null).length > 0
    ) {
      severity = "dangerous";
    }
    if (
      step.tool === "drop" &&
      !fullyResolved &&
      bindingReferences(raw.files ?? null).length > 0
    ) {
      severity = "dangerous";
    }
    result = maxSeverity(result, severity);
  }
  return result;
}
