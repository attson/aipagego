import { describe, expect, it } from "vitest";
import {
  createPortableToolSnapshot,
  scanLiteralSecrets,
  ToolSharePackageV1Schema,
  computeToolPackageDigest,
  type ToolSharePackageV1,
} from "../src/tool-package";
import type { PromptTool, StepsTool } from "../src/types";

function promptPackage(): ToolSharePackageV1 {
  return {
    schema: "aipagego.tool-package/v1",
    exportedAt: 1_700_000_000_000,
    package: { name: "Demo", description: "portable" },
    tools: [{
      kind: "prompt",
      id: "prompt-1",
      name: "Prompt",
      urlPatterns: ["https://example.com/**"],
      description: "",
      prompt: "Summarize",
      createdAt: 1,
      updatedAt: 2,
      versions: [{ version: 1, kind: "prompt", prompt: "Summarize", createdAt: 2 }],
      stats: { runs: 0 },
    }],
  };
}

describe("ToolSharePackageV1", () => {
  it("accepts the portable v1 package contract and rejects extra runtime fields", () => {
    expect(ToolSharePackageV1Schema.safeParse(promptPackage()).success).toBe(true);
    expect(ToolSharePackageV1Schema.safeParse({
      ...promptPackage(),
      connectorBindings: [{ connectorId: "local-only" }],
    }).success).toBe(false);
  });

  it("computes the SHA-256 digest from canonical JSON key ordering", async () => {
    await expect(computeToolPackageDigest(promptPackage())).resolves.toBe(
      "5bd67234df2aa2c3295ca6707d04ef682a7c4107b9aac9983f45e053ec456296",
    );
  });

  it("exports only the active steps snapshot as v1 without mutating the source tool", () => {
    const tool: StepsTool = {
      kind: "steps",
      id: "steps-1",
      name: "Collector",
      description: "collect",
      urlPatterns: ["https://shop.example/**"],
      activeVersion: 3,
      createdAt: 10,
      updatedAt: 30,
      versions: [
        {
          version: 1,
          kind: "steps",
          parameters: [],
          steps: [{ kind: "tool", tool: "extractText", args: { selector: ".old" } }],
          outputSchema: { type: "string" },
          createdAt: 10,
        },
        {
          version: 3,
          kind: "steps",
          parameters: [{ key: "query", label: "Query", type: "string", required: true }],
          steps: [{ kind: "tool", tool: "extractText", args: { selector: "${query}" } }],
          outputBinding: "result",
          outputSchema: { type: "string" },
          createdAt: 30,
          note: "active",
          basedOnVersion: 1,
        },
      ],
      stats: { runs: 12, lastRunAt: 40, lastRunOk: true },
      origin: { kind: "preset", presetId: "shop", presetVersion: 2 },
    };
    const before = structuredClone(tool);

    const portable = createPortableToolSnapshot(tool);

    expect(portable).toEqual({
      ...tool,
      activeVersion: 1,
      versions: [{
        version: 1,
        kind: "steps",
        parameters: [{ key: "query", label: "Query", type: "string", required: true }],
        steps: [{ kind: "tool", tool: "extractText", args: { selector: "${query}" } }],
        outputBinding: "result",
        outputSchema: { type: "string" },
        createdAt: 30,
        note: "active",
      }],
      stats: { runs: 0 },
      origin: undefined,
    });
    expect(tool).toEqual(before);
  });

  it("exports the current prompt as the only v1 definition and resets local metadata", () => {
    const tool: PromptTool = {
      kind: "prompt",
      id: "prompt-2",
      name: "Writer",
      description: "write",
      urlPatterns: ["https://docs.example/**"],
      prompt: "Current prompt",
      createdAt: 10,
      updatedAt: 30,
      versions: [
        { version: 1, kind: "prompt", prompt: "Old prompt", createdAt: 10 },
        { version: 4, kind: "prompt", prompt: "Current prompt", createdAt: 30, note: "active" },
      ],
      stats: { runs: 8, lastRunAt: 40 },
      origin: { kind: "preset", presetId: "writer", presetVersion: 1 },
    };

    expect(createPortableToolSnapshot(tool)).toEqual({
      ...tool,
      versions: [{ version: 1, kind: "prompt", prompt: "Current prompt", createdAt: 30, note: "active" }],
      stats: { runs: 0 },
      origin: undefined,
    });
  });

  it.each([
    ["sensitive-key-literal", { authorization: "top-secret-auth" }, "$.authorization"],
    ["sensitive-key-literal", { headers: { Cookie: "sid=top-secret-cookie" } }, "$.headers.Cookie"],
    ["sensitive-key-literal", { apiKey: "top-secret-key" }, "$.apiKey"],
    ["sensitive-key-literal", { token: "top-secret-token" }, "$.token"],
    ["sensitive-key-literal", { secret: "top-secret-value" }, "$.secret"],
    ["sensitive-key-literal", { password: "top-secret-password" }, "$.password"],
    ["authorization-scheme", { value: "Bearer abcdefghijklmnopqrstuvwxyz" }, "$.value"],
    ["authorization-scheme", { value: "Basic dXNlcjpwYXNzd29yZA==" }, "$.value"],
    ["cookie-header", { source: "fetch(url, { headers: { Cookie: 'sid=top-secret-cookie' } })" }, "$.source"],
    ["token-pattern", { value: "sk-abcdefghijklmnopqrstuvwxyz123456" }, "$.value"],
    ["token-pattern", { value: "ghp_abcdefghijklmnopqrstuvwxyz1234567890" }, "$.value"],
    ["token-pattern", { value: "github_pat_abcdefghijklmnopqrstuvwxyz1234567890" }, "$.value"],
    ["private-key", { value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" }, "$.value"],
    ["url-userinfo", { url: "https://alice:password@example.com/hook" }, "$.url"],
    ["url-userinfo", { prompt: "Send to https://alice:password@example.com/hook now" }, "$.prompt"],
    ["url-sensitive-query", { url: "https://example.com/hook?signature=top-secret-signature" }, "$.url"],
  ])("reports %s using only a JSON path", (rule, value, path) => {
    const findings = scanLiteralSecrets(value);
    expect(findings).toContainEqual({ rule, path });
    expect(JSON.stringify(findings)).not.toContain("top-secret");
    expect(JSON.stringify(findings)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("allows sensitive parameter references but rejects defaults on sensitive parameters", () => {
    const value = {
      versions: [{
        parameters: [
          { key: "apiToken", label: "API token", type: "string", required: true, sensitive: true },
          { key: "cookie", label: "Cookie", type: "string", required: false, sensitive: true, defaultValue: "sid=secret" },
        ],
        steps: [{
          args: {
            headers: {
              Authorization: "Bearer ${apiToken}",
              Cookie: "${cookie}",
            },
            url: "https://example.com/hook?token=${apiToken}",
          },
        }],
      }],
    };

    expect(scanLiteralSecrets(value)).toEqual([
      {
        rule: "sensitive-parameter-default",
        path: "$.versions[0].parameters[1].defaultValue",
      },
    ]);
  });

  it("does not mistake a JSON Schema property declaration for a credential value", () => {
    expect(scanLiteralSecrets({
      outputSchema: {
        type: "object",
        properties: {
          token: { type: "string" },
          password: { type: "string" },
        },
      },
    })).toEqual([]);
  });

  it("detects a literal nested inside a credential envelope", () => {
    expect(scanLiteralSecrets({
      credential: {
        password: { value: "nested-secret-value" },
      },
    })).toContainEqual({
      rule: "sensitive-key-literal",
      path: "$.credential.password",
    });
  });
});
