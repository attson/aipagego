export type CollectionAdvanceResult = {
  status: "clicked" | "missing" | "disabled";
};

function clickCollectionControl(
  selector: string,
  root: Document = document
): CollectionAdvanceResult {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) return { status: "missing" };
  if (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.matches(":disabled")
  ) {
    return { status: "disabled" };
  }
  element.click();
  return { status: "clicked" };
}

export function advanceCollectionNext(
  selector: string,
  root: Document = document
): CollectionAdvanceResult {
  return clickCollectionControl(selector, root);
}

export function advanceCollectionLoadMore(
  selector: string,
  root: Document = document
): CollectionAdvanceResult {
  return clickCollectionControl(selector, root);
}

export function advanceCollectionInfiniteScroll(
  target: Window = window,
  root: Document = document
): { status: "scrolled" } {
  target.scrollTo({ top: root.documentElement.scrollHeight, behavior: "auto" });
  return { status: "scrolled" };
}
