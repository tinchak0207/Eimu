/**
 * durable 圖像管線的**上游尺寸白名單**（單一真源，2026-09-30 收攏）。
 *
 * 事實依據（為什麼是這 5 條）：這正是平台對 B 端開放的 size 契約——`/v1/images/generations`
 * 原本硬編 `SUPPORTED_SIZES`、`/v1/images/edits` 硬編 `DURABLE_EDIT_SIZES`，兩份內容一致
 * （edits 多兼容 `"1k"`／`"2k"` 兩個別寫法）。同一個契約散在三處＝必然漂移，故收成一顆常數，
 * 由三個入口共用。
 *
 * **白名單＝「已知上游收得下」的集合，不是我們的偏好**：白名單外的尺寸（如 3072x2048、
 * 1792x1024）在我們手上沒有任何一次真單量到輸出，放行就是拿客戶的錢賭上游會收
 * ——與 4K 檔位 fail-closed 同一條紀律。要放寬必須先有真單證據（輸出實測寬高）。
 *
 * 檔位×尺寸的關係（由本表推得，不是另立一套）：
 *   `1k`＝1024x1024／1536x1024／1024x1536；`2k`＝2048x2048；`4k`＝4096x4096。
 * 即 2k／4k 目前只在 1:1 上有已知可交的尺寸；其他比例的高檔位屬於「未驗證」⇒ 具名拒。
 */

/** 已知可交的上游尺寸（＝平台對 B 端開放的 size 契約，逐字）。 */
export const DURABLE_IMAGE_SIZES: readonly string[] = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "4096x4096",
];

const DURABLE_IMAGE_SIZE_SET = new Set(DURABLE_IMAGE_SIZES);

/** 舊寫法（檔位別名）：B 端 `/v1/images/edits` 歷來兼容 `"1k"`／`"2k"`。 */
export const DURABLE_IMAGE_SIZE_ALIASES: Readonly<Record<string, string>> = {
  "1k": "1024x1024",
  "2k": "2048x2048",
};

/**
 * 別名 → 尺寸。用 Map 而非物件索引：物件索引會命中原型鍵（`size:"toString"` 之類
 * 會拿到函式），Map 只認自己那兩把。回 null ＝不是別名，呼叫端原樣往下走白名單檢查。
 */
export function resolveDurableImageSizeAlias(size: string): string | null {
  const raw = size.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DURABLE_IMAGE_SIZE_ALIASES, raw)
    ? DURABLE_IMAGE_SIZE_ALIASES[raw]
    : null;
}

/** 尺寸是否在已知可交白名單內（大小寫/空白無關）。 */
export function isDurableImageSize(size: unknown): boolean {
  const raw = typeof size === "string" ? size.trim().toLowerCase() : "";
  return DURABLE_IMAGE_SIZE_SET.has(raw);
}

/**
 * 檔位 → 尺寸倍率（1k＝原尺寸、2k＝×2、4k＝×4）。
 * 由 `1k` 的 1024x1024 → `2k` 的 2048x2048 → `4k` 的 4096x4096 反推，
 * 與 `resolutionFromImageSize` 的分檔（≤1536→1k、≤3072→2k、其餘→4k）相容。
 */
export const DURABLE_TIER_SCALE: Readonly<Record<"1k" | "2k" | "4k", number>> = {
  "1k": 1,
  "2k": 2,
  "4k": 4,
};

/** 依檔位倍率縮放尺寸字串（"1536x1024" × 2 ⇒ "3072x2048"）；非法輸入回 null，不以 0 冒充。 */
export function scaleDurableImageSize(size: string, scale: number): string | null {
  const [width, height] = size.trim().toLowerCase().split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return `${width * scale}x${height * scale}`;
}