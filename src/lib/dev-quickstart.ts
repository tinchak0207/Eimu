// 建 key 成功後的開發者快速上手（S2）：把「簽發成功 → 首調成功」之間的摩擦壓到零。
//
// 兩段 curl 的 model 與 size 一律由 catalog 真源推導，不在元件裡寫死猜測——
// catalog 換模型/換預設比例時，範例自動跟隨；範例引用的 id 必須同時存在於
// GENERATION_MODEL_CATALOG 與使用者可見白名單 IMAGE_MODEL_IDS，否則整段不顯示
// （寧可不給範例，也不給一顆打不通的 model）。
import { DEFAULT_IMAGE_MODEL_ID } from "./image-model-ids.js";
import {
  GENERATION_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  generationModel,
  imageSizeForAspectRatio,
} from "./generation-model-catalog";

/** /v1 對外 Base URL（與站內接入文檔、DSH 插件同一真源）。 */
export const DEV_QUICKSTART_BASE_URL = "https://eimu.dev/v1";

/**
 * OpenAI 標準同步兼容 Base URL（/openai/v1：images/generations、chat/completions、models）。
 * 給 new-api／Cherry Studio／OpenAI SDK 這類只認標準協議的工具直接填，不用學 /v1 異步任務。
 */
export const DEV_QUICKSTART_OPENAI_BASE_URL = "https://eimu.dev/openai/v1";

/** 充值入口（餘額不足 402 的落地頁）。 */
export const DEV_QUICKSTART_PRICING_URL = "https://eimu.dev/pricing";

/** 範例下方的餘額說明。 */
export const DEV_QUICKSTART_BALANCE_NOTE = "新人礼额度可直接调用；余额用完返回 402，附充值链接。";

/**
 * 二次元（PixAI）展示模型偏好序：首位為 catalog 內 promotionTag「推荐」的
 * Tsubaki.2，其後按人氣排；實際回傳值仍要通過 catalog + 白名單雙重存在性檢查。
 */
const PIXAI_SHOWCASE_PREFERENCE: readonly string[] = [
  "pixai-tsubaki2",
  "pixai-haruka-v2",
  "pixai-hoshino-v2",
  "pixai-tsubaki-11",
  "pixai-reference-pro",
];

/**
 * 取一個二次元（PixAI）展示 model id。
 *
 * 只認「catalog 實際存在 ∧ 使用者可見白名單內」的條目：先走偏好序，全落空時
 * 取 catalog 內第一個 pixai-* 條目；一個都沒有回 null（呼叫端據此隱藏該段範例）。
 * 純函數、零副作用，catalog/白名單可注入以便測試。
 */
export function pixaiShowcaseModelId(
  catalog: Record<string, unknown> = GENERATION_MODEL_CATALOG,
  visibleIds: readonly string[] = IMAGE_MODEL_IDS,
): string | null {
  const visible = new Set(visibleIds);
  const exists = (id: string): boolean => Boolean(catalog[id]) && visible.has(id);

  for (const candidate of PIXAI_SHOWCASE_PREFERENCE) {
    if (exists(candidate)) return candidate;
  }
  return visibleIds.find((id) => id.startsWith("pixai-") && Boolean(catalog[id])) ?? null;
}

/** 範例用的 size：由該 model 的預設比例推導（1:1 → 1024x1024），非手寫常數。 */
export function quickstartExampleSize(modelId: string): string | null {
  const model = generationModel(modelId);
  if (!model) return null;
  return imageSizeForAspectRatio(model.defaultAspectRatio);
}

export interface QuickstartCurlExample {
  /** 範例標題。 */
  title: string;
  /** 一行說明。 */
  subtitle: string;
  /** 對外 model id（catalog 真源推導）。 */
  modelId: string;
  /** 已代入金鑰明文的完整 curl，可一鍵複製。 */
  curl: string;
}

/**
 * 組一段 images/generations 的 curl。
 * 端點字面量只在此處出現一次，其餘呼叫端一律吃回傳值。
 */
export function buildGenerationCurl(input: {
  modelId: string;
  prompt: string;
  size: string;
  apiKey: string;
}): string {
  return [
    `curl -s -X POST ${DEV_QUICKSTART_BASE_URL}/images/generations \\`,
    `  -H "Authorization: Bearer ${input.apiKey}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"${input.modelId}","prompt":"${input.prompt}","size":"${input.size}"}'`,
  ].join("\n");
}

/**
 * 建 key 成功後顯示的兩段範例（通用 + 二次元）。
 * 任一 model 在 catalog/白名單裡不存在時，該段直接不出現——不編造 id。
 */
export function quickstartCurlExamples(apiKey: string): QuickstartCurlExample[] {
  const examples: QuickstartCurlExample[] = [];

  const generalSize = quickstartExampleSize(DEFAULT_IMAGE_MODEL_ID);
  if (generalSize) {
    examples.push({
      title: "通用生图（GPT Image 2）",
      subtitle: "一句话出图，1024×1024 方图。",
      modelId: DEFAULT_IMAGE_MODEL_ID,
      curl: buildGenerationCurl({
        modelId: DEFAULT_IMAGE_MODEL_ID,
        prompt: "一只橘猫趴在窗台上，水彩风格",
        size: generalSize,
        apiKey,
      }),
    });
  }

  const pixaiModelId = pixaiShowcaseModelId();
  const pixaiSize = pixaiModelId ? quickstartExampleSize(pixaiModelId) : null;
  if (pixaiModelId && pixaiSize) {
    examples.push({
      title: "PixAI 二次元",
      subtitle: "动漫插画风格，同一条端点换 model 即可。",
      modelId: pixaiModelId,
      curl: buildGenerationCurl({
        modelId: pixaiModelId,
        prompt: "1girl, silver hair, summer beach, anime illustration",
        size: pixaiSize,
        apiKey,
      }),
    });
  }

  return examples;
}