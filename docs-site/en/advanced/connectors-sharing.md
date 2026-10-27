# Connectors and secure sharing

AIPageGo can send an already-produced local result to a user-configured external system and can share tool definitions with another AIPageGo installation. Both flows require an explicit user action. Creating a connector never uploads arbitrary chat or page content by itself.

## Connector types

- **Webhook:** HTTPS only. Production sends use a fixed envelope, omit cookies, reject redirects, and cap one payload at 5 MiB. Connection tests send only a synthetic payload, never real page or result data.
- **Feishu/Lark Base:** the access token obtained from App ID / App Secret remains in memory. A test reads metadata and does not create records. Object rows use an explicit field mapping and are written in batches of at most 500 rows with checkpointed progress.

Each connector has a credential mode:

- `persistent`: credentials live in a separate local `chrome.storage.local` secret area and may be bound to automatic Jobs.
- `session`: credentials live only in `chrome.storage.session`. After a browser restart the connector becomes `needs_credentials`; it cannot be an automatic Job destination until credentials are entered again.

Lists and details expose only the name, kind, target summary, configuration state, and whether credentials exist. Full URL paths/queries, header names and values, App Secrets, and access tokens are never read back.

## Data delivery and history

From “Connectors & secure sharing,” select a Run, JobRun, or collection `resultId`, verify the target, and create a delivery. Full collection rows are paged by `resultId`; they are not copied into the delivery, Job, or chat. A delivery stores only a source reference, status, counts, and checkpoint.

Webhooks use a fixed envelope and idempotency key. Base delivery keeps `sentCount` and `nextOffset`, so a partial send can continue. If the network fails after submission and the external commit cannot be determined, the state is `unknown_commit`. AIPageGo does not silently resend it: the user must acknowledge the duplicate risk. Retry resends only the delivery and never reruns the page tool or Job.

## Job connector destination

A Job can bind up to five `persistent`, `ready` connectors whose configuration hashes still match. A destination raises safety to at least caution and requires acknowledgement.

Tool execution and external delivery have separate outcomes. If delivery fails, the tool run remains successful, while the Job enters `needs_attention` and pauses future automatic scheduling. Changing a target or secret changes the config hash; the Job must be reviewed again and is blocked before opening or operating a page.

## Secure tool packages

The default sharing format is `aipagego.tool-package/v1`:

- A steps tool contains only its active snapshot, renumbered to v1; a prompt tool contains only its current prompt.
- Stats are reset and preset origin is removed. Jobs, connectors, credentials, run history, results, inputs, and local trust state are excluded.
- Export scans for literal Authorization/Cookie/API keys/tokens/private keys, URL userinfo, and sensitive query values. A finding rejects the package and reports only its rule and path, never the value.

Every v2, v3, or `tool-package/v1` import uses two phases:

1. `preview` parses read-only in the background, recomputes a `digest`, and shows hosts, capabilities and severity across every version, dangerous steps, secret findings, ID conflicts, and dependent Jobs.
2. The user chooses copy / skip / overwrite per conflict and explicitly approves dangerous tools or dynamic prompts.
3. Commit repeats parsing, scanning, and audit. A changed `digest` fails with `import_digest_changed`; unknown tools, invalid workflows, and secrets are rejected per item.

If overwrite changes a pinned Job version hash, that Job immediately becomes `needs_attention / tool_version_changed`. Import does not execute a tool and does not bypass normal approval when the tool runs later.

## Local and remote boundary

Connector CRUD, credentials, and delivery sends are available only to local side-panel/background flows. The content widget, Coordinator, and MCP expose no connector secret/read/send tools. Their existing EXEC, chat, and collection-summary capabilities remain unchanged.

See also: [Jobs & monitoring](/en/advanced/jobs) · [Privacy](/en/privacy) · [Permissions](/en/permissions)
