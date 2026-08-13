// 分層價目（代理/分銷）的核心純邏輯。
//
// 商業場景：代理以「拿貨價」進貨後向下游二次分銷時有自己的加成，平台不希望對每個
// 下游即時改全局定價覆寫，而是按金鑰/租戶掛一個 tier（internal / reseller /
// enterprise），每個 tier 各自對「model × resolution」覆寫幣單價。單價是**絕對幣價**
// ——高於基準就是加成、低於基準就是拿貨價，一個數字同時涵蓋兩種語意。
//
// 優先順序（B 端計費）：tier 覆寫 → 基準價（generation coins 經全局 pricing-overrides
// 後的 effective 價）。無 tier 或該 tier 未覆寫該 model×resolution → 直接用基準價，
// C 端不吃這一層（C 端根本不走本模組）。
//
// 本模組是純函式層：不碰 Blob、不碰 process.env，可直接在 node --test 下測。
// 清洗規則複用 generation-model-catalog 的口徑（未知 modelId、未知 resolution、
// 非 [PRICING_COIN_STEP, 100_000] 的幣價全部靜默丟棄），避免兩套定價清洗規則漂移。

import {
  GENERATION_MODEL_CATALOG,
  PRICING_COIN_STEP,
  PRICING_DECIMALS,
  defaultOutputResolution,
  generationModel,
  type OutputResolution,
} from "./generation-model-catalog";
import { imageGenerationCoins, type ModelMode } from "./provider-config";

export const TIER_IDS = ["internal", "reseller", "enterprise"] as const;
export type TierId = (typeof TIER_IDS)[number];

export function isTierId(value: unknown): value is TierId {
  return typeof value === "string" && (TIER_IDS as readonly string[]).includes(value);
}

/** tier → modelId → resolution → 幣單價（absolute coins）。 */
export type TierPriceTable = Record<string, Record<string, number>>;
export type TierPricingTables = Partial<Record<TierId, TierPriceTable>>;

/** 金鑰 id 直接命中，或 `user:<userId>`（租戶級）。 */
export type TierAssignments = Record<string, TierId>;

export interface TierPricingDocument {
  tiers: TierPricingTables;
  assignments: TierAssignments;
}

export function emptyTierPricingDocument(): TierPricingDocument {
  return { tiers: {}, assignments: {} };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 清洗任何不可信輸入（Blob 內容 / PATCH body）到 tier-pricing schema。規則與
 * normalizeModelPricingOverrides 一致：越界直接丟棄該欄位而非報錯。未知 tier、
 * 未知 modelId、不屬於該模型 resolutions 的解析度、非 [PRICING_COIN_STEP, 100_000]
 * 的幣價全部靜默丟棄；清洗後為空的 tier 條目不輸出。
 */
export function normalizeTierPricingDocument(raw: unknown): TierPricingDocument {
  if (!isPlainObject(raw)) return { tiers: {}, assignments: {} };
  return {
    tiers: normalizeTierPricingTables(raw.tiers),
    assignments: normalizeTierAssignments(raw.assignments),
  };
}

export function normalizeTierPricingTables(raw: unknown): TierPricingTables {
  if (!isPlainObject(raw)) return {};
  const tables: TierPricingTables = {};
  for (const [tierId, table] of Object.entries(raw)) {
    if (!isTierId(tierId) || !isPlainObject(table)) continue;

    const normalizedTable: TierPriceTable = {};
    for (const [modelId, prices] of Object.entries(table)) {
      const base = GENERATION_MODEL_CATALOG[modelId];
      if (!base || !isPlainObject(prices)) continue;

      const normalizedPrices: Record<string, number> = {};
      for (const [resolution, value] of Object.entries(prices)) {
        if (!(base.resolutions as readonly string[]).includes(resolution)) continue;
        if (typeof value !== "number" || !Number.isFinite(value) || value < PRICING_COIN_STEP || value > 100_000) {
          continue;
        }
        normalizedPrices[resolution] = Math.round(value * 10 ** PRICING_DECIMALS) / 10 ** PRICING_DECIMALS;
      }

      if (Object.keys(normalizedPrices).length > 0) normalizedTable[modelId] = normalizedPrices;
    }

    if (Object.keys(normalizedTable).length > 0) tables[tierId] = normalizedTable;
  }
  return tables;
}

export function normalizeTierAssignments(raw: unknown): TierAssignments {
  if (!isPlainObject(raw)) return {};
  const assignments: TierAssignments = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || !isTierId(value)) continue;
    // defineProperty 而不是 assignment：JSON.parse 可能給我們 own "__proto__" key，
    // 用 `assignments[key] = value` 會設定原型而非 own property。
    Object.defineProperty(assignments, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return assignments;
}

/**
 * 與 provider-config.imageGenerationCoins 相同的 resolution 推導：quality → 2k（模型
 * 沒有 2k 就取 default），fast → 1k（模型沒有 1k 取 default）。tier 表的 resolution
 * key 必須與計費實際走的 resolution 一致，查價才會命中。
 */
export function imageBillingResolution(
  modelId: string,
  mode: ModelMode,
  outputResolution?: OutputResolution,
): OutputResolution {
  const model = generationModel(modelId);
  if (outputResolution) return outputResolution;
  return mode === "quality"
    ? model?.resolutions.includes("2k") ? "2k" : defaultOutputResolution(modelId)
    : model?.resolutions.includes("1k") ? "1k" : defaultOutputResolution(modelId);
}

/** 查 tier 表的單位幣價。tier 缺省/未知、model 或 resolution 未被覆寫 → null（回基準）。 */
export function tierBillingCoins(
  tables: TierPricingTables,
  tier: TierId | undefined,
  modelId: string,
  resolution: string,
): number | null {
  if (!tier) return null;
  const table = tables[tier];
  if (!table) return null;
  const prices = table[modelId];
  if (!prices) return null;
  const coins = prices[resolution];
  if (typeof coins !== "number" || !Number.isFinite(coins)) return null;
  return coins;
}

/** B 端圖片計費版本的 tier 單價查詢：mode → resolution 後再查表。 */
export function tierImageBillingCoins(
  tables: TierPricingTables,
  tier: TierId | undefined,
  modelId: string,
  mode: ModelMode,
  outputResolution?: OutputResolution,
): number | null {
  const resolution = imageBillingResolution(modelId, mode, outputResolution);
  return tierBillingCoins(tables, tier, modelId, resolution);
}

/** 金鑰優先、租戶（user:<userId>）次之；皆無 → undefined（基準價）。 */
export function resolveTierAssignment(
  assignments: TierAssignments,
  keyId: string,
  userId: number,
): TierId | undefined {
  if (isTierId(assignments[keyId])) return assignments[keyId];
  if (isTierId(assignments[`user:${userId}`])) return assignments[`user:${userId}`];
  return undefined;
}

export interface ResolvedBillingCoins {
  /** 實際扣費用的單張幣價（tier 覆寫，否則基準）。 */
  coins: number;
  /** 命中的 tier；undefined = 無 tier/無覆寫，走基準。 */
  tier: TierId | undefined;
  /** 實際計價的解析度（mode 推導）。 */
  resolution: OutputResolution;
}

/**
 * B 端 /v1 扣費的單價進入點：金鑰 tier → tier 覆寫，無覆寫就回
 * imageGenerationCoins（基準 generation coins）。這是 generations 路由實際呼叫的
 * 函式，contract 測試鎖的就是這一顆。
 */
export function resolveBillingCoinsPerImage(
  doc: TierPricingDocument,
  key: { id: string; userId: number },
  modelId: string,
  mode: ModelMode,
  outputResolution?: OutputResolution,
): ResolvedBillingCoins {
  const tier = resolveTierAssignment(doc.assignments, key.id, key.userId);
  const resolution = imageBillingResolution(modelId, mode, outputResolution);
  const tierCoins = tierBillingCoins(doc.tiers, tier, modelId, resolution);
  const coins = tierCoins ?? imageGenerationCoins(modelId, mode, resolution);
  return { coins, tier, resolution };
}