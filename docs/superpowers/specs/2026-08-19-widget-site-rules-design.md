# Widget Site Rules Design

## Goal

Move the in-page widget switch from the LLM settings section to the existing
"Widget / multi-tab" section, and let users control widget mounting with an
allowlist and a blocklist.

## Site policy

The settings expose two modes:

- `all`: mount on every supported HTML page unless a blocklist rule matches.
- `allowlist`: mount only when an allowlist rule matches and no blocklist rule
  matches.

The blocklist always wins. The global `widgetEnabled` switch wins over both
lists.

Rules are hostnames, one per line. `example.com` matches only that hostname;
`*.example.com` matches subdomains but not the apex hostname. Rules are
case-insensitive and normalized by trimming whitespace, lowercasing, removing
trailing dots, and deduplicating. Values containing schemes, ports, paths, or
invalid wildcard placement are rejected by the settings UI.

## Storage and compatibility

Use `aipagego.llm` for settings, `aipagego.widget.hiddenHosts` for the
blocklist, and `aipagego.widget.allowedHosts` for the allowlist. All legacy
storage keys, the IndexedDB name, and exported schema identifiers are replaced
without migration or backward-compatibility handling.

## Runtime behavior

The content script evaluates the policy before creating the widget host. It
also listens for relevant `chrome.storage` changes and reconciles immediately:
mount when the current host becomes eligible, unmount when it becomes
ineligible. This removes the need to refresh an already-open page.

The widget menu's existing "Do not show on this site" command adds the exact
current hostname to the blocklist and unmounts immediately.

## UI

Remove the widget switch from the LLM section. The Widget / multi-tab section
contains:

1. The global widget toggle.
2. A segmented mode selector for all sites or allowlist only.
3. Allowlist and blocklist multiline editors with hostname examples and inline
   validation.
4. The existing multi-tab behavior summary.

List edits are saved when the field loses focus, provided every non-empty line
is valid. Invalid input remains visible and is not persisted.

## Testing

Add pure unit coverage for normalization, validation, wildcard matching, and
precedence. Extend mount tests for both modes, blacklist precedence, and live
storage reconciliation. Add settings component tests for control placement and
valid/invalid list persistence.
