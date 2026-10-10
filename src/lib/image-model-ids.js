export const DEFAULT_IMAGE_MODEL_ID = /** @type {const} */ ("gpt-image-2");
export const ADOBE_FIREFLY_MODEL_ID = /** @type {const} */ ("adobe-firefly");
export const NANO_BANANA_MODEL_ID = /** @type {const} */ ("gemini-2.5-flash-image");
export const NANO_BANANA_PRO_MODEL_ID = /** @type {const} */ ("gemini-3-image");
export const NANO_BANANA_2_MODEL_ID = /** @type {const} */ ("gemini-3.1-flash-image");
export const GPT_IMAGE_MODEL_ID = /** @type {const} */ ("gpt-image");
export const GPT_IMAGE_15_MODEL_ID = /** @type {const} */ ("gpt-image-1.5");
// GPT Image 2.5（2026-09-08 发布）：走 adobe2api Firefly 家族映射（flare=快档，sunburst=旗舰，上游代号 prism）
export const GPT_IMAGE_25_FLARE_MODEL_ID = /** @type {const} */ ("gpt-image-2.5-flare");
export const GPT_IMAGE_25_SUNBURST_MODEL_ID = /** @type {const} */ ("gpt-image-2.5-sunburst");
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

// 服务类定价条目（非生成模型）：不加入 SUPPORTED_* 列表，因此不会出现在用户端
// 模型选单 /v1/models；只作为 admin 定价面板与对应计费 route 的定价键。
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
// agnes 渠道（apihub.agnes-ai.com，2026-09-19 接入）
export const AGNES_IMAGE_25_FLASH_MODEL_ID = /** @type {const} */ ("agnes-image-2.5-flash");

export const VEO_31_FAST_MODEL_ID = /** @type {const} */ ("veo-3.1-fast");
export const KLING_30_MODEL_ID = /** @type {const} */ ("kling-3.0");
export const KLING_30_OMNI_MODEL_ID = /** @type {const} */ ("kling-3.0-omni");
export const SEEDANCE_20_FAST_MODEL_ID = /** @type {const} */ ("seedance-2.0-fast");
export const SEEDANCE_20_MODEL_ID = /** @type {const} */ ("seedance-2.0");
export const SEEDANCE_20_MINI_MODEL_ID = /** @type {const} */ ("seedance-2.0-mini");
export const SEEDANCE_25_480P_MODEL_ID = /** @type {const} */ ("seedance-2.5-480p");
export const SEEDANCE_25_720P_MODEL_ID = /** @type {const} */ ("seedance-2.5-720p");
// drama 渠道专属：30 秒固定档 seedance 2.5（720p，按条计价），上游模型 sd25-30s
export const SEEDANCE_25_30S_MODEL_ID = /** @type {const} */ ("seedance-2.5-30s");
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
export const MINIMAX_H3_MODEL_ID = /** @type {const} */ ("minimax-h3");

// blender 节点能力标签（片Y/片AA，2026-09-06）：capability model_id 即能力标签
// （NODES-PLAN §3.1，零路由栏位扩散）。不入 SUPPORTED_* 列表（同 TTS/AV 先例）：
// C 端选单不可见，仅 supplier capability/adapter/定价键承载。
export const BLENDER_RENDER_EEVEE_MODEL_ID = /** @type {const} */ ("blender-render-eevee");
export const BLENDER_RENDER_CYCLES_MODEL_ID = /** @type {const} */ ("blender-render-cycles");
export const BLENDER_NODE_MODEL_IDS = [BLENDER_RENDER_EEVEE_MODEL_ID, BLENDER_RENDER_CYCLES_MODEL_ID];

export const SUPPORTED_IMAGE_MODEL_IDS = [
  DEFAULT_IMAGE_MODEL_ID,
  GPT_IMAGE_25_FLARE_MODEL_ID,
  GPT_IMAGE_25_SUNBURST_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  IMAGE_5_PRO_MODEL_ID,
  IMAGE_5_LITE_MODEL_ID,
  SEEDREAM_20_MODEL_ID,
  SEEDREAM_50_LITE_MODEL_ID,
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
  AGNES_IMAGE_25_FLASH_MODEL_ID,
];

// 2026-09-27 暴君裁定「无供货即下架」：以下 14 条视频 model 全层零供货（无任何
// enabled AND is_current 的 video_generate capability；adobe2api 停视频后亦无人承接），
// 自公开/在售目录移除（常数保留供 capability 历史与 adobe2api 映射表引用）：
//   adobe-firefly-video / kling-2.5-turbo / kling-3.0 / kling-3.0-omni /
//   luma-ray-2 / luma-ray-2-flash / luma-ray-3 / luma-ray-3-hdr /
//   luma-ray-3.14 / luma-ray-3.14-hdr / runway-gen-4 / runway-gen-4.5 /
//   veo-3.1 / veo-3.1-fast
// 另 3 条经 xiaoyxiao 白名单核对后**无白名单档位可承接**（不硬映射），一并下架：
//   seedance-2.0-fast（先前依赖 sd-2.0-933-720-fast-原生真人，该档位不在白名单）/
//   seedance-2.0-mini（依赖 seedance2.0-mini-A，不在白名单）/
//   seedance-2.5-30s（依赖 seedance-2.5-3010-特惠，不在白名单）
export const SUPPORTED_VIDEO_MODEL_IDS = [
  SEEDANCE_20_MODEL_ID,
  SEEDANCE_25_480P_MODEL_ID,
  SEEDANCE_25_720P_MODEL_ID,
  MINIMAX_H3_MODEL_ID,
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

// 音乐生成（2026-10-10）：站内单价权威＝`src/lib/music-pricing.ts`（1 币/次）。
// 同 TTS/AV 先例：**不入** SUPPORTED_* 列表（C 端选单/canvas 管线不受影响），只由
// B 端 `GET /v1/models` 显式附加价目（x_coins_per_music，与实扣同源），供 agent 报价。
export const MUSIC_1_MODEL_ID = /** @type {const} */ ("music-1");

// 2026-09-27 暴君裁定「adobe2api 留图、停视频」：本表只列 adobe2api 仍承接的**图像**
// 模型；原视频条目（veo/kling/seedance/firefly-video/luma/runway 全族）一并移除，
// 对应 capability 由 seed 的 retireUnclaimedCapabilities 退役。
export const ADOBE2API_MODEL_IDS = [
  DEFAULT_IMAGE_MODEL_ID,
  NANO_BANANA_2_MODEL_ID,
  ADOBE_FIREFLY_MODEL_ID,
  NANO_BANANA_PRO_MODEL_ID,
  GPT_IMAGE_15_MODEL_ID,
  GPT_IMAGE_25_FLARE_MODEL_ID,
  GPT_IMAGE_25_SUNBURST_MODEL_ID,
  NANO_BANANA_MODEL_ID,
  FLUX_2_PRO_MODEL_ID,
  FLUX_2_MODEL_ID,
  GPT_IMAGE_MODEL_ID,
  FLUX_KONTEXT_MAX_MODEL_ID,
  FLUX_KONTEXT_PRO_MODEL_ID,
  FLUX_11_ULTRA_MODEL_ID,
  FLUX_11_PRO_MODEL_ID,
  RUNWAY_GEN4_IMAGE_MODEL_ID,
];
