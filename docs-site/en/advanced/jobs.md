# Jobs and page-change monitoring

Jobs pin a saved **steps tool to one immutable version** and run it manually, on a schedule, or after a targeted page change while Chrome is running and the extension is enabled. Open “Jobs” from the side-panel header to create and manage them.

## Triggers

- **Manual**: click Run now. Dangerous workflows require approval every time.
- **Interval / weekly schedule**: one Chrome alarm wakes the local engine; daily times use the browser's local timezone.
- **Page change**: enter or capture one unique selector. The first check creates a SHA-256 baseline. Later checks run the pinned tool only when normalized text changes. Missing or ambiguous selectors pause the Job; AIPageGo never falls back to the whole page or calls an LLM.

If no exact, unowned tab matches the target URL, the Job opens an inactive tab and closes only that tab when finished. It never closes an existing user tab or reuses a tab owned by a Coordinator/MCP session.

## Versions and safety

A Job stays on the version selected when it was created or explicitly upgraded. A newer active version is shown as a reviewable upgrade and is never followed automatically.

- Safe workflows can run automatically.
- Caution workflows require one acknowledgement when created or upgraded; a version or input change invalidates it.
- Dangerous or statically unknown workflows are manual-only and require one-run approval.

Sensitive parameters are never persisted. Values entered for a manual run exist only for that execution. Jobs do not invoke autonomous self-heal; repair and publish in Workflow Studio, then review the upgrade.

## Connector destination

A Job can bind up to five `persistent`, `ready` connectors with matching configuration hashes. A connector destination raises safety to at least caution. If its target or secret changes, the Job enters `needs_attention` before any page is opened or operated and waits for review.

Tool execution and external delivery are recorded separately. If delivery fails, the tool run remains successful; the Job enters `needs_attention` and pauses future automatic scheduling. “Retry delivery” retries only the delivery and never reruns the Tool. An `unknown_commit` additionally requires acknowledgement of possible duplication.

## History, diffs, and notifications

History records the actual version, tab ownership, up to three attempts, and links to the ordinary RunRecord. Successful output keeps a structured preview of at most 64 KiB; adjacent successful outputs show up to 100 JSON-path changes. Full collection rows are never copied into Job history.

Change and final-failure notifications are enabled by default; ordinary-success notifications are off. `notifications` is optional. Denying or revoking it does not stop Jobs. Notifications exclude URL queries, inputs, page text, and output.

## Online-only limitation

Local Jobs are **not a cloud cron service**. They do not run while Chrome is closed, the extension is disabled, or the device is offline. A trigger more than five minutes late is recorded as `missed` and is not replayed.

Coordinator/MCP can remotely trigger existing capabilities only while the browser is online and paired. It cannot manage connector credentials, initiate deliveries, or execute pages in a closed browser.

See also: [Connectors and secure sharing](/en/advanced/connectors-sharing)
