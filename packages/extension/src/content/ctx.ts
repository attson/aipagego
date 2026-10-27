import type { Json } from "@aipagego/shared/types";
import { resolveWorkflowValue } from "@aipagego/shared/workflow";

export class RunContext {
  private bindings: Record<string, Json> = {};

  set(name: string, value: Json) {
    this.bindings[name] = value;
  }

  snapshot(): Record<string, Json> {
    return { ...this.bindings };
  }

  resolve(value: Json): Json {
    return resolveWorkflowValue(value, this.bindings);
  }
}
