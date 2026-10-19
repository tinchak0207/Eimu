/**
 * durable 图像管线的**上游尺寸白名单**（单一真源，2026-09-30 收拢）。
 *
 * 事实依据（为什么是这 5 条）：这正是平台对 B 端开放的 size 契约——`/v1/images/generations`
 * 原本硬编 `SUPPORTED_SIZES`、`/v1/images/edits` 硬编 `DURABLE_EDIT_SIZES`，两份内容一致
 * （edits 多兼容 `"1k"`／`"2k"` 两个别写法）。同一个契约散在三处＝必然漂移，故收成一颗常数，
 * 由三个入口共用。
 *
 * **白名单＝「已知上游收得下」的集合，不是我们的偏好**：白名单外的尺寸（如 3072x2048、
 * 1792x1024）在我们手上没有任何一次真单量到输出，放行就是拿客户的钱赌上游会收
 * ——与 4K 档位 fail-closed 同一条纪律。要放宽必须先有真单证据（输出实测宽高）。
 *
 * 档位×尺寸的关系（由本表推得，不是另立一套）：
 *   `1k`＝1024x1024／1536x1024／1024x1536；`2k`＝2048x2048；`4k`＝4096x4096。
 * 即 2k／4k 目前只在 1:1 上有已知可交的尺寸；其他比例的高档位属于「未验证」⇒ 具名拒。
 */

/** 已知可交的上游尺寸（＝平台对 B 端开放的 size 契约，逐字）。 */
export const DURABLE_IMAGE_SIZES: readonly string[] = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "4096x4096",
];

const DURABLE_IMAGE_SIZE_SET = new Set(DURABLE_IMAGE_SIZES);

/** 旧写法（档位别名）：B 端 `/v1/images/edits` 历来兼容 `"1k"`／`"2k"`。 */
export const DURABLE_IMAGE_SIZE_ALIASES: Readonly<Record<string, string>> = {
  "1k": "1024x1024",
  "2k": "2048x2048",
};

/**
 * 别名 → 尺寸。用 Map 而非物件索引：物件索引会命中原型键（`size:"toString"` 之类
 * 会拿到函式），Map 只认自己那两把。回 null ＝不是别名，呼叫端原样往下走白名单检查。
 */
export function resolveDurableImageSizeAlias(size: string): string | null {
  const raw = size.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DURABLE_IMAGE_SIZE_ALIASES, raw)
    ? DURABLE_IMAGE_SIZE_ALIASES[raw]
    : null;
}

/** 尺寸是否在已知可交白名单内（大小写/空白无关）。 */
export function isDurableImageSize(size: unknown): boolean {
  const raw = typeof size === "string" ? size.trim().toLowerCase() : "";
  return DURABLE_IMAGE_SIZE_SET.has(raw);
}

/**
 * 档位 → 尺寸倍率（1k＝原尺寸、2k＝×2、4k＝×4）。
 * 由 `1k` 的 1024x1024 → `2k` 的 2048x2048 → `4k` 的 4096x4096 反推，
 * 与 `resolutionFromImageSize` 的分档（≤1536→1k、≤3072→2k、其余→4k）相容。
 */
export const DURABLE_TIER_SCALE: Readonly<Record<"1k" | "2k" | "4k", number>> = {
  "1k": 1,
  "2k": 2,
  "4k": 4,
};

/** 依档位倍率缩放尺寸字串（"1536x1024" × 2 ⇒ "3072x2048"）；非法输入回 null，不以 0 冒充。 */
export function scaleDurableImageSize(size: string, scale: number): string | null {
  const [width, height] = size.trim().toLowerCase().split("x").map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return `${width * scale}x${height * scale}`;
}