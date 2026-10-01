/**
 * AID enums 入庫驗收測試（刀 5 尾，2026-09-15）。
 * 跑法：npx --yes tsx --test src/lib/aid-enums/aid-enums.test.ts
 *
 * 覆蓋：
 *   ① 逐 enum 值集合逐字斷言（鍵名、鍵序、每個欄位值全文比對）——防日後誤改。
 *      期望值是**獨立**從 Java 源檔重掃出來的（非複製 TS 產物），故能同時抓
 *      「產物寫錯」與「產物被改壞」兩類問題。
 *   ② 與我方既有 `creation-flow-steps.ts` 的一致性交叉檢查（7 步值域與中文 label、
 *      AID 六態 → 本站三態的映射宣稱）。
 *   ③ 排除清單防回歸：被裁定不入庫的 AID 檔，其識別特徵不得出現在本目錄。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  CREATION_STEPS,
  isValidCreationStep,
  creationStepMeta,
  episodeStatusFromAid,
} from "../creation-flow-steps.ts";

import {

  AID_CREATION_STEP_ENUM,

  AID_CREATION_MODE_ENUM,

  AID_PROJECT_TYPE_ENUM,

  AID_PROJECT_STATUS_ENUM,

  AID_EPISODE_STATUS_ENUM,

  AID_SCRIPT_TYPE_ENUM,

  AID_SCRIPT_STATUS_ENUM,

} from "./creation";

import {

  AID_GEN_MODE_ENUM,

  AID_GENERATE_MODE_ENUM,

  AID_GEN_TYPE_ENUM,

  AID_GEN_RESULT_TARGET_ENUM,

  AID_MODEL_TYPE_ENUM,

  AID_MEDIA_TYPE_ENUM,

  AID_MEDIA_TYPE,

  AID_PRODUCT_TYPE_ENUM,

  AID_ASPECT_RATIO_ENUM,

  AID_DISPATCH_MODE,

  AID_MEDIA_TASK_STATUS,

} from "./generation";

import {

  AID_STORYBOARD_SHOT_DENSITY_ENUM,

  AID_VIDEO_PROMPT_CONTINUITY_MODE,

  AID_PROMPT_TYPE_ENUM,

  AID_SUBTITLE_RECOGNITION_STATUS,

  AID_PROJECT_GEN_CONFIG_SCENE,

  AID_STYLE_CATEGORY_ENUM,

  AID_VIDEO_STYLE_TYPE_ENUM,

} from "./storyboard";

import {

  AID_ASSET_TYPE_ENUM,

  AID_ASSET_SOURCE_TYPE_ENUM,

  AID_ASSET_CENTER_CATEGORY_ENUM,

  AID_AUDIO_SOURCE_ENUM,

} from "./asset";

import {

  AID_BILLING_MODE,

  AID_CHARGE_TYPE,

  AID_METER_TYPE,

  AID_SETTLE_MODE,

  AID_TEXT_SETTLE_STATUS,

  AID_MEDIA_BILLING_STATUS,

  AID_EXTRACT_BILLING_STATUS,

  AID_BILLING_CONSTANTS,

} from "./billing";

// ── ① 逐 enum 值集合逐字斷言（37 個）─────────────────────────────────────────

test("AID_CREATION_STEP_ENUM：值集合與鍵序逐字對齊 AID `CreationStepEnum`", () => {
  assert.deepEqual(AID_CREATION_STEP_ENUM, {
    SERIES_DEFAULT: {value: -1, desc: "剧集默认"},
    GLOBAL_SETTING: {value: 1, desc: "项目配置"},
    SCRIPT: {value: 2, desc: "剧本创作"},
    ASSET: {value: 3, desc: "素材准备"},
    STORYBOARD: {value: 4, desc: "分镜设计"},
    VIDEO: {value: 5, desc: "视频生成"},
    AUDIO: {value: 6, desc: "音画同步"},
    PREVIEW: {value: 7, desc: "成品预览"},
  });
  assert.deepEqual(Object.keys(AID_CREATION_STEP_ENUM), ["SERIES_DEFAULT", "GLOBAL_SETTING", "SCRIPT", "ASSET", "STORYBOARD", "VIDEO", "AUDIO", "PREVIEW"]);
});

test("AID_CREATION_MODE_ENUM：值集合與鍵序逐字對齊 AID `CreationModeEnum`", () => {
  assert.deepEqual(AID_CREATION_MODE_ENUM, {
    I2V: {value: "i2v", desc: "图生视频"},
    MULTI: {value: "multi", desc: "多参生视频"},
    PRO: {value: "pro", desc: "专业版"},
    AUTO_GRID: {value: "auto_grid", desc: "自动宫格模式"},
  });
  assert.deepEqual(Object.keys(AID_CREATION_MODE_ENUM), ["I2V", "MULTI", "PRO", "AUTO_GRID"]);
});

test("AID_PROJECT_TYPE_ENUM：值集合與鍵序逐字對齊 AID `ProjectTypeEnum`", () => {
  assert.deepEqual(AID_PROJECT_TYPE_ENUM, {
    SERIES: {value: "series", desc: "剧集"},
    MOVIE: {value: "movie", desc: "电影"},
  });
  assert.deepEqual(Object.keys(AID_PROJECT_TYPE_ENUM), ["SERIES", "MOVIE"]);
});

test("AID_PROJECT_STATUS_ENUM：值集合與鍵序逐字對齊 AID `ProjectStatusEnum`", () => {
  assert.deepEqual(AID_PROJECT_STATUS_ENUM, {
    DRAFT: {value: 0, desc: "草稿"},
    PROCESSING: {value: 1, desc: "制作中"},
    FINISHED_UNSUBMITTED: {value: 2, desc: "完成未提交"},
    AUDITING: {value: 3, desc: "审核中"},
    AUDIT_PASSED: {value: 4, desc: "审核通过"},
    AUDIT_FAILED: {value: 5, desc: "审核失败"},
  });
  assert.deepEqual(Object.keys(AID_PROJECT_STATUS_ENUM), ["DRAFT", "PROCESSING", "FINISHED_UNSUBMITTED", "AUDITING", "AUDIT_PASSED", "AUDIT_FAILED"]);
});

test("AID_EPISODE_STATUS_ENUM：值集合與鍵序逐字對齊 AID `EpisodeStatusEnum`", () => {
  assert.deepEqual(AID_EPISODE_STATUS_ENUM, {
    DRAFT: {value: 0, desc: "草稿"},
    PROCESSING: {value: 1, desc: "制作中"},
    FINISHED_UNAUDITED: {value: 2, desc: "完成未审核"},
    AUDITING: {value: 3, desc: "审核中"},
    AUDIT_PASSED: {value: 4, desc: "审核通过"},
    AUDIT_FAILED: {value: 5, desc: "审核失败"},
  });
  assert.deepEqual(Object.keys(AID_EPISODE_STATUS_ENUM), ["DRAFT", "PROCESSING", "FINISHED_UNAUDITED", "AUDITING", "AUDIT_PASSED", "AUDIT_FAILED"]);
});

test("AID_SCRIPT_TYPE_ENUM：值集合與鍵序逐字對齊 AID `ScriptTypeEnum`", () => {
  assert.deepEqual(AID_SCRIPT_TYPE_ENUM, {
    PLOT: {value: "plot", desc: "剧情演绎"},
    MONOLOGUE: {value: "monologue", desc: "真人解说漫"},
  });
  assert.deepEqual(Object.keys(AID_SCRIPT_TYPE_ENUM), ["PLOT", "MONOLOGUE"]);
});

test("AID_SCRIPT_STATUS_ENUM：值集合與鍵序逐字對齊 AID `ScriptStatusEnum`", () => {
  assert.deepEqual(AID_SCRIPT_STATUS_ENUM, {
    DRAFT: {value: 0, desc: "草稿"},
    IN_USE: {value: 1, desc: "使用"},
    HISTORY: {value: 2, desc: "历史版本"},
  });
  assert.deepEqual(Object.keys(AID_SCRIPT_STATUS_ENUM), ["DRAFT", "IN_USE", "HISTORY"]);
});

test("AID_GEN_MODE_ENUM：值集合與鍵序逐字對齊 AID `GenModeEnum`", () => {
  assert.deepEqual(AID_GEN_MODE_ENUM, {
    ECONOMY: {value: "economy", desc: "经济模式"},
    PERFORMANCE: {value: "performance", desc: "性能模式"},
  });
  assert.deepEqual(Object.keys(AID_GEN_MODE_ENUM), ["ECONOMY", "PERFORMANCE"]);
});

test("AID_GENERATE_MODE_ENUM：值集合與鍵序逐字對齊 AID `GenerateModeEnum`", () => {
  assert.deepEqual(AID_GENERATE_MODE_ENUM, {
    TEXT: {value: "text", desc: "文本大模型"},
    TEXT_TO_IMAGE: {value: "text_to_image", desc: "文生图"},
    IMAGE_TO_IMAGE: {value: "image_to_image", desc: "图生图"},
    IMAGE_EDIT: {value: "image_edit", desc: "图片编辑"},
    IMAGE_UPSCALE: {value: "image_upscale", desc: "图片高清"},
    TEXT_TO_VIDEO: {value: "text_to_video", desc: "文生视频"},
    IMAGE_TO_VIDEO: {value: "image_to_video", desc: "图生视频"},
    VIDEO_TO_VIDEO: {value: "video_to_video", desc: "视频生视频"},
    AUDIO: {value: "audio", desc: "音频"},
  });
  assert.deepEqual(Object.keys(AID_GENERATE_MODE_ENUM), ["TEXT", "TEXT_TO_IMAGE", "IMAGE_TO_IMAGE", "IMAGE_EDIT", "IMAGE_UPSCALE", "TEXT_TO_VIDEO", "IMAGE_TO_VIDEO", "VIDEO_TO_VIDEO", "AUDIO"]);
});

test("AID_GEN_TYPE_ENUM：值集合與鍵序逐字對齊 AID `GenTypeEnum`", () => {
  assert.deepEqual(AID_GEN_TYPE_ENUM, {
    IMAGE: {value: "image", desc: "单图"},
    GRID: {value: "grid", desc: "九宫格"},
    I2V: {value: "i2v", desc: "图生视频"},
    MULTI: {value: "multi", desc: "多参视频"},
    EDGE: {value: "edge", desc: "首尾视频"},
    UPLOAD_VIDEO: {value: "upload_video", desc: "上传视频"},
    COMPOSE: {value: "compose", desc: "配音合成视频"},
  });
  assert.deepEqual(Object.keys(AID_GEN_TYPE_ENUM), ["IMAGE", "GRID", "I2V", "MULTI", "EDGE", "UPLOAD_VIDEO", "COMPOSE"]);
});

test("AID_GEN_RESULT_TARGET_ENUM：值集合與鍵序逐字對齊 AID `GenResultTargetEnum`", () => {
  assert.deepEqual(AID_GEN_RESULT_TARGET_ENUM, {
    ASSET: {value: "asset", desc: "资产表"},
    GEN_RECORD: {value: "gen_record", desc: "抽卡记录表"},
  });
  assert.deepEqual(Object.keys(AID_GEN_RESULT_TARGET_ENUM), ["ASSET", "GEN_RECORD"]);
});

test("AID_MODEL_TYPE_ENUM：值集合與鍵序逐字對齊 AID `ModelTypeEnum`", () => {
  assert.deepEqual(AID_MODEL_TYPE_ENUM, {
    IMAGE: {value: "image", desc: "生图"},
    VIDEO: {value: "video", desc: "生视频"},
    AUDIO: {value: "audio", desc: "配音"},
  });
  assert.deepEqual(Object.keys(AID_MODEL_TYPE_ENUM), ["IMAGE", "VIDEO", "AUDIO"]);
});

test("AID_MEDIA_TYPE_ENUM：值集合與鍵序逐字對齊 AID `MediaTypeEnum`", () => {
  assert.deepEqual(AID_MEDIA_TYPE_ENUM, {
    IMAGE: {value: "image", desc: "图片"},
    VIDEO: {value: "video", desc: "视频"},
  });
  assert.deepEqual(Object.keys(AID_MEDIA_TYPE_ENUM), ["IMAGE", "VIDEO"]);
});

test("AID_MEDIA_TYPE：值集合與鍵序逐字對齊 AID `MediaType`", () => {
  assert.deepEqual(AID_MEDIA_TYPE, {
    IMAGE: {value: "IMAGE"},
    VIDEO: {value: "VIDEO"},
    TEXT: {value: "TEXT"},
    AUDIO: {value: "AUDIO"},
  });
  assert.deepEqual(Object.keys(AID_MEDIA_TYPE), ["IMAGE", "VIDEO", "TEXT", "AUDIO"]);
});

test("AID_PRODUCT_TYPE_ENUM：值集合與鍵序逐字對齊 AID `ProductTypeEnum`", () => {
  assert.deepEqual(AID_PRODUCT_TYPE_ENUM, {
    ASSET: {value: "asset", desc: "资产"},
    STORYBOARD: {value: "storyboard", desc: "分镜"},
    VIDEO: {value: "video", desc: "视频"},
  });
  assert.deepEqual(Object.keys(AID_PRODUCT_TYPE_ENUM), ["ASSET", "STORYBOARD", "VIDEO"]);
});

test("AID_ASPECT_RATIO_ENUM：值集合與鍵序逐字對齊 AID `AspectRatioEnum`", () => {
  assert.deepEqual(AID_ASPECT_RATIO_ENUM, {
    RATIO_16_9: {value: "16:9", desc: "横屏"},
    RATIO_9_16: {value: "9:16", desc: "竖屏"},
    RATIO_1_1: {value: "1:1", desc: "方形"},
    RATIO_4_3: {value: "4:3", desc: "传统屏"},
    RATIO_3_4: {value: "3:4", desc: "竖版传统"},
    RATIO_3_2: {value: "3:2", desc: "经典横屏"},
    RATIO_2_3: {value: "2:3", desc: "经典竖屏"},
    RATIO_21_9: {value: "21:9", desc: "超宽屏"},
    RATIO_9_21: {value: "9:21", desc: "超长竖屏"},
    RATIO_2_1: {value: "2:1", desc: "宽银幕"},
    RATIO_1_2: {value: "1:2", desc: "长竖屏"},
    RATIO_4_5: {value: "4:5", desc: "社交媒体竖版"},
    RATIO_5_4: {value: "5:4", desc: "社交媒体横版"},
  });
  assert.deepEqual(Object.keys(AID_ASPECT_RATIO_ENUM), ["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3", "RATIO_3_4", "RATIO_3_2", "RATIO_2_3", "RATIO_21_9", "RATIO_9_21", "RATIO_2_1", "RATIO_1_2", "RATIO_4_5", "RATIO_5_4"]);
});

test("AID_DISPATCH_MODE：值集合與鍵序逐字對齊 AID `DispatchMode`", () => {
  assert.deepEqual(AID_DISPATCH_MODE, {
    DIRECT: {value: "DIRECT"},
    CALLBACK_FIRST: {value: "CALLBACK_FIRST"},
    POLL_ONLY: {value: "POLL_ONLY"},
  });
  assert.deepEqual(Object.keys(AID_DISPATCH_MODE), ["DIRECT", "CALLBACK_FIRST", "POLL_ONLY"]);
});

test("AID_MEDIA_TASK_STATUS：值集合與鍵序逐字對齊 AID `MediaTaskStatus`", () => {
  assert.deepEqual(AID_MEDIA_TASK_STATUS, {
    PENDING: {value: "PENDING"},
    QUEUED: {value: "QUEUED"},
    PROCESSING: {value: "PROCESSING"},
    WAIT_CALLBACK: {value: "WAIT_CALLBACK"},
    WAIT_POLL: {value: "WAIT_POLL"},
    SUCCEEDED: {value: "SUCCEEDED"},
    FAILED: {value: "FAILED"},
    CANCELLED: {value: "CANCELLED"},
  });
  assert.deepEqual(Object.keys(AID_MEDIA_TASK_STATUS), ["PENDING", "QUEUED", "PROCESSING", "WAIT_CALLBACK", "WAIT_POLL", "SUCCEEDED", "FAILED", "CANCELLED"]);
});

test("AID_STORYBOARD_SHOT_DENSITY_ENUM：值集合與鍵序逐字對齊 AID `StoryboardShotDensityEnum`", () => {
  assert.deepEqual(AID_STORYBOARD_SHOT_DENSITY_ENUM, {
    LITE: {value: "精简模式", desc: "节奏紧凑、信息密度高"},
    STANDARD: {value: "标准模式", desc: "默认拆分粒度"},
    DETAILED: {value: "细拆模式", desc: "重点戏份、情绪高潮、慢节奏"},
  });
  assert.deepEqual(Object.keys(AID_STORYBOARD_SHOT_DENSITY_ENUM), ["LITE", "STANDARD", "DETAILED"]);
});

test("AID_VIDEO_PROMPT_CONTINUITY_MODE：值集合與鍵序逐字對齊 AID `VideoPromptContinuityMode`", () => {
  assert.deepEqual(AID_VIDEO_PROMPT_CONTINUITY_MODE, {
    NONE: {value: "none"},
    PREVIOUS_PROMPT: {value: "previous_prompt"},
  });
  assert.deepEqual(Object.keys(AID_VIDEO_PROMPT_CONTINUITY_MODE), ["NONE", "PREVIOUS_PROMPT"]);
});

test("AID_PROMPT_TYPE_ENUM：值集合與鍵序逐字對齊 AID `PromptTypeEnum`", () => {
  assert.deepEqual(AID_PROMPT_TYPE_ENUM, {
    STYLE: {value: "style", desc: "视频风格"},
    CAMERA: {value: "camera", desc: "镜头语言"},
    SUBJECT: {value: "subject", desc: "主体描述"},
  });
  assert.deepEqual(Object.keys(AID_PROMPT_TYPE_ENUM), ["STYLE", "CAMERA", "SUBJECT"]);
});

test("AID_SUBTITLE_RECOGNITION_STATUS：值集合與鍵序逐字對齊 AID `SubtitleRecognitionStatus`", () => {
  assert.deepEqual(AID_SUBTITLE_RECOGNITION_STATUS, {
    PROCESSING: {value: "PROCESSING"},
    COMPLETED: {value: "COMPLETED"},
    TEXT_FALLBACK: {value: "TEXT_FALLBACK"},
    FAILED: {value: "FAILED"},
  });
  assert.deepEqual(Object.keys(AID_SUBTITLE_RECOGNITION_STATUS), ["PROCESSING", "COMPLETED", "TEXT_FALLBACK", "FAILED"]);
});

test("AID_PROJECT_GEN_CONFIG_SCENE：值集合與鍵序逐字對齊 AID `ProjectGenConfigScene`", () => {
  assert.deepEqual(AID_PROJECT_GEN_CONFIG_SCENE, {
    CHARACTER_EXTRACT: {sceneCode: "main_character_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    SCENE_EXTRACT: {sceneCode: "main_scene_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    PROP_EXTRACT: {sceneCode: "main_prop_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    CHARACTER_FORM: {sceneCode: "main_character_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    SCENE_FORM: {sceneCode: "main_scene_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    PROP_FORM: {sceneCode: "main_prop_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    CHARACTER_IMAGE: {sceneCode: "main_character_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage"},
    SCENE_IMAGE: {sceneCode: "main_scene_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage"},
    PROP_IMAGE: {sceneCode: "main_prop_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage"},
    CHARACTER_CARD_IMAGE: {sceneCode: "main_character_card_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "imageToImage"},
    STORYBOARD_SCRIPT: {sceneCode: "main_storyboard_script", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    STORYBOARD_STYLIST: {sceneCode: "main_storyboard_stylist", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    STORYBOARD_VIDEO_PROMPT: {sceneCode: "main_storyboard_video_prompt", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    STORYBOARD_VIDEO_PROMPT_IMAGE: {sceneCode: "main_storyboard_video_prompt_image", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    STORYBOARD_VIDEO_PROMPT_GRID: {sceneCode: "main_storyboard_video_prompt_grid", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null},
    STORYBOARD_IMAGE: {sceneCode: "main_storyboard_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "imageToImage"},
  });
  assert.deepEqual(Object.keys(AID_PROJECT_GEN_CONFIG_SCENE), ["CHARACTER_EXTRACT", "SCENE_EXTRACT", "PROP_EXTRACT", "CHARACTER_FORM", "SCENE_FORM", "PROP_FORM", "CHARACTER_IMAGE", "SCENE_IMAGE", "PROP_IMAGE", "CHARACTER_CARD_IMAGE", "STORYBOARD_SCRIPT", "STORYBOARD_STYLIST", "STORYBOARD_VIDEO_PROMPT", "STORYBOARD_VIDEO_PROMPT_IMAGE", "STORYBOARD_VIDEO_PROMPT_GRID", "STORYBOARD_IMAGE"]);
});

test("AID_STYLE_CATEGORY_ENUM：值集合與鍵序逐字對齊 AID `StyleCategoryEnum`", () => {
  assert.deepEqual(AID_STYLE_CATEGORY_ENUM, {
    COMIC_DRAMA: {code: "comic_drama", label: "漫剧", sortOrder: 10},
    LIVE_ACTION: {code: "live_action", label: "真人剧", sortOrder: 20},
    THREE_D: {code: "three_d", label: "3D", sortOrder: 30},
    CHINESE: {code: "chinese", label: "国风", sortOrder: 40},
    TWO_D: {code: "two_d", label: "2D", sortOrder: 50},
    CHIBI: {code: "chibi", label: "Q版", sortOrder: 60},
    GAME: {code: "game", label: "游戏", sortOrder: 70},
    JAPANESE: {code: "japanese", label: "日漫", sortOrder: 80},
    WESTERN: {code: "western", label: "欧美", sortOrder: 90},
    KOREAN: {code: "korean", label: "韩流", sortOrder: 100},
  });
  assert.deepEqual(Object.keys(AID_STYLE_CATEGORY_ENUM), ["COMIC_DRAMA", "LIVE_ACTION", "THREE_D", "CHINESE", "TWO_D", "CHIBI", "GAME", "JAPANESE", "WESTERN", "KOREAN"]);
});

test("AID_VIDEO_STYLE_TYPE_ENUM：值集合與鍵序逐字對齊 AID `VideoStyleTypeEnum`", () => {
  assert.deepEqual(AID_VIDEO_STYLE_TYPE_ENUM, {
    CUSTOM: {value: "custom", desc: "自定义"},
    AI_GEN: {value: "ai_gen", desc: "AI生成"},
    OFFICIAL: {value: "official", desc: "官方预设"},
  });
  assert.deepEqual(Object.keys(AID_VIDEO_STYLE_TYPE_ENUM), ["CUSTOM", "AI_GEN", "OFFICIAL"]);
});

test("AID_ASSET_TYPE_ENUM：值集合與鍵序逐字對齊 AID `AssetTypeEnum`", () => {
  assert.deepEqual(AID_ASSET_TYPE_ENUM, {
    STYLE: {value: "style", desc: "风格"},
    SCENE: {value: "scene", desc: "场景"},
    CHARACTER: {value: "character", desc: "角色"},
    PROP: {value: "prop", desc: "道具"},
    FILE: {value: "file", desc: "文件"},
    POSE: {value: "pose", desc: "姿势"},
    EFFECT: {value: "effect", desc: "特效"},
    EXPRESSION: {value: "expression", desc: "表情"},
  });
  assert.deepEqual(Object.keys(AID_ASSET_TYPE_ENUM), ["STYLE", "SCENE", "CHARACTER", "PROP", "FILE", "POSE", "EFFECT", "EXPRESSION"]);
});

test("AID_ASSET_SOURCE_TYPE_ENUM：值集合與鍵序逐字對齊 AID `AssetSourceTypeEnum`", () => {
  assert.deepEqual(AID_ASSET_SOURCE_TYPE_ENUM, {
    MANUAL: {value: 1, desc: "手动填写"},
    SINGLE_EXTRACT: {value: 2, desc: "单集提取"},
    GLOBAL_EXTRACT: {value: 3, desc: "全集全局提取"},
  });
  assert.deepEqual(Object.keys(AID_ASSET_SOURCE_TYPE_ENUM), ["MANUAL", "SINGLE_EXTRACT", "GLOBAL_EXTRACT"]);
});

test("AID_ASSET_CENTER_CATEGORY_ENUM：值集合與鍵序逐字對齊 AID `AssetCenterCategoryEnum`", () => {
  assert.deepEqual(AID_ASSET_CENTER_CATEGORY_ENUM, {
    SCRIPT: {code: "script", name: "剧本"},
    ROLE: {code: "role", name: "角色"},
    SCENE: {code: "scene", name: "场景"},
    PROP: {code: "prop", name: "道具"},
    ROLE_SETTING: {code: "role_setting", name: "角色设定"},
    SCENE_SETTING: {code: "scene_setting", name: "场景设定"},
    PROP_SETTING: {code: "prop_setting", name: "道具设定"},
    ROLE_IMAGE: {code: "role_image", name: "角色图"},
    SCENE_IMAGE: {code: "scene_image", name: "场景图"},
    PROP_IMAGE: {code: "prop_image", name: "道具图"},
    STORYBOARD_SCRIPT: {code: "storyboard_script", name: "分镜脚本"},
    STORYBOARD_IMAGE: {code: "storyboard_image", name: "分镜脚本图"},
    STORYBOARD_VIDEO: {code: "storyboard_video", name: "分镜视频"},
    DUBBING: {code: "dubbing", name: "配音"},
    PREVIEW_VIDEO: {code: "preview_video", name: "预览视频"},
  });
  assert.deepEqual(Object.keys(AID_ASSET_CENTER_CATEGORY_ENUM), ["SCRIPT", "ROLE", "SCENE", "PROP", "ROLE_SETTING", "SCENE_SETTING", "PROP_SETTING", "ROLE_IMAGE", "SCENE_IMAGE", "PROP_IMAGE", "STORYBOARD_SCRIPT", "STORYBOARD_IMAGE", "STORYBOARD_VIDEO", "DUBBING", "PREVIEW_VIDEO"]);
});

test("AID_AUDIO_SOURCE_ENUM：值集合與鍵序逐字對齊 AID `AudioSourceEnum`", () => {
  assert.deepEqual(AID_AUDIO_SOURCE_ENUM, {
    AI_TTS: {value: 1, desc: "AI文字配音"},
    USER_UPLOAD: {value: 2, desc: "用户上传"},
  });
  assert.deepEqual(Object.keys(AID_AUDIO_SOURCE_ENUM), ["AI_TTS", "USER_UPLOAD"]);
});

test("AID_BILLING_MODE：值集合與鍵序逐字對齊 AID `BillingMode`", () => {
  assert.deepEqual(AID_BILLING_MODE, {
    FIXED: {code: "FIXED", desc: "固定价格"},
    SKU: {code: "SKU", desc: "SKU规则计费"},
  });
  assert.deepEqual(Object.keys(AID_BILLING_MODE), ["FIXED", "SKU"]);
});

test("AID_CHARGE_TYPE：值集合與鍵序逐字對齊 AID `ChargeType`", () => {
  assert.deepEqual(AID_CHARGE_TYPE, {
    TEXT: {code: "TEXT", desc: "文本生成"},
    IMAGE: {code: "IMAGE", desc: "图片生成"},
    VIDEO: {code: "VIDEO", desc: "视频生成"},
  });
  assert.deepEqual(Object.keys(AID_CHARGE_TYPE), ["TEXT", "IMAGE", "VIDEO"]);
});

test("AID_METER_TYPE：值集合與鍵序逐字對齊 AID `MeterType`", () => {
  assert.deepEqual(AID_METER_TYPE, {
    TOKEN: {value: "TOKEN"},
    PER_IMAGE: {value: "PER_IMAGE"},
    PER_SECOND: {value: "PER_SECOND"},
    SKU_PACKAGE: {value: "SKU_PACKAGE"},
    PER_CHAR: {value: "PER_CHAR"},
  });
  assert.deepEqual(Object.keys(AID_METER_TYPE), ["TOKEN", "PER_IMAGE", "PER_SECOND", "SKU_PACKAGE", "PER_CHAR"]);
});

test("AID_SETTLE_MODE：值集合與鍵序逐字對齊 AID `SettleMode`", () => {
  assert.deepEqual(AID_SETTLE_MODE, {
    DIRECT_SETTLE: {code: "DIRECT_SETTLE", desc: "直接结算"},
    REFUND_ONLY: {code: "REFUND_ONLY", desc: "差额退款"},
  });
  assert.deepEqual(Object.keys(AID_SETTLE_MODE), ["DIRECT_SETTLE", "REFUND_ONLY"]);
});

test("AID_TEXT_SETTLE_STATUS：值集合與鍵序逐字對齊 AID `TextSettleStatus`", () => {
  assert.deepEqual(AID_TEXT_SETTLE_STATUS, {
    INIT: "INIT",
    PROCESSING: "PROCESSING",
    DONE: "DONE",
    PARTIAL_DONE: "PARTIAL_DONE",
  });
  assert.deepEqual(Object.keys(AID_TEXT_SETTLE_STATUS), ["INIT", "PROCESSING", "DONE", "PARTIAL_DONE"]);
});

test("AID_MEDIA_BILLING_STATUS：值集合與鍵序逐字對齊 AID `MediaBillingStatus`", () => {
  assert.deepEqual(AID_MEDIA_BILLING_STATUS, {
    INIT: {value: "INIT"},
    FROZEN: {value: "FROZEN"},
    SETTLING: {value: "SETTLING"},
    REFUNDING: {value: "REFUNDING"},
    SUCCESS: {value: "SUCCESS"},
    FAILED: {value: "FAILED"},
  });
  assert.deepEqual(Object.keys(AID_MEDIA_BILLING_STATUS), ["INIT", "FROZEN", "SETTLING", "REFUNDING", "SUCCESS", "FAILED"]);
});

test("AID_EXTRACT_BILLING_STATUS：值集合與鍵序逐字對齊 AID `ExtractBillingStatus`", () => {
  assert.deepEqual(AID_EXTRACT_BILLING_STATUS, {
    INIT: {value: "INIT"},
    FROZEN: {value: "FROZEN"},
    SETTLING: {value: "SETTLING"},
    REFUNDING: {value: "REFUNDING"},
    SUCCESS: {value: "SUCCESS"},
    PARTIAL_SUCCESS: {value: "PARTIAL_SUCCESS"},
    FAILED: {value: "FAILED"},
  });
  assert.deepEqual(Object.keys(AID_EXTRACT_BILLING_STATUS), ["INIT", "FROZEN", "SETTLING", "REFUNDING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"]);
});

test("AID_BILLING_CONSTANTS：值集合與鍵序逐字對齊 AID `BillingConstants`", () => {
  assert.deepEqual(AID_BILLING_CONSTANTS, {
    ACCOUNT_AMOUNT_SCALE: 4,
    MODE_FIXED: "FIXED",
    MODE_SKU: "SKU",
    MATCH_STRATEGY_FIRST_HIT: "FIRST_HIT",
    MODEL_PRICE_MULTIPLIER_CATEGORY: "media",
    MODEL_PRICE_MULTIPLIER_KEY: "ai_billing_global_multiplier",
    MODEL_PRICE_MULTIPLIER_CACHE_TTL_MS: 5000,
    DEFAULT_MODEL_PRICE_MULTIPLIER: "100",
    DEFAULT_CHAR_TO_TOKEN_RATIO: 2,
    CHAR_TO_TOKEN_NUMERATOR: 4,
    CHAR_TO_TOKEN_DENOMINATOR: 5,
    DEFAULT_ESTIMATED_OUTPUT_CHARS: 2000,
    GPT_IMAGE2_INPUT_TOKENS_PER_REF_IMAGE: 1800,
    SETTLE_DIRECT: "DIRECT_SETTLE",
    SETTLE_REFUND_ONLY: "REFUND_ONLY",
    USAGE_PROVIDER: "PROVIDER_USAGE",
    USAGE_ESTIMATE: "ESTIMATE",
  });
  assert.deepEqual(Object.keys(AID_BILLING_CONSTANTS), ["ACCOUNT_AMOUNT_SCALE", "MODE_FIXED", "MODE_SKU", "MATCH_STRATEGY_FIRST_HIT", "MODEL_PRICE_MULTIPLIER_CATEGORY", "MODEL_PRICE_MULTIPLIER_KEY", "MODEL_PRICE_MULTIPLIER_CACHE_TTL_MS", "DEFAULT_MODEL_PRICE_MULTIPLIER", "DEFAULT_CHAR_TO_TOKEN_RATIO", "CHAR_TO_TOKEN_NUMERATOR", "CHAR_TO_TOKEN_DENOMINATOR", "DEFAULT_ESTIMATED_OUTPUT_CHARS", "GPT_IMAGE2_INPUT_TOKENS_PER_REF_IMAGE", "SETTLE_DIRECT", "SETTLE_REFUND_ONLY", "USAGE_PROVIDER", "USAGE_ESTIMATE"]);
});

// ── ② 與我方 creation-flow-steps.ts 的一致性交叉檢查 ────────────────────────

test("CreationStep 值域一致：AID 的 1..7 七步，鍵與中文 label 逐字相同", () => {
  // AID CreationStepEnum 的 1..7（排除 SERIES_DEFAULT=-1）：本站 7 步必須逐值對上。
  const aidSteps = Object.values(AID_CREATION_STEP_ENUM)
    .filter((s) => s.value >= 1 && s.value <= 7)
    .sort((a, b) => a.value - b.value);
  assert.equal(aidSteps.length, CREATION_STEPS.length);
  CREATION_STEPS.forEach((step, i) => {
    assert.equal(step.value, aidSteps[i].value, `第 ${i + 1} 步 value 不一致`);
    assert.equal(step.label, aidSteps[i].desc, `第 ${i + 1} 步 label 應逐字等於 AID desc`);
  });
});

test("AID 的 SERIES_DEFAULT(-1) 確實被我方刻意排除", () => {
  assert.equal(AID_CREATION_STEP_ENUM.SERIES_DEFAULT.value, -1);
  assert.equal(isValidCreationStep(-1), false);
  assert.equal(CREATION_STEPS.some((s) => s.value === -1), false);
});

test("isValidCreationStep 的 1..7 判據與 AID isValidStep 等價", () => {
  for (let v = -3; v <= 12; v++) {
    const aid = Number.isInteger(v) && v >= 1 && v <= 7; // AID: value != null && value >= 1 && value <= 7
    assert.equal(isValidCreationStep(v), aid, `value=${v} 判據分歧`);
  }
  for (const bad of [null, undefined, "3", 3.5, NaN, {}]) {
    assert.equal(isValidCreationStep(bad), false);
  }
});

test("creationStepMeta 以 AID value 查表，回本站 step（含 key）", () => {
  assert.equal(creationStepMeta(1)?.key, "global-setting");
  assert.equal(creationStepMeta(7)?.key, "preview");
  assert.equal(creationStepMeta(0), undefined);
  assert.equal(creationStepMeta(8), undefined);
});

test("episodeStatusFromAid：AID EpisodeStatusEnum 六態 → 本站三態，逐值對齊檔內宣稱", () => {
  // 期望表即 creation-flow-steps.ts 檔頭聲明的映射，此處以 AID enum 值驅動。
  const expected = {
    [AID_EPISODE_STATUS_ENUM.DRAFT.value]: "draft", // 0
    [AID_EPISODE_STATUS_ENUM.PROCESSING.value]: "processing", // 1
    [AID_EPISODE_STATUS_ENUM.FINISHED_UNAUDITED.value]: "finished", // 2
    [AID_EPISODE_STATUS_ENUM.AUDITING.value]: "finished", // 3
    [AID_EPISODE_STATUS_ENUM.AUDIT_PASSED.value]: "finished", // 4
    [AID_EPISODE_STATUS_ENUM.AUDIT_FAILED.value]: "processing", // 5
  };
  for (const [k, v] of Object.entries(expected)) {
    assert.equal(episodeStatusFromAid(Number(k)), v, `value=${k} 映射分歧`);
  }
  assert.equal(episodeStatusFromAid(6), undefined);
  assert.equal(episodeStatusFromAid("0"), undefined);
});

test("審核三態值在 AID enums 中原樣在場（如實保留，未私自剔除）", () => {
  assert.equal(AID_EPISODE_STATUS_ENUM.AUDITING.value, 3);
  assert.equal(AID_EPISODE_STATUS_ENUM.AUDIT_PASSED.value, 4);
  assert.equal(AID_EPISODE_STATUS_ENUM.AUDIT_FAILED.value, 5);
  assert.equal(AID_PROJECT_STATUS_ENUM.FINISHED_UNSUBMITTED.desc, "完成未提交");
});

// ── ③ 排除清單防回歸 ────────────────────────────────────────────────────────

const DIR = new URL(".", import.meta.url).pathname;
const DIR_FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts") && f !== "aid-enums.test.ts");
const ALL_TEXT = DIR_FILES.map((f) => readFileSync(join(DIR, f), "utf8")).join("\n");

/** 被裁定不入庫的 AID enums：識別特徵（型別名）不得作為常數出現在本目錄。 */
const EXCLUDED = [
  ["AuditActionEnum", "審核隊列配套（用戶裁定配套不要）"],
  ["AuditTargetTypeEnum", "審核隊列配套（用戶裁定配套不要）"],
  ["BusinessStatus", "RuoYi 框架自帶（操作日誌）"],
  ["BusinessType", "RuoYi 框架自帶（操作日誌）"],
  ["DataSourceType", "RuoYi 框架自帶（主從庫）"],
  ["DesensitizedType", "RuoYi 框架自帶＋成員值為 Java Function（非純資料）"],
  ["HttpMethod", "Spring MVC 框架自帶"],
  ["LimitType", "RuoYi 框架自帶（限流）"],
  ["LoginType", "RuoYi 框架自帶；本站登入為 OAuth/第三方，值集不映射"],
  ["OperatorType", "RuoYi 框架自帶（操作日誌）"],
  ["UserStatus", "RuoYi 框架自帶（用戶表）"],
  ["CommonEnableStatusEnum", "本站無 char(1) \"0\"/\"1\" 狀態欄慣例（一律 boolean）"],
  ["CommonYesNoEnum", "本站無 char(1) \"0\"/\"1\" 狀態慣例（一律 boolean）"],
  ["IBaseEnum", "Java interface，無值域可搬"],
];

test("排除清單：14 個 AID 檔皆未入庫（以 export const AID_<X> 形式）", () => {
  for (const [aidName, reason] of EXCLUDED) {
    const asConst = "AID_" + aidName.replace(/(?<!^)(?=[A-Z])/g, "_").toUpperCase();
    assert.equal(
      ALL_TEXT.includes("export const " + asConst + " = {"),
      false,
      `${aidName} 應排除（${reason}）卻出現在本目錄`,
    );
  }
});

test("排除清單：14 個排除檔亦未以其他具名形式混入（防改名偷渡）", () => {
  for (const [aidName] of EXCLUDED) {
    assert.equal(
      new RegExp("(?:const|type)\\s+" + aidName + "\\s*[=:]").test(ALL_TEXT),
      false,
      `${aidName} 以非 AID_ 前綴形式混入本目錄`,
    );
  }
});

test("檔案職責單一：本目錄每個 .ts 只放常數／型別，不含函式宣告或 side effect", () => {
  for (const f of DIR_FILES) {
    const src = readFileSync(join(DIR, f), "utf8");
    assert.equal(/^\s*export\s+(?:async\s+)?function\b/m.test(src), false, `${f} 出現函式宣告`);
    assert.equal(/^\s*import\b/m.test(src) && f !== "index.ts", false, `${f} 不應 import 其他模組`);
    assert.equal(/^\s*(?:console\.|await\s)/m.test(src), false, `${f} 出現 side effect`);
  }
});

test("index.ts 匯出本目錄全部 37 個常數與其值集合型別", () => {
  const idxSrc = readFileSync(join(DIR, "index.ts"), "utf8");
  for (const m of [{"const": "AID_CREATION_STEP_ENUM", "aidType": "CreationStepEnum", "fields": ["value", "desc"], "n": 8, "type": "AidCreationStepEnumValue", "keys": ["SERIES_DEFAULT", "GLOBAL_SETTING", "SCRIPT", "ASSET", "STORYBOARD", "VIDEO", "AUDIO", "PREVIEW"], "srcFile": "CreationStepEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationStepEnum.java", "outFile": "creation.ts"}, {"const": "AID_CREATION_MODE_ENUM", "aidType": "CreationModeEnum", "fields": ["value", "desc"], "n": 4, "type": "AidCreationModeEnumValue", "keys": ["I2V", "MULTI", "PRO", "AUTO_GRID"], "srcFile": "CreationModeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationModeEnum.java", "outFile": "creation.ts"}, {"const": "AID_PROJECT_TYPE_ENUM", "aidType": "ProjectTypeEnum", "fields": ["value", "desc"], "n": 2, "type": "AidProjectTypeEnumValue", "keys": ["SERIES", "MOVIE"], "srcFile": "ProjectTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProjectTypeEnum.java", "outFile": "creation.ts"}, {"const": "AID_PROJECT_STATUS_ENUM", "aidType": "ProjectStatusEnum", "fields": ["value", "desc"], "n": 6, "type": "AidProjectStatusEnumValue", "keys": ["DRAFT", "PROCESSING", "FINISHED_UNSUBMITTED", "AUDITING", "AUDIT_PASSED", "AUDIT_FAILED"], "srcFile": "ProjectStatusEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProjectStatusEnum.java", "outFile": "creation.ts"}, {"const": "AID_EPISODE_STATUS_ENUM", "aidType": "EpisodeStatusEnum", "fields": ["value", "desc"], "n": 6, "type": "AidEpisodeStatusEnumValue", "keys": ["DRAFT", "PROCESSING", "FINISHED_UNAUDITED", "AUDITING", "AUDIT_PASSED", "AUDIT_FAILED"], "srcFile": "EpisodeStatusEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/EpisodeStatusEnum.java", "outFile": "creation.ts"}, {"const": "AID_SCRIPT_TYPE_ENUM", "aidType": "ScriptTypeEnum", "fields": ["value", "desc"], "n": 2, "type": "AidScriptTypeEnumValue", "keys": ["PLOT", "MONOLOGUE"], "srcFile": "ScriptTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ScriptTypeEnum.java", "outFile": "creation.ts"}, {"const": "AID_SCRIPT_STATUS_ENUM", "aidType": "ScriptStatusEnum", "fields": ["value", "desc"], "n": 3, "type": "AidScriptStatusEnumValue", "keys": ["DRAFT", "IN_USE", "HISTORY"], "srcFile": "ScriptStatusEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ScriptStatusEnum.java", "outFile": "creation.ts"}, {"const": "AID_GEN_MODE_ENUM", "aidType": "GenModeEnum", "fields": ["value", "desc"], "n": 2, "type": "AidGenModeEnumValue", "keys": ["ECONOMY", "PERFORMANCE"], "srcFile": "GenModeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenModeEnum.java", "outFile": "generation.ts"}, {"const": "AID_GENERATE_MODE_ENUM", "aidType": "GenerateModeEnum", "fields": ["value", "desc"], "n": 9, "type": "AidGenerateModeEnumValue", "keys": ["TEXT", "TEXT_TO_IMAGE", "IMAGE_TO_IMAGE", "IMAGE_EDIT", "IMAGE_UPSCALE", "TEXT_TO_VIDEO", "IMAGE_TO_VIDEO", "VIDEO_TO_VIDEO", "AUDIO"], "srcFile": "GenerateModeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenerateModeEnum.java", "outFile": "generation.ts"}, {"const": "AID_GEN_TYPE_ENUM", "aidType": "GenTypeEnum", "fields": ["value", "desc"], "n": 7, "type": "AidGenTypeEnumValue", "keys": ["IMAGE", "GRID", "I2V", "MULTI", "EDGE", "UPLOAD_VIDEO", "COMPOSE"], "srcFile": "GenTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenTypeEnum.java", "outFile": "generation.ts"}, {"const": "AID_GEN_RESULT_TARGET_ENUM", "aidType": "GenResultTargetEnum", "fields": ["value", "desc"], "n": 2, "type": "AidGenResultTargetEnumValue", "keys": ["ASSET", "GEN_RECORD"], "srcFile": "GenResultTargetEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenResultTargetEnum.java", "outFile": "generation.ts"}, {"const": "AID_MODEL_TYPE_ENUM", "aidType": "ModelTypeEnum", "fields": ["value", "desc"], "n": 3, "type": "AidModelTypeEnumValue", "keys": ["IMAGE", "VIDEO", "AUDIO"], "srcFile": "ModelTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ModelTypeEnum.java", "outFile": "generation.ts"}, {"const": "AID_MEDIA_TYPE_ENUM", "aidType": "MediaTypeEnum", "fields": ["value", "desc"], "n": 2, "type": "AidMediaTypeEnumValue", "keys": ["IMAGE", "VIDEO"], "srcFile": "MediaTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/MediaTypeEnum.java", "outFile": "generation.ts"}, {"const": "AID_MEDIA_TYPE", "aidType": "MediaType", "fields": [], "n": 4, "type": "AidMediaTypeValue", "keys": ["IMAGE", "VIDEO", "TEXT", "AUDIO"], "srcFile": "MediaType.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaType.java", "outFile": "generation.ts"}, {"const": "AID_PRODUCT_TYPE_ENUM", "aidType": "ProductTypeEnum", "fields": ["value", "desc"], "n": 3, "type": "AidProductTypeEnumValue", "keys": ["ASSET", "STORYBOARD", "VIDEO"], "srcFile": "ProductTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProductTypeEnum.java", "outFile": "generation.ts"}, {"const": "AID_ASPECT_RATIO_ENUM", "aidType": "AspectRatioEnum", "fields": ["value", "desc"], "n": 13, "type": "AidAspectRatioEnumValue", "keys": ["RATIO_16_9", "RATIO_9_16", "RATIO_1_1", "RATIO_4_3", "RATIO_3_4", "RATIO_3_2", "RATIO_2_3", "RATIO_21_9", "RATIO_9_21", "RATIO_2_1", "RATIO_1_2", "RATIO_4_5", "RATIO_5_4"], "srcFile": "AspectRatioEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/AspectRatioEnum.java", "outFile": "generation.ts"}, {"const": "AID_DISPATCH_MODE", "aidType": "DispatchMode", "fields": [], "n": 3, "type": "AidDispatchModeValue", "keys": ["DIRECT", "CALLBACK_FIRST", "POLL_ONLY"], "srcFile": "DispatchMode.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/DispatchMode.java", "outFile": "generation.ts"}, {"const": "AID_MEDIA_TASK_STATUS", "aidType": "MediaTaskStatus", "fields": [], "n": 8, "type": "AidMediaTaskStatusValue", "keys": ["PENDING", "QUEUED", "PROCESSING", "WAIT_CALLBACK", "WAIT_POLL", "SUCCEEDED", "FAILED", "CANCELLED"], "srcFile": "MediaTaskStatus.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaTaskStatus.java", "outFile": "generation.ts"}, {"const": "AID_STORYBOARD_SHOT_DENSITY_ENUM", "aidType": "StoryboardShotDensityEnum", "fields": ["value", "desc"], "n": 3, "type": "AidStoryboardShotDensityEnumValue", "keys": ["LITE", "STANDARD", "DETAILED"], "srcFile": "StoryboardShotDensityEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/StoryboardShotDensityEnum.java", "outFile": "storyboard.ts"}, {"const": "AID_VIDEO_PROMPT_CONTINUITY_MODE", "aidType": "VideoPromptContinuityMode", "fields": ["value"], "n": 2, "type": "AidVideoPromptContinuityModeValue", "keys": ["NONE", "PREVIOUS_PROMPT"], "srcFile": "VideoPromptContinuityMode.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/rps/enums/VideoPromptContinuityMode.java", "outFile": "storyboard.ts"}, {"const": "AID_PROMPT_TYPE_ENUM", "aidType": "PromptTypeEnum", "fields": ["value", "desc"], "n": 3, "type": "AidPromptTypeEnumValue", "keys": ["STYLE", "CAMERA", "SUBJECT"], "srcFile": "PromptTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/PromptTypeEnum.java", "outFile": "storyboard.ts"}, {"const": "AID_SUBTITLE_RECOGNITION_STATUS", "aidType": "SubtitleRecognitionStatus", "fields": [], "n": 4, "type": "AidSubtitleRecognitionStatusValue", "keys": ["PROCESSING", "COMPLETED", "TEXT_FALLBACK", "FAILED"], "srcFile": "SubtitleRecognitionStatus.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/compose/enums/SubtitleRecognitionStatus.java", "outFile": "storyboard.ts"}, {"const": "AID_PROJECT_GEN_CONFIG_SCENE", "aidType": "ProjectGenConfigScene", "fields": ["sceneCode", "modelType", "needResolution", "needAspectRatio", "capabilityScene"], "n": 16, "type": "AidProjectGenConfigSceneValue", "keys": ["CHARACTER_EXTRACT", "SCENE_EXTRACT", "PROP_EXTRACT", "CHARACTER_FORM", "SCENE_FORM", "PROP_FORM", "CHARACTER_IMAGE", "SCENE_IMAGE", "PROP_IMAGE", "CHARACTER_CARD_IMAGE", "STORYBOARD_SCRIPT", "STORYBOARD_STYLIST", "STORYBOARD_VIDEO_PROMPT", "STORYBOARD_VIDEO_PROMPT_IMAGE", "STORYBOARD_VIDEO_PROMPT_GRID", "STORYBOARD_IMAGE"], "srcFile": "ProjectGenConfigScene.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/projectgenconfig/enums/ProjectGenConfigScene.java", "outFile": "storyboard.ts"}, {"const": "AID_STYLE_CATEGORY_ENUM", "aidType": "StyleCategoryEnum", "fields": ["code", "label", "sortOrder"], "n": 10, "type": "AidStyleCategoryEnumValue", "keys": ["COMIC_DRAMA", "LIVE_ACTION", "THREE_D", "CHINESE", "TWO_D", "CHIBI", "GAME", "JAPANESE", "WESTERN", "KOREAN"], "srcFile": "StyleCategoryEnum.java", "srcPath": "aid-interface/aid-interface-system/src/main/java/com/aid/aid/enums/StyleCategoryEnum.java", "outFile": "storyboard.ts"}, {"const": "AID_VIDEO_STYLE_TYPE_ENUM", "aidType": "VideoStyleTypeEnum", "fields": ["value", "desc"], "n": 3, "type": "AidVideoStyleTypeEnumValue", "keys": ["CUSTOM", "AI_GEN", "OFFICIAL"], "srcFile": "VideoStyleTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/VideoStyleTypeEnum.java", "outFile": "storyboard.ts"}, {"const": "AID_ASSET_TYPE_ENUM", "aidType": "AssetTypeEnum", "fields": ["value", "desc"], "n": 8, "type": "AidAssetTypeEnumValue", "keys": ["STYLE", "SCENE", "CHARACTER", "PROP", "FILE", "POSE", "EFFECT", "EXPRESSION"], "srcFile": "AssetTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetTypeEnum.java", "outFile": "asset.ts"}, {"const": "AID_ASSET_SOURCE_TYPE_ENUM", "aidType": "AssetSourceTypeEnum", "fields": ["value", "desc"], "n": 3, "type": "AidAssetSourceTypeEnumValue", "keys": ["MANUAL", "SINGLE_EXTRACT", "GLOBAL_EXTRACT"], "srcFile": "AssetSourceTypeEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetSourceTypeEnum.java", "outFile": "asset.ts"}, {"const": "AID_ASSET_CENTER_CATEGORY_ENUM", "aidType": "AssetCenterCategoryEnum", "fields": ["code", "name"], "n": 15, "type": "AidAssetCenterCategoryEnumValue", "keys": ["SCRIPT", "ROLE", "SCENE", "PROP", "ROLE_SETTING", "SCENE_SETTING", "PROP_SETTING", "ROLE_IMAGE", "SCENE_IMAGE", "PROP_IMAGE", "STORYBOARD_SCRIPT", "STORYBOARD_IMAGE", "STORYBOARD_VIDEO", "DUBBING", "PREVIEW_VIDEO"], "srcFile": "AssetCenterCategoryEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetCenterCategoryEnum.java", "outFile": "asset.ts"}, {"const": "AID_AUDIO_SOURCE_ENUM", "aidType": "AudioSourceEnum", "fields": ["value", "desc"], "n": 2, "type": "AidAudioSourceEnumValue", "keys": ["AI_TTS", "USER_UPLOAD"], "srcFile": "AudioSourceEnum.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/enums/AudioSourceEnum.java", "outFile": "asset.ts"}, {"const": "AID_BILLING_MODE", "aidType": "BillingMode", "fields": ["code", "desc"], "n": 2, "type": "AidBillingModeValue", "keys": ["FIXED", "SKU"], "srcFile": "BillingMode.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/BillingMode.java", "outFile": "billing.ts"}, {"const": "AID_CHARGE_TYPE", "aidType": "ChargeType", "fields": ["code", "desc"], "n": 3, "type": "AidChargeTypeValue", "keys": ["TEXT", "IMAGE", "VIDEO"], "srcFile": "ChargeType.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/ChargeType.java", "outFile": "billing.ts"}, {"const": "AID_METER_TYPE", "aidType": "MeterType", "fields": [], "n": 5, "type": "AidMeterTypeValue", "keys": ["TOKEN", "PER_IMAGE", "PER_SECOND", "SKU_PACKAGE", "PER_CHAR"], "srcFile": "MeterType.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/MeterType.java", "outFile": "billing.ts"}, {"const": "AID_SETTLE_MODE", "aidType": "SettleMode", "fields": ["code", "desc"], "n": 2, "type": "AidSettleModeValue", "keys": ["DIRECT_SETTLE", "REFUND_ONLY"], "srcFile": "SettleMode.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/SettleMode.java", "outFile": "billing.ts"}, {"const": "AID_TEXT_SETTLE_STATUS", "aidType": "TextSettleStatus", "fields": [], "n": 4, "type": null, "keys": ["INIT", "PROCESSING", "DONE", "PARTIAL_DONE"], "srcFile": "TextSettleStatus.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/TextSettleStatus.java", "outFile": "billing.ts"}, {"const": "AID_MEDIA_BILLING_STATUS", "aidType": "MediaBillingStatus", "fields": [], "n": 6, "type": "AidMediaBillingStatusValue", "keys": ["INIT", "FROZEN", "SETTLING", "REFUNDING", "SUCCESS", "FAILED"], "srcFile": "MediaBillingStatus.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaBillingStatus.java", "outFile": "billing.ts"}, {"const": "AID_EXTRACT_BILLING_STATUS", "aidType": "ExtractBillingStatus", "fields": [], "n": 7, "type": "AidExtractBillingStatusValue", "keys": ["INIT", "FROZEN", "SETTLING", "REFUNDING", "SUCCESS", "PARTIAL_SUCCESS", "FAILED"], "srcFile": "ExtractBillingStatus.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/rps/enums/ExtractBillingStatus.java", "outFile": "billing.ts"}, {"const": "AID_BILLING_CONSTANTS", "aidType": "BillingConstants", "fields": [], "n": 17, "type": null, "keys": ["ACCOUNT_AMOUNT_SCALE", "MODE_FIXED", "MODE_SKU", "MATCH_STRATEGY_FIRST_HIT", "MODEL_PRICE_MULTIPLIER_CATEGORY", "MODEL_PRICE_MULTIPLIER_KEY", "MODEL_PRICE_MULTIPLIER_CACHE_TTL_MS", "DEFAULT_MODEL_PRICE_MULTIPLIER", "DEFAULT_CHAR_TO_TOKEN_RATIO", "CHAR_TO_TOKEN_NUMERATOR", "CHAR_TO_TOKEN_DENOMINATOR", "DEFAULT_ESTIMATED_OUTPUT_CHARS", "GPT_IMAGE2_INPUT_TOKENS_PER_REF_IMAGE", "SETTLE_DIRECT", "SETTLE_REFUND_ONLY", "USAGE_PROVIDER", "USAGE_ESTIMATE"], "srcFile": "BillingConstants.java", "srcPath": "aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/BillingConstants.java", "outFile": "billing.ts"}]) {
    assert.ok(idxSrc.includes(m.const), `index.ts 漏匯出 ${m.const}`);
  }
  assert.equal(/export default/g.test(idxSrc), false, "index.ts 出現 default export");
});
