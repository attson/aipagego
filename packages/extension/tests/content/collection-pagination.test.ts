import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceCollectionInfiniteScroll,
  advanceCollectionLoadMore,
  advanceCollectionNext,
} from "@/content/collection-pagination";

describe("advanceCollectionNext", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clicks an enabled next control", () => {
    document.body.innerHTML = '<button class="next">下一页</button>';
    const click = vi.fn();
    document.querySelector<HTMLButtonElement>(".next")!.click = click;

    expect(advanceCollectionNext(".next")).toEqual({ status: "clicked" });
    expect(click).toHaveBeenCalledOnce();
  });

  it("reports missing and native disabled controls without clicking", () => {
    expect(advanceCollectionNext(".next")).toEqual({ status: "missing" });
    document.body.innerHTML = '<button class="next" disabled>下一页</button>';
    const click = vi.spyOn(document.querySelector<HTMLButtonElement>(".next")!, "click");

    expect(advanceCollectionNext(".next")).toEqual({ status: "disabled" });
    expect(click).not.toHaveBeenCalled();
  });

  it("treats aria-disabled as disabled", () => {
    document.body.innerHTML = '<a class="next" aria-disabled="true">下一页</a>';
    const click = vi.spyOn(document.querySelector<HTMLAnchorElement>(".next")!, "click");

    expect(advanceCollectionNext(".next")).toEqual({ status: "disabled" });
    expect(click).not.toHaveBeenCalled();
  });
});

describe("advanceCollectionLoadMore", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clicks only an enabled configured control", () => {
    document.body.innerHTML = '<button class="load-more">加载更多</button>';
    const click = vi.fn();
    document.querySelector<HTMLButtonElement>(".load-more")!.click = click;

    expect(advanceCollectionLoadMore(".load-more")).toEqual({ status: "clicked" });
    expect(click).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", ""],
    ["disabled", '<button class="load-more" aria-disabled="true">加载更多</button>'],
  ] as const)("reports %s without clicking", (status, markup) => {
    document.body.innerHTML = markup;
    const element = document.querySelector<HTMLButtonElement>(".load-more");
    const click = element ? vi.spyOn(element, "click") : null;

    expect(advanceCollectionLoadMore(".load-more")).toEqual({ status });
    if (click) expect(click).not.toHaveBeenCalled();
  });
});

describe("advanceCollectionInfiniteScroll", () => {
  it("scrolls to the current document bottom", () => {
    const scrollTo = vi.fn();
    Object.defineProperty(document.documentElement, "scrollHeight", {
      configurable: true,
      value: 4321,
    });

    expect(advanceCollectionInfiniteScroll({ scrollTo } as unknown as Window)).toEqual({
      status: "scrolled",
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 4321, behavior: "auto" });
  });
});
