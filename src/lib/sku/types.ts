// 模板 SKU 引擎——自有 SKU 層的類型契約。
//
// 與 PixAI 代理模板（/v1/templates + /v1/template-generations，上游場景預設）是
// 兩回事：SKU 是我們自有的「營銷成片模板產品化」——一份輸入 schema + 一組鏡頭
// prompt 模板 + 輸出規格，客戶一句話/一張表就能批量下單。PixAI 模板賣的是上游
// 的場景能力；SKU 賣的是人工編排（鉤子結構、分鏡節奏、投放渠道適配），這是
// B 端的價格錨點：按交付物計價，不是按模型單價。
//
// 確定性優先：鏡頭 prompt 是純文本 + {{變量}}，展開不經過 LLM——同一份輸入永遠
// 得到同一份鏡頭計劃（B 端要可預測、可對賬、可重放）。需要 LLM 潤色的路徑屬於
// 未來擴展（expansion: "llm_assisted"），必須顯式標記為非確定性，v1 不提供。

/** 目標投放渠道：決定畫幅建議與鏡頭節奏的敘事風格。 */
export type SkuChannel = "ecommerce" | "short_video";

/** 計價模式：per_shot = 逐鏡頭按模型價（v1 全部如此）；per_sku = 整包一口價（商業化定價待定）。 */
export type SkuPricingMode = "per_shot" | "per_sku";

/** 輸入欄位的可編程描述——目錄端點直接序列化給客戶系統做表單/校驗。 */
export interface SkuFieldSchema {
  key: string;
  label: string;
  type: "string" | "string_list" | "integer" | "url";
  required: boolean;
  description: string;
  /** string_list 的條數區間。 */
  minItems?: number;
  maxItems?: number;
  /** integer 的取值區間。 */
  min?: number;
  max?: number;
  example?: unknown;
}

/** 單個鏡頭的生成模板：kind 如實標註（沒接 TTS/數字人就標 image，不假裝成片）。 */
export interface SkuShotTemplate {
  id: string;
  label: string;
  kind: "image" | "video";
  /** 純文本 + {{變量}}；展開是純字符串替換，無 LLM。 */
  promptTemplate: string;
  /** 缺省沿用 SKU outputSpec 的 aspectRatio。 */
  aspectRatio?: string;
  /** 僅 video 鏡頭有意義。 */
  durationSeconds?: number;
}

export interface SkuOutputSpec {
  /** v1 SKU 全部鏡頭同 kind；混合 kind 的 SKU 留給未來。 */
  kind: "image" | "video";
  aspectRatio: string;
  resolution: "1k" | "2k" | "4k";
  /** 展開後的鏡頭數區間（隨輸入自適應，如賣點數）。 */
  shotCount: { min: number; max: number };
  /** 僅 video：單鏡頭建議時長。 */
  durationSeconds?: number;
}

/**
 * 鏡頭計劃構建器：把規範化輸入映射成有序鏡頭模板列表。
 * 純函數（輸入 → 輸出，無副作用、無隨機、無時鐘）——單測直接鎖行為。
 */
export type SkuShotPlanBuilder = (input: Record<string, string | number | string[]>) => SkuShotTemplate[];

export interface MarketingSku {
  id: string;
  name: string;
  tagline: string;
  channel: SkuChannel;
  version: number;
  pricingMode: SkuPricingMode;
  /** 該 SKU 的默認模型（客戶可用 body.model 覆蓋）。 */
  defaultModelId: string;
  /** v1 全部確定性展開；llm_assisted 保留給未來的非確定性潤色路徑。 */
  expansion: "deterministic" | "llm_assisted";
  inputSchema: SkuFieldSchema[];
  buildShotPlan: SkuShotPlanBuilder;
  outputSpec: SkuOutputSpec;
  /** 如實的能力邊界聲明（目錄會原樣返回，不誇大）。 */
  notes: string[];
}

// ─────────────────────────────────────────── 輸入驗證與展開結果

export interface SkuInputIssue {
  code: "missing_field" | "invalid_field" | "field_too_long";
  param: string;
  message: string;
}

export interface SkuInputValidation {
  ok: boolean;
  /** 規範化後的輸入（trim、條數截斷、默認值注入），僅 ok 時有意義。 */
  normalized: Record<string, string | number | string[]>;
  issues: SkuInputIssue[];
}

/** 展開後的單個鏡頭：已含最終 prompt，直接可餵提交管線。 */
export interface ExpandedSkuShot {
  index: number;
  shotId: string;
  label: string;
  kind: "image" | "video";
  prompt: string;
  aspectRatio: string;
  resolution: "1k" | "2k" | "4k";
  durationSeconds?: number;
}

export type SkuExpansionResult =
  | { ok: true; shots: ExpandedSkuShot[] }
  | { ok: false; issues: SkuInputIssue[] };
