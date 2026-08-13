import { generationCoins } from "./generation-model-catalog";

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

export function gptImage2EquivalentImages(plan: PricingPlan): number {
  if (PLAN_REFERENCE_COINS_PER_IMAGE <= 0) return 0;
  return Math.floor(plan.coins / PLAN_REFERENCE_COINS_PER_IMAGE);
}

export function pricePerGptImage2Image(plan: PricingPlan): string {
  const images = gptImage2EquivalentImages(plan);
  if (images <= 0) return "0.000";
  return (Math.floor((plan.price / images) * 1000) / 1000).toFixed(3);
}
