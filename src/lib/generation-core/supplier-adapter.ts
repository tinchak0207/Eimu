import { isMetasoModel } from "@/lib/generation-core/metaso-upstream";
import { isNewApiVideoKernelEnabled } from "@/lib/generation-core/newapi-video-upstream";
import { SupplierRequestError } from "./failure-classifier";
import { generateWithNewApi, isNewApiSupplier } from "./newapi-adapter";
import { UnknownSupplyProtocolError, requireSupplyAdapter, type SupplyAdapter } from "./supply-registry";
import type { SupplierGenerationInput, SupplierGenerationOutput, SupplierRecord } from "./types";

// 供给分派（V-06）：协议分派已收进 supply-registry（`registry.get(adapterType)`），
// 本档只剩两条「按供给资料而非协议」的前置分流（皆为既有行为，原样保留）：
//   ① NEWAPI_VIDEO_KERNEL 影子期拦截（V-05 另案）；
//   ② base_url 指向 new-api 的已迁移供给（reblood 换血分流）。
// chatImageOutput / 通用 openai_images·adobe2api 请求构造已搬至 openai-images-adapter.ts。
export { chatImageOutput } from "./openai-images-adapter";

// new-api 换血分流：base_url 指向 new-api 的供应商（DB 路由表已切换的已迁移
// 渠道）直接走 new-api 适配层，跳过旧 openai_images 请求构造与模型映射。
// 以 base_url 判定（不是协议），因此不进 registry；adapter_type 仍按原协议记录。
const newApiRelayAdapter: SupplyAdapter = {
  protocol: "newapi_relay",
  checkpointsSubmissionStart: true,
  submit: (supplier, input) => generateWithNewApi(supplier, input),
  reconcileVia: "newapi_video",
};

/**
 * 解析本次提交实际会走的 adapter（生产平面成本闸与分派共用同一个判定，
 * 闸看到的 adapter ＝ 真正被呼叫的 adapter）。未知协议抛 SupplierRequestError(400)
 *（确定性失败，不重放、不烧钱）。
 */
export function resolveSupplyAdapter(supplier: SupplierRecord, input: SupplierGenerationInput): SupplyAdapter {
  // P1 影子期开关：NEWAPI_VIDEO_KERNEL=1 时 video 任务改走 new-api 原生任务内核
  //（提交 POST {NEWAPI_BASE_URL}/video/generations + 轮询 task 查询端点，见
  // newapi-video-upstream.ts）；未设/0 维持现行 supplier 表路由（metaso 直调桥）。
  // 拦截范围限 minimax-h3（现行生产唯一 video 路径，渠道 8 已验证出真片）——其他
  // video 供应商（filmera/adobe2api）在 new-api 无对应视频渠道，误灌会全量失败。
  // 扩大归一范围时改这个谓词（P1 收口点）。内核路径不依赖 supplier 表（渠道选择
  // 由 new-api Distribute 承担）；worker 侧供应商租约/路由归 orchestrator 收口。
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
  input.signal?.throwIfAborted();
  const adapter=resolveSupplyAdapter(supplier,input);
  if (!adapter.checkpointsSubmissionStart) await input.onProviderRequestStarted?.();
  const output = await adapter.submit(supplier, input);
  await input.onProviderResponse?.(output);
  return output;
}
