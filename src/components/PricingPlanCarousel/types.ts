import type { MapayPaymentType } from "@/lib/mapay";
import type { PricingPlan } from "@/lib/plans";

export interface PricingPlanCarouselProps {
  /** 静态套餐档（已按周期过滤）；引用必须稳定（滑杆拖动不得重建本数组）。 */
  plans: PricingPlan[];
  /** 是否追加「自定义」档（跟随周期过滤：自定义 30 天有效 → 不进季度档）。 */
  includeCustom: boolean;
  /** 动态自定义档对象（父层由滑杆额度用 customPlanFor() 派生；只进卡面渲染）。 */
  customPlan: PricingPlan;
  selectedPlanId: string;
  referenceCoinsPerImage: number;
  payMethod: MapayPaymentType;
  payOpened: boolean;
  refreshingBalance: boolean;
  onSelect: (planId: string) => void;
  onCustomCoinsChange: (coins: number) => void;
  onMethodChange: (method: MapayPaymentType) => void;
  onPay: () => void;
  onRefreshBalance: () => void;
  /** 正面卡换人时回报 plan id（整页氛围跟着当前档的世界走）。 */
  onFrontChange?: (planId: string) => void;
}
export interface CarouselItem {
  id: string;
  plan: PricingPlan;
  isCustom: boolean;
  glow: string;
}
