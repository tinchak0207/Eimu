import { GENERATION_MODEL_CATALOG } from "./catalog";
import { PRICING_DECIMALS, PRICING_COIN_STEP, PRICING_CREDIT_STEP } from "./types";
import type { GenerationModelDefinition, ImageCreditTable, VideoCreditTable } from "./types";

/**
 * 模型定价覆写（全局配置）。
 *
 * 这是模组级的**全局可变状态**，不是 per-request 快取：与 channel-overrides 的
 * 快取同性质，同实例并发请求共用同一份 effectiveCatalog 是刻意的。管理员在
 * /admin 改价后，服务端透过 pricing-runtime 的 syncModelPricing() 把覆写灌进这里；
 * 后端计费直接读 generationCredits()/generationCoins() 立刻按新价走，前端以
 * usePricingRevision() 订阅 revision 即时重绘，不需重新部署。
 */
export interface ModelPricingOverride {
  /** 仅对 kind === "image" 生效：各解析度的单张图 credit。 */
  imageCredits?: ImageCreditTable;
  /** 仅对 kind === "video" 生效：每秒 video credit（无音轨）。 */
  videoCreditsPerSecond?: VideoCreditTable;
  /** 仅对 kind === "video" 生效：每秒 video credit（含音轨）。 */
  videoCreditsWithAudioPerSecond?: VideoCreditTable;
  /** 固定币价（不随解析度/时长变化）。不允许 0 或负数——0 币会让扣费为零。 */
  fixedCoins?: number;
}

export type ModelPricingOverrides = Record<string, ModelPricingOverride>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 清洗任何不可信输入（Blob 内容 / PATCH body）到覆写 schema。规则严格、越界
 * 直接丢弃该栏位而非报错：未知 modelId、不存在于该模型 resolutions 的解析度、
 * 非整数或超出 [1, 1_000_000] 的 credit、错位栏位（image 模型塞 video 栏位、
 * video 模型塞 image 栏位）、非法 fixedCoins——全部静默丢弃；清洗后为空的模型
 * 条目不输出。
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
    // defineProperty instead of assignment：JSON.parse 可能给我们 own "__proto__" key，
    // 用 `overrides[key] = entry` 会设定原型而非 own property。
    Object.defineProperty(overrides, modelId, { value: entry, enumerable: true, writable: true, configurable: true });
  }
  return overrides;
}

/**
 * credit 表清洗：键必须在 allowedKeys（该模型真实 resolutions）内，值必须是
 * [PRICING_CREDIT_STEP, 1_000_000] 的有限数，按 PRICING_DECIMALS 派生精度舍入
 * （credit 小数位 = PRICING_DECIMALS - 1，与 admin UI 的输入缩放一致，覆盖限免级小数定价）。
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

// 全局配置：模组级可变状态，同实例并发请求共用一份是刻意的（与 channel-overrides 快取同性质）。
let effectiveCatalog: Record<string, GenerationModelDefinition> = GENERATION_MODEL_CATALOG;
let activeOverrides: ModelPricingOverrides = {};
let pricingRevision = 0;
const pricingListeners = new Set<() => void>();

/** 「基准 + 覆写」浅合并，只合并四个定价栏位；credit 表 per-key 合并。 */
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
 * 覆写生效：重算有效目录、bump revision、通知订阅者。传 {} 即回到基准价。
 * 只合并定价栏位，能力面（aspectRatios/resolutions/popularity 等）一律取基准。
 */
export function applyModelPricingOverrides(raw: unknown): void {
  const normalized = normalizeModelPricingOverrides(raw);
  activeOverrides = normalized;
  effectiveCatalog = buildEffectiveCatalog(normalized);
  pricingRevision += 1;
  for (const listener of [...pricingListeners]) listener();
}

/** 当前生效的覆写表（防御性复制，避免呼叫端污染内部状态）。 */
export function activeModelPricingOverrides(): ModelPricingOverrides {
  const copy: ModelPricingOverrides = {};
  for (const [modelId, entry] of Object.entries(activeOverrides)) {
    copy[modelId] = { ...entry };
  }
  return copy;
}

/** 单调递增的覆写版本号；前端 useSyncExternalStore 的 snapshot。 */
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
