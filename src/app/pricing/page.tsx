import { PricingClient } from "@/components/PricingClient";

const PRICING_TITLE = "充值方案 · Eimu";
const PRICING_DESCRIPTION =
  "GPT Image 2、Nano Banana Pro 生图充值方案，¥9.9 起，不用申请中转站 API Key，登录即可按张生成。";

export const metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  keywords: ["GPT Image 2 价格", "Nano Banana Pro 价格", "AI生图充值", "生图中转 替代方案"],
  openGraph: {
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
    url: "https://image.tinchak0207.xyz/pricing",
  },
  twitter: {
    card: "summary_large_image",
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
  },
};

export default function PricingPage() {
  return <PricingClient />;
}
