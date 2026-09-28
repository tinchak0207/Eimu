import { isMetasoModel } from "@/lib/generation-core/metaso-upstream";
import { isNewApiVideoKernelEnabled } from "@/lib/generation-core/newapi-video-upstream";
import { SupplierRequestError } from "./failure-classifier";
import { generateWithNewApi, isNewApiSupplier } from "./newapi-adapter";
import { UnknownSupplyProtocolError, requireSupplyAdapter, type SupplyAdapter } from "./supply-registry";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// 供給分派（V-06）：協議分派已收進 supply-registry（`registry.get(adapterType)`），
// 本檔只剩兩條「按供給資料而非協議」的前置分流（皆為既有行為，原樣保留）：
//   ① NEWAPI_VIDEO_KERNEL 影子期攔截（V-05 另案）；
//   ② base_url 指向 new-api 的已遷移供給（reblood 換血分流）。
// chatImageOutput / 通用 openai_images·adobe2api 請求構造已搬至 openai-images-adapter.ts。
export { chatImageOutput } from "./openai-images-adapter";

// new-api 换血分流：base_url 指向 new-api 的供应商（DB 路由表已切换的已迁移
// 渠道）直接走 new-api 适配层，跳过旧 openai_images 请求构造与模型映射。
// 以 base_url 判定（不是協議），因此不進 registry；adapter_type 仍按原協議記錄。
const newApiRelayAdapter: SupplyAdapter = {
  protocol: "newapi_relay",
  submit: (supplier, input) => generateWithNewApi(supplier, input),
  reconcileVia: "newapi_video",
};

/**
 * 解析本次提交實際會走的 adapter（生產平面成本閘與分派共用同一個判定，
 * 閘看到的 adapter ＝ 真正被呼叫的 adapter）。未知協議拋 SupplierRequestError(400)
 *（確定性失敗，不重放、不燒錢）。
 */
export function resolveSupplyAdapter(supplier: SupplierRecord, input: SupplierGenerationInput): SupplyAdapter {
  // P1 影子期開關：NEWAPI_VIDEO_KERNEL=1 時 video 任務改走 new-api 原生任務內核
  //（提交 POST {NEWAPI_BASE_URL}/video/generations + 輪詢 task 查詢端點，見
  // newapi-video-upstream.ts）；未設/0 維持現行 supplier 表路由（metaso 直調橋）。
  // 攔截範圍限 minimax-h3（現行生產唯一 video 路徑，渠道 8 已驗證出真片）——其他
  // video 供應商（filmera/adobe2api）在 new-api 無對應視頻渠道，誤灌會全量失敗。
  // 擴大歸一範圍時改這個謂詞（P1 收口點）。內核路徑不依賴 supplier 表（渠道選擇
  // 由 new-api Distribute 承擔）；worker 側供應商租約/路由歸 orchestrator 收口。
  if (input.kind === "video_generate" && isMetasoModel(input.modelId) && isNewApiVideoKernelEnabled()) {
    return requireSupplyAdapter("newapi_video", "video kernel");
  }
  if (isNewApiSupplier(supplier)) return newApiRelayAdapter;
  try {
    return requireSupplyAdapter(supplier.adapterType, `supplier ${supplier.id}`);
  } catch (error) {
    if (error instanceof UnknownSupplyProtocolError) throw new SupplierRequestError(error.message, 400);
    throw error;
  }
}

export async function generateWithSupplier(supplier: SupplierRecord, input: SupplierGenerationInput): Promise<SupplierGenerationOutput> {
  return resolveSupplyAdapter(supplier, input).submit(supplier, input);
}
