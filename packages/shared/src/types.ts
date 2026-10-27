export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [k: string]: Json };

export type JsonSchema = Json;

export type BuiltinTool =
  | "snapshotDOM"
  | "querySelector"
  | "querySelectorAll"
  | "extractImages"
  | "extractText"
  | "scroll"
  | "waitFor"
  | "click"
  | "httpRequest"
  | "readStorage"
  // Plan 3 additions
  | "fillInput"
  | "setCheckbox"
  | "selectOption"
  | "submitForm"
  | "hover"
  | "focus"
  | "uploadFile"
  | "getValue"
  | "extractFormState"
  | "askUser"
  | "screenshot"
  // Round 5 Tier 3 — control-plane helpers
  | "closeTab"
  | "switchToTab"
  | "searchBookmarks"
  | "searchHistory"
  | "downloadImage"
  | "downloadSpreadsheet"
  // Round 5 Tier 4 — UID-based + visual + batch
  | "takeSnapshot"
  | "clickByUid"
  | "fillByUid"
  | "highlightElement"
  | "highlightText"
  | "fillForm"
  // Round 6 — common helpers
  | "navigate"
  | "getPageInfo"
  | "pressKey"
  | "writeStorage"
  | "createPageIndex"
  | "searchPageIndex"
  | "readPageBlock"
  | "extractPageFields"
  // P1 Collect Studio — replay a validated local extraction recipe
  | "collectStructuredData"
  // Plan 32 — playwright parity
  | "consoleMessages"
  | "networkRequests"
  | "networkRequestDetail"
  | "handleDialog"
  | "recorderConfig"
  | "navigateBack"
  | "navigateForward"
  | "resize"
  | "drag"
  | "drop"
  | "findElements"
  | "inspectElement";

/** BuiltinTool minus tools that can't be replayed offline:
 *  - askUser / screenshot — sidepanel-only
 *  - takeSnapshot / clickByUid / fillByUid — depend on live snapshot UIDs
 *  - highlightElement / highlightText — purely visual feedback
 *  - searchBookmarks / searchHistory — query-time meta lookups
 *  - downloadSpreadsheet — sidepanel-only generated download
 *  - recorder tools — read or mutate per-session recorder state, which has no
 *    meaning outside the live session that armed it */
export type ReplayableTool = Exclude<
  BuiltinTool,
  | "askUser"
  | "consoleMessages"
  | "networkRequests"
  | "networkRequestDetail"
  | "handleDialog"
  | "recorderConfig"
  | "screenshot"
  | "takeSnapshot"
  | "clickByUid"
  | "fillByUid"
  | "highlightElement"
  | "highlightText"
  | "searchBookmarks"
  | "searchHistory"
  | "downloadSpreadsheet"
>;

export type Step =
  | { kind: "tool"; tool: ReplayableTool; args: Json; bindResultTo?: string; timeoutMs?: number }
  | { kind: "js"; source: string; bindResultTo?: string; timeoutMs?: number };

export type ToolParameterType = "string" | "number" | "boolean" | "json";

export type ToolParameter = {
  key: string;
  label: string;
  type: ToolParameterType;
  required: boolean;
  description?: string;
  defaultValue?: Json;
  sensitive?: boolean;
};

export type StepsToolVersion = {
  version: number;
  kind: "steps";
  parameters: ToolParameter[];
  steps: Step[];
  outputBinding?: string;
  outputSchema: JsonSchema;
  createdAt: number;
  note?: string;
  basedOnVersion?: number;
};

export type PromptToolVersion = {
  version: number;
  kind: "prompt";
  prompt: string;
  createdAt: number;
  note?: string;
};

export type ToolVersion = StepsToolVersion | PromptToolVersion;

export type ToolStats = { runs: number; lastRunAt?: number; lastRunOk?: boolean };

export type ToolOrigin = {
  kind: "preset";
  presetId: string;
  presetVersion: number;
};

export type StepsTool = {
  kind: "steps";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  activeVersion: number;
  createdAt: number;
  updatedAt: number;
  versions: StepsToolVersion[];
  stats: ToolStats;
  origin?: ToolOrigin;
};

export type PromptTool = {
  kind: "prompt";
  id: string;
  name: string;
  urlPatterns: string[];
  description: string;
  prompt: string;
  createdAt: number;
  updatedAt: number;
  versions: PromptToolVersion[];
  stats: ToolStats;
  origin?: ToolOrigin;
};

export type Tool = StepsTool | PromptTool;

export type StepsToolDraft = {
  kind: "steps";
  name: string;
  urlPatterns: string[];
  description: string;
  parameters?: ToolParameter[];
  steps: Step[];
  outputBinding?: string;
  outputSchema: JsonSchema;
};

export type PromptToolDraft = {
  kind: "prompt";
  name: string;
  urlPatterns: string[];
  description: string;
  prompt: string;
};

export type ToolDraft = StepsToolDraft | PromptToolDraft;

export type RedactedValue = { __redacted: true };

export type RunStepLogEntry = {
  stepIndex: number;
  input: Json;
  output: Json;
  ms: number;
  error?: string | RedactedValue;
};

export type RunStatus = "pending-approval" | "running" | "ok" | "error" | "aborted";

export type RunSource = "user" | "coordinator" | "job";

export type RunRecord = {
  id: string;
  toolId: string | null;
  toolVersion: number | null;
  url: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  stepLog: RunStepLogEntry[];
  output?: Json;
  source: RunSource;
  collection?: {
    resultId: string;
    tabId: number;
    sourceUrl: string;
  };
  healed?: {
    fromVersion: number;
    toVersion: number;
    fixedStepIndex: number;
  };
};

export type ExportBundle = {
  schema: "aipagego.tools/v3";
  exportedAt: number;
  tools: Tool[];
};

// === Plan 2 additions ===

export type TextPart = { type: "text"; text: string };

/** Inline image attached to a user message (multimodal input). `data` is
 *  base64-encoded bytes WITHOUT a `data:` prefix. */
export type ImagePart = {
  type: "image";
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  data: string;
};
export type ToolUsePart = { type: "tool_use"; id: string; name: string; input: Json };
export type ToolResultPart = {
  type: "tool_result";
  tool_use_id: string;
  /** String for plain results; array for results carrying image blocks (e.g. screenshot). */
  content: string | Array<TextPart | ImagePart>;
  is_error?: boolean;
};

export type ChatMessage =
  | { role: "user"; content: string | Array<TextPart | ImagePart | ToolResultPart> }
  | { role: "assistant"; content: Array<TextPart | ToolUsePart> };

export type Severity = "info" | "caution" | "dangerous";

export type ScanFinding = {
  rule: string;
  severity: Severity;
  message: string;
  matches: { line: number; col: number; text: string }[];
};

export type LlmProvider = "anthropic" | "openai";

export type ContextPolicy = "auto" | "conservative" | "large" | "huge" | "custom";

export type InjectionMode = "disabled" | "read" | "operate" | "diagnostic";

export type SiteInjectionRule = {
  pattern: string;
  injectionMode: "inherit" | InjectionMode;
  assistant: "inherit" | "enabled" | "disabled";
};

export type LlmSettings = {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  apiKeyMode: "persistent" | "session";
  maxRounds: number;
  /** 自定义 base URL，留空 = 用 provider 默认值。例如 "https://api.openai.com/v1" */
  endpoint?: string;
  /** dangerous 工具白名单，在 permissionMode === "trust" 时被消费。 */
  trustedDangerTools: string[];
  /** 新会话启动时使用的默认权限模式。 */
  defaultPermissionMode: "read" | "default" | "trust" | "yolo";
  /** UI 主题（light / dark / system）。 */
  theme: "light" | "dark" | "system";
  /** 单次 LLM 响应的 max_tokens；留空 = 用 provider 默认（4096） */
  maxTokens?: number;
  /**
   * 当模型某轮不调用任何工具（疑似提前收尾）时，最多连续追问几次让它确认/继续。
   * 模型只要再执行一次工具（取得进展），该计数就清零。留空 = 默认 1。0 = 关闭（旧行为：纯文本即结束）。
   */
  maxContinuationNudges?: number;
  /**
   * 提示词优化按钮用哪个模型。留空 = 用 `model`（对话模型）。
   * 复用同一份 provider / apiKey / endpoint。
   */
  optimizerModel?: string;
  /**
   * 聊天视图默认模式。
   * - `"compact"`：简洁模式（一行进展提示，默认）
   * - `"full"`：详细模式（完整 StepCard 展开）
   * 每次新会话时从这里初始化 `session.chatMode`；Header 图标可 session-scoped 覆盖，不写回。
   */
  defaultChatMode?: "compact" | "full";
  /** 是否启用 step 失败后的自愈功能。默认 true。 */
  selfHealEnabled: boolean;
  /** 自愈 LLM 调用的 max_tokens 上限。默认 4096。 */
  maxSelfHealOutputTokens: number;
  /** 未命中站点规则时使用的注入能力。 */
  defaultInjectionMode: InjectionMode;
  /** 未命中站点规则时是否显示网页助手。 */
  defaultAssistantEnabled: boolean;
  /** 按 hostname 覆盖默认注入与助手策略，后写的同级规则优先。 */
  siteInjectionRules: SiteInjectionRule[];
  /** 会话历史进入模型前的上下文压缩策略。默认 auto。 */
  contextPolicy?: ContextPolicy;
  /** contextPolicy=custom 时的压缩触发阈值，按序列化字符数估算。 */
  contextSoftCharBudget?: number;
  /** contextPolicy=custom 时保留最近多少条消息原文。 */
  contextRecentMessageLimit?: number;
  /** contextPolicy=custom 时 `[上下文记忆]` 的字符上限。 */
  contextMemoryCharLimit?: number;
};

// === 原始 LLM 交互日志（see specs/2026-05-23-raw-llm-exchange-log-design.md）===

export type LlmExchangeRequest = {
  provider: LlmProvider;
  model: string;
  endpoint?: string;
  maxTokens?: number;
  system: string;
  messages: ChatMessage[]; // 完整上下文，单块内容按上限截断
  toolNames: string[];
};

export type LlmExchangeResponse = {
  text: string;
  toolUses: { id: string; name: string; input: Json }[];
  usage?: { input_tokens: number; output_tokens: number };
  stopReason?: string;
  error?: string;
  aborted?: boolean;
};

export type LlmExchange = {
  id: string;
  round: number;
  kind: "main" | "tool-draft";
  startedAt: number;
  durationMs: number;
  request: LlmExchangeRequest;
  response: LlmExchangeResponse;
};

export type AttachedTabSource = "mention" | "ai-open" | "approval";

export type AttachedTab = {
  tabId: number;
  windowId: number;
  source: AttachedTabSource;
  addedAt: number;
  lastSeenUrl: string;
  lastSeenTitle: string;
  urlChanged?: boolean;
};

// === Persistence (see specs/2026-05-19-sidepanel-session-persistence-design.md) ===

export type PersistedCard = {
  toolUseId: string;
  name: string;
  input: Json;
  partialJson: string;
  inputReady: boolean;
  status: "draft" | "awaiting" | "running" | "ok" | "error" | "skipped" | "denied";
  output?: Json;
  error?: string;
  ms?: number;
};

export type PersistedSessionData = {
  messages: ChatMessage[];
  cards: PersistedCard[];
  executedSteps: Step[];
  tokenUsage: { input: number; output: number };
  roundCount: number;
  attachedTabs: AttachedTab[];
  url: string;
  runRecordId: string | null;
  errorMessage: string | null;
  /** 自 2026-05-23 起新增；旧持久化记录可能没有，读时默认 []。 */
  llmExchanges?: LlmExchange[];
};

export type PersistedSession = {
  id: string;
  url: string;
  lastTabId: number;
  status: "active" | "archived";
  data: PersistedSessionData;
  createdAt: number;
  updatedAt: number;
};
