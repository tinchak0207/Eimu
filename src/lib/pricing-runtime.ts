import { applyModelPricingOverrides } from "./generation-model-catalog";
import { getRuntimeModelPricingOverrides } from "./pricing-overrides";

/**
 * 服务端计费/报价路径进入点：把最新定价覆写从 Blob 灌进 catalog 的 effective
 * 状态。永不抛错——读不到就沿用当前生效值，绝不挡生成。
 */
export async function syncModelPricing(): Promise<void> {
  try {
    const overrides = await getRuntimeModelPricingOverrides();
    applyModelPricingOverrides(overrides);
  } catch (error) {
    console.error("[pricing-runtime] Failed to sync model pricing; keeping current effective pricing.", error);
  }
}
