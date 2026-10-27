# Permission Explanations

AIPageGo keeps core page automation available after installation and asks for browser-data access only when a matching feature is used. Denying an optional permission does not disable normal page chat.

## Requested at installation

| Permission | Purpose | Boundary |
|---|---|---|
| `sidePanel` | Show chat and tools in Chrome's side panel | Does not read page data by itself |
| `storage` | Store settings, conversations, tools, and runs | API keys are excluded from IndexedDB and exports |
| `scripting` / `activeTab` | Inject or run tools on pages involved in a user task | Site policy and tool approval still apply |
| `tabs` / `tabGroups` / `webNavigation` | Track the active tab, multi-tab sessions, URL changes, and visible session groups | Does not grant access to Chrome's history database |
| `contextMenus` | Provide a right-click entry point | Handles only a user-selected action |
| `<all_urls>` | Read or operate on the current page and match saved tools by URL | No background bulk upload; restricted pages cannot be injected |
| `ws://127.0.0.1/*` / `ws://localhost/*` | Connect to a local Coordinator or MCP service | Local addresses only; connection and remote chat are user-controlled |

## Requested when used

| Optional permission | Trigger | If denied | Revoke |
|---|---|---|---|
| `bookmarks` | Bookmark search and bookmark mentions | That bookmark action is skipped | Settings → Permissions or Chrome extension details |
| `history` | `searchHistory` | That search is skipped | Settings → Permissions or Chrome extension details |
| `downloads` | Image and XLSX downloads | No file is created | Settings → Permissions or Chrome extension details |
| `notifications` | Change, success, or final-failure notices for local Jobs | The Job still runs; no system notification is shown | Settings → Permissions or Chrome extension details |
| `debugger` | Explicitly enabled advanced page-event recording | Recording degrades to the non-CDP backend | Chrome extension details |

After a grant, AIPageGo retries the original operation once. If the Chrome API still fails, it reports the error and does not prompt in a loop. Coordinator and MCP cannot request permission for you; they receive a machine-readable `PermissionDenied` result.

Browser permissions and dangerous-tool approval are independent gates.

## Connector network access

Connectors require **no additional Chrome permission**. HTTPS requests use the extension's existing page-network capability and do not trigger another browser permission prompt. Webhook and Feishu/Lark Base targets and credentials are user-configured. AIPageGo provides no public relay and never sends page or chat content merely because a connector exists.

Job notifications include only the Job name, pinned version, terminal state, and a bounded error code or change count. They exclude URL queries, inputs, page text, and output.

See also: [Privacy Policy](/en/privacy) · [Connectors and secure sharing](/en/advanced/connectors-sharing) · [Configuration](/en/guide/config)
