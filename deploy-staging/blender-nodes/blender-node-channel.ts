/**
 * blender 節點 supplier channel 同構定義稿（片Y，2026-09-06）。
 *
 * 性質：staging 稿。本檔不改 src/（改碼歸後續執行片）；三個用途：
 *   ① registry 真源的最小 diff 稿（§A——貼進 src/lib/supplier-channels.config.ts
 *      的 REGISTRY-ENTRIES marker 區）
 *   ② seed/adapter/health 三處配套 diff 稿（§B/§C/§D）
 *   ③ 派發判定純函數（§E）——scheduler ORDER BY 的本地同構投影，可離線實跑
 *      （npx tsx deploy-staging/blender-nodes/verify-node-dispatch.ts），
 *      證明「本機 first_party → Modal managed_pool → CNB relay」的排序語義
 *      與 gateway 現有 supplier 派發逐字段同構。
 *
 * 同構真源（考古結論，全部帶行號核實）：
 *   - RegistryChannel 形狀：src/lib/supplier-channels.config.ts L17-28
 *   - env→descriptor：src/lib/sub2api.ts L114 registryChannelToDescriptor
 *   - seed 三表：tools/seed-generation-suppliers.ts L314-356
 *   - 認領排序：src/lib/generation-core/scheduler.ts L68-78
 *   - adapter 分派：src/lib/generation-core/supplier-adapter.ts L108-135
 *   - 健康探測輪子：src/lib/generation-core/adobe-health.ts L37-45
 *   - bridge 契約：bridge/blender-bridge/README.md（/v1/health、/v1/execute）
 */

// ═══════════════════════════════════════════════════════════════════════════
// §A 最小 diff 稿：src/lib/supplier-channels.config.ts
//    插入位置：REGISTRY-ENTRIES-START（L31）與 REGISTRY-ENTRIES-END（L192）之間
//    ——注意：此區由 tools/add-supplier-channel.ts 維護，手改會被工具覆蓋；
//    落位方式二選一：①直接手寫進 marker 區後不再跑該工具（registry 渠道已穩定，
//    風險低）；②工具跑完後把條目重新貼回。執行片拍板。
// ═══════════════════════════════════════════════════════════════════════════

/*
  {
    // 本機 RTX 5070 Laptop＋Blender 5.2.1 EGL。VPS gateway 經片W 反向隧道
    // （deploy-staging/blender-bridge-tunnel/）訪 http://127.0.0.1:8765。
    // first_party＝自營最快（與 adobe2api 同檔）：scheduler 第一排序鍵
    // supply_tier CASE → 0，本機 lease 空閒時必勝；併發 1（橋鐵律
    // BLENDER_BRIDGE_CONCURRENCY=1），佔線時 scheduler 走 lease 過濾自然落
    // 下一節點，零新邏輯。
    label: "blender-local",
    baseUrlEnv: "BLENDER_NODE_LOCAL_URL",   // VPS 值固定 http://127.0.0.1:8765（片W 裁定一字不改）
    apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",  // 片W §5 橋側 Bearer patch 的共享 token（同時作為 credentialRef）
    enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
    tier: "first_party",
    seedPriority: 10,                       // 同 adobe2api 檔位（seed-generation-suppliers.ts L322）
    sitePriority: 10,
    chatImageModels: [],                    // blender 節點無 chat 生圖概念，恆空
    adapterType: "blender_bridge",          // 新 enum 值，§B 配套
    claims: [
      // kinds 沿用 image_generate（單幀 PNG 產出語義同圖像生成，零枚舉擴散）。
      // supplierModelId: null＝同名直傳（模型名即引擎標籤，bridge /v1/execute
      // 的腳本構造器按 modelId 選 engine，無上游映射需求）。
      { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },

  {
    // Modal L4 節點（片X 交付物）。managed_pool＝額度池（GPU 分鐘計費，與
    // hublinuxdo/yyds 同檔）；本機 first_party 之後的受管備援。
    // ⚠ pending：endpoint/health 對齊以片X 實際交付為準——若片X 的 health 端點
    // 非 /v1/health（NODES-PLAN §3.3 預寫 /health），healthPath 走 §D 分派。
    label: "blender-modal",
    baseUrlEnv: "BLENDER_NODE_MODAL_URL",   // https://<modal-app>.modal.run（片X token 後補）
    apiKeyEnv: "BLENDER_NODE_MODAL_TOKEN",  // Modal 鑑權 token（形態待片X）
    enabledEnv: "BLENDER_NODE_MODAL_ENABLED",
    tier: "managed_pool",
    seedPriority: 20,                       // hub 12 / yyds 13 之後，與 blender 語義不衝突
    sitePriority: 20,
    chatImageModels: [],
    adapterType: "blender_bridge",
    claims: [
      { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },
  // blender-cnb（relay 檔位）只埋樁不註冊：無實體節點，註冊即虛報能力。
  // 觸發條件（研究片 V）：節點 ≥3 且異構＋需要場景檔分發 → 屆時評估 Flamenco 3
  // 而非繼續加 registry 條目（NODES-PLAN §5）。
*/

// ═══════════════════════════════════════════════════════════════════════════
// §B 最小 diff 稿：src/lib/generation-core/supplier-adapter.ts
// ═══════════════════════════════════════════════════════════════════════════

// B-1. adapterType 類型擴展（supplier-channels.config.ts L26 與 SupplierRecord
//     兩處）："openai_images" | "metaso" | "openai_video" | "blender_bridge"

// B-2. requestSupplier（L108 起）加分派分支——形狀照抄 filmera/metaso 分支：
/*
  if (supplier.adapterType === "blender_bridge") {
    return generateWithBlenderNode(supplier, input);
  }
*/

// B-3. generateWithBlenderNode 本體（新函數，~80 行；職責：modelId→engine、
//     單幀腳本構造、POST /v1/execute、產物收斂）：
/*
  async function generateWithBlenderNode(
    supplier: SupplierRecord, input: SupplierGenerationInput,
  ): Promise<SupplierGenerationOutput> {
    // 1. 引擎選型：input.modelId "blender-render-eevee"|"blender-render-cycles"
    //    → engine（"BLENDER_EEVEE_NEXT" 註釋釘死見片M；cycles 不受限）。
    // 2. 單幀渲染腳本：Eevee 存活配方 samples=1＋RT off（片M 已在
    //    blender-tools.ts 落地，同構搬運；動畫/多幀不在節點派發範圍——片L
    //    實錘橋內多幀必 native 崩，單幀 job 才是安全單位）。
    // 3. fetch `${supplier.baseUrl}/v1/execute`：
    //    body {script, timeout_ms: RENDER_DEFAULT_TIMEOUT_MS}，
    //    Authorization: Bearer readCredential(supplier)（既有輪子）。
    //    429 queue_full / connection lost＝瞬態，交上層重試（片K 契約）。
    // 4. 產物收斂：本機節點回 path（.blender-work/out/，零變化）；
    //    Modal 節點回 bytes（pending：片X 定卷形態後 adapter 內嵌收斂）——
    //    兩者在本函數收斂成同一 SupplierGenerationOutput，上層不感知節點差異。
    //    kind 分揀（png/blend/glb）復用 blender-delegate.ts 既有 collect 邏輯。
  }
*/

// B-4. worker-service.ts L54 protocolOfAdapter：**零改動**——blender_bridge 是
//     同步 adapter（請求-回應內完成），不加映射即不進異步對帳（L53 註釋明說
//     「同步 adapter 無異步任務語義，不在此列」）；deadline 由 worker 既有
//     雙層超時＋橋 timeout 契約覆蓋（片K）。

// ═══════════════════════════════════════════════════════════════════════════
// §C 最小 diff 稿：src/lib/generation-model-catalog/catalog.ts
//    GENERATION_MODEL_CATALOG 加兩條（claims 的前置依賴——channelCapabilities
//    對不在 catalog 的 modelId warn＋skip，寧少認領不虛報）：
/*
  "blender-render-eevee":  { aspectRatios: ["1:1"], resolutions: [1024], ... 按catalog既有條目形狀補全 },
  "blender-render-cycles": { aspectRatios: ["1:1"], resolutions: [1024], ... },
*/
//    ratios/resolutions 取 square 檔（bridge 渲染分辨率由腳本內 blender 相機
//    決定，catalog 欄位僅供平台側契約顯示）。

// ═══════════════════════════════════════════════════════════════════════════
// §D 最小 diff 稿：tools/seed-generation-suppliers.ts L338
//    現狀：supplier_account.configuration_json 對所有渠道寫死
//    healthPath: process.env.ADOBE2API_HEALTH_PATH ?? "health"
//    diff（按 adapter_type 分派 healthPath，~5 行）：
/*
        ${sql.json({
          healthPath:
            endpoint.protocol === "blender_bridge" && !registryChannel(channel.label)?.baseUrlEnv.includes("LOCAL")
              ? "health"                                        // blender-modal：片X 對齊（pending）
              : endpoint.protocol === "blender_bridge"
                ? "v1/health"                                   // blender-local：bridge 契約真源 README
                : process.env.ADOBE2API_HEALTH_PATH ?? "health",
          minimumSuccessRate5m: 0.8,
        } as never)}
*/
//    （healthPath 儲存形態與 adobe-health.ts L60-64 的讀取端一致：
//    configuration_json.healthPath，refreshBlenderNodeHealth 同構復用。）

//    配套新檔 src/lib/generation-core/blender-node-health.ts（~60 行）：
//    refreshBlenderNodeHealth＝adobe-health.ts L37-45 逐行同構換 SELECT 條件
//    （WHERE supplier.adapter_type='blender_bridge'）與健康判定（NODES-PLAN §3.3
//    表：ok+egl→healthy、ok+cpu→degraded、佇列飽和→degraded、不可達→unhealthy），
//    寫 account.health_status＋configuration_json 快照。掛載點＝adobe-health
//    現有輪詢的排程處（執行片核實掛載行）。

// ═══════════════════════════════════════════════════════════════════════════
// §E 派發判定純函數（可離線實跑）
//    scheduler.ts L68-78 ORDER BY 的本地同構投影。僅做排序語義驗證，
//    不是生產代碼（生產排序在 Postgres SQL 內，此處無法也不必復刻 SKIP LOCKED）。
// ═══════════════════════════════════════════════════════════════════════════

export type Tier = "first_party" | "managed_pool" | "relay" | "fallback";

/** scheduler L68-70 CASE supply_tier 同構。 */
export function tierRank(tier: Tier): number {
  switch (tier) {
    case "first_party": return 0;
    case "managed_pool": return 1;
    case "relay": return 2;
    default: return 3;
  }
}

/** scheduler L71 CASE health_status 同構。 */
export function healthRank(status: string): number {
  if (status === "healthy") return 0;
  if (status === "degraded") return 1;
  return 2;
}

export interface NodeCandidate {
  id: string;
  tier: Tier;
  priority: number;          // seedPriority
  healthStatus: string;      // healthy | degraded | disabled
  cooldownUntil: number | null; // epoch ms；null＝未冷卻
  qualityScore: number;      // 0-1
  capabilityHealthScore: number; // 0-1
  activeLeases: number;      // 活躍 supplier_lease 數
  concurrencyLimit: number;
  latencyEwmaMs: number | null;
  unitCost: number;          // blender 節點：本機 0、Modal GPU 分鐘折算、CNB 按次
  lastSelectedAt: number | null; // epoch ms
}

/**
 * 認領候選集過濾＝scheduler L37-45 + L61-66 WHERE 的同構投影（硬排除）：
 *   disabled／冷卻中（supplier 層；生產還有 capability/account 兩層同構條件）／
 *   lease 佔滿的節點根本不進候選集。
 * 依賴這一點的節點語義：本機佔線（併發 1 被佔）或 health 輪詢寫入
 * disabled/短冷卻（不可達、佇列飽和）時，流量自動落 managed_pool 的 modal——
 * 「本機最快優先→Modal 額度池」的梯隊語義由 WHERE 層實現，零新邏輯。
 */
export function acquireNodeCandidates(candidates: NodeCandidate[], now: number = Date.now()): NodeCandidate[] {
  return candidates.filter((c) =>
    c.healthStatus !== "disabled" &&
    (c.cooldownUntil === null || c.cooldownUntil <= now) &&
    c.activeLeases < c.concurrencyLimit
  );
}

/**
 * 存活候選排序＝scheduler L68-78 ORDER BY 的 TypeScript 同構投影：
 *   tier → priority ASC → health → score 乘積 DESC → 負載比 ASC →
 *   latency ASC → cost ASC → last_selected（LRU）。
 * 注意（誠實語義）：degraded 是排序內的軟懲罰（L71 CASE 第三鍵），壓不過
 * tier——本機 degraded 仍勝 modal healthy；要跨檔讓位必須由健康輪詢寫
 * disabled/cooldown_until（acquireNodeCandidates 的排除面），這是既有欄位的
 * 既有行為，不是本稿發明。
 */
export function rankNodeCandidates(candidates: NodeCandidate[]): NodeCandidate[] {
  return [...candidates].sort((a, b) =>
    tierRank(a.tier) - tierRank(b.tier) ||
    a.priority - b.priority ||
    healthRank(a.healthStatus) - healthRank(b.healthStatus) ||
    (b.healthScore * b.qualityScore * b.capabilityHealthScore) -
      (a.healthScore * a.qualityScore * a.capabilityHealthScore) ||
    a.activeLeases / a.concurrencyLimit - b.activeLeases / b.concurrencyLimit ||
    (a.latencyEwmaMs ?? Infinity) - (b.latencyEwmaMs ?? Infinity) ||
    a.unitCost - b.unitCost ||
    (a.lastSelectedAt ?? 0) - (b.lastSelectedAt ?? 0)
  );
}

/** 認領全流程投影：WHERE 排除 → ORDER BY 排序（= acquireSupplierLease 一體兩段）。 */
export function acquireNode(candidates: NodeCandidate[], now: number = Date.now()): NodeCandidate | null {
  const survivors = acquireNodeCandidates(candidates, now);
  return survivors[0] ? rankNodeCandidates(survivors)[0] : null;
}

/** 三節點梯隊的註冊形狀（§A diff 稿的運行時投影，供驗證腳本與文檔對照）。 */
export const BLENDER_NODE_REGISTRY_DRAFT = [
  {
    label: "blender-local",
    baseUrlEnv: "BLENDER_NODE_LOCAL_URL",
    apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",
    enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
    tier: "first_party" as Tier,
    seedPriority: 10,
    sitePriority: 10,
    chatImageModels: [] as string[],
    adapterType: "blender_bridge",
    claims: [
      { modelId: "blender-render-eevee", supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },
  {
    label: "blender-modal",
    baseUrlEnv: "BLENDER_NODE_MODAL_URL",   // pending：片X 交付
    apiKeyEnv: "BLENDER_NODE_MODAL_TOKEN",
    enabledEnv: "BLENDER_NODE_MODAL_ENABLED",
    tier: "managed_pool" as Tier,
    seedPriority: 20,
    sitePriority: 20,
    chatImageModels: [] as string[],
    adapterType: "blender_bridge",
    claims: [
      { modelId: "blender-render-eevee", supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },
] as const;
