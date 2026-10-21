import type { LlmStreamEvent } from "@aipagego/shared/llm";
import type { Json } from "@aipagego/shared/types";

/**
 * The scripted run the homepage demo replays through MockLlmClient.
 *
 * Chosen to exercise the whole loop in a few rounds: page-index first (the
 * behaviour the product actually wants), a uid snapshot, then a caution-tier
 * click so the visitor sees the approval bar rather than just watching an agent
 * do whatever it likes.
 */

export const DEMO_PROMPT = "采集这个商品的标题、价格和前 3 条评论";

/** Delay between rounds so the run reads at human pace. */
export const ROUND_DELAY_MS = 900;

const call = (id: string, name: string, input: Json): LlmStreamEvent[] => [
  { type: "tool_use_start", id, name },
  { type: "tool_use_end", id, input },
  { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
];

const say = (text: string): LlmStreamEvent[] => [
  { type: "text_delta", text },
  { type: "message_end", usage: { input_tokens: 0, output_tokens: 0 } }
];

export const DEMO_ROUNDS: LlmStreamEvent[][] = [
  [
    { type: "text_delta", text: "先给这个页面建个索引，这样不用把整页塞进模型。\n" },
    ...call("t1", "createPageIndex", {})
  ],
  [
    { type: "text_delta", text: "索引好了，直接取标题和价格。\n" },
    ...call("t2", "extractPageFields", { fields: ["标题", "价格"] })
  ],
  [
    { type: "text_delta", text: "评论是折叠的，先拿一份可交互元素快照定位那个按钮。\n" },
    ...call("t3", "takeSnapshot", {})
  ],
  [
    { type: "text_delta", text: "找到「展开全部评论」了。点击属于 caution，需要你确认。\n" },
    ...call("t4", "click", { selector: "#demo-expand-comments" })
  ],
  [
    { type: "text_delta", text: "评论展开了，取前 3 条。\n" },
    ...call("t5", "extractText", { selector: "#demo-comments" })
  ],
  say(
    "采集完成：\n\n" +
      "- **标题** 人体工学办公椅 Pro\n" +
      "- **价格** ¥1,299\n" +
      "- **评论** 3 条已取回\n\n" +
      "这段对话可以一键存成按 URL 匹配的工具，下次同类页面直接重放。"
  )
];

/** Derived, never hand-listed — a hand-written copy would drift from the script. */
export const DEMO_TOOL_NAMES: string[] = DEMO_ROUNDS.flatMap((round) =>
  round.filter((e) => e.type === "tool_use_start").map((e) => (e as { name: string }).name)
);
