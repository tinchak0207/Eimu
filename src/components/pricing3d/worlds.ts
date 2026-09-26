/* ╁━ /pricing 3D 作品卡世界表（無 three 依賴：SSR 與靜態卡面也讀這張表）╁━
   四档 = 四個世界，各自一套家具、機位、光與整頁氛圍；切档硬剪接。
   數量只由「金幣額度」決定（catalog 驅動的 plan.coins / customPlanFor().coins），
   這裡不存任何價格或額度數字。 */

export type WorldId = "starter" | "popular" | "pro" | "custom";

export const WORLD_IDS: WorldId[] = ["starter", "popular", "pro", "custom"];

export function isWorldId(value: string): value is WorldId {
  return (WORLD_IDS as string[]).includes(value);
}

/** 卡堆貼圖池：public/showcase 內真實生成圖（人物/場景/產品/概念混裝）。
 *  每張卡取池中一張 + 各自不同的裁切窗，所以同一堆裡沒有兩張卡長得一樣。 */
export const SHOWCASE_POOL: string[] = [
  "/showcase/showcase1.webp",
  "/showcase/agent-templates/ecom-model-2.webp",
  "/showcase/agent-templates/drama-visual-2.webp",
  "/showcase/showcase2.webp",
  "/showcase/agent-templates/ecom-launch-2.webp",
  "/showcase/agent-templates/art-style-2.webp",
  "/showcase/showcase3.webp",
  "/showcase/agent-templates/novel-film-3.webp",
  "/showcase/agent-templates/ip-pack-3.webp",
  "/showcase/showcase4.webp",
  "/showcase/agent-templates/drama-poster-2.webp",
  "/showcase/agent-templates/art-curation-3.webp",
  "/showcase/showcase5.webp",
  "/showcase/agent-templates/novel-film-2.webp",
  "/showcase/showcase6.webp",
];

/** 靜態卡面（3D 接管前 / 降級 / 選片條縮圖）用的封面，每档一張不同的。 */
export const WORLD_POSTERS: Record<WorldId, string> = {
  starter: "/showcase/agent-templates/ip-pack-3.webp",
  popular: "/showcase/showcase2.webp",
  pro: "/showcase/agent-templates/novel-film-3.webp",
  custom: "/showcase/showcase4.webp",
};

/** 整頁滾動節奏：氛圍光層相對滾動的視差倍率（晨光慢、夜燈更慢、雨後快、無邊界最快）。 */
export const WORLD_SCROLL_RATE: Record<WorldId, number> = {
  starter: 0.12,
  popular: 0.06,
  pro: 0.18,
  custom: 0.3,
};

/** 卡數 = 額度的量級函數。100 → 6 張、500 → 14、1500 → 26、2000 → 31、
 *  2 萬 → 110、100 萬 → 950（渲染端再按設備上限截斷，超出部分變成衝出鏡頭的塔）。
 *  指數 0.55：比線性收斂（100 萬不至於要畫幾萬張），又比對數陡（100 與 1500 一眼可分）。 */
export function cardCountForCoins(coins: number): number {
  if (!Number.isFinite(coins) || coins <= 0) return 3;
  return Math.max(3, Math.round(6 * Math.pow(coins / 100, 0.55)));
}
