/* ╁━ /pricing 梦境作品卡世界表（纯数据：SSR 首帧就读这张表，无任何延迟接管）╁━
   四档 = 同一座梦境空间的四种天光（晨 → 夜 → 雨后虹 → 天亮）；切档硬剪接。
   数量只由「金币额度」决定（catalog 驱动的 plan.coins / customPlanFor().coins），
   这里不存任何价格或额度数字。 */

export type WorldId = "starter" | "popular" | "pro" | "custom";

export const WORLD_IDS: WorldId[] = ["starter", "popular", "pro", "custom"];

export function isWorldId(value: string): value is WorldId {
  return (WORLD_IDS as string[]).includes(value);
}

/** 卡堆贴图池：public/showcase 内真实生成作品（人物 / 场景 / 产品 / 概念混装）。
 *  showcase/cards/ 是从 showcase/agent-templates/*.mp4 成片里抽的 3:4 竖幅原尺寸帧
 *  （768×1024；agent-templates/*.webp 只有 540×304 的横幅海报，裁成竖卡会糊，不进池）。
 *  排列刻意交错类别：人物、场景、产品、概念轮流，任何一段连续卡都是混装。 */
export const SHOWCASE_POOL: string[] = [
  "/showcase/cards/c01-art-curation-3-12.webp", // 人物·概念：水母机甲少女
  "/showcase/cards/c04-art-style-2-62.webp", // 场景：睡莲桥
  "/showcase/cards/c09-ecom-model-2-12.webp", // 产品：刺绣斜挎包
  "/showcase/showcase1.webp",
  "/showcase/cards/c17-novel-film-3-12.webp", // 人物：提灯人
  "/showcase/cards/c14-ip-pack-3-88.webp", // 场景：荒原越野
  "/showcase/cards/c08-ecom-launch-2-88.webp", // 产品：雪夜卡车
  "/showcase/showcase2.webp",
  "/showcase/cards/c11-ecom-model-2-62.webp", // 人物：金色西装
  "/showcase/cards/c19-novel-film-3-62.webp", // 场景：火把人潮
  "/showcase/cards/c10-ecom-model-2-38.webp", // 产品：刺绣长衣
  "/showcase/showcase3.webp",
  "/showcase/cards/c02-art-curation-3-38.webp", // 概念：掌心水母
  "/showcase/cards/c20-novel-film-3-88.webp", // 场景：雾中天坛
  "/showcase/cards/c16-novel-film-2-62.webp", // 人物：骑行
  "/showcase/showcase4.webp",
  "/showcase/cards/c12-ecom-model-2-88.webp", // 人物：花纹西装
  "/showcase/cards/c05-art-style-2-88.webp", // 场景：桥上画家
  "/showcase/cards/c15-novel-film-2-12.webp", // 产品：单车
  "/showcase/showcase5.webp",
  "/showcase/cards/c03-art-curation-3-62.webp", // 概念：机甲涉水
  "/showcase/cards/c18-novel-film-3-38.webp", // 场景：夜海
  "/showcase/cards/c13-ip-pack-3-38.webp", // 人物：创作者
  "/showcase/showcase6.webp",
  "/showcase/cards/c21-drama-visual-2-62.webp", // 场景：剧集群像
  "/showcase/cards/c22-art-curation-3-88.webp", // 概念：水面倒影
];

/** 静态卡面（主角卡 / 选片条缩图）用的封面，每档一张不同的。 */
export const WORLD_POSTERS: Record<WorldId, string> = {
  starter: "/showcase/showcase5.webp", // 晨光洒进客厅
  popular: "/showcase/showcase2.webp", // 夜里吧台一盏灯
  pro: "/showcase/showcase6.webp", // 雨后街口的霓虹倒影
  custom: "/showcase/showcase4.webp", // 天亮之后：光束灌进车站
};

/** 卡堆缩图（260px 竖幅 webp，~9KB/张）：喷泉卡只有 60–120px 宽，原图留给主角卡。 */
export function thumbOf(src: string): string {
  return src.replace(/^\/showcase\/(?:cards\/)?/, "/showcase/cards-thumb/");
}

/** 卡数 = 额度的量级函数（密度隐喻，不与真实张数一对一）。
 *  ≤1500：10 × (coins/100)^1.02 —— 100 → 10（台上一小叠）、500 → 52（台子满了、开始往地上掉）、
 *  1500 → 158（掉了一地）；>1500：接 158 × (coins/1500)^0.55 —— 2 万 → 660、100 万 → 5000+
 *  （渲染端按设备上限截断，超出部分变成冲出镜头的塔 + 镜头推近）。 */
export function cardCountForCoins(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 4;
  if (coins <= 1500) return Math.max(4, Math.round(10 * Math.pow(coins / 100, 1.02)));
  return Math.round(158 * Math.pow(coins / 1500, 0.55));
}

/** 每档一句「这是给谁的」（不含任何数字：张数、单价、省多少一律由 catalog 现算）。 */
export const TIER_COPY: Record<WorldId, { short: string; persona: string }> = {
  starter: { short: "梦芽", persona: "第一次来，先画一批试试手感" },
  popular: { short: "梦影", persona: "每周都在画的人最常选" },
  pro: { short: "梦虹", persona: "高频出图，90 天慢慢用" },
  custom: { short: "自定义", persona: "团队 / 批量，要多少加多少" },
};
