// 新生圖渠道註冊表：舊 6 渠道（adobe2api/sub2api/primary/fallback/pixai/filmera）
// 有特殊語義（開關互斥、/v1 補綴、supabase 配置），維持原有硬編碼邏輯不動；
// 之後新增的渠道一律登記在此，由 describeEnvChannels / seed 腳本 /
// channel-registry 數據驅動接管，加渠道 = 跑 tools/add-supplier-channel.ts 一條命令。
//
// 檔案必須是 .ts（而非 JSON）：Next 打包（Vercel lambda bundle）與 tsx 跑 tools
// 都要能直接 import。
//
// 新增一條**新協議**供給＝2 檔（V-06，docs/architecture/planes.md §2.3）：
//   ① 新 adapter 檔 `export const fooAdapter: SupplyAdapter = { protocol: "foo", submit, poll? }`
//   ② 本檔條目 `adapterType: "foo", adapter: fooAdapter`（import 該 adapter）
// generation-core/supply-registry.ts 載入時自動註冊條目上的 adapter，分派／對帳／
// 對帳協議映射都查 registry，不需改其他檔。同協議供給只動本檔（N=1）。

import type { SupplyAdapter } from "./generation-core/supply-registry";

export type RegistryClaimKind = "image_generate" | "image_edit" | "video_generate" | "tts";

export interface RegistryChannelClaim {
  modelId: string;                // 平台 catalog 模型 id
  supplierModelId: string | null; // 上游模型名；null = 同名直傳
  kinds: RegistryClaimKind[];
  /**
   * 已核上游單價（人民幣元／次，V-03）。按（本渠道, supplierModelId）定，不按模型名全域定；
   * 付費視頻成本閘（paid-video-cost-gate.ts）優先讀這裡，缺省才回退閘內兜底表。
   */
  unitPriceCny?: number;
  /** 核價來源原文＋日期，例 "GET https://www.gway.dev/api/pricing 2026-09-28 vip quota_type=1"。 */
  priceSource?: string;
}

export interface RegistryChannel {
  label: string;                 // 同時是 env channel label 與 DB supplier label
  baseUrlEnv: string;
  apiKeyEnv: string;             // 同時作為 credentialRef
  enabledEnv: string | null;     // 有值時：清洗後 === "true" 才 defaultEnabled
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  sitePriority: number;          // 站點隊列 ENV_CHANNEL_PRIORITIES 用
  chatImageModels: string[];     // 上游模型名走 /chat/completions 生圖（空 = 全走 images/generations）
  /** 上游 images/generations 拒收 quality 欄位時置 true（agnes 實錘 2026-09-19：text image queue 只認 model/prompt/size/n）。 */
  omitQualityBody?: boolean;
  /**
   * 供給協議（＝DB supplier.adapter_type ＝ supply-registry 的 protocol）；合法值由
   * registry 執行期判定（未註冊＝明確失敗）。內建：openai_images / adobe2api / metaso /
   * openai_video / filmera / blender_bridge / newapi_video。
   */
  adapterType?: string; // 缺省 openai_images；metaso 走自訂協議（見 metaso-upstream.ts），openai_video 走 /v1/videos 異步（見 openai-video-upstream.ts），blender_bridge 走橋 /v1/execute 同步單幀渲染（見 blender-node-upstream.ts），adobe2api 走 firefly-* 映射（見 adobe2api-upstream.ts，含視頻走 /v1/chat/completions）
  /** 新協議供給：直接掛 adapter 物件（宣告即註冊）；`adapterType` 若有須等於 `adapter.protocol`。 */
  adapter?: SupplyAdapter;
  claims: RegistryChannelClaim[];
}

export const REGISTRY_CHANNELS: RegistryChannel[] = [
  // REGISTRY-ENTRIES-START（腳本插入點，此註釋與結束標記之間的條目由工具維護，手改會被覆蓋）
{
    // xiaoyxiao（api.xiaoyxiao.xyz，2026-09-27 暴君裁定）：**視頻唯一權威渠道**。
    // 上游協議與我方既有 openai_video 輪子同型（禁造新輪子）：POST {base}/videos
    // 創建、GET {base}/videos/{id} 輪詢；成品 URL 在**頂層 `url`**（extractOutputUrl
    // 已支援該形狀，2026-09-27 實彈）。請求體走 sd4 族形狀（model/prompt/
    // aspect_ratio/duration/resolution/generate_audio），adapter 零改動。模型名由
    // claims 的 supplierModelId 渠道級短路（同 napi/drama 模式，不進靜態映射表）。
    //
    // 成本閘（2026-09-27 ¥31.2857 事故，見 src/lib/generation-core/paid-video-cost-gate.ts）：
    // 本渠道**只准**提交白名單 7 條上游 model（全部 quota_type=1 按次固定價，不隨
    // resolution/seconds 變動）。下列 supplierModelId 逐字取自該白名單；白名單外的
    // 檔位（3010-特惠／满血／原生真人／mini-A／max／-a 等）一律不認領——未核價或
    // 已遭剔除。缺 resolution／4k／≤720p 外／seconds>5 由閘門 fail-closed 拒收。
    // ⚠ 900/933/1010 檔位的分辨率語義未經真單校準，映射為保守候選（見白名單註解）。
    label: "xiaoyxiao",
    baseUrlEnv: "XIAOYXIAO_BASE_URL",
    apiKeyEnv: "XIAOYXIAO_API_KEY",
    enabledEnv: "XIAOYXIAO_ENABLED",
    tier: "managed_pool",
    sitePriority: 1,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      // 已核價（¥/次，GET /api/pricing 2026-09-27 免登入唯讀實查）：
      // seedance-2.0-900-特惠 0.7、seedance-2.5-900-特惠 0.9、
      // minimax-h3-933-2k-支持真人 1.1；seedance-2.5-1010-特惠 1.6（原文見
      // paid-video-cost-gate.ts PAID_VIDEO_UNIT_PRICE_CNY）。V-03 起寫成 claim 欄位。
      { modelId: "seedance-2.0",      supplierModelId: "seedance-2.0-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.7, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      { modelId: "seedance-2.5-480p", supplierModelId: "seedance-2.5-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.9, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      { modelId: "seedance-2.5-720p", supplierModelId: "seedance-2.5-1010-特惠",     kinds: ["video_generate"], unitPriceCny: 1.6, priceSource: "GET https://api.xiaoyxiao.xyz/api/pricing 2026-09-27 (quota_type=1, model_price)" },
      // H-fix（2026-10-02）：minimax-h3 → minimax-h3-a（白名單內、quota_type=1 按次 ¥1.6，
      // 上游 /api/pricing 2026-10-02 實查，billing_expr=tier("standard",1.6)，無分辨率鍵）。
      // 舊映射 minimax-h3-933-2k-支持真人 在 xiaoyxiao 與 gway 皆回
      // `no per_request price configured for resolution "2k"`（gway 該變體 video_pricing.by_group["*"].tiers=[]，
      // 且僅支持 resolution=2k，成本閘禁 2k）；故兩渠道均不再認領該變體。
      { modelId: "minimax-h3", supplierModelId: "minimax-h3-a", kinds: ["video_generate"], unitPriceCny: 1.6, priceSource: "GET https://api.xiaoyxiao.xyz:18443/api/pricing 2026-10-02 (quota_type=1, model_price=1.6)" },
    ],
  },

{
    // gway（極途Gway，api.gway.dev，2026-09-28）：xiaoyxiao 的直接上游（取證見記憶
    // 2026-09-28-xiaoyxiao-upstream-chain-0928）。同名模型掛 vip 分組、單價恆＝xiaoyxiao−¥0.1。
    // 現為**備用渠道**（priority 2，xiaoyxiao 失敗才輪到）；暴君裁定 xiaoyxiao 餘額跑完即搬家至此。
    // 協議、模型名、成本閘白名單與 xiaoyxiao 完全同型。V-03（2026-09-28）起成本閘按
    //（供給 label, supplierModelId）讀下方 claim 的 unitPriceCny，gway 的真實單價進閘。
    label: "gway",
    baseUrlEnv: "GWAY_BASE_URL",
    apiKeyEnv: "GWAY_API_KEY",
    enabledEnv: "GWAY_ENABLED",
    tier: "managed_pool",
    sitePriority: 2,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      // 已核價（GET https://www.gway.dev/api/pricing 2026-09-28，vip 分組，quota_type=1）：
      // seedance-2.0-900-特惠 0.6、seedance-2.5-900-特惠 0.8、seedance-2.5-1010-特惠 1.5、
      // minimax-h3-933-2k-支持真人 1.0。
      { modelId: "seedance-2.0",      supplierModelId: "seedance-2.0-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.6, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分組, quota_type=1)" },
      { modelId: "seedance-2.5-480p", supplierModelId: "seedance-2.5-900-特惠",      kinds: ["video_generate"], unitPriceCny: 0.8, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分組, quota_type=1)" },
      { modelId: "seedance-2.5-720p", supplierModelId: "seedance-2.5-1010-特惠",     kinds: ["video_generate"], unitPriceCny: 1.5, priceSource: "GET https://www.gway.dev/api/pricing 2026-09-28 (vip 分組, quota_type=1)" },
      // H-fix：gway 的 minimax-h3-933-2k-支持真人 無 per_request 價（上游 502），不認領；gway 無其他 minimax 變體。
    ],
  },

{
    label: "hublinuxdo",
    baseUrlEnv: "HUBLINUXDO_BASE_URL",
    apiKeyEnv: "HUBLINUXDO_API_KEY",
    enabledEnv: "HUBLINUXDO_ENABLED",
    tier: "managed_pool",
    sitePriority: 12,
    // 上游實測（2026-08-27 二次實測）：聚合 key 手動綁 19 渠道，nano-banana 家族
    // 以「真名」掛在 chat/completions（gemini 系平台名一律 422 model not found，
    // 花名必須映射）：gemini-2.5-flash-image 200@6.5s（anti-gemini）、
    // gemini-3-pro-image 200@21.9s（OpenAI兼容）、gemini-3.1-flash-image 200@73s。
    // gpt-image-2 走 images/generations 實測 200@59s。
    // chatImageModels 存「上游真名」，viaChatImage 按 upstreamModel 匹配。
    chatImageModels: ["gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-2.5-flash-image"],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      // 2026-09-11 實測：hub 上游 /v1/images/generations 對 gpt-image-2.5-flare 與
      // gpt-image-2.5-sunburst 均 200 真出圖（b64），上游名與平台名同名直傳，
      // 故由 hub 認領（adobe2api 路徑 408 未通）。kinds 只認 image_generate。
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
        modelId: "gemini-3.1-flash-image",   // nano-banana-2，同名直傳
        supplierModelId: null,
        kinds: ["image_generate", "image_edit"],
      },
      {
        modelId: "gemini-2.5-flash-image",   // nano-banana，同名直傳
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
    sitePriority: 13,
    chatImageModels: [],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        // 2026-09-14 實測：yyds /v1/images/edits 收 gpt-image-2 多模態改圖
        // （HTTP 200 / 24.9s / 1.85MB PNG，b64_json 直回）。此前只宣告
        // image_generate，使 gpt-image-2 的 edit 能力表只剩死渠道
        // （adobe2api 403 額度枯竭、sub2api 524），改圖全軍覆沒。
        kinds: ["image_generate", "image_edit"],
      },
    ],
  },

{
    // ⚠ 本條目位於 add-supplier-channel.ts 的 marker 維護區內（片Y 稿 §A 拍板：手寫
    // 落位、不再跑該工具）；若日後重跑工具，須把本條目重新貼回。
    // 本機 RTX 5070 Laptop＋Blender 5.2.1 EGL（blender-bridge，127.0.0.1:8765）。
    // first_party＝自營最快（與 adobe2api 同檔）：scheduler 第一排序鍵 supply_tier
    // CASE → 0，本機 lease 空閒時必勝；橋併發 1（BLENDER_BRIDGE_CONCURRENCY 鐵律），
    // 佔線時 scheduler 走 lease 過濾自然落下一節點，零新邏輯（片Y staging 稿 §A）。
    // 能力標籤＝capability model_id：blender-render-eevee / blender-render-cycles
    // 單幀渲染（多幀不進節點派發——片L 實錘單幀才是安全單位）。
    label: "blender-local",
    baseUrlEnv: "BLENDER_NODE_LOCAL_URL",   // VPS 側值固定 http://127.0.0.1:8765（片W 反向隧道裁定一字不改）
    apiKeyEnv: "BLENDER_NODE_LOCAL_TOKEN",  // 橋側 Bearer 共享 token（同時作為 credentialRef）
    enabledEnv: "BLENDER_NODE_LOCAL_ENABLED",
    tier: "first_party",
    sitePriority: 10,
    chatImageModels: [],                    // blender 節點無 chat 生圖概念，恆空
    adapterType: "blender_bridge",
    claims: [
      // kinds 沿用 image_generate（單幀 PNG 產出語義同圖像生成，零枚舉擴散）；
      // supplierModelId: null＝模型名即引擎標籤，adapter 腳本構造器按 modelId 選 engine。
      { modelId: "blender-render-eevee", supplierModelId: null, kinds: ["image_generate"] },
      { modelId: "blender-render-cycles", supplierModelId: null, kinds: ["image_generate"] },
    ],
  },

  // blender-modal（managed_pool，片X Modal L4）與 blender-cnb（relay）只埋樁不註冊：
  // 片X 未落盤（deploy-staging/blender-modal/ 不存在）、CNB 無實體節點——註冊即虛報能力。
  // NODES-PLAN §5：節點 ≥3 且異構＋需要場景檔分發時才評估 Flamenco 3。
  //
  // 2026-09-27 暴君裁定（視頻渠道重整）：metaso／tokenmix／cangyuansuanli／napi／
  // drama／adobe2api-plus 六條 registry 條目**自本表移除**（連同 env:filmera 由
  // seed 的 RETIRED_SUPPLIER_LABELS 一併停用）——視頻供貨唯一權威改為 xiaoyxiao，
  // 其餘渠道不得再藉 seed 復活（它們在控面已 supplier.enabled=false + capability
  // 停用）。adobe2api 留圖停視頻（見 seed 的 video 跳過）。

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
