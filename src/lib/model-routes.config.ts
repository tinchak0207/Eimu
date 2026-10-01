// 模型路由表：控面調度順序的**唯一真源**（2026-10-01 路由架構收口）。
//
// 一個模型 = 一條有序渠道 label 陣列；陣列順序就是調度器的嘗試順序
// （scheduler.ts acquireSupplierLease 按 array_position 排序，健康度/負載只在
// 同一條路由內做平手判定之後的細排——不會再有 supply_tier 壓過 priority 的暗規則）。
//
// 雙架構約定（暴君 2026-10-01 裁定「new-api 調度碾壓但兼容性一般，雙架構命中注定」）：
//   - `"newapi"` = 這一步整體交給 new-api（imagesite-new-api），它**內部**的渠道
//     順序／權重／重試在 new-api 後台調（它的強項），控面不再假裝成多個渠道重排一次。
//   - 其他 label = 控面直連渠道（new-api 沒有 adapter 的協議：視頻異步、adobe2api
//     變體、tts、blender，或刻意直連的 OpenAI 相容上游）。label 即 DB supplier `env:<label>`。
//
// 日常操作：
//   - 調優先序：改本表陣列順序 → 部署；或 /admin「模型路由」直接覆寫（寫
//     model_route_override 表，立即生效、不需部署，清除覆寫即回到本表）。
//   - 接新模型：catalog 加條目 → 本表加一行。
//   - 接新渠道：new-api 能接的直接在 new-api 後台加（本表該模型含 "newapi" 即可）；
//     直連渠道跑 tools/add-supplier-channel.ts（會把 label 自動追加到所認領模型的隊尾）。
//
// 生產校準（2026-10-01 唯讀實查 VPS supplier 表 + new-api abilities 表）：本表保留
// 換血前的實際生效順序，只做兩件事——①把 hublinuxdo/sub2api/fallback/pixai/dreamina
// 這 5 個「base_url 全指向同一個 new-api 的假渠道」合併成一步 "newapi"；②刪掉 new-api
// 根本沒有啟用渠道服務的死跳點（adobe-firefly-fill、image-5-*、seedream-*、
// pixai-edit/upscale/template、agnes 前面那一跳、flux/gpt-image 系 adobe 之後那一跳），
// 那些跳點過去每單必敗、白燒一次嘗試預算。上游恢復後把 "newapi" 加回該模型即可。

/** 交給 new-api 的那一步。DB supplier id = `env:newapi`。 */
export const NEWAPI_ROUTE_LABEL = "newapi";

/**
 * 已整體併入 new-api 的舊渠道（它們現在是 new-api 後台裡的渠道）。NEWAPI_ENABLED 時
 * seed 不再為它們建 supplier（孤兒清掃會停用舊行），路由裡也不得出現——寫 "newapi"。
 */
export const NEWAPI_SUPERSEDED_LABELS: ReadonlySet<string> = new Set(["hublinuxdo", "pixai", "sub2api", "dreamina", "fallback"]);

export const MODEL_ROUTES: Record<string, readonly string[]> = {
  // ── 圖片：GPT 系 ──
  "gpt-image-2": ["adobe2api", "newapi", "yyds"],
  "gpt-image-2.5-flare": ["adobe2api", "newapi"],
  "gpt-image-2.5-sunburst": ["adobe2api", "newapi"],
  "gpt-image-1.5": ["adobe2api", "newapi"],
  "gpt-image": ["adobe2api"],

  // ── 圖片：Gemini（Nano Banana）系 ──
  "gemini-3-image": ["adobe2api", "newapi"],
  "gemini-3.1-flash-image": ["adobe2api", "newapi"],
  "gemini-2.5-flash-image": ["adobe2api", "newapi"],

  // ── 圖片：Adobe Firefly 合作模型（只有 adobe2api 服務）──
  "adobe-firefly": ["adobe2api"],
  "flux-2-pro": ["adobe2api"],
  "flux-2": ["adobe2api"],
  "flux-kontext-max": ["adobe2api"],
  "flux-kontext-pro": ["adobe2api"],
  "flux-1.1-ultra": ["adobe2api"],
  "flux-1.1-pro": ["adobe2api"],
  "runway-gen-4-image": ["adobe2api"],

  // ── 圖片：其他直連 ──
  "agnes-image-2.5-flash": ["agnes"],
  "blender-render-eevee": ["blender-local"],
  "blender-render-cycles": ["blender-local"],

  // ── 圖片：PixAI（new-api pixai-bridge 渠道）──
  "pixai-tsubaki2": ["newapi"],
  "pixai-haruka-v2": ["newapi"],
  "pixai-reference-pro": ["newapi"],
  "pixai-tsubaki-11": ["newapi"],
  "pixai-hoshino-v2": ["newapi"],

  // ── 視頻（唯一權威 xiaoyxiao，gway 次之）──
  "seedance-2.0": ["xiaoyxiao", "gway"],
  "seedance-2.5-480p": ["xiaoyxiao", "gway"],
  "seedance-2.5-720p": ["xiaoyxiao", "gway"],
  "minimax-h3": ["xiaoyxiao", "gway"],

  // ── 語音 ──
  "tts-1": ["harness-tts"],
};

export function modelRoute(modelId: string): readonly string[] {
  return MODEL_ROUTES[modelId] ?? [];
}

/** 渠道 label → DB supplier id（seed 與 sub2api.describeEnvChannels 的既有命名約定）。 */
export function routeSupplierId(label: string): string {
  return `env:${label}`;
}

/** 某渠道出現在哪些模型的路由裡（seed 認領 "newapi" 用）。 */
export function modelsRoutedTo(label: string): string[] {
  return Object.entries(MODEL_ROUTES)
    .filter(([, route]) => route.includes(label))
    .map(([modelId]) => modelId);
}
