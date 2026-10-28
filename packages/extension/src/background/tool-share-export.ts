import {
  ToolSharePackageV1Schema,
  assertNoLiteralSecrets,
  createPortableToolSnapshot,
  type ToolSharePackageV1,
} from "@aipagego/shared/tool-package";
import { listTools } from "./storage/tools";

export type ToolShareExportInput = {
  toolIds: string[];
  name: string;
  description?: string;
};

export async function exportToolSharePackage(
  input: ToolShareExportInput,
): Promise<ToolSharePackageV1> {
  if (input.toolIds.length === 0 || new Set(input.toolIds).size !== input.toolIds.length) {
    throw new Error("invalid_tool_selection");
  }

  const byId = new Map((await listTools()).map((tool) => [tool.id, tool]));
  const tools = input.toolIds.map((id) => {
    const tool = byId.get(id);
    if (!tool) throw new Error(`tool_not_found: ${id}`);
    return createPortableToolSnapshot(tool);
  });
  const candidate = {
    schema: "aipagego.tool-package/v1" as const,
    exportedAt: Date.now(),
    package: {
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
    },
    tools,
  };
  const bundle = ToolSharePackageV1Schema.parse(candidate);
  assertNoLiteralSecrets(bundle);
  return bundle;
}
