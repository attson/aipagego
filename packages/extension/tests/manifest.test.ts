import manifest from "@/manifest";

const WEBPILOT_EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2MMIurte87Qyc3+fgE14sZvVNdY7Y/olNx0+9P5av+/KaVbtRjgsAWB7hEdJhvX0qjAPi083fknAmZ/kMjTWVGhjWgl+XVxWH19PANwk7gbPw0qxYQsEi8p9iFJteirmszxPootNYsFnSCdgTebk9O7j2E1mNDCcR9+vt6rOMTZXBgjNy8tmAtHeWG5m8XD+EZSvx7sxh4bXNIhKMcpUnnx8j6+BHiuJyAkKsgTHkZ8pDAapwRYX+FpMzSLap5ugeiGCFiA3RWOTFG0LdbjJ1tuIczu3EJ3diGOgQtt5nZmZJvCkcA60l4qShDiJhWTFHHi2VsROY51eJLecQsffFQIDAQAB";

describe("manifest", () => {
  it("includes a fixed extension key so unpacked builds keep the same id", () => {
    expect((manifest as { key?: string }).key).toBe(WEBPILOT_EXTENSION_KEY);
  });

  it("allows the service worker to connect to the local coordinator websocket", () => {
    const hostPermissions = (manifest as { host_permissions?: string[] }).host_permissions ?? [];
    expect(hostPermissions).toContain("ws://127.0.0.1/*");
    expect(hostPermissions).toContain("ws://localhost/*");
  });

  it("allows policy-gated script injection on HTTP and HTTPS pages", () => {
    const hostPermissions = (manifest as { host_permissions?: string[] }).host_permissions ?? [];
    expect(hostPermissions).toContain("<all_urls>");
  });

  it("declares native tab-group access for visible AI session ownership", () => {
    expect((manifest as { permissions?: string[] }).permissions).toContain("tabGroups");
  });
});

type ContentScript = { js?: string[]; world?: string; run_at?: string; matches?: string[] };
const m = manifest as {
  permissions?: string[];
  optional_permissions?: string[];
  content_scripts?: ContentScript[];
  web_accessible_resources?: Array<{ resources: string[]; matches: string[] }>;
};

describe("Plan 32 — recorder and CDP opt-in", () => {
  it("does not request the debugger permission up front", () => {
    expect(m.permissions).not.toContain("debugger");
    expect(m.optional_permissions).toContain("debugger");
  });

  it("declares the recorder as a MAIN-world document_start script", () => {
    const entry = (m.content_scripts ?? []).find((e) =>
      (e.js ?? []).some((f) => f.includes("recorder/main-world"))
    );
    expect(entry).toBeDefined();
    expect(entry!.world).toBe("MAIN");
    expect(entry!.run_at).toBe("document_start");
    expect(entry!.matches).not.toContain("<all_urls>");
  });

  it("loads only the inert bootstrap on ordinary pages", () => {
    const entry = (m.content_scripts ?? []).find((e) => e.matches?.includes("<all_urls>"));
    expect(entry?.js).toEqual(["src/content/bootstrap.ts"]);
  });

  it("exposes the recorder chunk for policy-gated MAIN-world dynamic import", () => {
    const entry = (m.web_accessible_resources ?? []).find((item) =>
      item.resources.includes("assets/main-world.ts-*.js")
    );
    expect(entry?.matches).toContain("<all_urls>");
  });
});

describe("P0 — browser data permissions are requested on demand", () => {
  it.each(["bookmarks", "history", "downloads"])(
    "does not request %s at install time",
    (permission) => {
      expect(m.permissions).not.toContain(permission);
      expect(m.optional_permissions).toContain(permission);
    },
  );
});

describe("P3 — local Job scheduling", () => {
  it("declares alarms for MV3 wakeups", () => {
    expect(m.permissions).toContain("alarms");
  });

  it("requests notifications only when the user enables Job notifications", () => {
    expect(m.permissions).not.toContain("notifications");
    expect(m.optional_permissions).toContain("notifications");
  });
});
