import { describe, expect, it } from "vitest";
import { parseDemoScene, sceneCaption } from "../../demo/scene-mode";
import { roundsForScene } from "../../demo/scenario";

describe("store demo scenes", () => {
  it("selects a known scene and safely falls back to task", () => {
    expect(parseDemoScene("?scene=onboarding")).toBe("onboarding");
    expect(parseDemoScene("?scene=approval")).toBe("approval");
    expect(parseDemoScene("?scene=unknown")).toBe("task");
  });

  it("gives every store scene a truthful caption", () => {
    for (const scene of ["onboarding", "task", "solidify", "approval"] as const) {
      expect(sceneCaption(scene).length).toBeGreaterThan(8);
    }
  });

  it("uses a dangerous submit only in the approval scene", () => {
    const approvalTools = roundsForScene("approval").flatMap((round) =>
      round.filter((event) => event.type === "tool_use_start").map((event) => event.name),
    );
    const taskTools = roundsForScene("task").flatMap((round) =>
      round.filter((event) => event.type === "tool_use_start").map((event) => event.name),
    );
    expect(approvalTools).toEqual(["submitForm"]);
    expect(taskTools).not.toContain("submitForm");
  });
});
