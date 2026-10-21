# Session Tab Groups Design

## Goal

Make AI-controlled tabs visibly attributable to the logical session driving
them without injecting any indicator into the page. AIPageGo groups tabs by
session through Chromium's native tab-group UI.

## Identity

- Sidepanel and in-page widget share a local logical session. Its id is the
  active `runRecordId` from their shared `SessionData` snapshot.
- MCP uses the protocol `session_id` announced by `SESSION_OPENED`.
- Background-driven remote chat uses `START_CHAT_SESSION.session_id`.
- A session spanning multiple windows owns one group per window because Chrome
  groups cannot cross window boundaries.

Group titles are readable and include only a short id:

- `AIPageGo · 侧栏 · a3f91c`
- `AIPageGo · MCP · a3f91c`
- `AIPageGo · 远程 · a3f91c`
- waiting sessions append `· 等待确认`.

Colors identify source: local blue, MCP green, remote purple. Group status is
expressed by title, not color.

## Lifecycle

The background owns a `TabSessionGroupManager`. Claiming a tab records its
original group and index, creates or reuses the session's group in that window,
and moves the tab into it. Releasing the session restores tabs to their
original groups when those groups still exist, otherwise it ungroups them.

Local `session.state.changed` snapshots claim the primary and attached tabs
while status is `streaming`, `running`, or `awaiting`; terminal/idle snapshots
release the logical session. MCP claims and releases follow the existing
ownership messages. Remote chat wraps its run lifecycle directly.

Manager state is stored in `chrome.storage.session` so MV3 service-worker
restarts do not orphan an active browser session. Startup reconciliation drops
records for closed tabs or missing groups.

## User Control

If the user manually moves a tab out of its expected AIPageGo group, the
manager relinquishes that tab and does not pull it back or restore it later.
Tabs manually added to an AIPageGo group are not claimed automatically.

The group remains expanded. AIPageGo never collapses a group containing the
active tab.

## Permissions And Privacy

The extension adds the `tabGroups` permission. Group membership, title, color,
and collapse state are browser UI and are not exposed to website JavaScript.
Grouping can move tab positions but does not navigate or reload the page.

## Testing

Unit tests cover one group per session/window, source titles/colors, original
group restoration, missing original groups, manual detachment, session release,
and state rehydration. Integration tests cover local snapshot and MCP ownership
wiring. Production manifest tests require `tabGroups` permission.
