import type { JsonSchema } from "@aipagego/shared/types";

export type ControlTool = { name: string; description: string; inputSchema: JsonSchema };

export const CONTROL_TOOLS: ControlTool[] = [
  {
    name: "browser_start",
    description:
      "Primary entry point for a live web page in the user's existing Chrome: localhost, screenshots/UI smoke, authenticated interaction, or console/network debugging. Pairs if needed and returns a ready session or tab candidates.",
    inputSchema: {
      type: "object",
      properties: {
        tab_id: { type: "string", description: "Exact id from browser_start/list_tabs" },
        url: { type: "string", description: "Exact URL of an open tab" },
        capabilities: { type: "array", items: { type: "string" }, description: "Optional capability scope" },
        idle_timeout_min: { type: "number", description: "Optional idle timeout in minutes" }
      },
      additionalProperties: false
    } as JsonSchema
  },
  {
    name: "pairing_status",
    description: "Start or check browser pairing without waiting. Returns connected or pairing_required with the pair URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as JsonSchema
  },
  {
    name: "list_tabs",
    description: "List browser tabs. On first use, opens the pairing page and waits up to 45 seconds for authorization, normally returning connected tabs in the same call. Returns pairing_required with the URL only on timeout.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as JsonSchema
  },
  {
    name: "open_session",
    description: "Open a session for a tab from list_tabs. Returns immediately with PAIRING_REQUIRED if the browser is not connected.",
    inputSchema: {
      type: "object",
      required: ["tab_id"],
      properties: {
        tab_id: { type: "string", description: "list_tabs 返回的 tab_id" },
        capabilities: { type: "array", items: { type: "string" }, description: "能力域白名单；省略=全部" },
        idle_timeout_min: { type: "number", description: "覆盖默认空闲超时（分钟）" }
      },
      additionalProperties: false
    } as JsonSchema
  },
  {
    name: "close_session",
    description: "关闭会话。",
    inputSchema: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" } }, additionalProperties: false } as JsonSchema
  },
  {
    name: "get_quota",
    description: "查询会话剩余预算：steps/dangerous 已用与上限、距过期时间。",
    inputSchema: { type: "object", required: ["session_id"], properties: { session_id: { type: "string" } }, additionalProperties: false } as JsonSchema
  }
];
