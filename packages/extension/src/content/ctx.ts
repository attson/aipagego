import type { Json } from "@aipagego/shared/types";

export class RunContext {
  private bindings: Record<string, Json> = {};

  set(name: string, value: Json) {
    this.bindings[name] = value;
  }

  snapshot(): Record<string, Json> {
    return { ...this.bindings };
  }

  resolve(value: unknown): Json {
    return resolveDeep(value, this.bindings) as Json;
  }
}

function resolveDeep(value: unknown, bindings: Record<string, Json>): unknown {
  if (typeof value === "string") return substitute(value, bindings);
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, bindings));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, bindings);
    }
    return out;
  }
  return value;
}

function substitute(s: string, bindings: Record<string, Json>): unknown {
  const exact = s.match(/^\$\{([^}]+)\}$/);
  if (exact) {
    const key = exact[1];
    return key in bindings ? bindings[key] : s;
  }
  return s.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = bindings[key];
    if (val == null) return "";
    return typeof val === "string" ? val : JSON.stringify(val);
  });
}
