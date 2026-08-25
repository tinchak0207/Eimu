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
    chatImageModels: ["gemini-3-pro-image", "gemini-3.1-flash-image"],
    claims: [
      {
        modelId: "gpt-image-2",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      {
        modelId: "gemini-3.1-flash-image",
        supplierModelId: null,
        kinds: ["image_generate"],
      },
      {
        modelId: "gemini-3-image",
        supplierModelId: "gemini-3-pro-image",
        kinds: ["image_generate"],
      },
    ],
  },
  // REGISTRY-ENTRIES-END
];
