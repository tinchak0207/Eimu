// PixAI 公开模型 ID ↔ bridge 模型名的唯一映射源。
//
// 排障记录（2026-08-05）：control plane 的 supplier_capability 曾 seed 自旧版
// catalog（moonbeam/diamond/neverland/whimsical/hassaku），而线上 pixai-bridge
// 的 MODEL_VERSION_MAP 只认 tsubaki2/haruka-v2/reference-pro/tsubaki-11/
// hoshino-v2。两套名字之间没有任何映射层，于是：
//   - 目录与 /v1/models 对外报 A 组名字
//   - bridge 收到 A 组名字回 400 "Unknown model"
//   - 更糟的是 capability 挂在 sub2api(disabled) 与 fallback(fallback 渠道，
//     根本不认 pixai) 上，调度器找不到合格 supplier → 一律 overloaded
//
// 这个档案是唯一收口：seed 写 supplier_model_id、路由做入站别名归一，
// 都只能从这里取值。任何一边要改名，只改这里。

import {
  PIXAI_EDIT_MODEL_ID,
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  PIXAI_TEMPLATE_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
  PIXAI_UPSCALE_MODEL_ID,
} from "./image-model-ids.js";

/**
 * 公开模型 ID → bridge 期望的模型名。
 *
 * 目前两者同名，映射是恒等的 —— 但恒等映射必须显式写出来：
 * seed 靠它填 `supplier_capability.supplier_model_id`，一旦 bridge 改名，
 * 这里改一行即可，不必再赌「两边刚好同名」。
 */
export const PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID: Readonly<Record<string, string>> = {
  [PIXAI_TSUBAKI2_MODEL_ID]: "pixai-tsubaki2",
  [PIXAI_HARUKA_V2_MODEL_ID]: "pixai-haruka-v2",
  [PIXAI_REFERENCE_PRO_MODEL_ID]: "pixai-reference-pro",
  [PIXAI_TSUBAKI_V11_MODEL_ID]: "pixai-tsubaki-11",
  [PIXAI_HOSHINO_V2_MODEL_ID]: "pixai-hoshino-v2",
};

/**
 * 历史别名 → 现行公开 ID。
 *
 * 旧版目录对外发过 moonbeam 那一组名字，DB 里也还躺着它们的 capability 行。
 * 已经按旧名字接好的 B 端客户不该因为我们改名而 400，所以入站一律先归一。
 * 对应关系按「同档位替换」取：旧 5 个是被新 5 个逐一替掉的。
 */
export const PIXAI_LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "pixai-moonbeam": PIXAI_TSUBAKI2_MODEL_ID,
  "pixai-diamond": PIXAI_REFERENCE_PRO_MODEL_ID,
  "pixai-neverland": PIXAI_TSUBAKI_V11_MODEL_ID,
  "pixai-whimsical": PIXAI_HARUKA_V2_MODEL_ID,
  "pixai-hassaku": PIXAI_HOSHINO_V2_MODEL_ID,
};

/** 生成类 PixAI 模型（可作为 `model` 参数传入 /v1/images/generations）。 */
export const PIXAI_GENERATE_MODEL_IDS: readonly string[] = Object.keys(
  PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID,
);

/**
 * 服务类定价键：改图、放大、模板生成。
 *
 * 这三个不是 bridge 的模型名，不进 /v1/models 选单，但必须算进 pixai 渠道的
 * capability —— 否则 /v1/images/edits、/v1/upscale、/v1/template-generations
 * 走 durable 调度时同样找不到 supplier。
 *
 * pixai-template 漏在这里的后果是实测过的：它在 catalog 里、却不在 pixai 的
 * 认领白名单里，于是 seed 把它判成「通用模型」，capability 落到 fallback
 * （fallback 渠道，不认 pixai）与 sub2api（线上 disabled）名下。
 */
export const PIXAI_SERVICE_MODEL_IDS: readonly string[] = [
  PIXAI_EDIT_MODEL_ID,
  PIXAI_UPSCALE_MODEL_ID,
  PIXAI_TEMPLATE_MODEL_ID,
];

/** pixai 渠道能服务的全部公开模型 ID（生成 + 服务）。 */
export const PIXAI_ALL_MODEL_IDS: readonly string[] = [
  ...PIXAI_GENERATE_MODEL_IDS,
  ...PIXAI_SERVICE_MODEL_IDS,
];

const PIXAI_ALL_MODEL_ID_SET = new Set(PIXAI_ALL_MODEL_IDS);

/** 这个公开模型 ID 是否只能由 pixai 渠道服务。 */
export function isPixaiModelId(modelId: string): boolean {
  return PIXAI_ALL_MODEL_ID_SET.has(modelId);
}

/**
 * 把入站模型名归一为现行公开 ID。
 *
 * 认三种输入：现行公开 ID、历史别名、bridge 名。非 pixai 模型原样返回，
 * 让上层的 `isSupportedImageModel` 照常判定。
 */
export function normalizePixaiModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (PIXAI_ALL_MODEL_ID_SET.has(trimmed)) return trimmed;
  const alias = PIXAI_LEGACY_MODEL_ALIASES[trimmed];
  if (alias) return alias;
  for (const [publicId, bridgeId] of Object.entries(PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID)) {
    if (bridgeId === trimmed) return publicId;
  }
  return trimmed;
}

/**
 * 公开模型 ID → bridge 模型名。
 *
 * 传进来的可以是别名；未知的 pixai 名字返回 null，让调用方回 400 而不是
 * 把一个 bridge 不认的名字丢过去换一条含义模糊的上游错误。
 */
export function pixaiBridgeModelId(modelId: string): string | null {
  return PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID[normalizePixaiModelId(modelId)] ?? null;
}
