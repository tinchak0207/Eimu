import {
  IMAGE_MODEL_IDS,
  VIDEO_MODEL_IDS,
  generationCoins,
  generationModel,
} from "./generation-model-catalog";

export interface PricingPlan {
  id: string;
  name: string;
  tagline: string;
  price: number;
  anchorPrice: number;
  couponNote?: string;
  coins: number;
  validDays: number;
  purchaseUrl: string;
  features: string[];
  highlight?: boolean;
  badge?: string;
}

export const PLAN_REFERENCE_MODEL_LABEL = "GPT Image 2（1K）";
export const PLAN_REFERENCE_COINS_PER_IMAGE = generationCoins("gpt-image-2", { resolution: "1k" });

/** 卡内第二换算口径：旗舰高清档（catalog 计价元数据驱动，改价自动跟随）。
 *  平台模型 id 是 gemini-3-image，displayName 为 Nano Banana Pro。 */
export const FLAGSHIP_MODEL_ID = "gemini-3-image";
export const FLAGSHIP_MODEL_LABEL = "Nano Banana Pro";
export const FLAGSHIP_COINS_PER_IMAGE = generationCoins(FLAGSHIP_MODEL_ID, { resolution: "1k" });

/** 邀请奖励口径（与后端发放一致）：邀请人 / 被邀请人各得金币。 */
export const REFERRAL_REWARD_COINS = 100;
export const REFEREE_REWARD_COINS = 50;

export const PLANS: PricingPlan[] = [
  {
    id: "starter",
    name: "梦芽 · 轻度尝鲜包",
    tagline: "创作的种子。100 金币全模型通用，约可生成 100 张 GPT Image 2（1K）。",
    price: 9.9,
    anchorPrice: 20,
    couponNote: "用无门槛券",
    coins: 100,
    validDays: 30,
    purchaseUrl: "https://m.tb.cn/h.R8hnjYn?tk=98pJg1LCwU5",
    features: [
      "100 金币通用额度",
      "约 100 张 GPT Image 2（1K）",
      "无门槛券后 9.9 元",
      "折合 0.099 元/张 GPT Image 2（1K）",
      "适合轻量尝鲜和小批量生成",
    ],
    badge: "梦芽",
  },
  {
    id: "popular",
    name: "梦影 · 主力月度会员",
    tagline: "光与形开始成形。500 金币全模型通用，约可生成 500 张 GPT Image 2（1K）。",
    price: 29.9,
    anchorPrice: 50,
    couponNote: "用满减券",
    coins: 500,
    validDays: 30,
    purchaseUrl: "https://m.tb.cn/h.RRNPSt8?tk=Jwqvg1LCmYc",
    features: [
      "500 金币通用额度",
      "约 500 张 GPT Image 2（1K）",
      "满减券后 29.9 元",
      "折合 0.059 元/张 GPT Image 2（1K）",
      "适合月度图像与视频创作",
    ],
    highlight: true,
    badge: "梦影",
  },
  {
    id: "pro",
    name: "梦虹 · 季度高频创作包",
    tagline: "创作绽放，漫天彩虹。1500 金币全模型通用，约可生成 1500 张 GPT Image 2（1K）。",
    price: 69,
    anchorPrice: 120,
    couponNote: "限时折扣",
    coins: 1500,
    validDays: 90,
    purchaseUrl: "https://m.tb.cn/h.RQl1F4Y?tk=FtGeg1LCZ7X",
    features: [
      "1500 金币通用额度",
      "约 1500 张 GPT Image 2（1K）",
      "限时折扣 69 元",
      "折合 0.046 元/张 GPT Image 2（1K）",
      "适合季度高频图像与视频创作",
    ],
    badge: "梦虹",
  },
];

export function pricePerCoin(plan: PricingPlan): string {
  return (Math.floor((plan.price / plan.coins) * 1000) / 1000).toFixed(3);
}

/**
 * 套餐金币可折算的张数。coinsPerImage 可选：缺省用模块加载时的基准价；
 * 定价页渲染时应传 generationCoins("gpt-image-2", { resolution: "1k" }) 的
 * 实时值（admin 覆写后 usePricingRevision 触发重渲，换算跟随新价）。
 */
export function gptImage2EquivalentImages(
  plan: PricingPlan,
  coinsPerImage: number = PLAN_REFERENCE_COINS_PER_IMAGE,
): number {
  if (coinsPerImage <= 0) return 0;
  return Math.floor(plan.coins / coinsPerImage);
}

export function pricePerGptImage2Image(
  plan: PricingPlan,
  coinsPerImage: number = PLAN_REFERENCE_COINS_PER_IMAGE,
): string {
  const images = gptImage2EquivalentImages(plan, coinsPerImage);
  if (images <= 0) return "0.000";
  return (Math.floor((plan.price / images) * 1000) / 1000).toFixed(3);
}

/** 套餐折扣百分比：相对 anchorPrice 的真实折扣，无折扣（或不足 5%）返回 null。 */
export function planDiscountPercent(plan: PricingPlan): number | null {
  if (plan.anchorPrice <= plan.price) return null;
  const pct = Math.round((1 - plan.price / plan.anchorPrice) * 100);
  return pct >= 5 ? pct : null;
}

/** 任意单价（币/张 或 币/秒）下套餐额度可换算的件数——对照表各套餐列的取值函数。 */
export function planUnitsForCoins(plan: PricingPlan, coinsPerUnit: number): number {
  if (coinsPerUnit <= 0) return 0;
  return Math.floor(plan.coins / coinsPerUnit);
}

/** 限时活动位的数据契约：接入真实活动数据源后填入；为 null 时整个 banner 不渲染（不放假倒计时）。 */
export interface PricingPromo {
  title: string;
  detail: string;
  /** ISO 时间串；存在才渲染倒计时。 */
  endsAt?: string;
}
export const ACTIVE_PRICING_PROMO: PricingPromo | null = null;

/**
 * 模型单价对照表的行结构：由计费 catalog（含运行时覆写）实时派生，
 * 不允许手写数字——定价改了展示必须跟着变。
 */
export interface ModelPriceCell {
  resolution: string;
  coins: number;
}

export interface ModelPriceRow {
  id: string;
  name: string;
  vendor: string;
  kind: "image" | "video";
  /** 图像=「张」，视频=「秒」（时长另乘）。 */
  unit: "张" | "秒";
  cells: ModelPriceCell[];
}

/**
 * 从有效 catalog（base + admin 覆写）派生全部上架模型的单价行。
 * 每次调用都读 currentEffectiveCatalog，所以在组件渲染期调用即活数据。
 */
export function modelPriceRows(): ModelPriceRow[] {
  const rows: ModelPriceRow[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: "image" | "video") => {
    if (seen.has(id)) return;
    const model = generationModel(id);
    if (!model || model.kind !== kind) return;
    const resolutions = model.resolutions;
    if (resolutions.length === 0) return;
    seen.add(id);
    rows.push({
      id,
      name: model.displayName,
      vendor: model.vendor ?? "",
      kind,
      unit: kind === "image" ? "张" : "秒",
      cells: resolutions.map((resolution) => ({
        resolution,
        coins: generationCoins(
          id,
          kind === "video" ? { resolution, durationSeconds: 1 } : { resolution },
        ),
      })),
    });
  };
  for (const id of IMAGE_MODEL_IDS) push(id, "image");
  for (const id of VIDEO_MODEL_IDS) push(id, "video");
  return rows;
}

/** 金币数字的展示格式：去尾零（1 / 0.5 / 2.5），与选择器标价口径一致。 */
export function formatCoins(coins: number): string {
  if (!Number.isFinite(coins)) return "0";
  return String(Math.round(coins * 10 ** 5) / 10 ** 5);
}
