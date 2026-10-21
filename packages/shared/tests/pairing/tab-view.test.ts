import { describe, expect, it } from "vitest";
import { deriveTabView } from "../../src/pairing/tab-view";

const tabs = [
  { tab_id: "1", url: "https://a.test", title: "A" },
  { tab_id: "2", url: "https://b.test", title: "B" },
  { tab_id: "3", url: "https://c.test", title: "C" }
];

const owners = {
  "1": { connectionId: "conn-a", label: "~/code/aipagego" },
  "2": { connectionId: "conn-b", label: "~/code/wanxin" }
};

describe("deriveTabView", () => {
  it("marks the viewer's own tabs as mine, not busy", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[0]).toMatchObject({ tab_id: "1", mine: true, busy: false });
    expect(v[0].busy_label).toBeUndefined();
  });

  it("marks tabs owned by others as busy and names the owner", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[1]).toMatchObject({
      tab_id: "2",
      mine: false,
      busy: true,
      busy_label: "~/code/wanxin"
    });
  });

  it("leaves unowned tabs free", () => {
    const v = deriveTabView(tabs, owners, "conn-a");
    expect(v[2]).toMatchObject({ tab_id: "3", mine: false, busy: false });
    expect(v[2].busy_label).toBeUndefined();
  });

  it("gives each connection its own view of the same state", () => {
    const a = deriveTabView(tabs, owners, "conn-a");
    const b = deriveTabView(tabs, owners, "conn-b");
    expect(a[0].busy).toBe(false);
    expect(b[0].busy).toBe(true);
    expect(a[1].busy).toBe(true);
    expect(b[1].busy).toBe(false);
  });

  it("preserves url and title", () => {
    expect(deriveTabView(tabs, {}, "conn-a")[0]).toMatchObject({
      url: "https://a.test",
      title: "A"
    });
  });

  it("treats an empty owner map as everything free", () => {
    expect(deriveTabView(tabs, {}, "conn-a").every((t) => !t.busy && !t.mine)).toBe(true);
  });
});
