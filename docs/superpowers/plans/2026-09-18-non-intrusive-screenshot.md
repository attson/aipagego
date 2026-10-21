# Non-intrusive screenshots implementation plan

## Task 1: Reduce accidental foreground switching

1. Update MCP tool-generation tests so core excludes `switchToTab`, discovery
   assigns it to `tabs`, and its description warns against setup calls.
2. Change the core/discovery lists and shared MCP description.
3. Update the MCP skill bundle and README tool counts.
4. Run shared and MCP tests, then commit.

## Task 2: Add CDP screenshot capture

1. Add failing recorder tests for viewport, full-page, and selector clips.
2. Add `CdpRecorder.captureScreenshot` and a lazy, opt-in helper that returns
   `null` when CDP is disabled or cannot attach.
3. Run focused recorder tests, then commit.

## Task 3: Route screenshots and harden fallback

1. Add failing background capture tests for CDP preference, no tab activation,
   visible-tab fallback metadata, and concurrent user tab switching.
2. Resolve page-index targets without moving the page, route eligible captures
   through CDP, and keep the current visible-tab fallback.
3. Restore the previous tab only while the capture target remains active.
4. Run focused extension tests, then commit.

## Task 4: Verify and release v0.0.72

1. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
2. Bump root and MCP package versions to `0.0.72`; commit the release.
3. Push the release branch, open and merge a pull request, tag the merge as
   `v0.0.72`, and push the tag.
4. Verify the GitHub Release workflow and npm publish workflow complete, the
   release asset exists, and npm reports `@attson/aipagego-mcp@0.0.72`.
