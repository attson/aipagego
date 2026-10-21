import type { Json } from "@aipagego/shared/types";
import { resolveTarget } from "./element-meta";

const DEFAULT_STYLE_PROPERTIES = [
  "display",
  "visibility",
  "opacity",
  "position",
  "boxSizing",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "overflow",
  "overflowX",
  "overflowY",
  "zIndex",
  "float",
  "flex",
  "flexDirection",
  "alignItems",
  "justifyContent",
  "gridTemplateColumns",
  "gridTemplateRows",
  "transform"
] as const;

const MAX_ANCESTOR_DEPTH = 10;
const MAX_STYLE_PROPERTIES = 50;

type RectResult = {
  viewport: Record<string, number>;
  document: { x: number; y: number; width: number; height: number };
};

export async function inspectElement(args: Json): Promise<Json> {
  const input = (args ?? {}) as Record<string, unknown>;
  const element = resolveTarget(input, { selector: "selector", uid: "uid" }, "inspectElement");
  const ancestorDepth = clampInteger(input.ancestorDepth, 5, 0, MAX_ANCESTOR_DEPTH);
  const styleProperties = normalizeStyleProperties(input.styleProperties);
  const ancestors: Json[] = [];

  let parent = element.parentElement;
  while (parent && ancestors.length < ancestorDepth) {
    ancestors.push(describeElement(parent, styleProperties));
    parent = parent.parentElement;
  }

  const rootNode = element.getRootNode();
  const shadowRoot = typeof ShadowRoot !== "undefined" && rootNode instanceof ShadowRoot;

  return {
    element: describeElement(element, styleProperties),
    ancestors,
    root: shadowRoot
      ? {
          type: "shadow-root",
          mode: rootNode.mode,
          host: describeIdentity(rootNode.host)
        }
      : { type: "document" },
    truncatedAncestors: parent != null
  } as Json;
}

function describeElement(element: Element, styleProperties: string[]): Json {
  const style = getComputedStyle(element);
  const rect = rectFor(element);
  return {
    ...describeIdentity(element),
    rect: rect as unknown as Json,
    visible:
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number.parseFloat(style.opacity || "1") !== 0 &&
      rect.viewport.bottom > 0 &&
      rect.viewport.right > 0 &&
      rect.viewport.top < window.innerHeight &&
      rect.viewport.left < window.innerWidth,
    styles: Object.fromEntries(
      styleProperties.map((property) => [property, readStyle(style, property)])
    )
  } as Json;
}

function describeIdentity(element: Element): Record<string, Json> {
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id || null,
    classes: Array.from(element.classList).slice(0, 20),
    role: element.getAttribute("role"),
    selectorHint: selectorHint(element)
  };
}

function rectFor(element: Element): RectResult {
  const rect = element.getBoundingClientRect();
  return {
    viewport: {
      x: rect.x,
      y: rect.y,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    },
    document: {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    }
  };
}

function normalizeStyleProperties(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_STYLE_PROPERTIES];
  const properties = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 100)
    .slice(0, MAX_STYLE_PROPERTIES);
  return properties.length > 0 ? [...new Set(properties)] : [...DEFAULT_STYLE_PROPERTIES];
}

function readStyle(style: CSSStyleDeclaration, property: string): string {
  const cssName = property.startsWith("--")
    ? property
    : property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  return style.getPropertyValue(cssName).trim();
}

function selectorHint(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (element.id) return `${tag}#${cssEscape(element.id)}`;
  const classes = Array.from(element.classList).slice(0, 3).map((name) => `.${cssEscape(name)}`).join("");
  return `${tag}${classes}`;
}

function cssEscape(value: string): string {
  const escape = (globalThis.CSS as { escape?: (input: string) => string } | undefined)?.escape;
  return typeof escape === "function" ? escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
