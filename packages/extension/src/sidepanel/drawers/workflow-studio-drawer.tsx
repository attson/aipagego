import { useEffect, useMemo, useRef, useState } from "react";
import { StepSchema } from "@aipagego/shared/messages";
import { TOOL_DEFS } from "@aipagego/shared/llm";
import { runStaticScan } from "@aipagego/shared/static-scan";
import type { Json, RunRecord, Step, StepsTool, ToolParameter } from "@aipagego/shared/types";
import {
  analyzeWorkflow,
  diffWorkflowDefinitions,
  prepareWorkflowInputs,
  resolveWorkflowValue,
  type WorkflowDefinitionDiff,
  type WorkflowSnapshot,
} from "@aipagego/shared/workflow";
import { useUi } from "@/sidepanel/chat/ui-store";
import { getSessionFor } from "@/sidepanel/chat/session-store";
import { useSettings } from "@/sidepanel/chat/settings-store";
import {
  classifyTool,
  evaluateAutoApproval,
  type ToolSeverity,
} from "@/sidepanel/chat/severity";
import { rpc } from "@/sidepanel/rpc";
import { Drawer } from "@/sidepanel/shell/drawer";
import {
  clearWorkflowDraft,
  createWorkflowDraft,
  loadWorkflowDraft,
  saveWorkflowDraft,
  type WorkflowDraft,
} from "@/sidepanel/workflow-studio/draft-storage";
import {
  addWorkflowStep,
  deleteWorkflowStep,
  duplicateWorkflowStep,
  moveWorkflowStep,
  reorderWorkflowStep,
  validateWorkflowDraft,
} from "@/sidepanel/workflow-studio/editor-model";

type JsonObject = Record<string, Json>;
type SimpleField = {
  key: string;
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  required: boolean;
  values?: Json[];
};
type StepTestResult = {
  status: "awaiting" | "running" | "ok" | "error" | "forbidden" | "blocked" | "skipped" | "denied";
  input?: Json | string;
  output?: Json;
  error?: string;
  ms?: number;
  missingBinding?: string;
  missingBindings?: string[];
  earliestStep?: number;
  sensitive?: boolean;
  failureKind?: "forbidden" | "tab_closed" | "error";
};
type PendingStepTest = {
  index: number;
  step: Step;
  bindings: Record<string, Json>;
  severity: ToolSeverity;
  startedAt: number;
  input: Json | string;
  sensitive: boolean;
};
type PendingWorkflowTest = {
  inputs: Record<string, Json>;
  severity: ToolSeverity;
  toolNames: string[];
};

const REPLAYABLE_TOOL_NAMES = TOOL_DEFS
  .map((definition) => definition.name)
  .filter((name) => StepSchema.safeParse({ kind: "tool", tool: name, args: {} }).success);

function asObject(value: Json): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function simpleFields(toolName: string): { fields: SimpleField[]; hasComplex: boolean } {
  const definition = TOOL_DEFS.find((tool) => tool.name === toolName);
  const schema = asObject((definition?.input_schema ?? {}) as Json);
  const properties = asObject((schema.properties ?? {}) as Json);
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((item): item is string => typeof item === "string"))
    : new Set<string>();
  const fields: SimpleField[] = [];
  let hasComplex = false;
  for (const [key, raw] of Object.entries(properties)) {
    const property = asObject(raw);
    const type = property.type;
    if (type !== "string" && type !== "number" && type !== "integer" && type !== "boolean") {
      hasComplex = true;
      continue;
    }
    fields.push({
      key,
      type,
      required: required.has(key),
      ...(typeof property.description === "string" ? { description: property.description } : {}),
      ...(Array.isArray(property.enum) ? { values: property.enum } : {})
    });
  }
  return { fields, hasComplex };
}

function displayJson(value: Json): string {
  return JSON.stringify(value, null, 2);
}

function boundedPreview(value: Json | undefined): string {
  const text = JSON.stringify(value ?? null, null, 2);
  return text.length <= 4_000 ? text : `${text.slice(0, 4_000)}\n…预览已截断`;
}

function boundedText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…上下文已截断`;
}

function classifyStepFailure(message: string): "forbidden" | "tab_closed" | "error" {
  const normalized = message.toLowerCase();
  if (
    message.includes("Content script 无法注入") ||
    message.includes("站点注入策略") ||
    normalized.includes("cannot access contents of url") ||
    normalized.includes("missing host permission")
  ) return "forbidden";
  if (
    normalized.includes("no tab with id") ||
    normalized.includes("tab was closed") ||
    normalized.includes("tab not found")
  ) return "tab_closed";
  return "error";
}

function collectBindingReferences(value: Json): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(/\$\{([^{}]+)\}/g)].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap(collectBindingReferences);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(collectBindingReferences);
  }
  return [];
}

function workflowStepSeverity(
  step: Step,
  bindings: Record<string, Json>,
): { toolName: string; severity: ToolSeverity } {
  if (step.kind === "js") {
    return {
      toolName: "runJS",
      severity: classifyTool("runJS", { source: step.source }),
    };
  }

  let resolvedArgs = step.args;
  try {
    resolvedArgs = resolveWorkflowValue(step.args, bindings);
  } catch {
    // Outputs of earlier draft steps do not exist during preflight. Dynamic
    // fields that can elevate severity are therefore treated conservatively.
  }
  let severity = classifyTool(step.tool, resolvedArgs);
  const rawArgs = asObject(step.args);
  if (
    step.tool === "httpRequest" &&
    collectBindingReferences(rawArgs.withCredentials ?? null).length > 0
  ) {
    severity = "dangerous";
  }
  if (
    step.tool === "drop" &&
    collectBindingReferences(rawArgs.files ?? null).length > 0
  ) {
    severity = "dangerous";
  }
  return { toolName: step.tool, severity };
}

function highestToolSeverity(severities: ToolSeverity[]): ToolSeverity {
  if (severities.includes("dangerous")) return "dangerous";
  if (severities.includes("caution")) return "caution";
  return "safe";
}

function parseDefault(parameter: ToolParameter, raw: string): Json | undefined {
  if (raw === "") return undefined;
  if (parameter.type === "string") return raw;
  if (parameter.type === "number") {
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  if (parameter.type === "boolean") return raw === "true";
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return raw;
  }
}

function initialRunInputs(parameters: ToolParameter[]): Record<string, string | boolean> {
  return Object.fromEntries(parameters.map((parameter) => [
    parameter.key,
    parameter.defaultValue === undefined
      ? parameter.type === "boolean" ? false : ""
      : parameter.type === "json"
        ? JSON.stringify(parameter.defaultValue)
        : parameter.defaultValue
  ])) as Record<string, string | boolean>;
}

export function WorkflowStudioDrawer({
  onEditCollection,
  onFixWithAi,
  currentTabId = null,
}: {
  onEditCollection?: (input: { toolId: string; recipe: Json; apply: (recipe: Json) => void }) => void;
  onFixWithAi?: (input: { initialPrompt: string; initialContext: string; tabId: number }) => void;
  currentTabId?: number | null;
} = {}) {
  const opened = useUi((state) => state.openedDrawer);
  const toolId = useUi((state) => state.drawerSubPath);
  const open = useUi((state) => state.open);
  const close = useUi((state) => state.close);
  const settings = useSettings();
  const isOpen = opened === "workflow";
  const [tool, setTool] = useState<StepsTool | null>(null);
  const [draft, setDraft] = useState<WorkflowDraft | null>(null);
  const [selectedStep, setSelectedStep] = useState(0);
  const [state, setState] = useState<"loading" | "default" | "error" | "conflict">("loading");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [draggedStep, setDraggedStep] = useState<number | null>(null);
  const [runInputs, setRunInputs] = useState<Record<string, string | boolean>>({});
  const [testRun, setTestRun] = useState<RunRecord | null>(null);
  const [testing, setTesting] = useState(false);
  const [testBindings, setTestBindings] = useState<Record<string, Json>>({});
  const [stepTests, setStepTests] = useState<Record<number, StepTestResult>>({});
  const [pendingStepTest, setPendingStepTest] = useState<PendingStepTest | null>(null);
  const [pendingWorkflowTest, setPendingWorkflowTest] = useState<PendingWorkflowTest | null>(null);
  const [diffLeft, setDiffLeft] = useState("1");
  const [diffRight, setDiffRight] = useState("draft");
  const [activatingVersion, setActivatingVersion] = useState<number | null>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const capturedTabId = useRef<number | null>(null);
  const initializedToolId = useRef<string | null>(null);
  const draftRef = useRef<WorkflowDraft | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!isOpen || !toolId) return;
    capturedTabId.current = currentTabId;
    const inMemoryDraft = initializedToolId.current === toolId ? draftRef.current : null;
    let cancelled = false;
    setState("loading");
    setError(null);
    setMessage(null);
    void rpc.getTool(toolId).then(async (loaded) => {
      if (cancelled) return;
      if (!loaded) throw new Error("workflow tool not found");
      if (loaded.kind !== "steps") throw new Error("prompt tools do not use Workflow Studio");
      const restored = inMemoryDraft
        ? {
            status: inMemoryDraft.basedOnVersion === loaded.activeVersion ? "ready" as const : "conflict" as const,
            draft: inMemoryDraft,
          }
        : await loadWorkflowDraft(loaded);
      if (cancelled) return;
      setTool(loaded);
      setDraft(restored.draft);
      setDiffLeft(String(restored.draft.basedOnVersion));
      setDiffRight("draft");
      initializedToolId.current = loaded.id;
      setRunInputs(initialRunInputs(restored.draft.parameters));
      setTestRun(null);
      setTestBindings({});
      setStepTests({});
      setPendingStepTest(null);
      setPendingWorkflowTest(null);
      setSelectedStep(0);
      setState(restored.status === "conflict" ? "conflict" : "default");
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason instanceof Error ? reason.message : String(reason));
      setState("error");
    });
    return () => { cancelled = true; };
  }, [isOpen, toolId]);

  useEffect(() => {
    if (isOpen) return;
    setRunInputs({});
    setTestRun(null);
    setTestBindings({});
    setStepTests({});
    setPendingStepTest(null);
    setPendingWorkflowTest(null);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || state !== "default" || !draft) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void saveWorkflowDraft(draft).catch(() => undefined);
    }, 120);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [draft, isOpen, state]);

  const issues = useMemo(() => draft ? validateWorkflowDraft(draft) : [], [draft]);
  const bindings = useMemo(() => draft?.steps
    .map((step) => step.bindResultTo)
    .filter((binding): binding is string => !!binding) ?? [], [draft]);
  const step = draft?.steps[selectedStep];
  const versionDiff = useMemo(() => {
    if (!tool || !draft) return null;
    const snapshot = (selection: string): WorkflowSnapshot | null => {
      if (selection === "draft") {
        return {
          parameters: draft.parameters,
          steps: draft.steps,
          outputBinding: draft.outputBinding,
          outputSchema: draft.outputSchema,
        };
      }
      const version = tool.versions.find((candidate) => candidate.version === Number(selection));
      if (!version) return null;
      return {
        parameters: version.parameters ?? [],
        steps: version.steps,
        outputBinding: version.outputBinding,
        outputSchema: version.outputSchema,
      };
    };
    const left = snapshot(diffLeft);
    const right = snapshot(diffRight);
    return left && right ? diffWorkflowDefinitions(left, right) : null;
  }, [diffLeft, diffRight, draft, tool]);

  function updateDraft(update: (current: WorkflowDraft) => WorkflowDraft): void {
    setDraft((current) => current ? update(current) : current);
    setMessage(null);
    setTestRun(null);
    setTestBindings({});
    setStepTests({});
    setPendingStepTest(null);
    setPendingWorkflowTest(null);
  }

  function updateParameter(index: number, patch: Partial<ToolParameter>): void {
    updateDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, currentIndex) => {
        if (currentIndex !== index) return parameter;
        const updated = { ...parameter, ...patch };
        if (updated.sensitive) delete updated.defaultValue;
        return updated;
      })
    }));
  }

  function updateStep(index: number, next: Step): void {
    updateDraft((current) => ({
      ...current,
      steps: current.steps.map((candidate, currentIndex) => currentIndex === index ? next : candidate)
    }));
  }

  async function publish(): Promise<void> {
    if (!tool || !draft || issues.length > 0 || draft.steps.length === 0) return;
    setPublishing(true);
    setError(null);
    try {
      const published = await rpc.publishWorkflow({
        id: tool.id,
        basedOnVersion: draft.basedOnVersion,
        parameters: draft.parameters,
        steps: draft.steps,
        outputBinding: draft.outputBinding,
        outputSchema: draft.outputSchema,
        ...(draft.note ? { note: draft.note } : {})
      });
      if (published.kind !== "steps") throw new Error("published workflow changed kind");
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      await clearWorkflowDraft(tool.id);
      setTool(published);
      setDraft(null);
      setMessage(`已发布 v${published.activeVersion}`);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      setError(text);
      if (text.includes("workflow_version_conflict")) {
        try {
          const latest = await rpc.getTool(tool.id);
          if (latest?.kind === "steps") setTool(latest);
        } catch (refreshError) {
          setError(`${text} · 刷新版本历史失败: ${refreshError instanceof Error ? refreshError.message : String(refreshError)}`);
        }
        setState("conflict");
      }
    } finally {
      setPublishing(false);
    }
  }

  async function discard(): Promise<void> {
    if (!tool) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    await clearWorkflowDraft(tool.id);
    setDraft(createWorkflowDraft(tool));
    setSelectedStep(0);
    setState("default");
    setMessage("草稿已放弃");
  }

  async function activateVersion(version: number): Promise<void> {
    if (!tool || !draft) return;
    setActivatingVersion(version);
    setError(null);
    try {
      const activated = await rpc.activateWorkflow(tool.id, version);
      if (activated.kind !== "steps") throw new Error("activated workflow changed kind");
      setTool(activated);
      setMessage(`已启用 v${version}；版本历史未变化`);
      setState(draft.basedOnVersion === version ? "default" : "conflict");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setActivatingVersion(null);
    }
  }

  async function rebaseConflictDraft(): Promise<void> {
    if (!tool || !draft) return;
    const activeVersion = tool.activeVersion ?? Math.max(...tool.versions.map((version) => version.version));
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const rebased = { ...draft, basedOnVersion: activeVersion };
    await clearWorkflowDraft(tool.id);
    await saveWorkflowDraft(rebased);
    setDraft(rebased);
    setDiffLeft(String(activeVersion));
    setDiffRight("draft");
    setState("default");
    setMessage(`草稿已改以 v${activeVersion} 为发布基线；内容未自动合并`);
  }

  async function discardConflictDraft(): Promise<void> {
    if (!tool) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    await clearWorkflowDraft(tool.id);
    const fresh = createWorkflowDraft(tool);
    setDraft(fresh);
    setDiffLeft(String(fresh.basedOnVersion));
    setDiffRight("draft");
    setState("default");
    setMessage(`已放弃冲突草稿，使用 v${fresh.basedOnVersion}`);
  }

  async function executeWorkflowTest(inputs: Record<string, Json>): Promise<void> {
    if (!tool || !draft || capturedTabId.current == null) return;
    setPendingWorkflowTest(null);
    setTesting(true);
    setError(null);
    try {
      const run = await rpc.runDraft({
        kind: "steps",
        name: tool.name,
        description: tool.description,
        urlPatterns: tool.urlPatterns,
        parameters: draft.parameters,
        steps: draft.steps,
        outputBinding: draft.outputBinding,
        outputSchema: draft.outputSchema,
      }, capturedTabId.current, inputs);
      setTestRun(run);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTesting(false);
    }
  }

  async function testWorkflow(): Promise<void> {
    if (!tool || !draft || capturedTabId.current == null || issues.length > 0 || draft.steps.length === 0) return;
    try {
      const inputs = readRunInputs();
      const prepared = prepareWorkflowInputs(draft.parameters, inputs);
      const mode = getSessionFor(capturedTabId.current).permissionMode;
      const blocked = draft.steps
        .map((candidate) => workflowStepSeverity(candidate, prepared.bindings))
        .filter(({ toolName, severity }) =>
          !evaluateAutoApproval(toolName, severity, mode, settings.trustedDangerTools ?? [])
        );
      if (blocked.length > 0) {
        setPendingWorkflowTest({
          inputs,
          severity: highestToolSeverity(blocked.map(({ severity }) => severity)),
          toolNames: [...new Set(blocked.map(({ toolName }) => toolName))],
        });
        return;
      }
      await executeWorkflowTest(inputs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function readRunInputs(): Record<string, Json> {
    if (!draft) return {};
    const inputs: Record<string, Json> = {};
    for (const parameter of draft.parameters) {
      const raw = runInputs[parameter.key];
      if ((raw === "" || raw === undefined) && !parameter.required) continue;
      if (parameter.type === "boolean") {
        inputs[parameter.key] = raw === true || raw === "true";
      } else if (parameter.type === "number") {
        const value = Number(raw);
        if (!Number.isFinite(value)) throw new Error(`${parameter.label} 必须是数字`);
        inputs[parameter.key] = value;
      } else if (parameter.type === "json") {
        inputs[parameter.key] = JSON.parse(String(raw)) as Json;
      } else {
        inputs[parameter.key] = String(raw ?? "");
      }
    }
    return inputs;
  }

  async function executeStepTest(pending: PendingStepTest): Promise<void> {
    setStepTests((current) => ({
      ...current,
      [pending.index]: {
        status: "running",
        input: pending.input,
        sensitive: pending.sensitive,
      },
    }));
    try {
      const output = await rpc.runOneStep({
        step: pending.step,
        tabId: capturedTabId.current!,
        bindings: pending.bindings,
      });
      const candidate = draft?.steps[pending.index];
      if (candidate?.bindResultTo) {
        setTestBindings((current) => ({
          ...pending.bindings,
          ...current,
          [candidate.bindResultTo!]: output,
        }));
      } else {
        setTestBindings((current) => ({ ...pending.bindings, ...current }));
      }
      setStepTests((current) => ({
        ...current,
        [pending.index]: {
          status: "ok",
          input: pending.input,
          output,
          sensitive: pending.sensitive,
          ms: Date.now() - pending.startedAt,
        },
      }));
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      const failureKind = classifyStepFailure(text);
      setStepTests((current) => ({
        ...current,
        [pending.index]: {
          status: failureKind === "forbidden" ? "forbidden" : "error",
          input: pending.input,
          error: text,
          sensitive: pending.sensitive,
          failureKind,
          ms: Date.now() - pending.startedAt,
        },
      }));
    }
  }

  async function testOneStep(index: number): Promise<void> {
    if (!draft || capturedTabId.current == null) return;
    const candidate = draft.steps[index];
    if (!candidate) return;
    const startedAt = Date.now();
    setError(null);
    setPendingStepTest(null);
    try {
      const prepared = prepareWorkflowInputs(draft.parameters, readRunInputs());
      const bindings = { ...prepared.bindings, ...testBindings };
      if (candidate.kind === "tool") {
        const references = [...new Set(collectBindingReferences(candidate.args))];
        const missingBindings = references.filter((reference) => {
          try {
            resolveWorkflowValue(`\${${reference}}`, bindings);
            return false;
          } catch (reason) {
            const text = reason instanceof Error ? reason.message : String(reason);
            return (reason && typeof reason === "object" && (reason as { code?: string }).code === "binding_path_not_found") ||
              text.startsWith("binding_path_not_found: ");
          }
        });
        if (missingBindings.length > 0) {
          const producerIndexes = missingBindings
            .map((reference) => reference.split(".")[0])
            .map((root) => draft.steps.findIndex((item, producerIndex) =>
              producerIndex < index && item.bindResultTo === root
            ))
            .filter((producerIndex) => producerIndex >= 0);
          setStepTests((current) => ({
            ...current,
            [index]: {
              status: "blocked",
              missingBinding: missingBindings.join(", "),
              missingBindings,
              ...(producerIndexes.length > 0 ? { earliestStep: Math.min(...producerIndexes) } : {}),
              ms: Date.now() - startedAt,
            },
          }));
          return;
        }
      }
      const resolvedStep: Step = candidate.kind === "tool"
        ? { ...candidate, args: resolveWorkflowValue(candidate.args, bindings) }
        : candidate;
      const toolName = resolvedStep.kind === "tool" ? resolvedStep.tool : "runJS";
      const severityInput: Json = resolvedStep.kind === "tool"
        ? resolvedStep.args
        : { source: resolvedStep.source };
      const severity = classifyTool(toolName, severityInput);
      const analysis = analyzeWorkflow({
        parameters: draft.parameters,
        steps: draft.steps,
        outputBinding: draft.outputBinding,
      });
      const pending: PendingStepTest = {
        index,
        step: resolvedStep,
        bindings,
        severity,
        startedAt,
        input: resolvedStep.kind === "tool" ? resolvedStep.args : resolvedStep.source,
        sensitive: analysis.taintedStepIndexes.includes(index),
      };
      const mode = getSessionFor(capturedTabId.current).permissionMode;
      if (!evaluateAutoApproval(toolName, severity, mode, settings.trustedDangerTools ?? [])) {
        setPendingStepTest(pending);
        setStepTests((current) => ({
          ...current,
          [index]: {
            status: "awaiting",
            input: pending.input,
            sensitive: pending.sensitive,
          },
        }));
        return;
      }
      await executeStepTest(pending);
    } catch (reason) {
      const text = reason instanceof Error ? reason.message : String(reason);
      const bindingFailure = reason && typeof reason === "object"
        ? reason as { code?: string; path?: string }
        : null;
      const missingPath = bindingFailure?.code === "binding_path_not_found"
        ? bindingFailure.path
        : text.startsWith("binding_path_not_found: ")
          ? text.slice("binding_path_not_found: ".length)
          : undefined;
      if (missingPath) {
        const root = missingPath.split(".")[0];
        const producer = draft.steps.findIndex((item, producerIndex) =>
          producerIndex < index && item.bindResultTo === root
        );
        setStepTests((current) => ({
          ...current,
          [index]: {
            status: "blocked",
            missingBinding: missingPath,
            ...(producer >= 0 ? { earliestStep: producer } : {}),
            ms: Date.now() - startedAt,
          },
        }));
        return;
      }
      setStepTests((current) => ({
        ...current,
        [index]: { status: "error", error: text, ms: Date.now() - startedAt },
      }));
    }
  }

  async function decideStepTest(decision: "run" | "always" | "skip" | "deny"): Promise<void> {
    const pending = pendingStepTest;
    if (!pending) return;
    setPendingStepTest(null);
    if (decision === "skip" || decision === "deny") {
      setStepTests((current) => ({
        ...current,
        [pending.index]: { status: decision === "skip" ? "skipped" : "denied" },
      }));
      return;
    }
    if (decision === "always") {
      const toolName = pending.step.kind === "tool" ? pending.step.tool : "runJS";
      await settings.save({
        trustedDangerTools: Array.from(new Set([...(settings.trustedDangerTools ?? []), toolName])),
      });
    }
    await executeStepTest(pending);
  }

  async function repairStepWithAi(index: number): Promise<void> {
    if (!draft || capturedTabId.current == null || !onFixWithAi) return;
    const result = stepTests[index];
    const candidate = draft.steps[index];
    if (!result || !candidate) return;
    const snapshot = result.sensitive
      ? ({ redacted: "[已脱敏] 敏感步骤不采集页面 DOM" } as Json)
      : await rpc.runOneStep({
          step: { kind: "tool", tool: "snapshotDOM", args: {} },
          tabId: capturedTabId.current,
          bindings: {},
        }).catch((reason) => ({ snapshotError: reason instanceof Error ? reason.message : String(reason) } as Json));
    const safeFailure = result.sensitive ? "[已脱敏]" : result.error ?? "(未知错误)";
    const definition = boundedText(JSON.stringify({
      parameters: draft.parameters.map((parameter) => parameter.sensitive
        ? { ...parameter, defaultValue: undefined }
        : parameter),
      steps: draft.steps,
      outputBinding: draft.outputBinding,
    }, null, 2), 4_000);
    const domContext = boundedText(JSON.stringify(snapshot, null, 2), 4_000);
    onFixWithAi({
      tabId: capturedTabId.current,
      initialPrompt: `请修复草稿工作流的第 ${index + 1} 步。\n失败 step: ${JSON.stringify(candidate)}\n错误: ${safeFailure}\n请先给出修复方案，不要自动发布版本。`,
      initialContext: `# 当前草稿（有界）\n${definition}\n\n# 当前页面 DOM 快照（有界）\n${domContext}`,
    });
  }

  const title = tool ? `Workflow Studio · ${tool.name}` : "Workflow Studio";
  return (
    <Drawer
      open={isOpen}
      title={title}
      onClose={close}
      onBack={() => toolId ? open("tools", toolId) : open("tools")}
    >
      {state === "loading" ? <StudioState title="正在加载工作流…" /> : null}
      {state === "error" ? <StudioState title="无法打开 Workflow Studio" detail={error ?? undefined} /> : null}
      {state === "conflict" && tool && draft ? (
        <div className="space-y-3 p-3 text-xs text-zinc-200">
          <section className="rounded border border-amber-800 bg-amber-950/20 p-3">
            <h3 className="font-medium text-amber-200">冲突草稿已保留</h3>
            <p className="mt-1 text-zinc-400">草稿基于 v{draft.basedOnVersion}，当前启用 v{tool.activeVersion}。不会静默覆盖或自动合并。</p>
            {message ? <p className="mt-1 text-emerald-300">{message}</p> : null}
            {error ? <p role="alert" className="mt-1 text-red-300">{error}</p> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <button aria-label="以当前启用版本为新基线" className="rounded bg-amber-700 px-2 py-1" onClick={() => void rebaseConflictDraft()}>保留草稿内容，显式改以 v{tool.activeVersion} 为基线</button>
              <button aria-label="放弃冲突草稿" className="rounded bg-zinc-700 px-2 py-1" onClick={() => void discardConflictDraft()}>放弃草稿，使用当前版本</button>
            </div>
          </section>
          <VersionPanel
            tool={tool}
            draft={draft}
            diff={versionDiff}
            left={diffLeft}
            right={diffRight}
            onLeft={setDiffLeft}
            onRight={setDiffRight}
            activatingVersion={activatingVersion}
            onActivate={activateVersion}
          />
        </div>
      ) : null}
      {message && !draft ? (
        <StudioState title={message} detail="版本历史已追加，当前草稿缓存已清理。" />
      ) : null}
      {state === "default" && tool && draft ? (
        <div className="flex min-h-full flex-col bg-zinc-950 text-xs text-zinc-200">
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-zinc-950/95 px-3 py-2">
            <span className="text-zinc-400">当前启用 v{tool.activeVersion}</span>
            <span className="text-emerald-400">● 草稿自动保存到本机</span>
            <div className="ml-auto flex gap-2">
              <button className="rounded bg-zinc-800 px-2 py-1" onClick={() => void discard()}>放弃草稿</button>
              <button
                aria-label="发布工作流"
                className="rounded bg-emerald-700 px-2 py-1 disabled:opacity-40"
                disabled={publishing || issues.length > 0 || draft.steps.length === 0}
                onClick={() => void publish()}
              >
                {publishing ? "发布中…" : "保存为新版本"}
              </button>
            </div>
          </div>
          {error ? <div role="alert" className="border-b border-red-900 bg-red-950/30 px-3 py-2 text-red-300">{error}</div> : null}
          {message ? <div className="border-b border-emerald-900 bg-emerald-950/20 px-3 py-2 text-emerald-300">{message}</div> : null}

          <div className="grid flex-1 grid-cols-1 gap-3 p-3 xl:grid-cols-3">
            <div className="space-y-3">
              <Section title={`运行参数 (${draft.parameters.length})`} action={(
                <button
                  className="rounded bg-zinc-800 px-2 py-1"
                  onClick={() => updateDraft((current) => ({
                    ...current,
                    parameters: [...current.parameters, {
                      key: `param_${current.parameters.length + 1}`,
                      label: `参数 ${current.parameters.length + 1}`,
                      type: "string",
                      required: false
                    }]
                  }))}
                >＋ 参数</button>
              )}>
                <div className="space-y-2">
                  {draft.parameters.map((parameter, index) => (
                    <div key={index} className="rounded border border-zinc-800 bg-zinc-900 p-2">
                      <div className="grid grid-cols-[1fr_1fr_auto] gap-1">
                        <input
                          aria-label={`参数 key ${index + 1}`}
                          className="rounded bg-zinc-950 px-2 py-1 font-mono"
                          value={parameter.key}
                          onChange={(event) => updateParameter(index, { key: event.target.value })}
                        />
                        <input
                          aria-label={`参数 label ${index + 1}`}
                          className="rounded bg-zinc-950 px-2 py-1"
                          value={parameter.label}
                          onChange={(event) => updateParameter(index, { label: event.target.value })}
                        />
                        <button
                          aria-label={`删除参数 ${index + 1}`}
                          onClick={() => updateDraft((current) => ({
                            ...current,
                            parameters: current.parameters.filter((_, currentIndex) => currentIndex !== index)
                          }))}
                        >×</button>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-1">
                        <select
                          aria-label={`参数类型 ${index + 1}`}
                          className="rounded bg-zinc-950 px-2 py-1"
                          value={parameter.type}
                          onChange={(event) => updateParameter(index, {
                            type: event.target.value as ToolParameter["type"],
                            defaultValue: undefined
                          })}
                        >
                          <option value="string">string</option><option value="number">number</option>
                          <option value="boolean">boolean</option><option value="json">json</option>
                        </select>
                        <input
                          aria-label={`参数默认值 ${index + 1}`}
                          className="rounded bg-zinc-950 px-2 py-1"
                          disabled={!!parameter.sensitive}
                          placeholder={parameter.sensitive ? "敏感参数不保存默认值" : "默认值"}
                          value={parameter.defaultValue === undefined
                            ? ""
                            : parameter.type === "json"
                              ? JSON.stringify(parameter.defaultValue)
                              : String(parameter.defaultValue)}
                          onChange={(event) => updateParameter(index, {
                            defaultValue: parseDefault(parameter, event.target.value)
                          })}
                        />
                      </div>
                      <input
                        aria-label={`参数说明 ${index + 1}`}
                        className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
                        placeholder="说明"
                        value={parameter.description ?? ""}
                        onChange={(event) => updateParameter(index, { description: event.target.value })}
                      />
                      <div className="mt-2 flex gap-3 text-zinc-400">
                        <label><input aria-label={`参数必填 ${index + 1}`} type="checkbox" checked={parameter.required} onChange={(event) => updateParameter(index, { required: event.target.checked })} /> 必填</label>
                        <label><input aria-label={`参数敏感 ${index + 1}`} type="checkbox" checked={!!parameter.sensitive} onChange={(event) => updateParameter(index, { sensitive: event.target.checked })} /> 敏感</label>
                        <code className="ml-auto text-sky-300">${`{${parameter.key}}`}</code>
                      </div>
                    </div>
                  ))}
                  {draft.parameters.length === 0 ? <p className="text-zinc-500">无参数；legacy 工具可继续直接运行。</p> : null}
                </div>
              </Section>

              <Section title="试运行输入">
                <div className="space-y-2">
                  {draft.parameters.map((parameter) => (
                    <label key={parameter.key} className="block">
                      <span className="text-zinc-400">{parameter.label}{parameter.required ? " *" : ""}</span>
                      {parameter.type === "boolean" ? (
                        <select
                          aria-label={`试运行参数 ${parameter.key}`}
                          className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
                          value={String(runInputs[parameter.key] ?? false)}
                          onChange={(event) => setRunInputs((current) => ({ ...current, [parameter.key]: event.target.value === "true" }))}
                        ><option value="false">false</option><option value="true">true</option></select>
                      ) : (
                        <input
                          aria-label={`试运行参数 ${parameter.key}`}
                          type={parameter.sensitive ? "password" : "text"}
                          className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
                          value={String(runInputs[parameter.key] ?? "")}
                          onChange={(event) => setRunInputs((current) => ({ ...current, [parameter.key]: event.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                  <button
                    aria-label="测试完整工作流"
                    className="w-full rounded bg-sky-700 px-2 py-1 disabled:opacity-40"
                    disabled={testing || capturedTabId.current == null || issues.length > 0 || draft.steps.length === 0}
                    onClick={() => void testWorkflow()}
                  >{testing ? "测试中…" : `测试完整工作流${capturedTabId.current == null ? "（无可用 tab）" : ` · tab #${capturedTabId.current}`}`}</button>
                  {pendingWorkflowTest ? (
                    <div className="rounded border border-red-900 bg-red-950/30 p-2">
                      <div className="text-red-300">
                        完整工作流包含{pendingWorkflowTest.severity === "dangerous" ? "危险" : "需确认"}操作：{pendingWorkflowTest.toolNames.join("、")}
                      </div>
                      <p className="mt-1 text-zinc-400">批准后才会在固定 tab 上执行完整草稿。</p>
                      <div className="mt-2 flex gap-1">
                        <button
                          aria-label="批准完整工作流"
                          className="rounded bg-emerald-700 px-2 py-1"
                          onClick={() => void executeWorkflowTest(pendingWorkflowTest.inputs)}
                        >批准并运行</button>
                        <button
                          aria-label="拒绝完整工作流"
                          className="rounded bg-red-800 px-2 py-1"
                          onClick={() => setPendingWorkflowTest(null)}
                        >拒绝</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Section>

              <Section title="输出定义">
                <label className="block text-zinc-400">最终输出</label>
                <select
                  aria-label="最终输出 binding"
                  className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
                  value={draft.outputBinding ?? ""}
                  onChange={(event) => updateDraft((current) => ({
                    ...current,
                    outputBinding: event.target.value || undefined
                  }))}
                >
                  <option value="">最后一步</option>
                  {bindings.map((binding) => <option key={binding} value={binding}>{binding}</option>)}
                </select>
                <textarea
                  aria-label="输出 schema JSON"
                  className="mt-2 min-h-28 w-full rounded bg-zinc-950 p-2 font-mono text-[11px]"
                  value={displayJson(draft.outputSchema)}
                  onChange={(event) => {
                    try {
                      const outputSchema = JSON.parse(event.target.value) as Json;
                      setJsonError(null);
                      updateDraft((current) => ({ ...current, outputSchema }));
                    } catch {
                      setJsonError("输出 schema JSON 无效");
                    }
                  }}
                />
                {testRun ? (
                  <div className="mt-2 rounded bg-zinc-950 p-2">
                    <div className={testRun.status === "ok" ? "text-emerald-400" : "text-red-400"}>测试 {testRun.status}</div>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-zinc-300">
                      {boundedPreview(testRun.output)}
                    </pre>
                  </div>
                ) : <p className="mt-1 text-zinc-500">样例预览将在完整测试后显示；页面结果不会写入草稿。</p>}
              </Section>
            </div>

            <div className="space-y-3">
              <Section title={`步骤 (${draft.steps.length})`} action={(
                <div className="flex gap-1">
                  <button className="rounded bg-zinc-800 px-2 py-1" onClick={() => {
                    updateDraft((current) => addWorkflowStep(current, { kind: "tool", tool: "snapshotDOM", args: {} }));
                    setSelectedStep(draft.steps.length);
                  }}>＋ Tool</button>
                  <button className="rounded bg-zinc-800 px-2 py-1" onClick={() => {
                    updateDraft((current) => addWorkflowStep(current, { kind: "js", source: "return null" }));
                    setSelectedStep(draft.steps.length);
                  }}>＋ runJS</button>
                </div>
              )}>
                {draft.steps.length === 0 ? (
                  <div className="rounded border border-dashed border-zinc-700 p-6 text-center text-zinc-400">这个工具还没有工作流步骤</div>
                ) : (
                  <ol className="space-y-2">
                    {draft.steps.map((candidate, index) => (
                      <li
                        key={index}
                        data-testid="workflow-step-row"
                        draggable
                        onDragStart={() => setDraggedStep(index)}
                        onDragOver={(event) => event.preventDefault()}
                        onDrop={() => {
                          if (draggedStep == null) return;
                          updateDraft((current) => reorderWorkflowStep(current, draggedStep, index));
                          setSelectedStep(index);
                          setDraggedStep(null);
                        }}
                        className={`rounded border p-2 ${selectedStep === index ? "border-sky-600 bg-sky-950/20" : "border-zinc-800 bg-zinc-900"}`}
                      >
                        <button className="w-full text-left" onClick={() => setSelectedStep(index)}>
                          <span className="text-zinc-500">#{index + 1}</span>{" "}
                          <span>{candidate.kind === "tool" ? candidate.tool : "runJS"}</span>{" "}
                          {candidate.bindResultTo ? <code className="text-sky-300">→ {candidate.bindResultTo}</code> : null}
                        </button>
                        <div className="mt-2 flex gap-1">
                          <button
                            aria-label={`测试步骤 ${index + 1}`}
                            disabled={stepTests[index]?.status === "running" || capturedTabId.current == null}
                            onClick={() => void testOneStep(index)}
                          >测试</button>
                          <button aria-label={`上移步骤 ${index + 1}`} onClick={() => { updateDraft((current) => moveWorkflowStep(current, index, -1)); setSelectedStep(Math.max(0, index - 1)); }}>↑</button>
                          <button aria-label={`下移步骤 ${index + 1}`} onClick={() => { updateDraft((current) => moveWorkflowStep(current, index, 1)); setSelectedStep(Math.min(draft.steps.length - 1, index + 1)); }}>↓</button>
                          <button aria-label={`复制步骤 ${index + 1}`} onClick={() => { updateDraft((current) => duplicateWorkflowStep(current, index)); setSelectedStep(index + 1); }}>⧉</button>
                          <button aria-label={`删除步骤 ${index + 1}`} className="ml-auto text-red-400" onClick={() => { updateDraft((current) => deleteWorkflowStep(current, index)); setSelectedStep(Math.max(0, index - 1)); }}>删除</button>
                        </div>
                        {stepTests[index] ? (
                          <div className="mt-2 rounded bg-zinc-950 p-2 text-[10px]">
                            <div className={stepTests[index].status === "ok" ? "text-emerald-400" : stepTests[index].status === "error" || stepTests[index].status === "forbidden" ? "text-red-400" : stepTests[index].status === "blocked" ? "text-amber-300" : "text-sky-300"}>
                              {stepTests[index].status === "awaiting"
                                ? "危险操作需要确认"
                                : stepTests[index].status === "running"
                                ? "正在测试…"
                                : stepTests[index].status === "ok"
                                  ? `测试成功 · ${stepTests[index].ms ?? 0}ms`
                                  : stepTests[index].status === "blocked"
                                    ? `缺少上游 binding: ${stepTests[index].missingBinding}`
                                    : stepTests[index].status === "skipped"
                                      ? "已跳过，未执行页面操作"
                                      : stepTests[index].status === "denied"
                                        ? "已拒绝，未执行页面操作"
                                      : stepTests[index].status === "forbidden"
                                        ? "页面受限 · 无法注入或站点权限不足"
                                      : stepTests[index].failureKind === "tab_closed"
                                        ? "Tab 已关闭"
                                  : `测试失败 · ${stepTests[index].ms ?? 0}ms`}
                            </div>
                            {pendingStepTest?.index === index ? (
                              <div className="mt-2 rounded border border-red-900 bg-red-950/30 p-2">
                                <div className="text-red-300">{pendingStepTest.severity}</div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                  <button aria-label={`批准步骤 ${index + 1}`} className="rounded bg-emerald-700 px-2 py-1" onClick={() => void decideStepTest("run")}>批准并运行</button>
                                  <button aria-label={`始终允许步骤 ${index + 1}`} className="rounded bg-emerald-800 px-2 py-1" onClick={() => void decideStepTest("always")}>允许并始终通过</button>
                                  <button aria-label={`跳过步骤 ${index + 1}`} className="rounded bg-zinc-700 px-2 py-1" onClick={() => void decideStepTest("skip")}>跳过</button>
                                  <button aria-label={`拒绝步骤 ${index + 1}`} className="rounded bg-red-800 px-2 py-1" onClick={() => void decideStepTest("deny")}>拒绝</button>
                                </div>
                              </div>
                            ) : null}
                            {stepTests[index].input !== undefined && stepTests[index].status !== "awaiting" ? (
                              <pre className="mt-1 whitespace-pre-wrap break-all text-zinc-300">输入：{stepTests[index].sensitive ? "[已脱敏]" : boundedPreview(stepTests[index].input as Json)}</pre>
                            ) : null}
                            {stepTests[index].status === "ok" ? <pre className="mt-1 whitespace-pre-wrap break-all">输出：{stepTests[index].sensitive ? "[已脱敏]" : boundedPreview(stepTests[index].output)}</pre> : null}
                            {stepTests[index].status === "error" || stepTests[index].status === "forbidden" ? <div className="mt-1 break-all text-red-300">错误：{stepTests[index].sensitive ? "[已脱敏]" : stepTests[index].error}</div> : null}
                            {stepTests[index].status === "error" || stepTests[index].status === "forbidden" ? (
                              <div className="mt-2 flex flex-wrap gap-1">
                                <button aria-label={`重新圈选步骤 ${index + 1}`} className="rounded bg-zinc-700 px-2 py-1" onClick={() => capturedTabId.current == null ? undefined : void rpc.startElementCapture(capturedTabId.current)}>重新圈选</button>
                                {onFixWithAi ? <button aria-label={`让 AI 修复步骤 ${index + 1}`} className="rounded bg-amber-700 px-2 py-1" onClick={() => void repairStepWithAi(index)}>让 AI 修复</button> : null}
                              </div>
                            ) : null}
                            {stepTests[index].status === "blocked" && stepTests[index].earliestStep !== undefined ? (
                              <button
                                className="mt-1 rounded bg-amber-800 px-2 py-1"
                                onClick={() => {
                                  setSelectedStep(stepTests[index].earliestStep!);
                                  void testOneStep(stepTests[index].earliestStep!);
                                }}
                              >最早需要测试步骤 {stepTests[index].earliestStep! + 1} · 从这里开始逐步测试</button>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                )}
              </Section>

              <Section title="依赖检查">
                {issues.length === 0 && !jsonError ? <p className="text-emerald-400">✓ 参数、步骤变量与输出引用通过</p> : (
                  <ul className="space-y-1 text-amber-300">
                    {issues.map((issue, index) => <li key={index}>{issue.code}{"stepIndex" in issue && issue.stepIndex !== undefined ? ` · step ${issue.stepIndex + 1}` : ""}</li>)}
                    {jsonError ? <li>{jsonError}</li> : null}
                  </ul>
                )}
              </Section>
              {draft.steps.length > 50 ? <div className="rounded border border-amber-800 bg-amber-950/20 p-3 text-amber-200">大型工作流 · 默认只展开当前步骤（{draft.steps.length} steps）</div> : null}
            </div>

            <div className="space-y-3">
              <VersionPanel
                tool={tool}
                draft={draft}
                diff={versionDiff}
                left={diffLeft}
                right={diffRight}
                onLeft={setDiffLeft}
                onRight={setDiffRight}
                activatingVersion={activatingVersion}
                onActivate={activateVersion}
              />
              <Section title={step ? `编辑步骤 ${selectedStep + 1}` : "步骤编辑"}>
                {step ? (
                  <StepEditor
                    step={step}
                    index={selectedStep}
                    onChange={(next) => updateStep(selectedStep, next)}
                    onEditCollection={onEditCollection
                      ? (input) => onEditCollection({ ...input, toolId: tool.id })
                      : undefined}
                  />
                ) : <p className="text-zinc-500">先添加一个步骤。</p>}
              </Section>
              <Section title="发布说明">
                <textarea
                  aria-label="版本说明"
                  className="min-h-20 w-full rounded bg-zinc-950 p-2"
                  placeholder="这次调整了什么"
                  value={draft.note ?? ""}
                  onChange={(event) => updateDraft((current) => ({ ...current, note: event.target.value }))}
                />
                <p className="mt-2 text-zinc-500">发布会追加不可变新版本并自动启用，不改写历史。</p>
              </Section>
            </div>
          </div>
        </div>
      ) : null}
    </Drawer>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex items-center gap-2"><h3 className="font-medium text-zinc-100">{title}</h3><div className="ml-auto">{action}</div></div>
      {children}
    </section>
  );
}

function StudioState({ title, detail }: { title: string; detail?: string }) {
  return <div className="grid min-h-[420px] place-content-center p-6 text-center"><h3 className="text-base">{title}</h3>{detail ? <p className="mt-2 max-w-lg text-zinc-400">{detail}</p> : null}</div>;
}

function VersionPanel({
  tool,
  draft,
  diff,
  left,
  right,
  onLeft,
  onRight,
  activatingVersion,
  onActivate,
}: {
  tool: StepsTool;
  draft: WorkflowDraft;
  diff: WorkflowDefinitionDiff | null;
  left: string;
  right: string;
  onLeft: (value: string) => void;
  onRight: (value: string) => void;
  activatingVersion: number | null;
  onActivate: (version: number) => Promise<void>;
}) {
  const versions = [...tool.versions].sort((a, b) => a.version - b.version);
  const noChanges = !!diff &&
    diff.parameters.length === 0 &&
    diff.steps.length === 0 &&
    diff.output.kind === "unchanged";
  return (
    <Section title="版本比较与启用">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label><span className="text-zinc-400">左侧</span><select aria-label="差异左侧版本" className="mt-1 w-full rounded bg-zinc-950 px-2 py-1" value={left} onChange={(event) => onLeft(event.target.value)}>
          {versions.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
          <option value="draft">当前草稿</option>
        </select></label>
        <label><span className="text-zinc-400">右侧</span><select aria-label="差异右侧版本" className="mt-1 w-full rounded bg-zinc-950 px-2 py-1" value={right} onChange={(event) => onRight(event.target.value)}>
          {versions.map((version) => <option key={version.version} value={version.version}>v{version.version}</option>)}
          <option value="draft">当前草稿（基于 v{draft.basedOnVersion}）</option>
        </select></label>
      </div>
      <div className="mt-3 flex flex-wrap gap-1">
        {versions.map((version) => (
          <button
            key={version.version}
            aria-label={`启用版本 ${version.version}`}
            className={`rounded px-2 py-1 ${tool.activeVersion === version.version ? "bg-emerald-800" : "bg-zinc-800"}`}
            disabled={tool.activeVersion === version.version || activatingVersion !== null}
            onClick={() => void onActivate(version.version)}
          >v{version.version}{tool.activeVersion === version.version ? " · 已启用" : " · 启用"}</button>
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {!diff ? <p className="text-red-300">所选版本不存在，请重新选择。</p> : null}
        {noChanges ? <p className="text-zinc-500">无结构变化</p> : null}
        {diff?.parameters.map((change) => (
          <DiffJson key={`parameter-${change.kind}-${change.key}`} label={`参数 ${change.kind}: ${change.key}`} value={{ before: change.before ?? null, after: change.after ?? null }} />
        ))}
        {diff?.steps.map((change, index) => {
          const from = change.fromIndex === undefined ? "-" : `#${change.fromIndex + 1}`;
          const to = change.toIndex === undefined ? "-" : `#${change.toIndex + 1}`;
          return <DiffJson key={`step-${change.kind}-${index}`} label={`步骤 ${change.kind}: ${from} → ${to}`} value={{ before: change.before ?? null, after: change.after ?? null }} />;
        })}
        {diff?.output.kind === "modified" ? <DiffJson label="输出 modified" value={{ before: diff.output.before, after: diff.output.after }} /> : null}
      </div>
    </Section>
  );
}

function DiffJson({ label, value }: { label: string; value: Json }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <details className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
      <summary className="cursor-pointer text-zinc-300">{label}{text.length > 4_000 ? ` · 大 JSON ${text.length} chars` : ""}</summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10px] text-zinc-400">{text}</pre>
    </details>
  );
}

function StepEditor({
  step,
  index,
  onChange,
  onEditCollection,
}: {
  step: Step;
  index: number;
  onChange: (step: Step) => void;
  onEditCollection?: (input: { recipe: Json; apply: (recipe: Json) => void }) => void;
}) {
  const [argsText, setArgsText] = useState(step.kind === "tool" ? displayJson(step.args) : "");
  const [argsError, setArgsError] = useState<string | null>(null);
  useEffect(() => {
    if (step.kind === "tool") setArgsText(displayJson(step.args));
  }, [index, step]);

  if (step.kind === "js") {
    const findings = runStaticScan(step.source);
    const severity = findings.some((finding) => finding.severity === "dangerous")
      ? "dangerous"
      : findings.some((finding) => finding.severity === "caution") ? "caution" : "safe";
    return (
      <div className="space-y-2">
        <div className="text-zinc-400">runJS · 静态扫描 <span className={severity === "dangerous" ? "text-red-400" : severity === "caution" ? "text-amber-300" : "text-emerald-400"}>{severity}</span></div>
        <textarea aria-label="runJS source" className="min-h-48 w-full rounded bg-zinc-950 p-2 font-mono" value={step.source} onChange={(event) => onChange({ ...step, source: event.target.value })} />
        {findings.map((finding, findingIndex) => <div key={findingIndex} className="text-amber-300">{finding.rule}: {finding.message}</div>)}
        <CommonStepFields step={step} onChange={onChange} />
      </div>
    );
  }

  const descriptor = simpleFields(step.tool);
  const args = asObject(step.args);
  if (step.tool === "collectStructuredData") {
    const recipe = args.recipe ?? {};
    return (
      <div className="space-y-2">
        <div className="rounded bg-zinc-950 p-2 text-zinc-400">Recipe：{typeof recipe === "object" && recipe !== null && !Array.isArray(recipe) ? Object.keys(recipe).join(" · ") : "未配置"}</div>
        <button className="rounded bg-sky-700 px-2 py-1" onClick={() => onEditCollection?.({
          recipe,
          apply: (nextRecipe) => onChange({ ...step, args: { ...args, recipe: nextRecipe } })
        })}>在 Collect Studio 编辑</button>
        <CommonStepFields step={step} onChange={onChange} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <label className="block text-zinc-400">工具</label>
      <select
        aria-label="步骤工具"
        className="w-full rounded bg-zinc-950 px-2 py-1"
        value={step.tool}
        onChange={(event) => onChange({ ...step, tool: event.target.value as typeof step.tool, args: {} })}
      >
        {REPLAYABLE_TOOL_NAMES.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      {descriptor.fields.map((field) => (
        <label key={field.key} className="block">
          <span className="text-zinc-400">{field.key}{field.required ? " *" : ""}</span>
          {field.values ? (
            <select
              aria-label={`步骤参数 ${field.key}`}
              className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
              value={String(args[field.key] ?? "")}
              onChange={(event) => onChange({ ...step, args: { ...args, [field.key]: event.target.value } })}
            >
              <option value="">—</option>
              {field.values.map((value) => <option key={String(value)} value={String(value)}>{String(value)}</option>)}
            </select>
          ) : field.type === "boolean" ? (
            <select
              aria-label={`步骤参数 ${field.key}`}
              className="mt-1 w-full rounded bg-zinc-950 px-2 py-1"
              value={String(args[field.key] ?? "")}
              onChange={(event) => onChange({ ...step, args: { ...args, [field.key]: event.target.value === "true" } })}
            ><option value="">—</option><option value="true">true</option><option value="false">false</option></select>
          ) : (
            <input
              aria-label={`步骤参数 ${field.key}`}
              className="mt-1 w-full rounded bg-zinc-950 px-2 py-1 font-mono"
              value={typeof args[field.key] === "string" || typeof args[field.key] === "number" ? String(args[field.key]) : ""}
              onChange={(event) => {
                const raw = event.target.value;
                const value: Json = (field.type === "number" || field.type === "integer") && !raw.includes("${") && raw !== ""
                  ? Number(raw)
                  : raw;
                onChange({ ...step, args: { ...args, [field.key]: value } });
              }}
            />
          )}
        </label>
      ))}
      {descriptor.hasComplex ? <p className="text-zinc-500">复杂 object/array 字段请使用 JSON 高级编辑。</p> : null}
      <label className="block text-zinc-400">Args JSON（高级）</label>
      <textarea
        aria-label="步骤 args JSON"
        className="min-h-36 w-full rounded bg-zinc-950 p-2 font-mono"
        value={argsText}
        onChange={(event) => {
          setArgsText(event.target.value);
          try {
            const args = JSON.parse(event.target.value) as Json;
            setArgsError(null);
            onChange({ ...step, args });
          } catch {
            setArgsError("Args JSON 无效");
          }
        }}
      />
      {argsError ? <p className="text-red-400">{argsError}</p> : null}
      <CommonStepFields step={step} onChange={onChange} />
    </div>
  );
}

function CommonStepFields({ step, onChange }: { step: Step; onChange: (step: Step) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <label><span className="text-zinc-400">超时 ms</span><input aria-label="步骤 timeout" className="mt-1 w-full rounded bg-zinc-950 px-2 py-1" type="number" value={step.timeoutMs ?? ""} onChange={(event) => onChange({ ...step, timeoutMs: event.target.value ? Number(event.target.value) : undefined })} /></label>
      <label><span className="text-zinc-400">绑定结果为</span><input aria-label="步骤输出 binding" className="mt-1 w-full rounded bg-zinc-950 px-2 py-1 font-mono" value={step.bindResultTo ?? ""} onChange={(event) => onChange({ ...step, bindResultTo: event.target.value || undefined })} /></label>
    </div>
  );
}
