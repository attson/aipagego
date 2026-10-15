import { describe, it, expect } from "vitest";
import { generateBrowserTools } from "../src/tool-gen";
import { DISCOVER_TOOL, handleDiscover } from "../src/discover-tool";

const all = generateBrowserTools("full");
const coreNames = () => new Set(generateBrowserTools("core").map((t) => t.name));

describe("browser_discoverTools", () => {
  it("has an English description and optional tool/group enable arrays", () => {
    expect(DISCOVER_TOOL.name).toBe("browser_discoverTools");
    expect(DISCOVER_TOOL.description).not.toMatch(/[一-鿿]/);
    const props = DISCOVER_TOOL.inputSchema.properties as Record<string, { type: string }>;
    expect(props.enable.type).toBe("array");
    expect(props.enableGroups.type).toBe("array");
    expect(props.profile.type).toBe("string");
    expect(DISCOVER_TOOL.inputSchema.required ?? []).not.toContain("enable");
  });

  it("without enable returns the catalog and does not change state", () => {
    const advertised = coreNames();
    const before = advertised.size;
    const r = handleDiscover({ all, advertised, args: {} });
    expect(r.changed).toBe(false);
    expect(r.catalog!.length).toBe(all.length - before);
    expect(advertised.size).toBe(before);
  });

  it("with enable adds tools, returns their schemas, reports unknown names", () => {
    const advertised = coreNames();
    const r = handleDiscover({
      all, advertised,
      args: { enable: ["browser_downloadSpreadsheet", "browser_storage", "browser_nope"] }
    });
    expect(r.changed).toBe(true);
    expect(r.enabled!.map((t) => t.name)).toEqual(["browser_downloadSpreadsheet", "browser_storage"]);
    expect(r.enabled![0].inputSchema).toBeTruthy();
    expect(r.unknown).toEqual(["browser_nope"]);
    expect(advertised.has("browser_downloadSpreadsheet")).toBe(true);
  });

  it("returns the schema for an already advertised tool without reporting a state change", () => {
    const advertised = coreNames();
    const r = handleDiscover({ all, advertised, args: { enable: ["browser_click"] } });
    expect(r.changed).toBe(false);
    expect(r.enabled!.map((t) => t.name)).toEqual(["browser_click"]);
    expect(r.enabled![0].inputSchema).toBeTruthy();
  });

  it("profile=core returns every core schema without growing the default state", () => {
    const advertised = coreNames();
    const r = handleDiscover({ all, advertised, args: { profile: "core" } });
    expect(r.changed).toBe(false);
    expect(r.enabled!.map((t) => t.name).sort()).toEqual([...coreNames()].sort());
  });

  it("profile=full enables and returns the complete runnable surface", () => {
    const advertised = coreNames();
    const r = handleDiscover({ all, advertised, args: { profile: "full" } });
    expect(r.changed).toBe(true);
    expect(r.enabled).toHaveLength(all.length);
    expect(advertised.size).toBe(all.length);
  });

  it("accepts bare builtin names as a convenience", () => {
    const advertised = coreNames();
    const r = handleDiscover({ all, advertised, args: { enable: ["downloadSpreadsheet"] } });
    expect(r.enabled!.map((t) => t.name)).toEqual(["browser_downloadSpreadsheet"]);
  });

  it("preserves bare names when reporting unknown explicit tools", () => {
    const advertised = coreNames();
    const r = handleDiscover({ all, advertised, args: { enable: ["nope"] } });
    expect(r.unknown).toEqual(["nope"]);
  });

  it("enables a known group directly and deduplicates explicit names", () => {
    const advertised = coreNames();
    const r = handleDiscover({
      all,
      advertised,
      args: {
        enableGroups: ["browser-data"],
        enable: ["browser_searchHistory"]
      }
    });
    expect(r.enabled!.map((t) => t.name)).toEqual([
      "browser_searchHistory",
      "browser_searchBookmarks"
    ]);
    expect(r.unknownGroups).toBeUndefined();
  });

  it("reports unknown groups without blocking valid groups", () => {
    const advertised = coreNames();
    const r = handleDiscover({
      all,
      advertised,
      args: { enableGroups: ["browser-data", "nope"] }
    });
    expect(r.enabled!.map((t) => t.name)).toEqual([
      "browser_searchBookmarks",
      "browser_searchHistory"
    ]);
    expect(r.unknownGroups).toEqual(["nope"]);
    expect(r.changed).toBe(true);
  });

  it("applies worker support filtering to group activation", () => {
    const advertised = coreNames();
    const r = handleDiscover({
      all,
      advertised,
      args: { enableGroups: ["browser-data"] },
      supported: new Set(["searchBookmarks"])
    });
    expect(r.enabled!.map((t) => t.name)).toEqual(["browser_searchBookmarks"]);
    expect(r.unsupported).toEqual(["browser_searchHistory"]);
  });

  it("catalog omits tools the worker cannot run", () => {
    const advertised = coreNames();
    const supported = new Set(["downloadImage"]);
    const r = handleDiscover({ all, advertised, args: {}, supported });
    const names = r.catalog!.map((c) => c.name);
    expect(names).toContain("browser_downloadImage");
    expect(names).not.toContain("browser_downloadSpreadsheet");
    expect(names).not.toContain("browser_storage");
  });

  it("enable routes unsupported names to `unsupported` without advertising them", () => {
    const advertised = coreNames();
    const supported = new Set(["downloadImage", "readStorage"]);
    const r = handleDiscover({
      all, advertised,
      args: { enable: ["browser_storage", "browser_downloadImage"] },
      supported
    });
    expect(r.enabled!.map((t) => t.name)).toEqual(["browser_downloadImage"]);
    expect(r.unsupported).toEqual(["browser_storage"]);
    expect(advertised.has("browser_storage")).toBe(false);
    expect(r.changed).toBe(true);
  });

  it("undefined supported means everything is runnable", () => {
    const advertised = coreNames();
    const before = advertised.size;
    const r = handleDiscover({ all, advertised, args: {} });
    expect(r.catalog!.length).toBe(all.length - before);
  });
});
