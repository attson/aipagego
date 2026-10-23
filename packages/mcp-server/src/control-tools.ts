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
        tab_id: { type: "string" },
        url: { type: "string" },
        session_id: { type: "string" },
        force_new: { type: "boolean" },
        capabilities: { type: "array", items: { type: "string" } },
        idle_timeout_min: { type: "number" }
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
    description: "Open, reuse, or attach a tab session. Returns PAIRING_REQUIRED when disconnected.",
    inputSchema: {
      type: "object",
      required: ["tab_id"],
      properties: {
        tab_id: { type: "string" },
        session_id: { type: "string" },
        force_new: { type: "boolean" },
        capabilities: { type: "array", items: { type: "string" } },
        idle_timeout_min: { type: "number" }
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
