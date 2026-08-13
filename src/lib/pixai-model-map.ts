// PixAI 公開模型 ID ↔ bridge 模型名的唯一映射源。
//
// 排障記錄（2026-08-05）：control plane 的 supplier_capability 曾 seed 自舊版
// catalog（moonbeam/diamond/neverland/whimsical/hassaku），而線上 pixai-bridge
// 的 MODEL_VERSION_MAP 只認 tsubaki2/haruka-v2/reference-pro/tsubaki-11/
// hoshino-v2。兩套名字之間沒有任何映射層，於是：
//   - 目錄與 /v1/models 對外報 A 組名字
//   - bridge 收到 A 組名字回 400 "Unknown model"
//   - 更糟的是 capability 掛在 sub2api(disabled) 與 fallback(share-api.com，
//     根本不認 pixai) 上，調度器找不到合格 supplier → 一律 overloaded
//
// 這個檔案是唯一收口：seed 寫 supplier_model_id、路由做入站別名歸一，
// 都只能從這裡取值。任何一邊要改名，只改這裡。

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
 * 公開模型 ID → bridge 期望的模型名。
 *
 * 目前兩者同名，映射是恆等的 —— 但恆等映射必須顯式寫出來：
 * seed 靠它填 `supplier_capability.supplier_model_id`，一旦 bridge 改名，
 * 這裡改一行即可，不必再賭「兩邊剛好同名」。
 */
export const PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID: Readonly<Record<string, string>> = {
  [PIXAI_TSUBAKI2_MODEL_ID]: "pixai-tsubaki2",
  [PIXAI_HARUKA_V2_MODEL_ID]: "pixai-haruka-v2",
  [PIXAI_REFERENCE_PRO_MODEL_ID]: "pixai-reference-pro",
  [PIXAI_TSUBAKI_V11_MODEL_ID]: "pixai-tsubaki-11",
  [PIXAI_HOSHINO_V2_MODEL_ID]: "pixai-hoshino-v2",
};

/**
 * 歷史別名 → 現行公開 ID。
 *
 * 舊版目錄對外發過 moonbeam 那一組名字，DB 裡也還躺着它們的 capability 行。
 * 已經按舊名字接好的 B 端客戶不該因為我們改名而 400，所以入站一律先歸一。
 * 對應關係按「同檔位替換」取：舊 5 個是被新 5 個逐一替掉的。
 */
export const PIXAI_LEGACY_MODEL_ALIASES: Readonly<Record<string, string>> = {
  "pixai-moonbeam": PIXAI_TSUBAKI2_MODEL_ID,
  "pixai-diamond": PIXAI_REFERENCE_PRO_MODEL_ID,
  "pixai-neverland": PIXAI_TSUBAKI_V11_MODEL_ID,
  "pixai-whimsical": PIXAI_HARUKA_V2_MODEL_ID,
  "pixai-hassaku": PIXAI_HOSHINO_V2_MODEL_ID,
};

/** 生成類 PixAI 模型（可作為 `model` 參數傳入 /v1/images/generations）。 */
export const PIXAI_GENERATE_MODEL_IDS: readonly string[] = Object.keys(
  PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID,
);

/**
 * 服務類定價鍵：改圖、放大、模板生成。
 *
 * 這三個不是 bridge 的模型名，不進 /v1/models 選單，但必須算進 pixai 渠道的
 * capability —— 否則 /v1/images/edits、/v1/upscale、/v1/template-generations
 * 走 durable 調度時同樣找不到 supplier。
 *
 * pixai-template 漏在這裡的後果是實測過的：它在 catalog 裡、卻不在 pixai 的
 * 認領白名單裡，於是 seed 把它判成「通用模型」，capability 落到 fallback
 * （share-api.com，不認 pixai）與 sub2api（線上 disabled）名下。
 */
export const PIXAI_SERVICE_MODEL_IDS: readonly string[] = [
  PIXAI_EDIT_MODEL_ID,
  PIXAI_UPSCALE_MODEL_ID,
  PIXAI_TEMPLATE_MODEL_ID,
];

/** pixai 渠道能服務的全部公開模型 ID（生成 + 服務）。 */
export const PIXAI_ALL_MODEL_IDS: readonly string[] = [
  ...PIXAI_GENERATE_MODEL_IDS,
  ...PIXAI_SERVICE_MODEL_IDS,
];

const PIXAI_ALL_MODEL_ID_SET = new Set(PIXAI_ALL_MODEL_IDS);

/** 這個公開模型 ID 是否只能由 pixai 渠道服務。 */
export function isPixaiModelId(modelId: string): boolean {
  return PIXAI_ALL_MODEL_ID_SET.has(modelId);
}

/**
 * 把入站模型名歸一為現行公開 ID。
 *
 * 認三種輸入：現行公開 ID、歷史別名、bridge 名。非 pixai 模型原樣返回，
 * 讓上層的 `isSupportedImageModel` 照常判定。
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
 * 公開模型 ID → bridge 模型名。
 *
 * 傳進來的可以是別名；未知的 pixai 名字返回 null，讓調用方回 400 而不是
 * 把一個 bridge 不認的名字丟過去換一條含義模糊的上游錯誤。
 */
export function pixaiBridgeModelId(modelId: string): string | null {
  return PIXAI_BRIDGE_MODEL_BY_PUBLIC_ID[normalizePixaiModelId(modelId)] ?? null;
}
