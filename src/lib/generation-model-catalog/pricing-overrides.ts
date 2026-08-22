import { GENERATION_MODEL_CATALOG } from "./catalog";
import { PRICING_DECIMALS, PRICING_COIN_STEP, PRICING_CREDIT_STEP } from "./types";
import type { GenerationModelDefinition, ImageCreditTable, VideoCreditTable } from "./types";

/**
 * 模型定價覆寫（全局配置）。
 *
 * 這是模組級的**全局可變狀態**，不是 per-request 快取：與 channel-overrides 的
 * 快取同性質，同實例併發請求共用同一份 effectiveCatalog 是刻意的。管理員在
 * /admin 改價後，服務端透過 pricing-runtime 的 syncModelPricing() 把覆寫灌進這裡；
 * 後端計費直接讀 generationCredits()/generationCoins() 立刻按新價走，前端以
 * usePricingRevision() 訂閱 revision 即時重繪，不需重新部署。
 */
export interface ModelPricingOverride {
  /** 僅對 kind === "image" 生效：各解析度的單張圖 credit。 */
  imageCredits?: ImageCreditTable;
  /** 僅對 kind === "video" 生效：每秒 video credit（無音軌）。 */
  videoCreditsPerSecond?: VideoCreditTable;
  /** 僅對 kind === "video" 生效：每秒 video credit（含音軌）。 */
  videoCreditsWithAudioPerSecond?: VideoCreditTable;
  /** 固定幣價（不隨解析度/時長變化）。不允許 0 或負數——0 幣會讓扣費為零。 */
  fixedCoins?: number;
}

export type ModelPricingOverrides = Record<string, ModelPricingOverride>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 清洗任何不可信輸入（Blob 內容 / PATCH body）到覆寫 schema。規則嚴格、越界
 * 直接丟棄該欄位而非報錯：未知 modelId、不存在於該模型 resolutions 的解析度、
 * 非整數或超出 [1, 1_000_000] 的 credit、錯位欄位（image 模型塞 video 欄位、
 * video 模型塞 image 欄位）、非法 fixedCoins——全部靜默丟棄；清洗後為空的模型
 * 條目不輸出。
 */
export function normalizeModelPricingOverrides(raw: unknown): ModelPricingOverrides {
  if (!isPlainObject(raw)) return {};

  const overrides: ModelPricingOverrides = {};
  for (const [modelId, value] of Object.entries(raw)) {
    const base = GENERATION_MODEL_CATALOG[modelId];
    if (!base || !isPlainObject(value)) continue;

    const entry: ModelPricingOverride = {};
    const allowedResolutions = base.resolutions as readonly string[];

    if (base.kind === "image") {
      const imageCredits = sanitizeCreditTable(value.imageCredits, allowedResolutions);
      if (Object.keys(imageCredits).length > 0) entry.imageCredits = imageCredits as ImageCreditTable;
    } else {
      const videoCreditsPerSecond = sanitizeCreditTable(value.videoCreditsPerSecond, allowedResolutions);
      if (Object.keys(videoCreditsPerSecond).length > 0) entry.videoCreditsPerSecond = videoCreditsPerSecond as VideoCreditTable;
      const videoCreditsWithAudio = sanitizeCreditTable(value.videoCreditsWithAudioPerSecond, allowedResolutions);
      if (Object.keys(videoCreditsWithAudio).length > 0) entry.videoCreditsWithAudioPerSecond = videoCreditsWithAudio as VideoCreditTable;
    }

    const fixedCoins = value.fixedCoins;
    if (typeof fixedCoins === "number" && Number.isFinite(fixedCoins) && fixedCoins >= PRICING_COIN_STEP && fixedCoins <= 100_000) {
      entry.fixedCoins = Math.round(fixedCoins * 10 ** PRICING_DECIMALS) / 10 ** PRICING_DECIMALS;
    }

    if (Object.keys(entry).length === 0) continue;
    // defineProperty instead of assignment：JSON.parse 可能給我們 own "__proto__" key，
    // 用 `overrides[key] = entry` 會設定原型而非 own property。
    Object.defineProperty(overrides, modelId, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return overrides;
}

/**
 * credit 表清洗：鍵必須在 allowedKeys（該模型真實 resolutions）內，值必須是
 * [PRICING_CREDIT_STEP, 1_000_000] 的有限數，按 PRICING_DECIMALS 派生精度舍入
 * （credit 小數位 = PRICING_DECIMALS - 1，與 admin UI 的輸入縮放一致，覆蓋限免級小數定價）。
 */
function sanitizeCreditTable(raw: unknown, allowedKeys: readonly string[]): Record<string, number> {
  if (!isPlainObject(raw)) return {};
  const table: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!allowedKeys.includes(key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < PRICING_CREDIT_STEP || value > 1_000_000) continue;
    const creditScale = 10 ** (PRICING_DECIMALS - 1);
    table[key] = Math.round(value * creditScale) / creditScale;
  }
  return table;
}

// 全局配置：模組級可變狀態，同實例併發請求共用一份是刻意的（與 channel-overrides 快取同性質）。
let effectiveCatalog: Record<string, GenerationModelDefinition> = GENERATION_MODEL_CATALOG;
let activeOverrides: ModelPricingOverrides = {};
let pricingRevision = 0;
const pricingListeners = new Set<() => void>();

/** 「基準 + 覆寫」淺合併，只合併四個定價欄位；credit 表 per-key 合併。 */
function mergePricingOverride(base: GenerationModelDefinition, override: ModelPricingOverride): GenerationModelDefinition {
  const merged: GenerationModelDefinition = { ...base };
  if (override.imageCredits !== undefined) {
    merged.imageCredits = { ...(base.imageCredits ?? {}), ...override.imageCredits };
  }
  if (override.videoCreditsPerSecond !== undefined) {
    merged.videoCreditsPerSecond = { ...(base.videoCreditsPerSecond ?? {}), ...override.videoCreditsPerSecond };
  }
  if (override.videoCreditsWithAudioPerSecond !== undefined) {
    merged.videoCreditsWithAudioPerSecond = {
      ...(base.videoCreditsWithAudioPerSecond ?? {}),
      ...override.videoCreditsWithAudioPerSecond,
    };
  }
  if (override.fixedCoins !== undefined) {
    merged.fixedCoins = override.fixedCoins;
  }
  return merged;
}

function buildEffectiveCatalog(overrides: ModelPricingOverrides): Record<string, GenerationModelDefinition> {
  if (Object.keys(overrides).length === 0) return GENERATION_MODEL_CATALOG;
  const catalog: Record<string, GenerationModelDefinition> = {};
  for (const [modelId, base] of Object.entries(GENERATION_MODEL_CATALOG)) {
    const override = overrides[modelId];
    catalog[modelId] = override ? mergePricingOverride(base, override) : base;
  }
  return catalog;
}

/**
 * 覆寫生效：重算有效目錄、bump revision、通知訂閱者。傳 {} 即回到基準價。
 * 只合併定價欄位，能力面（aspectRatios/resolutions/popularity 等）一律取基準。
 */
export function applyModelPricingOverrides(raw: unknown): void {
  const normalized = normalizeModelPricingOverrides(raw);
  activeOverrides = normalized;
  effectiveCatalog = buildEffectiveCatalog(normalized);
  pricingRevision += 1;
  for (const listener of [...pricingListeners]) listener();
}

/** 當前生效的覆寫表（防禦性複製，避免呼叫端污染內部狀態）。 */
export function activeModelPricingOverrides(): ModelPricingOverrides {
  const copy: ModelPricingOverrides = {};
  for (const [modelId, entry] of Object.entries(activeOverrides)) {
    copy[modelId] = { ...entry };
  }
  return copy;
}

/** 單調遞增的覆寫版本號；前端 useSyncExternalStore 的 snapshot。 */
export function modelPricingRevision(): number {
  return pricingRevision;
}

export function subscribeModelPricing(listener: () => void): () => void {
  pricingListeners.add(listener);
  return () => {
    pricingListeners.delete(listener);
  };
}

/**
 * 内部 accessor：当前生效目录（基准 + 覆写）的读取口。唯一真相仍是本模组的
 * effectiveCatalog；capabilities 等下游模组单向 import 本函数，禁止自持副本。
 */
export function currentEffectiveCatalog(): Record<string, GenerationModelDefinition> {
  return effectiveCatalog;
}
