export const DEMO_SCENES = ["onboarding", "task", "solidify", "approval"] as const;

export type DemoScene = (typeof DEMO_SCENES)[number];

/** Keep public demo URLs stable and fall back to the normal task scene. */
export function parseDemoScene(search: string): DemoScene {
  const value = new URLSearchParams(search).get("scene");
  return DEMO_SCENES.includes(value as DemoScene) ? (value as DemoScene) : "task";
}

export function sceneCaption(scene: DemoScene): string {
  switch (scene) {
    case "onboarding":
      return "首次使用 · 密钥只存本机，敏感权限按需询问";
    case "task":
      return "真实任务 · AI 正在读取并操作左侧演示页面";
    case "solidify":
      return "完成任务 · 成功步骤可固化为可重放工具";
    case "approval":
      return "危险操作 · 执行前必须由用户明确确认";
  }
}
