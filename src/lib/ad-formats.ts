// 广告版位尺寸。id 就是 imageSizeForAspectRatio 的反函数输入：
// 专业模式把选中的 id 交给 aspectRatioFromImageSize 换成 aspectRatio 再送请求，
// 所以这里每一项的宽高比必须能在 generation-model-catalog 的比例表里找到对应项。

export interface AdSizeOption {
  id: string;
  label: string;
  usage: string;
}

export const AD_SIZE_OPTIONS: AdSizeOption[] = [
  { id: "1024x1024", label: "1:1 方图", usage: "电商主图 / 朋友圈广告" },
  { id: "1536x1024", label: "3:2 横图", usage: "banner / 公众号头图" },
  { id: "1024x1536", label: "2:3 竖图", usage: "开屏海报 / 小红书封面" },
  { id: "1792x1024", label: "16:9 宽屏", usage: "视频封面 / 落地页头图" },
  { id: "1024x1792", label: "9:16 竖屏", usage: "抖音 / Reels / 开屏" },
  { id: "1365x1024", label: "4:3 横图", usage: "PPT / 详情页配图" },
  { id: "1024x1365", label: "3:4 竖图", usage: "商品长图 / 杂志内页" },
  { id: "1024x1280", label: "4:5 竖图", usage: "小红书 / Instagram 主流版位" },
  { id: "1280x1024", label: "5:4 横图", usage: "画册 / 印刷跨页" },
  { id: "1792x768", label: "21:9 超宽", usage: "官网 banner / 影视感横幅" },
  { id: "768x1792", label: "9:21 超长", usage: "长图海报 / 活动落地页" },
  { id: "2048x512", label: "4:1 横条", usage: "站内通栏 / 邮件头图" },
  { id: "512x2048", label: "1:4 长条", usage: "侧边栏 / 长幅推广" },
];

const DEFAULT_SIZE = "1024x1024";

/** 前 3 项是历史默认版位，模型能力表拿不到时的兜底集合。 */
const BASE_SIZE_IDS = AD_SIZE_OPTIONS.slice(0, 3).map((option) => option.id);

export function normalizeSizeSelection(sizes: string[]): string[] {
  const selected = new Set(sizes);
  const result = AD_SIZE_OPTIONS.filter((option) => selected.has(option.id)).map(
    (option) => option.id
  );
  return result.length > 0 ? result : [DEFAULT_SIZE];
}

export function sizeForSlot(sizes: string[], slotIndex: number): string {
  if (sizes.length === 0) return DEFAULT_SIZE;
  return sizes[slotIndex % sizes.length];
}

/** "1024x1280" → "4:5"。与 aspectRatioFromImageSize 同一套约简逻辑，此处避免跨模块循环依赖。 */
export function ratioOfSizeId(sizeId: string): string {
  const [width, height] = sizeId.split("x").map(Number);
  if (!width || !height) return "1:1";
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/**
 * 按模型支持的比例过滤版位。
 *
 * 以前这里是硬编码 3 项，与 generationCapabilities().aspectRatios 完全脱钩：
 * 支持 14 种比例的模型在专业模式里也只能选 3 种，比普通模式还少。
 * 现在能力表是唯一真相，比例对不上的版位不再出现在 UI 上。
 */
export function adSizeOptionsForRatios(aspectRatios?: readonly string[]): AdSizeOption[] {
  if (!aspectRatios?.length) {
    return AD_SIZE_OPTIONS.filter((option) => BASE_SIZE_IDS.includes(option.id));
  }
  const allowed = new Set(aspectRatios);
  const matched = AD_SIZE_OPTIONS.filter((option) => allowed.has(ratioOfSizeId(option.id)));
  return matched.length ? matched : AD_SIZE_OPTIONS.filter((option) => BASE_SIZE_IDS.includes(option.id));
}

/** 把当前选中版位收敛到模型支持的集合；全部不支持时退回该模型的默认比例。 */
export function clampSizesToRatios(sizes: string[], aspectRatios?: readonly string[], fallbackRatio?: string): string[] {
  const options = adSizeOptionsForRatios(aspectRatios);
  const allowedIds = new Set(options.map((option) => option.id));
  const kept = sizes.filter((size) => allowedIds.has(size));
  if (kept.length) return kept;
  const fallback = options.find((option) => ratioOfSizeId(option.id) === fallbackRatio);
  return [fallback?.id ?? options[0]?.id ?? DEFAULT_SIZE];
}
