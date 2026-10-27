# Privacy Policy

Effective date: 2026-10-23

AIPageGo is a local-first Chromium side-panel extension. It does not operate an AIPageGo account system, cloud sync, advertising, or telemetry service, and it does not sell user data.

## Data processed

- **Page content:** Read only when you start a task, and only from the current page or tabs you explicitly attach.
- **Model requests:** Conversation text, necessary page content, and tool results are sent directly to the Anthropic, OpenAI, or compatible API endpoint you select. That provider's privacy policy also applies.
- **Local data:** Tools, conversations, runs, site rules, and settings are stored in your browser. You may store the API key in `chrome.storage.local` or only for the current browser session in `chrome.storage.session`.
- **Optional browser data:** Bookmarks, browsing history, and downloads are accessed only after you use the matching feature and approve Chrome's permission prompt.
- **Coordinator / MCP:** Enabled only when you explicitly pair or connect. Tool arguments, results, and tab metadata may be sent to the local or self-hosted service you choose. Remote chat has a separate opt-in switch.
- **Connector delivery:** A selected Run, JobRun, or collection result is sent to a user-configured Webhook or Feishu/Lark Base only after manual confirmation or through an explicitly bound `persistent` Job destination. The external system's own privacy policy applies.
- **Connector credentials:** Public summaries may be stored in IndexedDB. Secrets are separated into local/session partitions under `aipagego.connectorSecrets`, and no API reads them back.

## What AIPageGo does not do

- API keys are not written to IndexedDB, exported tool bundles, store screenshots, or diagnostic logs.
- Connector secrets are excluded from IndexedDB, every share package, run history, notifications, and logs. Share packages also exclude connectors, deliveries, and result data.
- No telemetry, user profiling, or sale or rental of user data.
- Browser permission does not bypass dangerous-tool approval; actions such as submitting forms or uploading files remain separately gated.

## Retention, deletion, and revocation

Local data remains until you delete it in the extension, clear extension storage, or uninstall AIPageGo. Bookmark, history, and download permissions can be revoked in AIPageGo Settings or Chrome's extension details. Chrome removes extension storage when the extension is uninstalled.

## Security and contact

AIPageGo transmits data only when a task needs it and uses the HTTPS/WSS endpoint you configure. Do not post keys, cookies, or other secrets in a public issue. For support or privacy questions, use [GitHub Issues](https://github.com/attson/aipagego/issues).

See also: [Permission explanations](/en/permissions) · [Installation and local storage](/en/guide/install)
