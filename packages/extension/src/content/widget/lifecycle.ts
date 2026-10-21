/**
 * Shared module-scope teardown handle so the widget can be fully disposed
 * (React root + broadcast listener + host element) from any component.
 *
 * mount.ts sets this after bootstrap; fab.tsx (or any future component)
 * calls unmountWidget() to trigger it.
 *
 * Kept in its own module so fab.tsx can import it without pulling in
 * mount.ts's top-level auto-mount side effect (which fails outside a
 * content-script runtime).
 */

let teardownWidget: (() => void) | null = null;

export function setTeardown(fn: (() => void) | null): void {
  teardownWidget = fn;
}

export function unmountWidget(): void {
  teardownWidget?.();
  teardownWidget = null;
  document.querySelector("aipagego-widget")?.remove();
}
