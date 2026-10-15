import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "atwebpilot-browser";
const SKILL_DESCRIPTION = "Strategy + scenarios + safety rails for driving the AtWebPilot browser extension via MCP.";

export type SkillTopic =
  | "quickstart"
  | "pairing"
  | "reading"
  | "interaction"
  | "visual"
  | "debugging"
  | "full";

const TOPICS: Record<Exclude<SkillTopic, "full">, string> = {
  quickstart: `# AtWebPilot quickstart

1. Call list_tabs once. If it returns pairing_required, show pair_url and wait for the user to approve.
2. After approval, call pairing_status. Do not retry list_tabs while status is unchanged.
3. Call list_tabs when connected, choose a tab, then open_session with its tab_id.
4. For interaction use browser_getPageInfo then browser_takeSnapshot; for broad reading use browser_createPageIndex.
5. Prefer purpose-built tools and verified results. Use browser_discoverTools only for capabilities outside the connected core surface. Its response always includes the selected schemas. If a newly enabled native tool is not visible in the current turn, call it immediately with browser_call; do not ask the user to send "continue".
6. Close the session when finished.
`,
  pairing: `# AtWebPilot pairing

list_tabs and pairing_status never wait for browser authorization. A pairing_required result includes pair_url. Show that URL once and wait for the user to approve in the browser. Then call pairing_status; only call list_tabs after it reports connected. Never poll list_tabs or inspect the pair-page HTML.
`,
  reading: `# AtWebPilot reading

Call browser_getPageInfo first. For articles, products, tables, and forms, use browser_createPageIndex, then browser_extractPageFields or browser_searchPageIndex, and read only the relevant block with browser_readPageBlock. Avoid browser_extractText on body and full-DOM reads. Use targeted screenshots only when visual evidence matters.
`,
  interaction: `# AtWebPilot interaction

Refresh browser_takeSnapshot before each major action. Prefer uid-based browser_clickByUid/browser_fillByUid, and use browser_fillForm for independent fields. Use condition-based browser_waitFor rather than fixed delays. Keep submit, upload, storage, and credentialed network actions as explicit reviewed steps.
`,
  visual: `# AtWebPilot visual validation

Use browser_resize and trust its actualViewport/verified result. Capture one browser_screenshot after the page settles; target a selector or page-index block and lower scale when detail permits. Do not follow browser_resize or browser_screenshot with browser_runJS that only re-reads viewport dimensions.
`,
  debugging: `# AtWebPilot debugging

Read browser_consoleMessages first, then browser_networkRequests summaries. Arm recorder bodies only when needed, reproduce once, and fetch one browser_networkRequestDetail. Poll incrementally with sinceId. Check backend and degradedReason before treating missing events as proof.
`
};

let cached: string | null = null;

function locateSkillFile(): string {
  // mcp-server runs in `packages/mcp-server/dist/...` or `src/...` (tsx).
  // Walk up looking for the monorepo root sibling `skill/SKILL.md`.
  let here = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(here, "skill", "SKILL.md");
    try {
      readFileSync(candidate, "utf-8");
      return candidate;
    } catch {
      // walk one level up
    }
    here = dirname(here);
  }
  // Fallback: bundled copy that may have been included next to dist/
  return join(dirname(fileURLToPath(import.meta.url)), "../../../skill/SKILL.md");
}

export function readSkillBundle(rawTopic: unknown = "quickstart"): { name: string; description: string; content: string } {
  const topic = rawTopic == null ? "quickstart" : String(rawTopic);
  if (topic !== "full") {
    const content = TOPICS[topic as Exclude<SkillTopic, "full">];
    if (!content) throw new Error(`Unknown skill topic: ${topic}`);
    return { name: SKILL_NAME, description: SKILL_DESCRIPTION, content };
  }
  if (cached == null) {
    try {
      cached = readFileSync(locateSkillFile(), "utf-8");
    } catch {
      cached =
        `# ${SKILL_NAME}\n\n${SKILL_DESCRIPTION}\n\n(Skill bundle not found at build time; see https://github.com/attson/atwebpilot)\n`;
    }
  }
  return { name: SKILL_NAME, description: SKILL_DESCRIPTION, content: cached };
}

export const SKILL_TOOL = {
  name: "atwebpilot_skill_read",
  description:
    "Return concise AtWebPilot guidance by topic. Defaults to quickstart; request full only when detailed reference is necessary.",
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["quickstart", "pairing", "reading", "interaction", "visual", "debugging", "full"],
        description: "Guidance section; quickstart is the token-efficient default"
      }
    },
    required: [] as string[],
    additionalProperties: false
  },
};
