// `/openai/v1/models` 的模型清單真源。
//
// 只列**當下真的能出圖**的模型，判準全部複用站內既有閘，不自己另立一套：
//   ① `SUPPORTED_IMAGE_MODEL_IDS` ∩ `isSupportedImageModel()`（目錄裡 kind=image）；
//   ② `isModelAllowedForKey()`（金鑰白名單，與提交入口同一支函數）；
//   ③ `readUnavailableModels()`（真實生成結果驅動的熔斷／斷供名單，與 /v1/models 同一支）。
//
// ②③ 的意義：列表不許宣稱比提交入口更多——列出來的名字必然能提交，提交得了的名字必然
// 在列表裡（同一組閘）。③ 讀取失敗時與 `/v1/models` 一樣 degrade 成空 map（fail-open），
// 不因觀測面抖動把整張清單打空。
//
// 注意：`readUnavailableModels()` 需要控制面 DB。路由跑在 Vercel 時沒有
// GENERATION_DATABASE_URL（見 generation.ts 檔頭），此閘會靜默 fail-open；要讓熔斷閘
// 真正生效，這條路由必須跑在持有 DB 的一方（控制面）——部署判定見回報。
import { isModelAllowedForKey, type BizApiKey } from "@/lib/biz-api-keys";
import { isSupportedImageModel, resolveGenerationModelId } from "@/lib/generation-model-catalog";
import { readUnavailableModels } from "@/lib/generation-core/model-availability-gate";
import { SUPPORTED_IMAGE_MODEL_IDS } from "@/lib/image-model-ids";
import { syncModelPricing } from "@/lib/pricing-runtime";

/** OpenAI 客戶端的 `owned_by`；本站品牌名。 */
export const OPENAI_COMPAT_MODEL_OWNER = "eimu";

/**
 * 固定 created：與 `/v1/models` 同慣例（2026-01-01）。模型清單不是時間序列資源，
 * 每次請求回不同時間戳只會讓客戶端快取判斷閃爍。
 */
export const OPENAI_COMPAT_MODEL_CREATED = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

export interface CompatModelDeps {
  sync?: () => Promise<void>;
  readUnavailable?: () => Promise<Map<string, string>>;
}

/** 可出圖的模型 id 清單（見檔頭三條閘）。 */
export async function listCompatibleImageModelIds(
  key: BizApiKey,
  deps: CompatModelDeps = {},
): Promise<string[]> {
  // 與扣費路由同源：先同步 admin 定價覆寫（內部吞錯），列表與扣費才不會各說一套。
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
 * 客戶端送來的 model → 站內 model id；不是可出圖模型回 null。
 *
 * 走 `resolveGenerationModelId`（顯示名風格分隔符容忍：`seedream 2.0` → `seedream-2.0`），
 * 與 `/v1/images/generations` 的解析路徑同一支，不另寫一份正則。
 */
export function resolveCompatibleImageModelId(rawModelId: string): string | null {
  const resolved = resolveGenerationModelId(rawModelId) ?? rawModelId;
  return isSupportedImageModel(resolved) ? resolved : null;
}
