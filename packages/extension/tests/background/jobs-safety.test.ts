import { describe, expect, it } from "vitest";
import type { StepsToolVersion } from "@aipagego/shared/types";
import { classifyJobWorkflow } from "@/background/jobs/safety";

function snapshot(
  step: StepsToolVersion["steps"][number],
  parameters: StepsToolVersion["parameters"] = [],
): StepsToolVersion {
  return {
    version: 1,
    kind: "steps",
    parameters,
    steps: [step],
    outputSchema: {},
    createdAt: 1,
  };
}

describe("classifyJobWorkflow", () => {
  it("classifies safe, caution and fixed dangerous tools", () => {
    expect(classifyJobWorkflow(snapshot({
      kind: "tool",
      tool: "extractText",
      args: { selector: "h1" },
    }), {})).toBe("safe");
    expect(classifyJobWorkflow(snapshot({
      kind: "tool",
      tool: "fillInput",
      args: { selector: "#q", value: "x" },
    }), {})).toBe("caution");
    expect(classifyJobWorkflow(snapshot({
      kind: "tool",
      tool: "submitForm",
      args: { selector: "form" },
    }), {})).toBe("dangerous");
  });

  it("uses resolved parameters but treats earlier-step risk bindings as dangerous", () => {
    const parameter = {
      key: "credentials",
      label: "Credentials",
      type: "boolean" as const,
      required: true,
    };
    expect(classifyJobWorkflow(snapshot({
      kind: "tool",
      tool: "httpRequest",
      args: { url: "https://example.com", withCredentials: "${credentials}" },
    }, [parameter]), { credentials: false })).toBe("caution");

    const dynamic: StepsToolVersion = {
      version: 1,
      kind: "steps",
      parameters: [],
      steps: [
        { kind: "tool", tool: "extractText", args: { selector: "#flag" }, bindResultTo: "flag" },
        {
          kind: "tool",
          tool: "httpRequest",
          args: { url: "https://example.com", withCredentials: "${flag}" },
        },
      ],
      outputSchema: {},
      createdAt: 1,
    };
    expect(classifyJobWorkflow(dynamic, {})).toBe("dangerous");
  });

  it("uses static scan for JavaScript steps", () => {
    expect(classifyJobWorkflow(snapshot({
      kind: "js",
      source: "return document.title",
    }), {})).toBe("caution");
    expect(classifyJobWorkflow(snapshot({
      kind: "js",
      source: "return document.cookie",
    }), {})).toBe("dangerous");
  });
});
