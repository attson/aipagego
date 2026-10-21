import type { Json } from "@aipagego/shared/types";

type Args = {
  to: "bottom" | "top" | number;
  max?: number;
  intervalMs?: number;
  untilSelector?: string;
};

export async function scroll(args: Json): Promise<Json> {
  const { to, max = 1, intervalMs = 250, untilSelector } = (args ?? {}) as Args;
  let iterations = 0;
  let foundUntil = false;

  for (let i = 0; i < max; i++) {
    iterations++;
    if (typeof to === "number") {
      window.scrollTo({ top: to, behavior: "instant" as ScrollBehavior });
    } else if (to === "top") {
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    } else {
      window.scrollTo({
        top: document.documentElement.scrollHeight,
        behavior: "instant" as ScrollBehavior
      });
    }

    if (untilSelector && document.querySelector(untilSelector)) {
      foundUntil = true;
      break;
    }
    if (typeof to === "number" || to === "top") break;
    await sleep(intervalMs);
  }

  return { iterations, foundUntil };
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}
