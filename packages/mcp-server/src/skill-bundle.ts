import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "aipagego-browser";
const SKILL_DESCRIPTION = "Strategy + scenarios + safety rails for driving the AIPageGo browser extension via MCP.";

export type SkillTopic =
  | "quickstart"
  | "pairing"
  | "reading"
  | "interaction"
  | "visual"
  | "debugging"
  | "full";

const TOPICS: Record<Exclude<SkillTopic, "full">, string> = {
  quickstart: `# AIPageGo quickstart

1. Call browser_start once. On first use it opens the pairing page and waits for authorization; when one tab is unambiguous it returns a ready session in the same call.
2. If browser_start returns select_tab, call browser_start again with one returned tab_id. list_tabs and open_session remain lower-level compatibility tools.
3. If browser_start times out and returns pairing_required, show pair_url and wait for browser approval. Use pairing_status for a later non-blocking status check; do not ask the user to reply just to continue.
4. For interaction use browser_getPageInfo then browser_takeSnapshot; for broad reading use browser_createPageIndex.
5. When 2-20 safe/caution steps and their arguments are already known, use browser_runSteps to execute them in one MCP call. Keep dangerous actions and steps needing intermediate inspection as separate calls.
6. Prefer purpose-built tools and verified results. Use browser_discoverTools only for capabilities outside the connected core surface. Its response always includes the selected schemas. If a newly enabled native tool is not visible in the current turn, call it immediately with browser_call; do not ask the user to send "continue".
7. Close the session when finished.
`,
  pairing: `# AIPageGo pairing

list_tabs opens the pairing page when needed and waits up to 45 seconds for the extension's HELLO, so successful authorization normally returns connected tabs in the same call. pairing_status remains immediate and non-blocking. A pairing_required result from list_tabs means the bounded wait expired; show pair_url once and use pairing_status for a later check. Never ask the user to reply merely to continue, poll list_tabs, or inspect the pair-page HTML.
`,
  reading: `# AIPageGo reading

Call browser_getPageInfo first. For articles, products, tables, and forms, use browser_createPageIndex, then browser_extractPageFields or browser_searchPageIndex, and read only the relevant block with browser_readPageBlock. Avoid browser_extractText on body and full-DOM reads. Use targeted screenshots only when visual evidence matters.
`,
  interaction: `# AIPageGo interaction

Refresh browser_takeSnapshot before each major action. Prefer uid-based browser_clickByUid/browser_fillByUid, and use browser_fillForm for independent fields. Use condition-based browser_waitFor rather than fixed delays. Keep submit, upload, storage, and credentialed network actions as explicit reviewed steps.
`,
  visual: `# AIPageGo visual validation

Use browser_resize and trust its actualViewport/verified result. Capture one browser_screenshot after the page settles; target a selector or page-index block and lower scale when detail permits. Do not follow browser_resize or browser_screenshot with browser_runJS that only re-reads viewport dimensions.
`,
  debugging: `# AIPageGo debugging

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
      cached = `${TOPICS.quickstart}\n${readFileSync(locateSkillFile(), "utf-8")}`;
    } catch {
      cached =
        `${TOPICS.quickstart}\n# ${SKILL_NAME}\n\n${SKILL_DESCRIPTION}\n\n` +
        `(Skill bundle not found at build time; see https://github.com/attson/aipagego)\n`;
    }
  }
  return { name: SKILL_NAME, description: SKILL_DESCRIPTION, content: cached };
}

export const SKILL_TOOL = {
  name: "aipagego_skill_read",
  description:
    "Return concise AIPageGo guidance by topic. Defaults to quickstart; request full only when detailed reference is necessary.",
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
