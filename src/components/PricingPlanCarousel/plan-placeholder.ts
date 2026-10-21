import type { PricingPlan } from "@/lib/plans";

/** items 构建期的自定义档占位对象：卡面渲染一律用 props.customPlan（滑杆实时值），
 *  这里只保证 item.plan 类型完整（防止误用静态假数据渲染价格）。 */
export function customPlanForPlaceholder(): PricingPlan {
  return {
    id: "custom",
    name: "自定义 · 自由额度",
    tagline: "",
    price: 0,
    anchorPrice: 0,
    coins: 0,
    validDays: 30,
    purchaseUrl: "",
    features: [],
  };
}
