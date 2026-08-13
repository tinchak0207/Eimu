// D-26 首张锚定：使用者确认第一张满意后，整批按这张的风格生成，
// 第 100 张与第 1 张不漂移。
//
// 为什么必须显式锚定：agent 每一轮都是重新决定参数的，不锚就会漂——
// 同一句「再来 20 张」可能换了 seed、换了 LoRA 权重，出来的东西不是一批。
// 锚定的做法是把第一张实际用过的参数**原样念回给 agent**，让它照抄，
// 而不是让它凭「上文印象」再猜一次。
//
// 关键约束：这里只能引用事件流里真实出现过的参数（tool.invoke 的 args_summary）。
// 凑不出可复现的参数时宁可不给锚定按钮 —— 一颗按下去不保证同风格的
// 「锚定」按钮，比没有按钮更糟。

import type { AgentTranscriptItem } from "./agent-chat-types";
import { parseToolParams, type AgentParam } from "./agent-tool-params";

/** 锚定要念回给 agent 的参数键。顺序即念回顺序。 */
const ANCHOR_KEYS = [
  "model",
  "size",
  "aspect_ratio",
  "quality",
  "sampler",
  "sampling_method",
  "steps",
  "cfg",
  "cfg_scale",
  "seed",
  "lora",
  "lora_id",
  "lora_weight",
  "negative_prompt",
] as const;

const ANCHOR_KEY_SET = new Set<string>(ANCHOR_KEYS);

export interface BatchAnchor {
  /** 第一张图的条目 id，用来记住「这张已经问过了」。 */
  imageId: string;
  /** 第一张图的展示序号（人话里的「第 N 张」）。 */
  seq: number;
  /** 可念回的参数，已按 ANCHOR_KEYS 排序。空数组代表没有可复现参数。 */
  params: AgentParam[];
  /** 上游把 args_summary 截断过 → 参数可能不全，UI 要说出来。 */
  truncated: boolean;
}

/**
 * 从 transcript 找出「第一张图 + 生成它的那次工具调用参数」。
 *
 * 配对规则：取第一个 image 条目，往前找**最近一条**带参数的 tool 条目。
 * 事件流里 tool.invoke 一定早于它产出的 image.done（网关按序号发），
 * 所以「image 之前最近的那次调用」就是产出它的那次。
 *
 * 返回 null 的三种情况，都不该显示锚定卡：
 *   - 还没有图
 *   - 图之前没有任何带参数的工具调用（拿不到可复现参数）
 *   - 参数里没有任何一项属于可锚定集合（例如只有 prompt，锚不住风格）
 */
export function deriveBatchAnchor(items: readonly AgentTranscriptItem[]): BatchAnchor | null {
  const imageIndex = items.findIndex((item) => item.kind === "image");
  if (imageIndex === -1) return null;

  const image = items[imageIndex];
  if (image.kind !== "image") return null;

  for (let i = imageIndex - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind !== "tool") continue;
    const parsed = parseToolParams(item.argsSummary);
    if (!parsed) continue;

    const params = parsed.params
      .filter((param) => ANCHOR_KEY_SET.has(param.key))
      .sort((a, b) => ANCHOR_KEYS.indexOf(a.key as never) - ANCHOR_KEYS.indexOf(b.key as never));

    // 找到了调用但捞不出可锚定参数：继续往前找上一次调用没有意义
    // （更早的调用产出的是更早的图），直接放弃锚定。
    if (params.length === 0) return null;

    return { imageId: image.id, seq: image.seq, params, truncated: parsed.truncated };
  }

  return null;
}

/**
 * 锚定指令。把参数原样念回去，让 agent 照抄而不是重新猜。
 *
 * 用「不要改动」而非「尽量保持」：后者给了 agent 自行发挥的余地，
 * 而 D-26 要的正是不漂移。
 */
export function buildAnchorMessage(anchor: BatchAnchor): string {
  const lines = anchor.params.map((param) => `- ${param.label}（${param.key}）：${param.value}`);
  return [
    `第 ${anchor.seq} 张就是我要的风格。接下来这一批都按它生成，以下参数不要改动：`,
    ...lines,
    "每张只改动必要的随机性，其余保持一致；如果某项参数无法沿用，先告诉我再继续。",
  ].join("\n");
}

/** 「换个风格重来」：先回到一张，确认满意再放量，不要直接烧一整批。 */
export function buildReanchorMessage(anchor: BatchAnchor): string {
  return `第 ${anchor.seq} 张不是我想要的风格。先只出 1 张换个方向给我看，满意了我再让你出整批。`;
}
