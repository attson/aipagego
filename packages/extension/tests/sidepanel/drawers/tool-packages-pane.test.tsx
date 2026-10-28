import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSharePackageV1 } from "@aipagego/shared/tool-package";
import type { Tool } from "@aipagego/shared/types";
import { ToolPackagesPane } from "@/sidepanel/drawers/tool-packages-pane";

const rpcMocks = vi.hoisted(() => ({
  listTools: vi.fn(),
  exportToolSharePackage: vi.fn(),
  previewToolImport: vi.fn(),
  commitToolImport: vi.fn(),
}));
vi.mock("@/sidepanel/rpc", () => ({ rpc: rpcMocks }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function tool(id: string, name: string, host: string, toolName: "extractText" | "submitForm"): Tool {
  return {
    kind: "steps",
    id,
    name,
    description: "",
    urlPatterns: [`https://${host}/**`],
    activeVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    versions: [{
      version: 1,
      kind: "steps",
      parameters: [],
      steps: [{ kind: "tool", tool: toolName, args: { selector: "main" } }],
      outputSchema: {},
      createdAt: 1,
    }],
    stats: { runs: 3 },
  };
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("ToolPackagesPane", () => {
  let host: HTMLDivElement;
  let root: Root;
  const createObjectURL = vi.fn(() => "blob:tool-package");
  const revokeObjectURL = vi.fn();
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    rpcMocks.listTools.mockReset();
    rpcMocks.exportToolSharePackage.mockReset();
    rpcMocks.previewToolImport.mockReset();
    rpcMocks.commitToolImport.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    anchorClick.mockClear();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("reviews selected tools with host, capability and severity before download", async () => {
    const read = tool("read-1", "Reader", "docs.example.com", "extractText");
    const submit = tool("submit-1", "Submitter", "shop.example.com", "submitForm");
    rpcMocks.listTools.mockResolvedValue([read, submit]);
    const bundle: ToolSharePackageV1 = {
      schema: "aipagego.tool-package/v1",
      exportedAt: 1_700_000_000_000,
      package: { name: "Research kit", description: "Portable" },
      tools: [read, submit].map((item) => ({ ...item, stats: { runs: 0 } })),
    };
    rpcMocks.exportToolSharePackage.mockResolvedValue(bundle);

    await act(async () => root.render(<ToolPackagesPane />));
    await act(async () => undefined);

    expect(host.textContent).toContain("docs.example.com");
    expect(host.textContent).toContain("read:dom");
    expect(host.textContent).toContain("safe");
    expect(host.textContent).toContain("submit:form");
    expect(host.textContent).toContain("dangerous");

    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    await act(async () => checkboxes.forEach((checkbox) => checkbox.click()));
    await act(async () => {
      changeValue(host.querySelector<HTMLInputElement>('input[aria-label="工具包名称"]')!, "Research kit");
      changeValue(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="工具包描述"]')!, "Portable");
    });
    const review = [...host.querySelectorAll("button")].find((button) => button.textContent === "审查并生成");
    await act(async () => review?.click());

    expect(rpcMocks.exportToolSharePackage).toHaveBeenCalledWith(
      ["read-1", "submit-1"],
      "Research kit",
      "Portable",
    );
    await vi.waitFor(() => expect(host.textContent).toContain("未发现 literal secret"));
    expect(host.textContent).toContain("未发现 literal secret");
    expect(host.textContent).toContain("不包含 Job、历史、结果、connector、凭据或原使用统计");
    expect(host.textContent).toMatch(/package digest: [a-f0-9]{12}/);

    const download = [...host.querySelectorAll("button")].find((button) => button.textContent === "下载安全工具包");
    await act(async () => download?.click());
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchorClick).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:tool-package");
  });

  it("previews import risks and commits per-tool conflict choices after dangerous confirmation", async () => {
    rpcMocks.listTools.mockResolvedValue([]);
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [{ id: "incoming" }] };
    rpcMocks.previewToolImport.mockResolvedValue({
      schema: "aipagego.tools/v3",
      digest: "b".repeat(64),
      secretFindings: [{ rule: "sensitive-key-literal", path: "$.tools[1].token" }],
      items: [
        {
          index: 0,
          valid: true,
          toolId: "incoming",
          name: "Submit orders",
          kind: "steps",
          activeVersion: 2,
          urlPatterns: ["https://shop.example/**"],
          hosts: ["shop.example"],
          capabilities: ["submit:form"],
          severity: "dangerous",
          dangerousSteps: ["v2 step 1: submitForm"],
          conflict: true,
          dependentJobs: 1,
          suggestedAction: "copy",
        },
        {
          index: 1,
          valid: false,
          urlPatterns: [],
          hosts: [],
          capabilities: [],
          severity: "dangerous",
          dangerousSteps: [],
          conflict: false,
          dependentJobs: 0,
          suggestedAction: "copy",
          errorCode: "package_unknown_capability",
        },
      ],
    });
    rpcMocks.commitToolImport.mockResolvedValue({
      items: [
        { index: 0, status: "imported", id: "incoming" },
        { index: 1, status: "rejected", code: "package_unknown_capability" },
      ],
    });

    await act(async () => root.render(<ToolPackagesPane />));
    await act(async () => undefined);
    const fileInput = host.querySelector<HTMLInputElement>('input[aria-label="导入工具 JSON"]')!;
    const file = new File([JSON.stringify(bundle)], "tools.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(rpcMocks.previewToolImport).toHaveBeenCalledWith(bundle));

    expect(host.textContent).toContain("bbbbbbbbbbbb");
    expect(host.textContent).toContain("shop.example");
    expect(host.textContent).toContain("submit:form");
    expect(host.textContent).toContain("v2 step 1: submitForm");
    expect(host.textContent).toContain("1 个依赖 Job");
    expect(host.textContent).toContain("package_unknown_capability");
    expect(host.textContent).toContain("sensitive-key-literal");

    const strategy = host.querySelector<HTMLSelectElement>('select[aria-label="导入策略 0"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(strategy, "overwrite");
      strategy.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const approval = host.querySelector<HTMLInputElement>('input[aria-label="确认导入危险工具"]')!;
    await act(async () => approval.click());
    const commit = [...host.querySelectorAll("button")].find((button) => button.textContent === "确认导入");
    await act(async () => commit?.click());

    expect(rpcMocks.commitToolImport).toHaveBeenCalledWith({
      bundle,
      digest: "b".repeat(64),
      decisions: [
        { index: 0, action: "overwrite" },
        { index: 1, action: "copy" },
      ],
      approveDangerous: true,
    });
    expect(host.textContent).toContain("已导入 1 个，拒绝 1 个");
  });

  it("surfaces malformed files and digest changes without claiming an import", async () => {
    rpcMocks.listTools.mockResolvedValue([]);
    await act(async () => root.render(<ToolPackagesPane />));
    await act(async () => undefined);
    const fileInput = host.querySelector<HTMLInputElement>('input[aria-label="导入工具 JSON"]')!;

    const malformed = new File(["{"], "broken.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [malformed] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(host.querySelector('[data-state="error"]')).toBeTruthy());
    expect(rpcMocks.previewToolImport).not.toHaveBeenCalled();

    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [] };
    rpcMocks.previewToolImport.mockResolvedValue({
      schema: "aipagego.tools/v3",
      digest: "c".repeat(64),
      secretFindings: [],
      items: [],
    });
    rpcMocks.commitToolImport.mockRejectedValue(new Error("import_digest_changed"));
    const valid = new File([JSON.stringify(bundle)], "valid.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [valid] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("cccccccccccc"));
    const commit = [...host.querySelectorAll("button")].find((button) => button.textContent === "确认导入");
    await act(async () => commit?.click());

    expect(host.textContent).toContain("import_digest_changed");
    expect(host.textContent).not.toContain("已导入 0 个");
  });

  it("keeps a successful commit visible and prevents duplicate submission when refresh fails", async () => {
    rpcMocks.listTools
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("refresh offline"));
    const bundle = { schema: "aipagego.tools/v3", exportedAt: 1, tools: [] };
    rpcMocks.previewToolImport.mockResolvedValue({
      schema: "aipagego.tools/v3",
      digest: "d".repeat(64),
      secretFindings: [],
      items: [],
    });
    rpcMocks.commitToolImport.mockResolvedValue({
      items: [{ index: 0, status: "imported", id: "imported-once" }],
    });

    await act(async () => root.render(<ToolPackagesPane />));
    await act(async () => undefined);
    const fileInput = host.querySelector<HTMLInputElement>('input[aria-label="导入工具 JSON"]')!;
    const file = new File([JSON.stringify(bundle)], "valid.json", { type: "application/json" });
    Object.defineProperty(fileInput, "files", { configurable: true, value: [file] });
    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    await vi.waitFor(() => expect(host.textContent).toContain("dddddddddddd"));
    const commit = [...host.querySelectorAll("button")].find((button) => button.textContent === "确认导入")!;
    await act(async () => commit.click());

    expect(host.textContent).toContain("已导入 1 个");
    expect(host.textContent).toContain("导入已完成，但工具列表刷新失败");
    expect(commit.disabled).toBe(true);
    await act(async () => commit.click());
    expect(rpcMocks.commitToolImport).toHaveBeenCalledOnce();
  });
});
