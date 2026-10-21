/**
 * The drain expression is evaluated in the MAIN world by `injectMainWorld`,
 * which wraps it in `async (ctx) => { ... }`. It therefore shares the realm
 * with `main-world.ts` and can reach `window.__AIPAGEGO_REC__` directly —
 * no extra message channel is needed.
 *
 * Everything it returns must be plain JSON. Filtering happens on the
 * background side so the query logic stays pure and unit-tested in one place.
 */
export const DRAIN_SOURCE = `
  const rec = window.__AIPAGEGO_REC__;
  if (!rec) return { missing: true };
  const op = ctx && ctx.op;
  if (op === "configure") return { config: rec.configure(ctx.patch || {}) };
  if (op === "setDialogPolicy") {
    rec.setDialogPolicy(ctx.policy || null);
    return { ok: true, config: rec.config };
  }
  if (op === "read") return {
    config: rec.config,
    console: { dropped: rec.console.dropped, entries: rec.console.toArray() },
    network: { dropped: rec.network.dropped, entries: rec.network.toArray() },
    dialog: { dropped: rec.dialog.dropped, entries: rec.dialog.toArray() }
  };
  if (op === "detail") return { detail: rec.details.get(ctx.id) || null, config: rec.config };
  if (op === "uninstall") { rec.uninstall(); return { ok: true }; }
  return { error: "unknown recorder op: " + String(op) };
`;

export type DrainOp =
  | { op: "read" }
  | { op: "detail"; id: number }
  | { op: "configure"; patch: Record<string, unknown> }
  | { op: "setDialogPolicy"; policy: Record<string, unknown> | null }
  | { op: "uninstall" };
