import type { BuiltinTool, Json } from "@aipagego/shared/types";
import { click } from "./click";
import { clickByUid } from "./click-by-uid";
import { extractFormState } from "./extract-form-state";
import { extractImages } from "./extract-images";
import { extractText } from "./extract-text";
import { fillByUid } from "./fill-by-uid";
import { drag } from "./drag";
import { drop } from "./drop";
import { findElements } from "./find-elements";
import { inspectElement } from "./inspect-element";
import { fillForm } from "./fill-form";
import { fillInput } from "./fill-input";
import { focus } from "./focus";
import { getValue } from "./get-value";
import { highlightElement, highlightText } from "./highlight";
import { hover } from "./hover";
import { httpRequestBridge } from "./http-request";
import { querySelector, querySelectorAll } from "./query";
import { readStorage } from "./read-storage";
import { scroll } from "./scroll";
import { selectOption } from "./select-option";
import { setCheckbox } from "./set-checkbox";
import { snapshotDOM } from "./snapshot-dom";
import { submitForm } from "./submit-form";
import { takeSnapshot } from "./take-snapshot";
import { uploadFile } from "./upload-file";
import { waitFor } from "./wait-for";
import { navigate } from "./navigate";
import { getPageInfo } from "./get-page-info";
import { pressKey } from "./press-key";
import { writeStorage } from "./write-storage";
import { createPageIndex, extractPageFields, readPageBlock, searchPageIndex } from "./page-index";

export type ToolFn = (args: Json) => Promise<Json>;

export const TOOLS: Partial<Record<BuiltinTool, ToolFn>> = {
  snapshotDOM,
  querySelector,
  querySelectorAll,
  extractText,
  extractImages,
  scroll,
  waitFor,
  click,
  readStorage,
  httpRequest: httpRequestBridge,
  fillInput,
  setCheckbox,
  selectOption,
  submitForm,
  hover,
  focus,
  uploadFile,
  getValue,
  extractFormState,
  // Round 5 — UID-based + visual + batch
  takeSnapshot,
  clickByUid,
  fillByUid,
  highlightElement,
  highlightText,
  fillForm,
  // Round 6 — common helpers
  navigate,
  getPageInfo,
  pressKey,
  writeStorage,
  // Plan 32 — playwright parity
  drag,
  drop,
  findElements,
  inspectElement,
  // Page Context Index
  createPageIndex,
  searchPageIndex,
  readPageBlock,
  extractPageFields
};

export async function callTool(name: BuiltinTool, args: Json): Promise<Json> {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`tool not implemented: ${name}`);
  return fn(args);
}
