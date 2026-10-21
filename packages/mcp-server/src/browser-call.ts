import type { JsonSchema } from "@aipagego/shared/types";

export const BROWSER_CALL_TOOL = {
  name: "browser_call",
  description:
    "Call an enabled browser tool in the current turn after browser_discoverTools returns its schema. " +
    "Prefer the native tool when available.",
  inputSchema: {
    type: "object",
    required: ["session_id", "tool", "args"],
    properties: {
      session_id: { type: "string", description: "Session id from open_session" },
      tool: { type: "string", description: "Enabled browser tool name; browser_ prefix is optional" },
      args: {
        type: "object",
        description: "Arguments matching the schema returned by browser_discoverTools, excluding session_id",
        additionalProperties: true
      }
    },
    additionalProperties: false
  } as JsonSchema
};
