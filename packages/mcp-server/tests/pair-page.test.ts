import { describe, expect, it } from "vitest";
import { renderPairPage } from "../src/pair-page";
import type { PairPayload } from "@aipagego/shared/pairing";

const payload: PairPayload = {
  v: 1,
  installId: "inst_abc",
  secret: "s3cr3t",
  sessionId: "sess_1",
  label: "~/code/aipagego",
  pid: 1234,
  port: 51234,
  mcpVersion: "0.0.75"
};

describe("renderPairPage", () => {
  it("embeds the payload and posts it", () => {
    const html = renderPairPage(payload);
    expect(html).toContain("aipagego-pair");
    expect(html).toContain("window.postMessage");
    expect(html).toContain("inst_abc");
    expect(html).toContain("51234");
  });

  it("shows the session label, pid and port to the user", () => {
    const html = renderPairPage(payload);
    expect(html).toContain("~/code/aipagego");
    expect(html).toContain("pid 1234");
    expect(html).toContain("MCP v0.0.75");
  });

  it("escapes the label so a directory name cannot inject markup", () => {
    const html = renderPairPage({ ...payload, label: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("escapes < inside the embedded JSON so it cannot close the script block", () => {
    const html = renderPairPage({ ...payload, label: "</script><b>" });
    expect(html).toContain("\\u003c/script");
    // The only real </script> is the page's own closing tag.
    expect(html.match(/<\/script>/g)).toHaveLength(1);
  });

  it("tells the user what to do when nothing responds", () => {
    expect(renderPairPage(payload)).toContain("扩展");
  });

  it("distinguishes connection failure from explicit denial", () => {
    const html = renderPairPage(payload);
    expect(html).toContain('e.data.reason === "denied"');
    expect(html).toContain("连接扩展失败");
  });

  it("keeps the page open and shows an extension-supplied version warning", () => {
    const html = renderPairPage(payload);
    expect(html).toContain("e.data.versionWarning");
    expect(html).toContain("版本提醒");
    expect(html).toContain("window.close");
  });

  it("reports explicit denial to the local server so the pending call can stop", () => {
    const html = renderPairPage(payload);
    expect(html).toContain('fetch("/pair/decision"');
    expect(html).toContain('decision: "denied"');
    expect(html).toContain("sessionId: payload.sessionId");
    expect(html).toContain("secret: payload.secret");
  });
});

describe("renderPairPage — install ordering", () => {
  const html = renderPairPage(payload);

  it("answers the relay's ready announcement", () => {
    expect(html).toContain("aipagego-pair-ready");
  });

  it("keeps announcing rather than posting once", () => {
    // The page's inline script runs while parsing; the relay installs at
    // document_idle. A single post would be heard by nobody.
    expect(html).toContain("setInterval");
    expect(html).toContain("announce");
  });

  it("gives up eventually and says why", () => {
    expect(html).toContain("clearInterval");
    expect(html).toContain("没有联系上扩展");
  });

  it("stops announcing once a result arrives", () => {
    expect(html).toContain("done = true");
  });
});
