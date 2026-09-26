/* ╁━ /pricing 夢境作品卡世界表（純數據：SSR 首幀就讀這張表，無任何延遲接管）╁━
   四档 = 同一座夢境空間的四種天光（晨 → 夜 → 雨後虹 → 天亮）；切档硬剪接。
   數量只由「金幣額度」決定（catalog 驅動的 plan.coins / customPlanFor().coins），
   這裡不存任何價格或額度數字。 */

export type WorldId = "starter" | "popular" | "pro" | "custom";

export const WORLD_IDS: WorldId[] = ["starter", "popular", "pro", "custom"];

export function isWorldId(value: string): value is WorldId {
  return (WORLD_IDS as string[]).includes(value);
}

/** 卡堆貼圖池：public/showcase 內真實生成作品（人物 / 場景 / 產品 / 概念混裝）。
 *  showcase/cards/ 是從 showcase/agent-templates/*.mp4 成片裡抽的 3:4 竪幅原尺寸幀
 *  （768×1024；agent-templates/*.webp 只有 540×304 的橫幅海報，裁成竪卡會糊，不進池）。
 *  排列刻意交錯類別：人物、場景、產品、概念輪流，任何一段連續卡都是混裝。 */
export const SHOWCASE_POOL: string[] = [
  "/showcase/cards/c01-art-curation-3-12.webp", // 人物·概念：水母機甲少女
  "/showcase/cards/c04-art-style-2-62.webp", // 場景：睡蓮橋
  "/showcase/cards/c09-ecom-model-2-12.webp", // 產品：刺繡斜挎包
  "/showcase/showcase1.webp",
  "/showcase/cards/c17-novel-film-3-12.webp", // 人物：提燈人
  "/showcase/cards/c14-ip-pack-3-88.webp", // 場景：荒原越野
  "/showcase/cards/c08-ecom-launch-2-88.webp", // 產品：雪夜卡車
  "/showcase/showcase2.webp",
  "/showcase/cards/c11-ecom-model-2-62.webp", // 人物：金色西裝
  "/showcase/cards/c19-novel-film-3-62.webp", // 場景：火把人潮
  "/showcase/cards/c10-ecom-model-2-38.webp", // 產品：刺繡長衣
  "/showcase/showcase3.webp",
  "/showcase/cards/c02-art-curation-3-38.webp", // 概念：掌心水母
  "/showcase/cards/c20-novel-film-3-88.webp", // 場景：霧中天壇
  "/showcase/cards/c16-novel-film-2-62.webp", // 人物：騎行
  "/showcase/showcase4.webp",
  "/showcase/cards/c12-ecom-model-2-88.webp", // 人物：花紋西裝
  "/showcase/cards/c05-art-style-2-88.webp", // 場景：橋上畫家
  "/showcase/cards/c15-novel-film-2-12.webp", // 產品：單車
  "/showcase/showcase5.webp",
  "/showcase/cards/c03-art-curation-3-62.webp", // 概念：機甲涉水
  "/showcase/cards/c18-novel-film-3-38.webp", // 場景：夜海
  "/showcase/cards/c13-ip-pack-3-38.webp", // 人物：創作者
  "/showcase/showcase6.webp",
  "/showcase/cards/c21-drama-visual-2-62.webp", // 場景：劇集群像
  "/showcase/cards/c22-art-curation-3-88.webp", // 概念：水面倒影
];

/** 靜態卡面（主角卡 / 選片條縮圖）用的封面，每档一張不同的。 */
export const WORLD_POSTERS: Record<WorldId, string> = {
  starter: "/showcase/showcase5.webp", // 晨光灑進客廳
  popular: "/showcase/showcase2.webp", // 夜裡吧台一盞燈
  pro: "/showcase/showcase6.webp", // 雨後街口的霓虹倒影
  custom: "/showcase/showcase4.webp", // 天亮之後：光束灌進車站
};

/** 卡堆縮圖（260px 竪幅 webp，~9KB/張）：噴泉卡只有 60–120px 寬，原圖留給主角卡。 */
export function thumbOf(src: string): string {
  return src.replace(/^\/showcase\/(?:cards\/)?/, "/showcase/cards-thumb/");
}

/** 卡數 = 額度的量級函數（密度隱喻，不與真實張數一對一）。
 *  ≤1500：10 × (coins/100)^1.02 —— 100 → 10（台上一小疊）、500 → 52（台子滿了、開始往地上掉）、
 *  1500 → 158（掉了一地）；>1500：接 158 × (coins/1500)^0.55 —— 2 萬 → 660、100 萬 → 5000+
 *  （渲染端按設備上限截斷，超出部分變成衝出鏡頭的塔 + 鏡頭推近）。 */
export function cardCountForCoins(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 4;
  if (coins <= 1500) return Math.max(4, Math.round(10 * Math.pow(coins / 100, 1.02)));
  return Math.round(158 * Math.pow(coins / 1500, 0.55));
}

/** 每档一句「這是給誰的」（不含任何數字：張數、單價、省多少一律由 catalog 現算）。 */
export const TIER_COPY: Record<WorldId, { short: string; persona: string }> = {
  starter: { short: "梦芽", persona: "第一次来，先画一批试试手感" },
  popular: { short: "梦影", persona: "每周都在画的人最常选" },
  pro: { short: "梦虹", persona: "高频出图，90 天慢慢用" },
  custom: { short: "自定义", persona: "团队 / 批量，要多少加多少" },
};
