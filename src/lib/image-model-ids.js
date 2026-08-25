export const DEFAULT_IMAGE_MODEL_ID = /** @type {const} */ ("gpt-image-2");
export const ADOBE_FIREFLY_MODEL_ID = /** @type {const} */ ("adobe-firefly");
export const NANO_BANANA_MODEL_ID = /** @type {const} */ ("gemini-2.5-flash-image");
export const NANO_BANANA_PRO_MODEL_ID = /** @type {const} */ ("gemini-3-image");
export const NANO_BANANA_2_MODEL_ID = /** @type {const} */ ("gemini-3.1-flash-image");
export const GPT_IMAGE_MODEL_ID = /** @type {const} */ ("gpt-image");
export const GPT_IMAGE_15_MODEL_ID = /** @type {const} */ ("gpt-image-1.5");
export const FLUX_2_MODEL_ID = /** @type {const} */ ("flux-2");
export const FLUX_2_PRO_MODEL_ID = /** @type {const} */ ("flux-2-pro");
export const FLUX_11_PRO_MODEL_ID = /** @type {const} */ ("flux-1.1-pro");
export const FLUX_11_ULTRA_MODEL_ID = /** @type {const} */ ("flux-1.1-ultra");
export const FLUX_KONTEXT_PRO_MODEL_ID = /** @type {const} */ ("flux-kontext-pro");
export const FLUX_KONTEXT_MAX_MODEL_ID = /** @type {const} */ ("flux-kontext-max");
export const RUNWAY_GEN4_IMAGE_MODEL_ID = /** @type {const} */ ("runway-gen-4-image");
export const IMAGE_5_PRO_MODEL_ID = /** @type {const} */ ("image-5-pro");
export const IMAGE_5_LITE_MODEL_ID = /** @type {const} */ ("image-5-lite");
export const SEEDREAM_20_MODEL_ID = /** @type {const} */ ("seedream-2.0");
export const SEEDREAM_50_PRO_MODEL_ID = /** @type {const} */ ("seedream-5.0-pro");
export const SEEDREAM_50_LITE_MODEL_ID = /** @type {const} */ ("seedream-5.0-lite");
export const SENSENOVA_U1_FAST_MODEL_ID = /** @type {const} */ ("sensenova-u1-fast");

// 服務類定價條目（非生成模型）：不加入 SUPPORTED_* 列表，因此不會出現在用戶端
// 模型選單 /v1/models；只作為 admin 定價面板與對應計費 route 的定價鍵。
export const ADOBE_FIREFLY_FILL_MODEL_ID = /** @type {const} */ ("adobe-firefly-fill");
export const PIXAI_EDIT_MODEL_ID = /** @type {const} */ ("pixai-edit");
export const PIXAI_UPSCALE_MODEL_ID = /** @type {const} */ ("pixai-upscale");
export const PIXAI_TEMPLATE_MODEL_ID = /** @type {const} */ ("pixai-template");

// PixAI premium models (2026-08-02: replaced the SD1.5 set).
export const PIXAI_MOONBEAM_MODEL_ID = /** @type {const} */ ("pixai-moonbeam");
export const PIXAI_DIAMOND_MODEL_ID = /** @type {const} */ ("pixai-diamond");
export const PIXAI_NEVERLAND_MODEL_ID = /** @type {const} */ ("pixai-neverland");
export const PIXAI_WHIMSICAL_MODEL_ID = /** @type {const} */ ("pixai-whimsical");
export const PIXAI_HASSAKU_MODEL_ID = /** @type {const} */ ("pixai-hassaku");
export const PIXAI_TSUBAKI2_MODEL_ID = /** @type {const} */ ("pixai-tsubaki2");
export const PIXAI_HARUKA_V2_MODEL_ID = /** @type {const} */ ("pixai-haruka-v2");
export const PIXAI_REFERENCE_PRO_MODEL_ID = /** @type {const} */ ("pixai-reference-pro");
export const PIXAI_TSUBAKI_V11_MODEL_ID = /** @type {const} */ ("pixai-tsubaki-11");
export const PIXAI_HOSHINO_V2_MODEL_ID = /** @type {const} */ ("pixai-hoshino-v2");

export const VEO_31_FAST_MODEL_ID = /** @type {const} */ ("veo-3.1-fast");
export const KLING_30_MODEL_ID = /** @type {const} */ ("kling-3.0");
export const KLING_30_OMNI_MODEL_ID = /** @type {const} */ ("kling-3.0-omni");
export const SEEDANCE_20_FAST_MODEL_ID = /** @type {const} */ ("seedance-2.0-fast");
export const SEEDANCE_20_MODEL_ID = /** @type {const} */ ("seedance-2.0");
export const VEO_31_MODEL_ID = /** @type {const} */ ("veo-3.1");
export const RUNWAY_GEN45_VIDEO_MODEL_ID = /** @type {const} */ ("runway-gen-4.5");
export const ADOBE_FIREFLY_VIDEO_MODEL_ID = /** @type {const} */ ("adobe-firefly-video");
export const LUMA_RAY314_MODEL_ID = /** @type {const} */ ("luma-ray-3.14");
export const RUNWAY_GEN4_VIDEO_MODEL_ID = /** @type {const} */ ("runway-gen-4");
export const LUMA_RAY3_MODEL_ID = /** @type {const} */ ("luma-ray-3");
export const LUMA_RAY314_HDR_MODEL_ID = /** @type {const} */ ("luma-ray-3.14-hdr");
export const LUMA_RAY2_FLASH_MODEL_ID = /** @type {const} */ ("luma-ray-2-flash");
export const LUMA_RAY2_MODEL_ID = /** @type {const} */ ("luma-ray-2");
export const LUMA_RAY3_HDR_MODEL_ID = /** @type {const} */ ("luma-ray-3-hdr");
export const KLING_25_TURBO_MODEL_ID = /** @type {const} */ ("kling-2.5-turbo");

export const SUPPORTED_IMAGE_MODEL_IDS = [
  PIXAI_TSUBAKI2_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  IMAGE_5_PRO_MODEL_ID,
  IMAGE_5_LITE_MODEL_ID,
  SEEDREAM_20_MODEL_ID,
  SEEDREAM_50_PRO_MODEL_ID,
  SEEDREAM_50_LITE_MODEL_ID,
  SENSENOVA_U1_FAST_MODEL_ID,
  ADOBE_FIREFLY_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  GPT_IMAGE_15_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  FLUX_2_PRO_MODEL_ID,
  FLUX_2_MODEL_ID,
  GPT_IMAGE_MODEL_ID,
  FLUX_KONTEXT_MAX_MODEL_ID,
  FLUX_KONTEXT_PRO_MODEL_ID,
  FLUX_11_ULTRA_MODEL_ID,
  FLUX_11_PRO_MODEL_ID,
  RUNWAY_GEN4_IMAGE_MODEL_ID,
  PIXAI_TSUBAKI2_MODEL_ID,
  PIXAI_HARUKA_V2_MODEL_ID,
  PIXAI_REFERENCE_PRO_MODEL_ID,
  PIXAI_TSUBAKI_V11_MODEL_ID,
  PIXAI_HOSHINO_V2_MODEL_ID,
];

export const SUPPORTED_VIDEO_MODEL_IDS = [
  VEO_31_FAST_MODEL_ID,
  KLING_30_MODEL_ID,
  KLING_30_OMNI_MODEL_ID,
  SEEDANCE_20_FAST_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  VEO_31_MODEL_ID,
  RUNWAY_GEN45_VIDEO_MODEL_ID,
  ADOBE_FIREFLY_VIDEO_MODEL_ID,
  LUMA_RAY314_MODEL_ID,
  RUNWAY_GEN4_VIDEO_MODEL_ID,
  LUMA_RAY3_MODEL_ID,
  LUMA_RAY314_HDR_MODEL_ID,
  LUMA_RAY2_FLASH_MODEL_ID,
  LUMA_RAY2_MODEL_ID,
  LUMA_RAY3_HDR_MODEL_ID,
  KLING_25_TURBO_MODEL_ID,
];

export const SUPPORTED_GENERATION_MODEL_IDS = [
  ...SUPPORTED_IMAGE_MODEL_IDS,
  ...SUPPORTED_VIDEO_MODEL_IDS,
];

// ── AV 成片链路（配音/数字人/唇形）。不入 SUPPORTED_* 列表：C 端选单与 canvas
// 管线不受影响，只有 B 端 /v1/models、/v1/object_info 与 model-status 显式附加。
export const TTS_1_MODEL_ID = /** @type {const} */ ("tts-1");
export const AVATAR_1_MODEL_ID = /** @type {const} */ ("avatar-1");
export const LIPSYNC_1_MODEL_ID = /** @type {const} */ ("lipsync-1");
export const SUPPORTED_AV_MODEL_IDS = [TTS_1_MODEL_ID, AVATAR_1_MODEL_ID, LIPSYNC_1_MODEL_ID];

export const ADOBE2API_MODEL_IDS = [
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  ADOBE_FIREFLY_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  GPT_IMAGE_15_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  FLUX_2_PRO_MODEL_ID,
  FLUX_2_MODEL_ID,
  GPT_IMAGE_MODEL_ID,
  FLUX_KONTEXT_MAX_MODEL_ID,
  FLUX_KONTEXT_PRO_MODEL_ID,
  FLUX_11_ULTRA_MODEL_ID,
  FLUX_11_PRO_MODEL_ID,
  RUNWAY_GEN4_IMAGE_MODEL_ID,
  VEO_31_FAST_MODEL_ID,
  KLING_30_MODEL_ID,
  KLING_30_OMNI_MODEL_ID,
  SEEDANCE_20_FAST_MODEL_ID,
  SEEDANCE_20_MODEL_ID,
  VEO_31_MODEL_ID,
  RUNWAY_GEN45_VIDEO_MODEL_ID,
  ADOBE_FIREFLY_VIDEO_MODEL_ID,
  LUMA_RAY314_MODEL_ID,
  RUNWAY_GEN4_VIDEO_MODEL_ID,
  LUMA_RAY3_MODEL_ID,
  LUMA_RAY314_HDR_MODEL_ID,
  LUMA_RAY2_FLASH_MODEL_ID,
  LUMA_RAY2_MODEL_ID,
  LUMA_RAY3_HDR_MODEL_ID,
  KLING_25_TURBO_MODEL_ID,
];
