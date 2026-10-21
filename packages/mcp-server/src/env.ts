export type AIPageGoEnvKey =
  | "WS_PORT"
  | "WS_TOKEN"
  | "CODEX_SKILLS_DIR"
  | "MCP_TOOLS";

/** Read an AIPageGo MCP environment variable. */
export function readAIPageGoEnv(
  env: Record<string, string | undefined>,
  key: AIPageGoEnvKey
): string | undefined {
  return env[`AIPAGEGO_${key}`];
}
