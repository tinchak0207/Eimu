// 新生圖渠道註冊表：舊 6 渠道（adobe2api/sub2api/primary/fallback/pixai/filmera）
// 有特殊語義（開關互斥、/v1 補綴、supabase 配置），維持原有硬編碼邏輯不動；
// 之後新增的渠道一律登記在此，由 describeEnvChannels / seed 腳本 /
// channel-registry 數據驅動接管，加渠道 = 跑 tools/add-supplier-channel.ts 一條命令。
//
// 檔案必須是 .ts（而非 JSON）：Next 打包（Vercel lambda bundle）與 tsx 跑 tools
// 都要能直接 import。

export type RegistryClaimKind = "image_generate" | "image_edit" | "video_generate";

export interface RegistryChannelClaim {
  modelId: string;                // 平台 catalog 模型 id
  supplierModelId: string | null; // 上游模型名；null = 同名直傳
  kinds: RegistryClaimKind[];
}

export interface RegistryChannel {
  label: string;                 // 同時是 env channel label 與 DB supplier label
  baseUrlEnv: string;
  apiKeyEnv: string;             // 同時作為 credentialRef
  enabledEnv: string | null;     // 有值時：清洗後 === "true" 才 defaultEnabled
  tier: "first_party" | "managed_pool" | "relay" | "fallback";
  seedPriority: number;          // seed 進 supplier 表的 priority
  sitePriority: number;          // 站點隊列 ENV_CHANNEL_PRIORITIES 用
  chatImageModels: string[];     // 上游模型名走 /chat/completions 生圖（空 = 全走 images/generations）
  adapterType?: "openai_images" | "metaso" | "openai_video"; // 缺省 openai_images；metaso 走自訂協議（見 metaso-upstream.ts），openai_video 走 /v1/videos 異步（見 openai-video-upstream.ts）
  claims: RegistryChannelClaim[];
}

export const REGISTRY_CHANNELS: RegistryChannel[] = [
  // REGISTRY-ENTRIES-START（腳本插入點，此註釋與結束標記之間的條目由工具維護，手改會被覆蓋）
{
    label: "hublinuxdo",
    baseUrlEnv: "HUBLINUXDO_BASE_URL",
    apiKeyEnv: "HUBLINUXDO_API_KEY",
    enabledEnv: "HUBLINUXDO_ENABLED",
    tier: "managed_pool",
    seedPriority: 12,
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
    label: "metaso",
    baseUrlEnv: "METASO_BASE_URL",
    apiKeyEnv: "METASO_API_KEY",
    enabledEnv: "METASO_ENABLED",
    tier: "managed_pool",
    seedPriority: 12,
    sitePriority: 12,
    chatImageModels: [],
    adapterType: "metaso",
    claims: [
      {
        modelId: "minimax-h3",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
    ],
  },

{
    label: "tokenmix",
    baseUrlEnv: "TOKENMIX_BASE_URL",
    apiKeyEnv: "TOKENMIX_API_KEY",
    enabledEnv: "TOKENMIX_ENABLED",
    tier: "managed_pool",
    seedPriority: 12,
    sitePriority: 12,
    // tokenmix 上游接受平台 id「seedream-5.0-lite」直傳（2026-08-28 實測 HTTP 200），
    // 與 new-api 渠道 9 的 model_mapping（→ bytedance/seedream-5.0-lite）雙路兼容。
    chatImageModels: [],
    claims: [
      {
        modelId: "seedream-5.0-lite",
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
    seedPriority: 13,
    sitePriority: 13,
    chatImageModels: [],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
    ],
  },

{
    label: "cangyuansuanli",
    baseUrlEnv: "CANGYUANSUANLI_BASE_URL",
    apiKeyEnv: "CANGYUANSUANLI_API_KEY",
    enabledEnv: "CANGYUANSUANLI_ENABLED",
    tier: "managed_pool",
    seedPriority: 8,
    sitePriority: 8,
    // seedance 2.5/2.0 视频主渠道（2026-08-30 接入）。上游为 new-api openai-video
    // 兼容（POST /v1/videos + GET /videos/{task_id} 轮询），adapterType=openai_video
    // 走 openai-video-upstream.ts。模型名按平台 modelId+resolution 在 adapter 内
    // 解析（sd4 族分辨率可选 / sd7 族固定），supplierModelId 一律 null。
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      {
        modelId: "seedance-2.0",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
      {
        modelId: "seedance-2.0-fast",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
      {
        modelId: "seedance-2.0-mini",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
      {
        modelId: "seedance-2.5-480p",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
      {
        modelId: "seedance-2.5-720p",
        supplierModelId: null,
        kinds: ["video_generate"],
      },
    ],
  },
  {
    // drama 渠道（drama.dafeiyangapi.top，2026-08-30 接入）：只供应 30 秒固定档
    // seedance 2.5（上游模型 sd25-30s，720p，按条 6 RMB）。唯一认领 seedance-2.5-30s，
    // 短时长 seedance 任务不会被路由到这里；上游账号当前欠费（暴君裁定无视，充值前
    // 该渠道任务会以 insufficient_user_quota 失败，由 failure classifier 归类欠费）。
    label: "drama",
    baseUrlEnv: "DRAMA_BASE_URL",
    apiKeyEnv: "DRAMA_API_KEY",
    enabledEnv: "DRAMA_ENABLED",
    tier: "managed_pool",
    seedPriority: 9,
    sitePriority: 9,
    chatImageModels: [],
    adapterType: "openai_video",
    claims: [
      {
        modelId: "seedance-2.5-30s",
        supplierModelId: "sd25-30s",
        kinds: ["video_generate"],
      },
    ],
  },
  // REGISTRY-ENTRIES-END
];
