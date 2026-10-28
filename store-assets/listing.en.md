# Chrome Web Store Listing (English)

## Name

AIPageGo — AI Web Assistant

## Short description

Chat with AI on the current page: summarize, fill, collect, and save successful flows as replayable tools.

## Single purpose

AIPageGo lets a user-selected AI model read, operate on, or collect from the current web page when the user starts a task, and save successful steps as reusable local tools.

## Full description

AIPageGo lives in Chromium's side panel. Ask it to summarize an article, translate content, extract product or list data, fill forms, click page controls, or work across attached tabs.

Successful conversations can be “solidified” into URL-pattern-matched tools and replayed on similar pages without another planning round. Page reading prefers a structured Page Context Index, and dangerous operations remain separately approval-gated.

Highlights:

- Read: summarization, translation, page Q&A, and structured extraction.
- Operate: fill, select, click, submit, and upload with visible step status.
- Collect: lists, images, reviews, and tables with JSON/XLSX output.
- Reuse: save successful flows as local replayable tools.
- Developer mode: optionally pair MCP or Coordinator so Codex or Claude Code can drive the real browser.

AIPageGo has no cloud account, telemetry, or hosted model. You choose Anthropic, OpenAI, or a compatible endpoint. The API key stays on the device or in the current browser session.

## Links

- Privacy policy: https://attson.github.io/aipagego/en/privacy
- Permission explanations: https://attson.github.io/aipagego/en/permissions
- Support: https://github.com/attson/aipagego/issues
- Project home: https://attson.github.io/aipagego/

## Permission rationale summary

Core page permissions support user-initiated page reading and operation, multi-tab sessions, and URL matching. `bookmarks`, `history`, `downloads`, and `debugger` are optional and requested only when the matching feature is used. Denial does not disable ordinary page chat.
