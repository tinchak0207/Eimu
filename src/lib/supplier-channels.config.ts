// 新生图渠道注册表：旧 6 渠道（adobe2api/sub2api/primary/fallback/pixai/filmera）
// 有特殊语义（开关互斥、/v1 补缀、supabase 配置），维持原有硬编码逻辑不动；
// 之后新增的渠道一律登记在此，由 describeEnvChannels / seed 脚本 /
// channel-registry 数据驱动接管，加渠道 = 跑 tools/add-supplier-channel.ts 一条命令。
//
// 档案必须是 .ts（而非 JSON）：Next 打包（Vercel lambda bundle）与 tsx 跑 tools
// 都要能直接 import。
//
// 新增一条**新协议**供给＝2 档（V-06，docs/architecture/planes.md §2.3）：
//   ① 新 adapter 档 `export const fooAdapter: SupplyAdapter = { protocol: "foo", submit, poll? }`
//   ② 本档条目 `adapterType: "foo", adapter: fooAdapter`（import 该 adapter）
// generation-core/supply-registry.ts 载入时自动注册条目上的 adapter，分派／对帐／
// 对帐协议映射都查 registry，不需改其他档。同协议供给只动本档（N=1）。

import type { SupplyAdapter } from "./generation-core/supply-registry";

export type RegistryClaimKind = "image_generate" | "image_edit" | "video_generate" | "tts";

export interface RegistryChannelClaim {
  modelId: string;                // 平台 catalog 模型 id
  supplierModelId: string | null; // 上游模型名；null = 同名直传
  kinds: RegistryClaimKind[];
  /**
   * 已核上游单价（人民币元／次，V-03）。按（本渠道, supplierModelId）定，不按模型名全域定；
   * 付费视频成本闸（paid-video-cost-gate.ts）优先读这里，缺省才回退闸内兜底表。
   */
  unitPriceCny?: number;
  /**
   * 按**秒**计费上游的每档分辨率单价（人民币元／秒），键＝resolution（如 "480p"/"720p"）。
   * 与 unitPriceCny（按次固定价）互斥；两者皆缺＝未核价（付费视频闸 fail-closed 拒收）。
   */
  unitPriceCnyPerSecond?: Record<string, number>;
  /** 核价来源原文＋日期，例 "GET https://www.gway.dev/api/pricing 2026-09-28 vip quota_type=1"。 */
  priceSource?: string;
}

export interface RegistryChannel {
  label: string;                 // 同时是 env channel label 与 DB supplier label
  baseUrlEnv: string;
  apiKeyEnv: string;             // 同时作为 credentialRef
  enabledEnv: string | null;     // 有值时：清洗后 === "true" 才 defaultEnabled
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  sitePriority: number;          // 站点队列 ENV_CHANNEL_PRIORITIES 用
  chatImageModels: string[];     // 上游模型名走 /chat/completions 生图（空 = 全走 images/generations）
  /** 上游 images/generations 拒收 quality 栏位时置 true（agnes 实锤 2026-09-19：text image queue 只认 model/prompt/size/n）。 */
  omitQualityBody?: boolean;
  /**
   * 供给协议（＝DB supplier.adapter_type ＝ supply-registry 的 protocol）；合法值由
   * registry 执行期判定（未注册＝明确失败）。内建：openai_images / adobe2api / metaso /
   * openai_video / filmera / blender_bridge / newapi_video。
   */
  adapterType?: string; // 缺省 openai_images；metaso 走自订协议（见 metaso-upstream.ts），openai_video 走 /v1/videos 异步（见 openai-video-upstream.ts），blender_bridge 走桥 /v1/execute 同步单帧渲染（见 blender-node-upstream.ts），adobe2api 走 firefly-* 映射（见 adobe2api-upstream.ts，含视频走 /v1/chat/completions）
  /** 新协议供给：直接挂 adapter 物件（宣告即注册）；`adapterType` 若有须等于 `adapter.protocol`。 */
  adapter?: SupplyAdapter;
  claims: RegistryChannelClaim[];
}

export const REGISTRY_CHANNELS: RegistryChannel[] = [
  // REGISTRY-ENTRIES-START（脚本插入点，此注释与结束标记之间的条目由工具维护，手改会被覆盖）
{
    // xiaoyxiao（api.xiaoyxiao.xyz，2026-09-27 暴君裁定）：**视频唯一权威渠道**。
    // 上游协议与我方既有 openai_video 轮子同型（禁造新轮子）：POST {base}/videos
    // 创建、GET {base}/videos/{id} 轮询；成品 URL 在**顶层 `url`**（extractOutputUrl
    // 已支援该形状，2026-09-27 实弹）。请求体走 sd4 族形状（model/prompt/
    // aspect_ratio/duration/resolution/generate_audio），adapter 零改动。模型名由
    // claims 的 supplierModelId 渠道级短路（同 napi/drama 模式，不进静态映射表）。
    //
    // 成本闸（2026-09-27 ¥31.2857 事故，见 src/lib/generation-core/paid-video-cost-gate.ts）：
    // 本渠道**只准**提交白名单 7 条上游 model（全部 quota_type=1 按次固定价，不随
    // resolution/seconds 变动）。下列 supplierModelId 逐字取自该白名单；白名单外的
    // 档位（3010-特惠／满血／原生真人／mini-A／max／-a 等）一律不认领——未核价或
    // 已遭剔除。缺 resolution／4k／≤720p 外／seconds>5 由闸门 fail-closed 拒收。
    // ⚠ 900/933/1010 档位的分辨率语义未经真单校准，映射为保守候选（见白名单注解）。
    label: "xiaoyxiao",
    baseUrlEnv: "XIAOYXIAO_BASE_URL",
    apiKeyEnv: "XIAOYXIAO_API_KEY",
    enabledEnv: "XIAOYXIAO_ENABLED",
    tier: "managed_pool",
    sitePriority: 1,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      // 已核价（¥/次，GET /api/pricing 2026-09-27 免登入唯读实查）：
      // seedance-2.0-900-特惠 0.7、seedance-2.5-900-特惠 0.9、
      // minimax-h3-933-2k-支持真人 1.1；seedance-2.5-1010-特惠 1.6（原文见
      // paid-video-cost-gate.ts PAID_VIDEO_UNIT_PRICE_CNY）。V-03 起写成 claim 栏位。
      { modelId: "seedance-2.0",      supplierModelId: "seedance-2.0-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.7, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      { modelId: "seedance-2.5-480p", supplierModelId: "seedance-2.5-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.9, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      { modelId: "seedance-2.5-720p", supplierModelId: "seedance-2.5-1010-特惠",     kinds: ["video_generate"], unitPriceCny: 1.6, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      // H-fix（2026-10-02）：minimax-h3 → minimax-h3-a（白名单内、quota_type=1 按次 ¥1.6，
      // 上游 /api/pricing 2026-10-02 实查，billing_expr=tier("standard",1.6)，无分辨率键）。
      // 旧映射 minimax-h3-933-2k-支持真人 在 xiaoyxiao 与 gway 皆回
      // `no per_request price configured for resolution "2k"`（gway 该变体 video_pricing.by_group["*"].tiers=[]，
      // 且仅支持 resolution=2k，成本闸禁 2k）；故两渠道均不再认领该变体。
      { modelId: "minimax-h3", supplierModelId: "minimax-h3-a", kinds: ["video_generate"], unitPriceCny: 1.6, priceSource: "GET https://api.xiaoyxiao.xyz:18443/api/pricing 2026-10-02 (quota_type=1, model_price=1.6)" },
    ],
  },

{
    // gway（极途Gway，api.gway.dev，2026-09-28）：xiaoyxiao 的直接上游（取证见记忆
    // 2026-09-28-xiaoyxiao-upstream-chain-0928）。同名模型挂 vip 分组、单价恒＝xiaoyxiao−¥0.1。
    // 现为**备用渠道**（priority 2，xiaoyxiao 失败才轮到）；暴君裁定 xiaoyxiao 余额跑完即搬家至此。
    // 协议、模型名、成本闸白名单与 xiaoyxiao 完全同型。V-03（2026-09-28）起成本闸按
    //（供给 label, supplierModelId）读下方 claim 的 unitPriceCny，gway 的真实单价进闸。
    label: "gway",
    baseUrlEnv: "GWAY_BASE_URL",
    apiKeyEnv: "GWAY_API_KEY",
    enabledEnv: "GWAY_ENABLED",
    tier: "managed_pool",
    sitePriority: 2,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      // 已核价（GET https://www.gway.dev/api/pricing 2026-09-28，vip 分组，quota_type=1）：
      // seedance-2.0-900-特惠 0.6、seedance-2.5-900-特惠 0.8、seedance-2.5-1010-特惠 1.5、
      // minimax-h3-933-2k-支持真人 1.0。
      { modelId: "seedance-2.0",      supplierModelId: "seedance-2.0-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.6, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分组, quota_type=1)" },
      { modelId: "seedance-2.5-480p", supplierModelId: "seedance-2.5-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.8, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分组, quota_type=1)" },
      { modelId: "seedance-2.5-720p", supplierModelId: "seedance-2.5-1010-特惠",     kinds: ["video_generate"], unitPriceCny: 1.5, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分组, quota_type=1)" },
      // H-fix：gway 的 minimax-h3-933-2k-支持真人 无 per_request 价（上游 502），不认领；gway 无其他 minimax 变体。
    ],
  },

{
    // dmc（dmc.cc，2026-10-13 暴君指定为影片**首发上游**）：与 metaso 同形的
    // MiniMax 官方协议（POST {base}/v2/video_generation 建任务、GET
    // {base}/v2/query/video_generation/{id} 轮询），见 dmc-upstream.ts。上游只出
    // 768P、整数 1–15 秒，模型名固定 MiniMax-H3（GET /v1/models 2026-10-13 实查：
    // 仅 MiniMax-H3 一条）。
    //
    // 上游单价（GET https://dmc.cc/api/pricing 2026-10-13 免登入唯读实查）：
    //   model_name=MiniMax-H3, quota_type=1, model_price=0.014706（USD/s；
    //   站点 /api/status usd_exchange_rate=6.8 ⇒ ¥0.10/秒，**按秒计价**，与
    //   miaowu 的按次固定价不同型）；billing_usage_schema.seconds 与
    //   billing_usage_examples（768P 5s/10s/15s）确认按秒计。
    // 实单对帐（2×5s 文生视频，2026-10-13）：/v1/dashboard/billing/usage
    //   total_usage=100.0008 分 = ¥1.000008 ≈ ¥0.10/s × 10s，与核价一致。
    label: "dmc",
    baseUrlEnv: "DMC_BASE_URL",
    apiKeyEnv: "DMC_API_KEY",
    enabledEnv: "DMC_ENABLED",
    tier: "relay",
    sitePriority: 2,
    chatImageModels: [],
    adapterType: "dmc",
    claims: [
      { modelId: "minimax-h3", supplierModelId: "MiniMax-H3", kinds: ["video_generate"], unitPriceCnyPerSecond: { "720p": 0.1 }, priceSource: "GET https://dmc.cc/api/pricing 2026-10-13 (quota_type=1, model_price=0.014706 USD/s × usd_exchange_rate=6.8 = ¥0.10/s)；实单对帐 2×5s → /v1/dashboard/billing/usage total_usage=100.0008分 = ¥1.000008" },
    ],
  },

{
    // miaowuai（喵呜API，api.miaowuai.store，2026-10-12 暴君指定）：影片生成
    // **默认渠道**——协议与我方既有 openai_video 轮子同型（new-api 上游：POST
    // {base}/videos 创建、GET {base}/videos/{id} 轮询，completed 顶层 `url`，与
    // xiaoyxiao 实弹形状相同），adapter 零改动。认领 minimax-h3 → 上游
    // minimax-h3-max（GET /v1/models 2026-10-12 实查）。
    //
    // 上游单价（GET https://api.miaowuai.store/api/pricing 2026-10-12 免 key 唯读实查）：
    //   model_name=minimax-h3-max, quota_type=1, model_price=0.2857142857142857（USD；
    //   站点 /api/status usd_exchange_rate=7 ⇒ ¥2.00/次，按次固定价、不随
    //   resolution/seconds 变动）；video_api：sizes=["720p","480p"]、seconds 5–15
    //   （≤720p，符合成本闸红线；**不是** 4k 动态价，无 ¥31.2857 事故形状）。
    label: "miaowuai",
    baseUrlEnv: "MIAOWUAI_BASE_URL",
    apiKeyEnv: "MIAOWUAI_API_KEY",
    enabledEnv: "MIAOWUAI_ENABLED",
    tier: "managed_pool",
    sitePriority: 3,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      { modelId: "minimax-h3", supplierModelId: "minimax-h3-max", kinds: ["video_generate"], unitPriceCny: 2.0, priceSource: "GET https://api.miaowuai.store/api/pricing 2026-10-12 (quota_type=1, model_price=0.2857142857142857 USD × usd_exchange_rate=7 = ¥2.00)" },
      // seedance-2.0-mini（2026-10-13 暴君指定）：上游按**秒**计价，与 minimax-h3-max
      // 的按次固定价不同型——`video_api.pricing.unit="per_second"`，rules：480p
      // 0.012857142857142857 USD/s、720p 0.028571428571428574 USD/s，站点
      // usd_exchange_rate=7 ⇒ ¥0.09/s、¥0.2/s。上游名与平台名同名直传；sizes 480p/720p、
      // seconds 4–15、ratios 1:1/16:9/9:16/4:3/3:4（**无 21:9**）。
      { modelId: "seedance-2.0-mini", supplierModelId: "seedance-2.0-mini", kinds: ["video_generate"], unitPriceCnyPerSecond: { "480p": 0.09, "720p": 0.2 }, priceSource: "GET https://api.miaowuai.store/api/pricing 2026-10-13 (video_api.pricing.unit=per_second: 480p 0.012857142857142857 USD/s → ¥0.09/s, 720p 0.028571428571428574 USD/s → ¥0.2/s × usd_exchange_rate=7)" },
    ],
  },

{
    label: "hublinuxdo",
    baseUrlEnv: "HUBLINUXDO_BASE_URL",
    apiKeyEnv: "HUBLINUXDO_API_KEY",
    enabledEnv: "HUBLINUXDO_ENABLED",
    tier: "managed_pool",
    sitePriority: 12,
    // 上游实测（2026-08-27 二次实测）：聚合 key 手动绑 19 渠道，nano-banana 家族
    // 以「真名」挂在 chat/completions（gemini 系平台名一律 422 model not found，
    // 花名必须映射）：gemini-2.5-flash-image 200@6.5s（anti-gemini）、
    // gemini-3-pro-image 200@21.9s（OpenAI兼容）、gemini-3.1-flash-image 200@73s。
    // gpt-image-2 走 images/generations 实测 200@59s。
    // chatImageModels 存「上游真名」，viaChatImage 按 upstreamModel 匹配。
    chatImageModels: ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      // 2026-09-11 实测：hub 上游 /v1/images/generations 对 gpt-image-2.5-flare 与
      // gpt-image-2.5-sunburst 均 200 真出图（b64），上游名与平台名同名直传，
      // 故由 hub 认领（adobe2api 路径 408 未通）。kinds 只认 image_generate。
      {
        modelId: "gpt-image-2.5-flare",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      {
        modelId: "gpt-image-2.5-sunburst",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      {
        modelId: "gemini-3-image",           // nano-banana-pro（花名）
        supplierModelId: "gemini-3-pro-image", // 上游真名
        kinds: ["image_generate", "image_edit"],
      },
      {
        modelId: "gemini-3.1-flash-image",   // nano-banana-2，同名直传
        supplierModelId: null,
        kinds: ["image_generate", "image_edit"],
      },
      {
        modelId: "gemini-2.5-flash-image",   // nano-banana，同名直传
        supplierModelId: null,
        kinds: ["image_generate"],
      },
    ],
  },

{
    label: "yyds",
    baseUrlEnv: "YYDS_BASE_URL",
    apiKeyEnv: "YYDS_API_KEY",
    enabledEnv: null,
    tier: "managed_pool",
    sitePriority: 11,
    chatImageModels: [],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        // 2026-09-14 实测：yyds /v1/images/edits 收 gpt-image-2 多模态改图
        // （HTTP 200 / 24.9s / 1.85MB PNG，b64_json 直回）。此前只宣告
        // image_generate，使 gpt-image-2 的 edit 能力表只剩死渠道
        // （adobe2api 403 额度枯竭、sub2api 524），改图全军覆没。
        kinds: ["image_generate", "image_edit"],
        unitPriceCny: 0.016,
        priceSource: "GET https://yyds.chybenzun.top/api/v1/model-plaza 2026-10-03 (group #75/#159, 1K/2K/4K 统一 0.016 元/次; 免 key 唯读实查)",
      },
      // 0.016＝1K/2K/4K 统一价，来源与日期见 priceSource（站点公开价目，免 key 唯读实查）。
      // 上游模型名与我方同名，`GET /v1/models` 实证无分组后缀（非 -g75 等变体），故 supplierModelId=null 直传。
      // edit 未实测，故这两条只宣告 image_generate；上游 hub 对同两模型亦只宣告 generate。
      {
        modelId: "gpt-image-2.5-flare",
        supplierModelId: null,
        kinds: ["image_generate"],
        unitPriceCny: 0.016,
        priceSource: "GET https://yyds.chybenzun.top/api/v1/model-plaza 2026-10-03 (group #75/#159, 1K/2K/4K 统一 0.016 元/次; 免 key 唯读实查)",
      },
      {
        modelId: "gpt-image-2.5-sunburst",
        supplierModelId: null,
        kinds: ["image_generate"],
        unitPriceCny: 0.016,
        priceSource: "GET https://yyds.chybenzun.top/api/v1/model-plaza 2026-10-03 (group #75/#159, 1K/2K/4K 统一 0.016 元/次; 免 key 唯读实查)",
      },
    ],
  },

{
    // ⚠ 本条目位于 add-supplier-channel.ts 的 marker 维护区内（片Y 稿 §A 拍板：手写
    // 落位、不再跑该工具）；若日后重跑工具，须把本条目重新贴回。
    // 本机 RTX 5070 Laptop＋Blender 5.2.1 EGL（blender-bridge，127.0.0.1:8765）。
    // first_party＝自营最快（与 adobe2api 同档）：scheduler 第一排序键 supply_tier
    // CASE → 0，本机 lease 空闲时必胜；桥并发 1（BLENDER_BRIDGE_CONCURRENCY 铁律），
    // 占线时 scheduler 走 lease 过滤自然落下一节点，零新逻辑（片Y staging 稿 §A）。
    // 能力标签＝capability model_id：blender-render-eevee / blender-render-cycles
    // 单帧渲染（多帧不进节点派发——片L 实锤单帧才是安全单位）。
    label: "blender-local",
    baseUrlEnv: "BLENDER_NODE_LOCAL_URL",   // VPS 侧值固定 http://127.0.0.1:8765（片W 反向隧道裁定一字不改）
    apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",  // 桥侧 Bearer 共享 token（同时作为 credentialRef）
    enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
    tier: "first_party",
    sitePriority: 10,
    chatImageModels: [],                    // blender 节点无 chat 生图概念，恒空
    adapterType: "blender_bridge",
    claims: [
      // kinds 沿用 image_generate（单帧 PNG 产出语义同图像生成，零枚举扩散）；
      // supplierModelId: null＝模型名即引擎标签，adapter 脚本构造器按 modelId 选 engine。
      { modelId: "blender-render-eevee", supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },

  // blender-modal（managed_pool，片X Modal L4）与 blender-cnb（relay）只埋桩不注册：
  // 片X 未落盘（deploy-staging/blender-modal/ 不存在）、CNB 无实体节点——注册即虚报能力。
  // NODES-PLAN §5：节点 ≥3 且异构＋需要场景档分发时才评估 Flamenco 3。
  //
  // 2026-09-27 暴君裁定（视频渠道重整）：metaso／tokenmix／cangyuansuanli／napi／
  // drama／adobe2api-plus 六条 registry 条目**自本表移除**（连同 env:filmera 由
  // seed 的 RETIRED_SUPPLIER_LABELS 一并停用）——视频供货唯一权威改为 xiaoyxiao，
  // 其余渠道不得再藉 seed 复活（它们在控面已 supplier.enabled=false + capability
  // 停用）。adobe2api 留图停视频（见 seed 的 video 跳过）。

  {
    label: "agnes",
    baseUrlEnv: "AGNES_BASE_URL",
    apiKeyEnv: "AGNES_API_KEY",
    enabledEnv: null,
    tier: "relay",
    sitePriority: 25,
    chatImageModels: [],
    omitQualityBody: true,
    claims: [
      {
        modelId: "agnes-image-2.5-flash",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
    ],
  },

  {
    // agnes-video（免费兜底视频档，2026-10-13 暴君指定）：与既有 agnes（图片）同一上游
    // base，但视频走 /v1/videos 异步协议。**一个 supplier 只有一个 adapter_type**，图片与
    // 视频协议不同，故拆成两条 registry 条目（`env:agnes` 图片、`env:agnes-video` 视频）。
    //
    // 协议复用 openai_video 轮子（禁造新轮子）：POST {base}/videos 创建、GET {base}/videos/{id}
    // 轮询——与 xiaoyxiao/miaowu 同型；请求体形状是 agnes 专属的
    // {model, prompt, seconds(字串), mode, size(大写 720P), aspect_ratio}，由
    // openai-video-upstream 的 agnes 分支构造。**上游严格拒未知栏位**（真单 400
    // `foo is not an allowed request field`），故只送上述六栏。
    //
    // **免费**：上游成本 ¥0（平台自有免费额度）。但视频提交走 openai_video 的 fail-closed
    // 成本闸，故上游名进视频白名单并给 unitPriceCny:0（成本 0，闸照样审，保留 ≤720p 边界）。
    // 免费档队列/限速（真单见过 429 rate_limit_exceeded / 503 video_queue_full）；key 与图片
    // 渠道分开（AGNES_VIDEO_API_KEY），不覆写既有可用的 AGNES_API_KEY。
    label: "agnes-video",
    baseUrlEnv: "AGNES_BASE_URL",
    apiKeyEnv: "AGNES_VIDEO_API_KEY",
    enabledEnv: null,
    tier: "fallback",
    sitePriority: 40,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      { modelId: "agnes-video-2.5-flash", supplierModelId: "agnes-video-2.5-flash", kinds: ["video_generate"], unitPriceCny: 0, priceSource: "free tier（agnes 平台自有免费额度，上游成本 ¥0，2026-10-13 暴君指定为免费兜底）" },
    ],
  },

  {
    label: "harness-tts",
    baseUrlEnv: "HARNESS_TTS_BASE_URL",
    apiKeyEnv: "HARNESS_TTS_API_KEY",
    enabledEnv: "HARNESS_TTS_ENABLED",
    tier: "relay",
    sitePriority: 50,
    chatImageModels: [],
    adapterType: "harness_tts",
    claims: [
      {
        modelId: "tts-1",
        supplierModelId: null,
        kinds: ["tts"],
      },
    ],
  },
  // REGISTRY-ENTRIES-END
];
