// 分层价目（代理/分销）的核心纯逻辑。
//
// 商业场景：代理以「拿货价」进货后向下游二次分销时有自己的加成，平台不希望对每个
// 下游即时改全局定价覆写，而是按金钥/租户挂一个 tier（internal / reseller /
// enterprise），每个 tier 各自对「model × resolution」覆写币单价。单价是**绝对币价**
// ——高于基准就是加成、低于基准就是拿货价，一个数字同时涵盖两种语意。
//
// 优先顺序（B 端计费）：tier 覆写 → 基准价（generation coins 经全局 pricing-overrides
// 后的 effective 价）。无 tier 或该 tier 未覆写该 model×resolution → 直接用基准价，
// C 端不吃这一层（C 端根本不走本模组）。
//
// 本模组是纯函式层：不碰 Blob、不碰 process.env，可直接在 node --test 下测。
// 清洗规则复用 generation-model-catalog 的口径（未知 modelId、未知 resolution、
// 非 [PRICING_COIN_STEP, 100_000] 的币价全部静默丢弃），避免两套定价清洗规则漂移。

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

/** tier → modelId → resolution → 币单价（absolute coins）。 */
export type TierPriceTable = Record<string, Record<string, number>>;
export type TierPricingTables = Partial<Record<TierId, TierPriceTable>>;

/** 金钥 id 直接命中，或 `user:<userId>`（租户级）。 */
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
 * 清洗任何不可信输入（Blob 内容 / PATCH body）到 tier-pricing schema。规则与
 * normalizeModelPricingOverrides 一致：越界直接丢弃该栏位而非报错。未知 tier、
 * 未知 modelId、不属于该模型 resolutions 的解析度、非 [PRICING_COIN_STEP, 100_000]
 * 的币价全部静默丢弃；清洗后为空的 tier 条目不输出。
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
    // defineProperty 而不是 assignment：JSON.parse 可能给我们 own "__proto__" key，
    // 用 `assignments[key] = value` 会设定原型而非 own property。
    Object.defineProperty(assignments, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return assignments;
}

/**
 * 与 provider-config.imageGenerationCoins 相同的 resolution 推导：quality → 2k（模型
 * 没有 2k 就取 default），fast → 1k（模型没有 1k 取 default）。tier 表的 resolution
 * key 必须与计费实际走的 resolution 一致，查价才会命中。
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

/** 查 tier 表的单位币价。tier 缺省/未知、model 或 resolution 未被覆写 → null（回基准）。 */
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

/** B 端图片计费版本的 tier 单价查询：mode → resolution 后再查表。 */
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

/** 金钥优先、租户（user:<userId>）次之；皆无 → undefined（基准价）。 */
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
  /** 实际扣费用的单张币价（tier 覆写，否则基准）。 */
  coins: number;
  /** 命中的 tier；undefined = 无 tier/无覆写，走基准。 */
  tier: TierId | undefined;
  /** 实际计价的解析度（mode 推导）。 */
  resolution: OutputResolution;
}

/**
 * B 端 /v1 扣费的单价进入点：金钥 tier → tier 覆写，无覆写就回
 * imageGenerationCoins（基准 generation coins）。这是 generations 路由实际呼叫的
 * 函式，contract 测试锁的就是这一颗。
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