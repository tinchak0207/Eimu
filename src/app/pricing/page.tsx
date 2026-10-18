import { PricingClient } from "@/components/PricingClient";
import { PLANS } from "@/lib/plans";
import { getSiteUrlFromEnv } from "@/lib/site-url";

const SITE_URL = getSiteUrlFromEnv();

const PRICING_TITLE = "定价与充值：¥9.9 起，按张按秒计费、失败自动退币";
const PRICING_DESCRIPTION =
  "Eimu 充值方案：梦芽 ¥9.9 / 梦影 ¥29.9 / 梦虹 ¥69。图片按张、视频按秒计价，提交预扣、成功结算、失败自动退回；网页、API、MCP 共用一本账。";

export const metadata = {
  title: PRICING_TITLE,
  description: PRICING_DESCRIPTION,
  alternates: { canonical: `${SITE_URL}/pricing` },
  openGraph: {
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
    url: `${SITE_URL}/pricing`,
  },
  twitter: {
    card: "summary_large_image",
    title: PRICING_TITLE,
    description: PRICING_DESCRIPTION,
  },
};

const pricingJsonLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "Eimu 充值套餐",
  description: PRICING_DESCRIPTION,
  offers: PLANS.map((plan) => ({
    "@type": "Offer",
    name: plan.name,
    price: plan.price,
    priceCurrency: "CNY",
    description: `${plan.coins} 金币，${plan.validDays} 天。${plan.tagline}`,
  })),
};

export default function PricingPage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingJsonLd) }} />
      <PricingClient />
    </>
  );
}
