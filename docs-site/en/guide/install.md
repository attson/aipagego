# Installation

Three ways to use it.

## Option 1: Browser extension only

1. Grab `atwebpilot-<version>.zip` from [Releases](https://github.com/attson/atwebpilot/releases/latest) and unzip
2. Open `chrome://extensions`
3. Turn on "Developer mode" (top-right)
4. Click "Load unpacked" → select the unzipped `dist/` directory
5. Click the extension icon on any page → side panel opens

## Option 2: Add MCP so Codex or Claude Code can drive the browser

Codex:

```bash
npx -y @attson/atwebpilot-mcp --install-codex-skill
codex mcp add atwebpilot -- npx -y @attson/atwebpilot-mcp
```

The first command installs a user-level Codex Skill so live-page tasks can discover
AtWebPilot without changing any project's `AGENTS.md`. Start a new Codex session after
installation. The installer refuses to overwrite a modified Skill unless `--force` is explicit.

Claude Code:

```bash
claude mcp add atwebpilot --scope user -- npx -y @attson/atwebpilot-mcp
```

Then install the extension as in Option 1. **No port to fill in** — the first time the AI
needs to touch a page, a pairing page opens; click Allow and it connects. Later sessions on
the same machine connect silently, and several Codex or Claude Code sessions can share one browser.

See [MCP Bridge](/en/advanced/mcp-bridge).

## Option 3: Build from source

```bash
git clone https://github.com/attson/atwebpilot
cd atwebpilot
pnpm install
pnpm build       # → packages/extension/dist/
```

Then back to Option 1 steps 2–5.

## Next

- [Configuration](/en/guide/config)
- [First task](/en/guide/first-task)
