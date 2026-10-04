// 建 key 成功后的开发者快速上手（S2）：把「签发成功 → 首调成功」之间的摩擦压到零。
//
// 两段 curl 的 model 与 size 一律由 catalog 真源推导，不在元件里写死猜测——
// catalog 换模型/换预设比例时，范例自动跟随；范例引用的 id 必须同时存在于
// GENERATION_MODEL_CATALOG 与使用者可见白名单 IMAGE_MODEL_IDS，否则整段不显示
// （宁可不给范例，也不给一颗打不通的 model）。
import { DEFAULT_IMAGE_MODEL_ID } from "./image-model-ids.js";
import {
  GENERATION_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  generationModel,
  imageSizeForAspectRatio,
} from "./generation-model-catalog";

/** /v1 对外 Base URL（与站内接入文档、DSH 插件同一真源）。 */
export const DEV_QUICKSTART_BASE_URL = "https://eimu.dev/v1";

/**
 * OpenAI 标准同步兼容 Base URL（/openai/v1：images/generations、chat/completions、models）。
 * 给 new-api／Cherry Studio／OpenAI SDK 这类只认标准协议的工具直接填，不用学 /v1 异步任务。
 */
export const DEV_QUICKSTART_OPENAI_BASE_URL = "https://eimu.dev/openai/v1";

/** 充值入口（余额不足 402 的落地页）。 */
export const DEV_QUICKSTART_PRICING_URL = "https://eimu.dev/pricing";

/** 范例下方的余额说明。 */
export const DEV_QUICKSTART_BALANCE_NOTE = "新人礼额度可直接调用；余额用完返回 402，附充值链接。";

/**
 * 二次元（PixAI）展示模型偏好序：首位为 catalog 内 promotionTag「推荐」的
 * Tsubaki.2，其后按人气排；实际回传值仍要通过 catalog + 白名单双重存在性检查。
 */
const PIXAI_SHOWCASE_PREFERENCE: readonly string[] = [
  "pixai-tsubaki2",
  "pixai-haruka-v2",
  "pixai-hoshino-v2",
  "pixai-tsubaki-11",
  "pixai-reference-pro",
];

/**
 * 取一个二次元（PixAI）展示 model id。
 *
 * 只认「catalog 实际存在 ∧ 使用者可见白名单内」的条目：先走偏好序，全落空时
 * 取 catalog 内第一个 pixai-* 条目；一个都没有回 null（呼叫端据此隐藏该段范例）。
 * 纯函数、零副作用，catalog/白名单可注入以便测试。
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

/** 范例用的 size：由该 model 的预设比例推导（1:1 → 1024x1024），非手写常数。 */
export function quickstartExampleSize(modelId: string): string | null {
  const model = generationModel(modelId);
  if (!model) return null;
  return imageSizeForAspectRatio(model.defaultAspectRatio);
}

export interface QuickstartCurlExample {
  /** 范例标题。 */
  title: string;
  /** 一行说明。 */
  subtitle: string;
  /** 对外 model id（catalog 真源推导）。 */
  modelId: string;
  /** 已代入金钥明文的完整 curl，可一键复制。 */
  curl: string;
}

/**
 * 组一段 images/generations 的 curl。
 * 端点字面量只在此处出现一次，其余呼叫端一律吃回传值。
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
 * 建 key 成功后显示的两段范例（通用 + 二次元）。
 * 任一 model 在 catalog/白名单里不存在时，该段直接不出现——不编造 id。
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