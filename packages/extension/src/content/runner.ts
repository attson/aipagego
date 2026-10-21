import type { BuiltinTool, Json, RunStatus, RunStepLogEntry, Step } from "@aipagego/shared/types";
import { RunContext } from "./ctx";

export type RunnerHandlers = {
  runTool: (tool: BuiltinTool, args: Json, stepIndex: number) => Promise<Json>;
  runJs: (source: string, bindings: Record<string, Json>, stepIndex: number) => Promise<Json>;
};

export type RunResult = {
  status: RunStatus;
  output?: Json;
  stepLog: RunStepLogEntry[];
};

const DEFAULT_TIMEOUT = 10_000;

export async function runSteps(steps: Step[], handlers: RunnerHandlers): Promise<RunResult> {
  const ctx = new RunContext();
  const stepLog: RunStepLogEntry[] = [];
  let lastOutput: Json = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const start = Date.now();
    try {
      let resolvedInput: Json;
      let output: Json;
      if (step.kind === "tool") {
        resolvedInput = ctx.resolve(step.args);
        output = await withTimeout(
          handlers.runTool(step.tool, resolvedInput, i),
          step.timeoutMs ?? DEFAULT_TIMEOUT
        );
      } else {
        resolvedInput = step.source;
        output = await withTimeout(
          handlers.runJs(step.source, ctx.snapshot(), i),
          step.timeoutMs ?? DEFAULT_TIMEOUT
        );
      }
      stepLog.push({
        stepIndex: i,
        input: resolvedInput,
        output,
        ms: Date.now() - start
      });
      if (step.bindResultTo) ctx.set(step.bindResultTo, output);
      lastOutput = output;
    } catch (e) {
      stepLog.push({
        stepIndex: i,
        input: step.kind === "tool" ? (ctx.resolve(step.args) as Json) : step.source,
        output: null,
        ms: Date.now() - start,
        error: e instanceof Error ? e.message : String(e)
      });
      return { status: "error", stepLog };
    }
  }

  return { status: "ok", output: lastOutput, stepLog };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`step timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
