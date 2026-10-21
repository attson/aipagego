# Widget Site Rules Implementation Plan

1. Extend shared settings types with the widget site mode and add its default
   in the extension settings store.
2. Implement pure hostname rule parsing and matching in the widget per-site
   module with AIPageGo-prefixed storage keys and preserve the hide action.
3. Update widget mounting to apply the policy and reconcile on relevant
   storage changes.
4. Move the global widget control into the mounting settings section and add
   mode, allowlist, blocklist, validation, and persistence controls.
5. Add focused tests for policy, mounting, live reconciliation, and settings
   UI behavior.
6. Run targeted tests, typecheck, and the broader affected test suites; fix any
   regressions.
