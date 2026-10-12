// 模型路由表：控面调度顺序的**唯一真源**（2026-10-01 路由架构收口）。
//
// 一个模型 = 一条有序渠道 label 阵列；阵列顺序就是调度器的尝试顺序
// （scheduler.ts acquireSupplierLease 按 array_position 排序，健康度/负载只在
// 同一条路由内做平手判定之后的细排——不会再有 supply_tier 压过 priority 的暗规则）。
//
// 双架构约定（暴君 2026-10-01 裁定「new-api 调度碾压但兼容性一般，双架构命中注定」）：
//   - `"newapi"` = 这一步整体交给 new-api（imagesite-new-api），它**内部**的渠道
//     顺序／权重／重试在 new-api 后台调（它的强项），控面不再假装成多个渠道重排一次。
//   - 其他 label = 控面直连渠道（new-api 没有 adapter 的协议：视频异步、adobe2api
//     变体、tts、blender，或刻意直连的 OpenAI 相容上游）。label 即 DB supplier `env:<label>`。
//
// 日常操作：
//   - 调优先序：改本表阵列顺序 → 部署；或 /admin「模型路由」直接覆写（写
//     model_route_override 表，立即生效、不需部署，清除覆写即回到本表）。
//   - 接新模型：catalog 加条目 → 本表加一行。
//   - 接新渠道：new-api 能接的直接在 new-api 后台加（本表该模型含 "newapi" 即可）；
//     直连渠道跑 tools/add-supplier-channel.ts（会把 label 自动追加到所认领模型的队尾）。
//
// 生产校准（2026-10-01 唯读实查 VPS supplier 表 + new-api abilities 表）：本表保留
// 换血前的实际生效顺序，只做两件事——①把 hublinuxdo/sub2api/fallback/pixai/dreamina
// 这 5 个「base_url 全指向同一个 new-api 的假渠道」合并成一步 "newapi"；②删掉 new-api
// 根本没有启用渠道服务的死跳点（adobe-firefly-fill、image-5-*、seedream-*、
// pixai-edit/upscale/template、agnes 前面那一跳、flux/gpt-image 系 adobe 之后那一跳），
// 那些跳点过去每单必败、白烧一次尝试预算。上游恢复后把 "newapi" 加回该模型即可。

/** 交给 new-api 的那一步。DB supplier id = `env:newapi`。 */
export const NEWAPI_ROUTE_LABEL = "newapi";

/**
 * 已整体并入 new-api 的旧渠道（它们现在是 new-api 后台里的渠道）。NEWAPI_ENABLED 时
 * seed 不再为它们建 supplier（孤儿清扫会停用旧行），路由里也不得出现——写 "newapi"。
 */
export const NEWAPI_SUPERSEDED_LABELS: ReadonlySet<string> = new Set(["hublinuxdo", "pixai", "sub2api", "dreamina", "fallback"]);

export const MODEL_ROUTES: Record<string, readonly string[]> = {
  // ── 图片：GPT 系 ──
  // yyds 放首位＝1K/2K/4K 统一 0.016 元/次（站方公开价目 /api/v1/model-plaza 2026-10-03 实查），
  // 比 adobe2api（自有额度，常枯竭）与 newapi 便宜；yyds 失败照阵列顺序往下落。
  "gpt-image-2": ["yyds", "adobe2api", "newapi"],
  "gpt-image-2.5-flare": ["yyds", "adobe2api", "newapi"],
  "gpt-image-2.5-sunburst": ["yyds", "adobe2api", "newapi"],
  "gpt-image-1.5": ["adobe2api", "newapi"],
  "gpt-image": ["adobe2api"],

  // ── 图片：Gemini（Nano Banana）系 ──
  "gemini-3-image": ["adobe2api", "newapi"],
  "gemini-3.1-flash-image": ["adobe2api", "newapi"],
  "gemini-2.5-flash-image": ["adobe2api", "newapi"],

  // ── 图片：Adobe Firefly 合作模型（只有 adobe2api 服务）──
  "adobe-firefly": ["adobe2api"],
  "flux-2-pro": ["adobe2api"],
  "flux-2": ["adobe2api"],
  "flux-kontext-max": ["adobe2api"],
  "flux-kontext-pro": ["adobe2api"],
  "flux-1.1-ultra": ["adobe2api"],
  "flux-1.1-pro": ["adobe2api"],
  "runway-gen-4-image": ["adobe2api"],

  // ── 图片：其他直连 ──
  "agnes-image-2.5-flash": ["agnes"],
  "blender-render-eevee": ["blender-local"],
  "blender-render-cycles": ["blender-local"],

  // ── 图片：PixAI（new-api pixai-bridge 渠道）──
  "pixai-tsubaki2": ["newapi"],
  "pixai-haruka-v2": ["newapi"],
  "pixai-reference-pro": ["newapi"],
  "pixai-tsubaki-11": ["newapi"],
  "pixai-hoshino-v2": ["newapi"],

  // ── 视频（唯一权威 xiaoyxiao，gway 次之）──
  "seedance-2.0": ["xiaoyxiao", "gway"],
  "seedance-2.5-480p": ["xiaoyxiao", "gway"],
  "seedance-2.5-720p": ["xiaoyxiao", "gway"],
  // 2026-10-12 暴君裁定：影片生成默认渠道改 miaowuai（api.miaowuai.store），
  // minimax-h3 → 上游 minimax-h3-max（¥2.00/次，成本闸白名单已登记）；xiaoyxiao 退为备援。
  "minimax-h3": ["miaowuai", "xiaoyxiao"],

  // ── 语音 ──
  "tts-1": ["harness-tts"],
};

export function modelRoute(modelId: string): readonly string[] {
  return MODEL_ROUTES[modelId] ?? [];
}

/** 渠道 label → DB supplier id（seed 与 sub2api.describeEnvChannels 的既有命名约定）。 */
export function routeSupplierId(label: string): string {
  return `env:${label}`;
}

/** 某渠道出现在哪些模型的路由里（seed 认领 "newapi" 用）。 */
export function modelsRoutedTo(label: string): string[] {
  return Object.entries(MODEL_ROUTES)
    .filter(([, route]) => route.includes(label))
    .map(([modelId]) => modelId);
}
