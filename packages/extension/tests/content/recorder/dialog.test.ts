import { beforeEach, describe, expect, it, vi } from "vitest";
import { install } from "@/content/recorder/main-world";

describe("dialog interception", () => {
  let rec: ReturnType<typeof install>;
  let nativeConfirm: ReturnType<typeof vi.fn>;
  let nativeAlert: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const w = window as unknown as { __AIPAGEGO_REC__?: unknown };
    delete w.__AIPAGEGO_REC__;
    nativeConfirm = vi.fn(() => true);
    nativeAlert = vi.fn();
    window.confirm = nativeConfirm as unknown as typeof window.confirm;
    window.alert = nativeAlert as unknown as typeof window.alert;
    window.prompt = vi.fn(() => "native") as unknown as typeof window.prompt;
    rec = install();
  });

  it("passes through to the native dialog until armed", () => {
    expect(window.confirm("sure?")).toBe(true);
    expect(nativeConfirm).toHaveBeenCalledWith("sure?");
    expect(rec.dialog.toArray().at(-1)!.handled).toBe("passthrough");
  });

  it("ignores a policy while the dialog channel is off", () => {
    rec.setDialogPolicy({ accept: false, scope: "all" });
    expect(window.confirm("sure?")).toBe(true);
    expect(nativeConfirm).toHaveBeenCalled();
  });

  it("answers from the policy once armed", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: false, scope: "all" });
    expect(window.confirm("sure?")).toBe(false);
    expect(nativeConfirm).not.toHaveBeenCalled();
    expect(rec.dialog.toArray().at(-1)!.handled).toBe("dismissed");
  });

  it("returns promptText and consumes a next-scoped policy", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: true, promptText: "typed", scope: "next" });
    expect(window.prompt("name?")).toBe("typed");
    expect(rec.dialogPolicy).toBeNull();
    expect(window.prompt("again?")).toBe("native");
  });

  it("keeps an all-scoped policy across dialogs", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: true, promptText: "x", scope: "all" });
    expect(window.prompt("a")).toBe("x");
    expect(window.prompt("b")).toBe("x");
  });

  it("records the message and kind", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: true, scope: "all" });
    window.alert("hello");
    const e = rec.dialog.toArray().at(-1)!;
    expect(e.kind).toBe("alert");
    expect(e.message).toBe("hello");
    expect(e.handled).toBe("accepted");
    expect(nativeAlert).not.toHaveBeenCalled();
  });

  it("returns null from a dismissed prompt", () => {
    rec.configure({ dialog: true });
    rec.setDialogPolicy({ accept: false, scope: "all" });
    expect(window.prompt("name?")).toBeNull();
  });
});
