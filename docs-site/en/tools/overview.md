# Tool reference (overview)

<!-- English version is a short summary; auto-generated Chinese pages have full param tables. -->

AIPageGo ships **41 built-in tools** grouped by category:

| Category | Description | Chinese page |
|---|---|---|
| Inspect | Page reads · safe | [/tools/inspect](/tools/inspect) |
| Action | Page writes · caution | [/tools/action](/tools/action) |
| Danger | Submit / cookie'd requests / runJS · dangerous | [/tools/danger](/tools/danger) |
| Meta / visual | Cross-tab / bookmarks / history / visual | [/tools/meta](/tools/meta) |

## Severity legend

- 🟢 **safe**: runs automatically, no approval needed
- 🟡 **caution**: auto-runs by default (depends on permission mode); requires approval in `read` mode
- 🔴 **dangerous**: requires approval every time by default; allowlisted per-tool in `trust` mode; auto-runs in `yolo` mode (careful)

> **Full English tool docs are coming soon.** Meanwhile, category pages linked above have Chinese descriptions and param tables auto-generated from the source code.
