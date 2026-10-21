import { describe, expect, it, vi } from "vitest";
import { TabOwnership } from "@/background/tab-ownership";
import { deriveTabView } from "@aipagego/shared/pairing";

const a = { connectionId: "conn-a", sessionId: "sess-a", label: "~/code/aipagego" };
const b = { connectionId: "conn-b", sessionId: "sess-b", label: "~/code/wanxin" };

describe("TabOwnership", () => {
  it("records who claimed a tab", () => {
    const o = new TabOwnership();
    o.claim("42", a);
    expect(o.owners()).toEqual({ "42": { connectionId: "conn-a", label: "~/code/aipagego" } });
  });

  it("releasing by session clears only that session's tabs", () => {
    const o = new TabOwnership();
    o.claim("1", a);
    o.claim("2", b);
    o.releaseBySession("sess-a");
    expect(Object.keys(o.owners())).toEqual(["2"]);
  });

  it("a dropped connection releases everything it held", () => {
    const o = new TabOwnership();
    o.claim("1", a);
    o.claim("2", a);
    o.claim("3", b);
    o.releaseByConnection("conn-a");
    expect(Object.keys(o.owners())).toEqual(["3"]);
  });

  it("closing a tab releases it", () => {
    const o = new TabOwnership();
    o.claim("1", a);
    o.releaseTab("1");
    expect(o.size).toBe(0);
  });

  it("notifies on claim and release", () => {
    const o = new TabOwnership();
    const fn = vi.fn();
    o.onChange(fn);
    o.claim("1", a);
    o.releaseTab("1");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not notify when nothing changed", () => {
    const o = new TabOwnership();
    const fn = vi.fn();
    o.onChange(fn);
    o.releaseTab("nope");
    o.releaseBySession("nobody");
    expect(fn).not.toHaveBeenCalled();
  });

  it("unsubscribing stops notifications", () => {
    const o = new TabOwnership();
    const fn = vi.fn();
    o.onChange(fn)();
    o.claim("1", a);
    expect(fn).not.toHaveBeenCalled();
  });

  it("re-claiming a tab transfers it", () => {
    const o = new TabOwnership();
    o.claim("1", a);
    o.claim("1", b);
    expect(o.ownerOf("1")?.sessionId).toBe("sess-b");
  });

  it("feeds deriveTabView so each connection sees its own view", () => {
    const o = new TabOwnership();
    o.claim("1", a);
    const tabs = [{ tab_id: "1", url: "https://a.test" }];
    expect(deriveTabView(tabs, o.owners(), "conn-a")[0]).toMatchObject({ mine: true, busy: false });
    expect(deriveTabView(tabs, o.owners(), "conn-b")[0]).toMatchObject({
      mine: false,
      busy: true,
      busy_label: "~/code/aipagego"
    });
  });
});
