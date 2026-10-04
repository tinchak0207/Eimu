// `/openai/v1/models` 的模型清单真源。
//
// 只列**当下真的能出图**的模型，判准全部复用站内既有闸，不自己另立一套：
//   ① `SUPPORTED_IMAGE_MODEL_IDS` ∩ `isSupportedImageModel()`（目录里 kind=image）；
//   ② `isModelAllowedForKey()`（金钥白名单，与提交入口同一支函数）；
//   ③ `readUnavailableModels()`（真实生成结果驱动的熔断／断供名单，与 /v1/models 同一支）。
//
// ②③ 的意义：列表不许宣称比提交入口更多——列出来的名字必然能提交，提交得了的名字必然
// 在列表里（同一组闸）。③ 读取失败时与 `/v1/models` 一样 degrade 成空 map（fail-open），
// 不因观测面抖动把整张清单打空。
//
// 注意：`readUnavailableModels()` 需要控制面 DB。路由跑在 Vercel 时没有
// GENERATION_DATABASE_URL（见 generation.ts 档头），此闸会静默 fail-open；要让熔断闸
// 真正生效，这条路由必须跑在持有 DB 的一方（控制面）——部署判定见回报。
import { isModelAllowedForKey, type BizApiKey } from "@/lib/biz-api-keys";
import { isSupportedImageModel, resolveGenerationModelId } from "@/lib/generation-model-catalog";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids";
import { syncModelPricing } from "@/lib/pricing-runtime";

/** OpenAI 客户端的 `owned_by`；本站品牌名。 */
export const OPENAI_COMPAT_MODEL_OWNER = "eimu";

/**
 * 固定 created：与 `/v1/models` 同惯例（2026-01-01）。模型清单不是时间序列资源，
 * 每次请求回不同时间戳只会让客户端快取判断闪烁。
 */
export const OPENAI_COMPAT_MODEL_CREATED = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

export interface CompatModelDeps {
  sync?: () => Promise<void>;
  readUnavailable?: () => Promise<Map<string, string>>;
}

/** 可出图的模型 id 清单（见档头三条闸）。 */
export async function listCompatibleImageModelIds(
  key: BizApiKey,
  deps: CompatModelDeps = {},
): Promise<string[]> {
  // 与扣费路由同源：先同步 admin 定价覆写（内部吞错），列表与扣费才不会各说一套。
  await (deps.sync ?? syncModelPricing)();
  const unavailable = await (deps.readUnavailable ?? readUnavailableModels)().catch(
    () => new Map<string, string>(),
  );
  return SUPPORTED_IMAGE_MODEL_IDS.filter(
    (modelId) =>
      isSupportedImageModel(modelId) && isModelAllowedForKey(key, modelId) && !unavailable.has(modelId),
  );
}

export interface OpenAICompatModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function openAICompatModelList(ids: string[]): { object: "list"; data: OpenAICompatModelEntry[] } {
  return {
    object: "list",
    data: ids.map((id) => ({
      id,
      object: "model" as const,
      created: OPENAI_COMPAT_MODEL_CREATED,
      owned_by: OPENAI_COMPAT_MODEL_OWNER,
    })),
  };
}

/**
 * 客户端送来的 model → 站内 model id；不是可出图模型回 null。
 *
 * 走 `resolveGenerationModelId`（显示名风格分隔符容忍：`seedream 2.0` → `seedream-2.0`），
 * 与 `/v1/images/generations` 的解析路径同一支，不另写一份正则。
 */
export function resolveCompatibleImageModelId(rawModelId: string): string | null {
  const resolved = resolveGenerationModelId(rawModelId) ?? rawModelId;
  return isSupportedImageModel(resolved) ? resolved : null;
}
