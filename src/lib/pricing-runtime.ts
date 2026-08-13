import { applyModelPricingOverrides } from "./generation-model-catalog";
import { getRuntimeModelPricingOverrides } from "./pricing-overrides";

/**
 * 服務端計費/報價路徑進入點：把最新定價覆寫從 Blob 灌進 catalog 的 effective
 * 狀態。永不拋錯——讀不到就沿用當前生效值，絕不擋生成。
 */
export async function syncModelPricing(): Promise<void> {
  try {
    const overrides = await getRuntimeModelPricingOverrides();
    applyModelPricingOverrides(overrides);
  } catch (error) {
    console.error("[pricing-runtime] Failed to sync model pricing; keeping current effective pricing.", error);
  }
}
