# URL Injection Policy Design

## Goal

Let users choose how much AIPageGo functionality is active for each
hostname. Injection capability and the visible in-page assistant are separate
policies with configurable defaults and per-site overrides.

## Configuration

`LlmSettings` gains:

```ts
type InjectionMode = "disabled" | "read" | "operate" | "diagnostic";
type SiteInjectionRule = {
  pattern: string;
  injectionMode: "inherit" | InjectionMode;
  assistant: "inherit" | "enabled" | "disabled";
};

defaultInjectionMode: InjectionMode;
defaultAssistantEnabled: boolean;
siteInjectionRules: SiteInjectionRule[];
```

The old widget site mode, allowlist, and blocklist are removed without data
migration. All settings remain under the `aipagego.*` Chrome storage
namespace.

Rules accept exact hostnames (`example.com`) and subdomain wildcards
(`*.example.com`). They do not accept schemes, ports, or paths. Exact matches
beat wildcards, longer wildcard suffixes beat shorter suffixes, and later rules
beat earlier rules at equal specificity. Injection and assistant fields resolve
independently. A final `disabled` injection mode always disables the assistant.

## Capability levels

| Mode | DOM reads | DOM actions | MAIN-world recorder |
|---|---|---|---|
| disabled | no | no | no |
| read | yes | no | no |
| operate | yes | yes | no |
| diagnostic | yes | yes | yes |

The background enforces these levels before dispatching a tool. Read mode is a
security boundary, not merely a hidden UI state. Tab metadata and screenshots
remain background capabilities in disabled mode; tools requiring a page
content runtime are rejected with an actionable policy error.

## Runtime architecture

The manifest keeps one minimal isolated-world bootstrap on supported pages.
The bootstrap reads the resolved policy but does not touch page DOM, patch page
globals, or log to the page console. It activates the DOM runner only for read,
operate, or diagnostic modes and activates the widget separately when the
assistant policy resolves enabled.

The existing content entry is split so installing the RPC listener is
idempotent and reversible. The widget and breathing border expose explicit
mount/dispose functions. Storage changes reconcile the active page immediately.
Already-evaluated isolated JavaScript cannot be removed from a realm, but its
listeners and visible effects are removed; the next navigation starts clean.

The MAIN-world recorder is removed from static manifest injection. Diagnostic
mode installs it through the background's scripting path and leaving diagnostic
mode calls its existing `uninstall()`. Recorder tools may ensure installation
on demand so no page-native functions are wrapped in lower modes.

The loopback pairing page is a system exception: its isolated pairing relay is
available regardless of the configured site policy so a restrictive localhost
rule cannot make browser authorization unrecoverable.

## Assistant

The assistant policy controls the widget and breathing border together. It is
resolved independently from injection mode. It can be enabled with read,
operate, or diagnostic mode, but is forced off in disabled mode.

## Settings UI

Replace the current widget allowlist/blocklist form with:

- default injection mode control;
- default assistant toggle;
- an ordered site-rule editor;
- per-rule pattern, injection override, and assistant override controls;
- add, delete, move up, and move down actions;
- validation and a current-tab resolved-policy preview.

## Pairing error state

Pairing transport/background errors are reported as connection failures. Only
an explicit user denial is rendered as "denied".

## Testing

Add unit tests for normalization, specificity, independent inheritance, and the
disabled-mode assistant constraint. Cover background tool gating, bootstrap
activation, recorder installation/removal, assistant reconciliation, pairing
error rendering, and settings editing. Run full typecheck, tests, and build.
