import type { Step, StepsTool, StepsToolVersion, Json } from "@aipagego/shared/types";
import { classifyTool } from "@/sidepanel/chat/severity";

export type HealContext = {
  tool: Pick<StepsTool, "id" | "kind" | "name" | "description" | "urlPatterns"> & StepsToolVersion;
  failedStepIndex: number;
  failedInput: Step;
  errorText: string;
  prevSteps: { input: Json | string; output: Json }[];
  domSnapshot: unknown;
  url: string;
};

export type HealResult =
  | { ok: true;  patchedSteps: Step[]; llmUsage: { in: number; out: number } }
  | { ok: false; reason:
      | "llm_error" | "budget_exceeded" | "invalid_output"
      | "static_scan_reject" | "step_still_fails"
      | "no_sidepanel" | "no_api_key" | "self_heal_disabled" };

export type HealDeps = {
  requestSidepanelLlm: (
    ctx: HealContext,
    maxOutputTokens: number
  ) => Promise<{ patchedSteps: unknown; usage: { in: number; out: number } }>;
  snapshot: (tabId: number) => Promise<unknown>;
  staticScan: (steps: Step[]) => Array<"safe" | "caution" | "dangerous">;
  classifyStep?: (step: Step) => "safe" | "caution" | "dangerous";
  parseSteps: (raw: unknown) => Step[] | null;
  validatePatch?: (steps: Step[]) => boolean;
  now: () => number;
};

export function parseStepsSafe(raw: unknown): Step[] | null {
  if (!Array.isArray(raw)) return null;
  const steps = raw as unknown[];
  for (const s of steps) {
    if (typeof s !== "object" || s === null) return null;
    const step = s as Record<string, unknown>;
    if (step.kind !== "tool" && step.kind !== "js") return null;
  }
  return raw as Step[];
}

export async function attemptHeal(
  ctx: HealContext,
  deps: HealDeps,
  opts: { maxOutputTokens?: number } = {}
): Promise<HealResult> {
  const cap = opts.maxOutputTokens ?? 4096;
  let resp: { patchedSteps: unknown; usage: { in: number; out: number } };
  try {
    resp = await deps.requestSidepanelLlm(ctx, cap);
  } catch (e: any) {
    if (e?.message?.includes?.("no_sidepanel")) return { ok: false, reason: "no_sidepanel" };
    if (e?.message?.includes?.("no_api_key")) return { ok: false, reason: "no_api_key" };
    if (e?.message?.includes?.("self_heal_disabled")) return { ok: false, reason: "self_heal_disabled" };
    return { ok: false, reason: "llm_error" };
  }
  if (resp.usage.out > cap) {
    return { ok: false, reason: "budget_exceeded" };
  }
  const parsed = deps.parseSteps(resp.patchedSteps);
  if (!parsed || parsed.length === 0) {
    return { ok: false, reason: "invalid_output" };
  }
  if (deps.validatePatch && !deps.validatePatch(parsed)) {
    return { ok: false, reason: "invalid_output" };
  }
  // Per-step check: tool steps use classifyTool; js steps delegate to staticScan dep
  for (const step of parsed) {
    if (step.kind === "tool") {
      const severity = deps.classifyStep?.(step) ?? classifyTool(step.tool, step.args as Json);
      if (severity === "dangerous") {
        return { ok: false, reason: "static_scan_reject" };
      }
    } else {
      // js step — static-scan must not report dangerous
      const sev = deps.staticScan([step]);
      if (sev.some((s) => s === "dangerous")) {
        return { ok: false, reason: "static_scan_reject" };
      }
    }
  }
  // Holistic staticScan pass over the full patch
  const globalSev = deps.staticScan(parsed);
  if (globalSev.some((s) => s === "dangerous")) {
    return { ok: false, reason: "static_scan_reject" };
  }
  return { ok: true, patchedSteps: parsed, llmUsage: resp.usage };
}
