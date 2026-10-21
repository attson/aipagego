import type { TabOwner } from "@aipagego/shared/pairing";

/**
 * Which session is driving which tab.
 *
 * `open_session` is server-local, so the extension cannot see it directly and
 * would otherwise have to guess from whichever EXEC arrived first. The server
 * sends SESSION_OPENED instead, which makes the claim exact.
 *
 * Ownership is advisory throughout. Nothing here blocks a call — it exists so
 * `list_tabs` can tell an agent a tab is already in use, letting it open its
 * own instead of contending. Two sessions may still share a tab deliberately.
 */

type Claim = TabOwner & { sessionId: string; since: number };

export class TabOwnership {
  private byTab = new Map<string, Claim>();
  private listeners: Array<() => void> = [];

  onChange(fn: () => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  claim(tabId: string, owner: { connectionId: string; sessionId: string; label: string }): void {
    this.byTab.set(tabId, { ...owner, since: Date.now() });
    this.emit();
  }

  releaseTab(tabId: string): void {
    if (this.byTab.delete(tabId)) this.emit();
  }

  releaseBySession(sessionId: string): void {
    let changed = false;
    for (const [tab, claim] of this.byTab) {
      if (claim.sessionId === sessionId) {
        this.byTab.delete(tab);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  /** A dropped connection releases everything it held. */
  releaseByConnection(connectionId: string): void {
    let changed = false;
    for (const [tab, claim] of this.byTab) {
      if (claim.connectionId === connectionId) {
        this.byTab.delete(tab);
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  owners(): Record<string, TabOwner> {
    const out: Record<string, TabOwner> = {};
    for (const [tab, claim] of this.byTab) {
      out[tab] = { connectionId: claim.connectionId, label: claim.label };
    }
    return out;
  }

  ownerOf(tabId: string): Claim | undefined {
    return this.byTab.get(tabId);
  }

  get size(): number {
    return this.byTab.size;
  }
}
