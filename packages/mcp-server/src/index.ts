import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DefaultClock, DefaultIdGen } from "@atwebpilot/coordinator";
import { createMcpServer } from "./mcp-server";
import { createHubEnsurer, defaultOpenUrl } from "./ensure-hub";

// ⚠ stdout 是 MCP 通道，日志一律 console.error。
async function main(): Promise<void> {
  const explicitPort = process.env.ATWEBPILOT_WS_PORT
    ? Number(process.env.ATWEBPILOT_WS_PORT)
    : undefined;
  const token = process.env.ATWEBPILOT_WS_TOKEN || undefined;

  const clock = new DefaultClock();
  const idGen = new DefaultIdGen();

  // No port is bound here. A session that never touches a page costs nothing,
  // and two such sessions cannot collide.
  const deps = createHubEnsurer({
    clock,
    idGen,
    explicitPort,
    token
  });

  const server = createMcpServer(deps, undefined, { fallbackOpenUrl: defaultOpenUrl });
  await server.connect(new StdioServerTransport());
  console.error("[atwebpilot-mcp] stdio MCP connected; ws port binds on first browser use");

  const shutdown = () => {
    const bundle = deps.peek();
    // Tell any connected extension this is deliberate so it drops the endpoint
    // instead of retrying it for the rest of the browser session.
    void (bundle?.hub.shutdown?.() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.stdin.on("close", shutdown);
}

main().catch((e) => { console.error("[atwebpilot-mcp] fatal", e); process.exit(1); });
