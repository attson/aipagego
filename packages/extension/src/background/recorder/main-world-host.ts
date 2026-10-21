import {
  DEFAULT_RECORDER_CONFIG,
  filterConsole,
  filterNetwork,
  type BackendTag,
  type ConsoleEntry,
  type ConsoleQuery,
  type ConsoleReadResult,
  type DialogEntry,
  type DialogPolicy,
  type DialogReadResult,
  type NetworkDetail,
  type NetworkEntry,
  type NetworkDetailResult,
  type NetworkPart,
  type NetworkQuery,
  type NetworkReadResult,
  type PageRecorder,
  type RecorderConfig,
  type RecorderConfigPatch
} from "@aipagego/shared/recorder";

/** Shape returned by the `read` op in `content/recorder/drain.ts`. */
type DrainRead = {
  missing?: true;
  config?: RecorderConfig;
  console?: { dropped: number; entries: ConsoleEntry[] };
  network?: { dropped: number; entries: NetworkEntry[] };
  dialog?: { dropped: number; entries: DialogEntry[] };
};

type DrainDetail = { missing?: true; detail?: NetworkDetail | null; config?: RecorderConfig };

const NOT_INSTALLED =
  "recorder not installed on this page — restricted URL, or the tab loaded before the extension";

const BODY_OFF =
  "body capture is off — call recorderConfig({bodies:true}) and re-run the request";

export type DrainFn = (ctx: unknown) => Promise<unknown>;

/**
 * Reads the MAIN-world recorder through the one-shot `injectMainWorld`
 * channel. Never throws for backend reasons: a page without the recorder
 * yields an empty result carrying `disabled`, because "no requests" and
 * "could not observe requests" must be distinguishable by the caller.
 */
export class MainWorldRecorder implements PageRecorder {
  readonly backend = "main-world" as const;

  constructor(
    private readonly tabId: number,
    private readonly drain: DrainFn,
    private readonly degradedReason?: string
  ) {}

  private tag(disabled?: string): BackendTag {
    return {
      backend: this.backend,
      ...(this.degradedReason ? { degradedReason: this.degradedReason } : {}),
      ...(disabled ? { disabled } : {})
    };
  }

  private async read(): Promise<DrainRead> {
    try {
      return ((await this.drain({ op: "read" })) ?? {}) as DrainRead;
    } catch (e) {
      return { missing: true, config: undefined } as DrainRead & { reason?: string };
    }
  }

  async readConsole(q: ConsoleQuery): Promise<ConsoleReadResult> {
    const r = await this.read();
    if (r.missing || !r.console) {
      return { ...this.tag(NOT_INSTALLED), dropped: 0, messages: [] };
    }
    return {
      ...this.tag(),
      dropped: r.console.dropped,
      messages: filterConsole(r.console.entries, q)
    };
  }

  async readNetwork(q: NetworkQuery): Promise<NetworkReadResult> {
    const r = await this.read();
    if (r.missing || !r.network) {
      return { ...this.tag(NOT_INSTALLED), dropped: 0, requests: [] };
    }
    return {
      ...this.tag(),
      dropped: r.network.dropped,
      requests: filterNetwork(r.network.entries, q)
    };
  }

  async readDialogs(q: { limit?: number }): Promise<DialogReadResult> {
    const r = await this.read();
    if (r.missing || !r.dialog) {
      return { ...this.tag(NOT_INSTALLED), dropped: 0, dialogs: [] };
    }
    const all = r.dialog.entries;
    const limit = q.limit;
    const dialogs = limit && limit > 0 && all.length > limit ? all.slice(all.length - limit) : all;
    return { ...this.tag(), dropped: r.dialog.dropped, dialogs };
  }

  async readNetworkDetail(q: { id: number; part?: NetworkPart }): Promise<NetworkDetailResult> {
    const raw = ((await this.drain({ op: "detail", id: q.id })) ?? {}) as DrainDetail;
    if (raw.missing) return { ...this.tag(NOT_INSTALLED), detail: null };
    const detail = raw.detail ?? null;
    if (!detail) return { ...this.tag(), detail: null };

    const bodiesArmed = raw.config?.bodies ?? DEFAULT_RECORDER_CONFIG.bodies;
    const missingBody = detail.responseBody == null && detail.requestBody == null;
    const withReason: NetworkDetail =
      !bodiesArmed && missingBody ? { ...detail, bodyUnavailable: BODY_OFF } : detail;

    return { ...this.tag(), detail: q.part ? project(withReason, q.part) : withReason };
  }

  async setDialogPolicy(p: DialogPolicy): Promise<DialogReadResult> {
    await this.drain({ op: "setDialogPolicy", policy: p });
    return this.readDialogs({});
  }

  async configure(patch: RecorderConfigPatch): Promise<BackendTag & { config: RecorderConfig }> {
    const raw = ((await this.drain({ op: "configure", patch })) ?? {}) as {
      missing?: true;
      config?: RecorderConfig;
    };
    if (raw.missing || !raw.config) {
      return { ...this.tag(NOT_INSTALLED), config: { ...DEFAULT_RECORDER_CONFIG } };
    }
    return { ...this.tag(), config: raw.config };
  }

  /** Restores every patched global and clears the buffers on this page. */
  async uninstall(): Promise<void> {
    await this.drain({ op: "uninstall" }).catch(() => undefined);
  }

  get targetTabId(): number {
    return this.tabId;
  }
}

/** Narrows a detail to the single part the caller asked for. */
function project(d: NetworkDetail, part: NetworkPart): NetworkDetail {
  const base: NetworkDetail = {
    id: d.id,
    ts: d.ts,
    method: d.method,
    url: d.url,
    status: d.status,
    ...(d.bodyUnavailable ? { bodyUnavailable: d.bodyUnavailable } : {})
  };
  if (part === "request-headers") return { ...base, requestHeaders: d.requestHeaders };
  if (part === "request-body") return { ...base, requestBody: d.requestBody };
  if (part === "response-headers") return { ...base, responseHeaders: d.responseHeaders };
  return { ...base, responseBody: d.responseBody };
}
