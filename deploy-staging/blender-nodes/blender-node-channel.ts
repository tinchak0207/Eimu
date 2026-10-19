/**
 * blender 节点 supplier channel 同构定义稿（片Y，2026-09-06）。
 *
 * 性质：staging 稿。本档不改 src/（改码归后续执行片）；三个用途：
 *   ① registry 真源的最小 diff 稿（§A——贴进 src/lib/supplier-channels.config.ts
 *      的 REGISTRY-ENTRIES marker 区）
 *   ② seed/adapter/health 三处配套 diff 稿（§B/§C/§D）
 *   ③ 派发判定纯函数（§E）——scheduler ORDER BY 的本地同构投影，可离线实跑
 *      （npx tsx deploy-staging/blender-nodes/verify-node-dispatch.ts），
 *      证明「本机 first_party → Modal managed_pool → CNB relay」的排序语义
 *      与 gateway 现有 supplier 派发逐字段同构。
 *
 * 同构真源（考古结论，全部带行号核实）：
 *   - RegistryChannel 形状：src/lib/supplier-channels.config.ts L17-28
 *   - env→descriptor：src/lib/sub2api.ts L114 registryChannelToDescriptor
 *   - seed 三表：tools/seed-generation-suppliers.ts L314-356
 *   - 认领排序：src/lib/generation-core/scheduler.ts L68-78
 *   - adapter 分派：src/lib/generation-core/supplier-adapter.ts L108-135
 *   - 健康探测轮子：src/lib/generation-core/adobe-health.ts L37-45
 *   - bridge 契约：bridge/blender-bridge/README.md（/v1/health、/v1/execute）
 */

// ═══════════════════════════════════════════════════════════════════════════
// §A 最小 diff 稿：src/lib/supplier-channels.config.ts
//    插入位置：REGISTRY-ENTRIES-START（L31）与 REGISTRY-ENTRIES-END（L192）之间
//    ——注意：此区由 tools/add-supplier-channel.ts 维护，手改会被工具覆盖；
//    落位方式二选一：①直接手写进 marker 区后不再跑该工具（registry 渠道已稳定，
//    风险低）；②工具跑完后把条目重新贴回。执行片拍板。
// ═══════════════════════════════════════════════════════════════════════════

/*
  {
    // 本机 RTX 5070 Laptop＋Blender 5.2.1 EGL。VPS gateway 经片W 反向隧道
    // （deploy-staging/blender-bridge-tunnel/）访 http://127.0.0.1:8765。
    // first_party＝自营最快（与 adobe2api 同档）：scheduler 第一排序键
    // supply_tier CASE → 0，本机 lease 空闲时必胜；并发 1（桥铁律
    // BLENDER_BRIDGE_CONCURRENCY=1），占线时 scheduler 走 lease 过滤自然落
    // 下一节点，零新逻辑。
    label: "blender-local",
    baseUrlEnv: "BLENDER_NODE_LOCAL_URL",   // VPS 值固定 http://127.0.0.1:8765（片W 裁定一字不改）
    apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",  // 片W §5 桥侧 Bearer patch 的共享 token（同时作为 credentialRef）
    enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
    tier: "first_party",
    seedPriority: 10,                       // 同 adobe2api 档位（seed-generation-suppliers.ts L322）
    sitePriority: 10,
    chatImageModels: [],                    // blender 节点无 chat 生图概念，恒空
    adapterType: "blender_bridge",          // 新 enum 值，§B 配套
    claims: [
      // kinds 沿用 image_generate（单帧 PNG 产出语义同图像生成，零枚举扩散）。
      // supplierModelId: null＝同名直传（模型名即引擎标签，bridge /v1/execute
      // 的脚本构造器按 modelId 选 engine，无上游映射需求）。
      { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },

  {
    // Modal L4 节点（片X 交付物）。managed_pool＝额度池（GPU 分钟计费，与
    // hublinuxdo/yyds 同档）；本机 first_party 之后的受管备援。
    // ⚠ pending：endpoint/health 对齐以片X 实际交付为准——若片X 的 health 端点
    // 非 /v1/health（NODES-PLAN §3.3 预写 /health），healthPath 走 §D 分派。
    label: "blender-modal",
    baseUrlEnv: "BLENDER_NODE_MODAL_URL",   // https://<modal-app>.modal.run（片X token 后补）
    apiKeyEnv: "BLENDER_NODE_MODAL_TOKEN",  // Modal 鉴权 token（形态待片X）
    enabledEnv: "BLENDER_NODE_MODAL_ENABLED",
    tier: "managed_pool",
    seedPriority: 20,                       // hub 12 / yyds 13 之后，与 blender 语义不冲突
    sitePriority: 20,
    chatImageModels: [],
    adapterType: "blender_bridge",
    claims: [
      { modelId: "blender-render-eevee",  supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },
  // blender-cnb（relay 档位）只埋桩不注册：无实体节点，注册即虚报能力。
  // 触发条件（研究片 V）：节点 ≥3 且异构＋需要场景档分发 → 届时评估 Flamenco 3
  // 而非继续加 registry 条目（NODES-PLAN §5）。
*/

// ═══════════════════════════════════════════════════════════════════════════
// §B 最小 diff 稿：src/lib/generation-core/supplier-adapter.ts
// ═══════════════════════════════════════════════════════════════════════════

// B-1. adapterType 类型扩展（supplier-channels.config.ts L26 与 SupplierRecord
//     两处）："openai_images" | "metaso" | "openai_video" | "blender_bridge"

// B-2. requestSupplier（L108 起）加分派分支——形状照抄 filmera/metaso 分支：
/*
  if (supplier.adapterType === "blender_bridge") {
    return generateWithBlenderNode(supplier, input);
  }
*/

// B-3. generateWithBlenderNode 本体（新函数，~80 行；职责：modelId→engine、
//     单帧脚本构造、POST /v1/execute、产物收敛）：
/*
  async function generateWithBlenderNode(
    supplier: SupplierRecord, input: SupplierGenerationInput,
  ): Promise<SupplierGenerationOutput> {
    // 1. 引擎选型：input.modelId "blender-render-eevee"|"blender-render-cycles"
    //    → engine（"BLENDER_EEVEE_NEXT" 注释钉死见片M；cycles 不受限）。
    // 2. 单帧渲染脚本：Eevee 存活配方 samples=1＋RT off（片M 已在
    //    blender-tools.ts 落地，同构搬运；动画/多帧不在节点派发范围——片L
    //    实锤桥内多帧必 native 崩，单帧 job 才是安全单位）。
    // 3. fetch `${supplier.baseUrl}/v1/execute`：
    //    body {script, timeout_ms: RENDER_DEFAULT_TIMEOUT_MS}，
    //    Authorization: Bearer readCredential(supplier)（既有轮子）。
    //    429 queue_full / connection lost＝瞬态，交上层重试（片K 契约）。
    // 4. 产物收敛：本机节点回 path（.blender-work/out/，零变化）；
    //    Modal 节点回 bytes（pending：片X 定卷形态后 adapter 内嵌收敛）——
    //    两者在本函数收敛成同一 SupplierGenerationOutput，上层不感知节点差异。
    //    kind 分拣（png/blend/glb）复用 blender-delegate.ts 既有 collect 逻辑。
  }
*/

// B-4. worker-service.ts L54 protocolOfAdapter：**零改动**——blender_bridge 是
//     同步 adapter（请求-回应内完成），不加映射即不进异步对帐（L53 注释明说
//     「同步 adapter 无异步任务语义，不在此列」）；deadline 由 worker 既有
//     双层超时＋桥 timeout 契约覆盖（片K）。

// ═══════════════════════════════════════════════════════════════════════════
// §C 最小 diff 稿：src/lib/generation-model-catalog/catalog.ts
//    GENERATION_MODEL_CATALOG 加两条（claims 的前置依赖——channelCapabilities
//    对不在 catalog 的 modelId warn＋skip，宁少认领不虚报）：
/*
  "blender-render-eevee":  { aspectRatios: ["1:1"], resolutions: [1024], ... 按catalog既有条目形状补全 },
  "blender-render-cycles": { aspectRatios: ["1:1"], resolutions: [1024], ... },
*/
//    ratios/resolutions 取 square 档（bridge 渲染分辨率由脚本内 blender 相机
//    决定，catalog 栏位仅供平台侧契约显示）。

// ═══════════════════════════════════════════════════════════════════════════
// §D 最小 diff 稿：tools/seed-generation-suppliers.ts L338
//    现状：supplier_account.configuration_json 对所有渠道写死
//    healthPath: process.env.ADOBE2API_HEALTH_PATH ?? "health"
//    diff（按 adapter_type 分派 healthPath，~5 行）：
/*
        ${sql.json({
          healthPath:
            endpoint.protocol === "blender_bridge" && !registryChannel(channel.label)?.baseUrlEnv.includes("LOCAL")
              ? "health"                                        // blender-modal：片X 对齐（pending）
              : endpoint.protocol === "blender_bridge"
                ? "v1/health"                                   // blender-local：bridge 契约真源 README
                : process.env.ADOBE2API_HEALTH_PATH ?? "health",
          minimumSuccessRate5m: 0.8,
        } as never)}
*/
//    （healthPath 储存形态与 adobe-health.ts L60-64 的读取端一致：
//    configuration_json.healthPath，refreshBlenderNodeHealth 同构复用。）

//    配套新档 src/lib/generation-core/blender-node-health.ts（~60 行）：
//    refreshBlenderNodeHealth＝adobe-health.ts L37-45 逐行同构换 SELECT 条件
//    （WHERE supplier.adapter_type='blender_bridge'）与健康判定（NODES-PLAN §3.3
//    表：ok+egl→healthy、ok+cpu→degraded、伫列饱和→degraded、不可达→unhealthy），
//    写 account.health_status＋configuration_json 快照。挂载点＝adobe-health
//    现有轮询的排程处（执行片核实挂载行）。

// ═══════════════════════════════════════════════════════════════════════════
// §E 派发判定纯函数（可离线实跑）
//    scheduler.ts L68-78 ORDER BY 的本地同构投影。仅做排序语义验证，
//    不是生产代码（生产排序在 Postgres SQL 内，此处无法也不必复刻 SKIP LOCKED）。
// ═══════════════════════════════════════════════════════════════════════════

export type Tier = "first_party" | "managed_pool" | "relay" | "fallback";

/** scheduler L68-70 CASE supply_tier 同构。 */
export function tierRank(tier: Tier): number {
  switch (tier) {
    case "first_party": return 0;
    case "managed_pool": return 1;
    case "relay": return 2;
    default: return 3;
  }
}

/** scheduler L71 CASE health_status 同构。 */
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
  cooldownUntil: number | null; // epoch ms；null＝未冷却
  qualityScore: number;      // 0-1
  capabilityHealthScore: number; // 0-1
  activeLeases: number;      // 活跃 supplier_lease 数
  concurrencyLimit: number;
  latencyEwmaMs: number | null;
  unitCost: number;          // blender 节点：本机 0、Modal GPU 分钟折算、CNB 按次
  lastSelectedAt: number | null; // epoch ms
}

/**
 * 认领候选集过滤＝scheduler L37-45 + L61-66 WHERE 的同构投影（硬排除）：
 *   disabled／冷却中（supplier 层；生产还有 capability/account 两层同构条件）／
 *   lease 占满的节点根本不进候选集。
 * 依赖这一点的节点语义：本机占线（并发 1 被占）或 health 轮询写入
 * disabled/短冷却（不可达、伫列饱和）时，流量自动落 managed_pool 的 modal——
 * 「本机最快优先→Modal 额度池」的梯队语义由 WHERE 层实现，零新逻辑。
 */
export function acquireNodeCandidates(candidates: NodeCandidate[], now: number = Date.now()): NodeCandidate[] {
  return candidates.filter((c) =>
    c.healthStatus !== "disabled" &&
    (c.cooldownUntil === null || c.cooldownUntil <= now) &&
    c.activeLeases < c.concurrencyLimit
  );
}

/**
 * 存活候选排序＝scheduler L68-78 ORDER BY 的 TypeScript 同构投影：
 *   tier → priority ASC → health → score 乘积 DESC → 负载比 ASC →
 *   latency ASC → cost ASC → last_selected（LRU）。
 * 注意（诚实语义）：degraded 是排序内的软惩罚（L71 CASE 第三键），压不过
 * tier——本机 degraded 仍胜 modal healthy；要跨档让位必须由健康轮询写
 * disabled/cooldown_until（acquireNodeCandidates 的排除面），这是既有栏位的
 * 既有行为，不是本稿发明。
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

/** 认领全流程投影：WHERE 排除 → ORDER BY 排序（= acquireSupplierLease 一体两段）。 */
export function acquireNode(candidates: NodeCandidate[], now: number = Date.now()): NodeCandidate | null {
  const survivors = acquireNodeCandidates(candidates, now);
  return survivors[0] ? rankNodeCandidates(survivors)[0] : null;
}

/** 三节点梯队的注册形状（§A diff 稿的运行时投影，供验证脚本与文档对照）。 */
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
