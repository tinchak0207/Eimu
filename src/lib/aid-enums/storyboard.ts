/**
 * AID 分镜 / 提示词 / 风格 enums。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；本次共抓取 AID 目录树列出的全部 51 个 enum 档，0 失败；本档收录其中 7 个）
 * 来源档（7 个，路径相对 repo 根）：
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/StoryboardShotDensityEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/rps/enums/VideoPromptContinuityMode.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/PromptTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/compose/enums/SubtitleRecognitionStatus.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/projectgenconfig/enums/ProjectGenConfigScene.java
 *   - aid-interface/aid-interface-system/src/main/java/com/aid/aid/enums/StyleCategoryEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/VideoStyleTypeEnum.java
 * 逐字保留：每个 enum 的成员名（→ TS 物件键）、成员栏位值（value/desc/code/label/sortOrder 等
 *   一律按 AID 栏位名原样输出）、以及成员上方的 Javadoc 或 `//` 注解原文。中文 desc **一字未改、
 *   未翻译、未做简繁转换、未「优化」**。键序＝AID 宣告序。
 * 白名单改写（仅此三处，其余逐行等价）：
 *   1. Java `enum` → TS `as const` 常数物件（＋由常数物件推导的值集合型别 `Aid<X>Value`）。
 *   2. 命名空间加前缀 `AID_`（`CreationModeEnum` → `AID_CREATION_MODE_ENUM`），避免与本站常数撞名。
 *   3. 无栏位的纯名称 enum（如 `MediaTaskStatus`）在 TS 以 `{ value: "<成员名>" }` 表示，
 *      以维持与其他 enum 一致的取值面（Java 侧其值即 `name()`）。
 * 不搬入（如实声明，非静默省略）：
 *   - AID 的 static 查表／工具方法（`getByValue` / `of` / `fromCode` / `isCrossGroupSwitch` 等）
 *     与 `isValid*`——本站此目录只放纯资料常数，无逻辑；查表由消费端自建或后续另案。
 *   - `BillingConstants` 的查表方法与 private 比例集合（逻辑，本站另有估算器）；
 *     其 public static final 纯量常数逐字保留。
 *
 * 本档为纯资料常数，无函式、无副作用。
 *
 * 收录取舍（全 51 档的处置表）见同目录 `index.ts` 档头。
 */

/** 分镜脚本生成 - 镜头密度档位枚举。（AID `StoryboardShotDensityEnum`） */
export const AID_STORYBOARD_SHOT_DENSITY_ENUM = {
  /** 精简模式：密度低、节奏紧凑（约为标准档位的 60%~70%） */
  LITE: { value: "精简模式", desc: "节奏紧凑、信息密度高" },
  /** 标准模式：默认档位、基准拆分粒度 */
  STANDARD: { value: "标准模式", desc: "默认拆分粒度" },
  /** 细拆模式：密度高、重点戏份 / 情绪高潮（约为标准档位的 130%~150%） */
  DETAILED: { value: "细拆模式", desc: "重点戏份、情绪高潮、慢节奏" },
} as const;

/** `StoryboardShotDensityEnum` 的值集合（由常数物件推导）。 */
export type AidStoryboardShotDensityEnumValue = (typeof AID_STORYBOARD_SHOT_DENSITY_ENUM)[keyof typeof AID_STORYBOARD_SHOT_DENSITY_ENUM]["value"];

/** 分镜视频提示词连续性模式。（AID `VideoPromptContinuityMode`） */
export const AID_VIDEO_PROMPT_CONTINUITY_MODE = {
  NONE: { value: "none" },
  PREVIOUS_PROMPT: { value: "previous_prompt" },
} as const;

/** `VideoPromptContinuityMode` 的值集合（由常数物件推导）。 */
export type AidVideoPromptContinuityModeValue = (typeof AID_VIDEO_PROMPT_CONTINUITY_MODE)[keyof typeof AID_VIDEO_PROMPT_CONTINUITY_MODE]["value"];

/** 提示词分类枚举 对应数据库字段：prompt_type（AID `PromptTypeEnum`） */
export const AID_PROMPT_TYPE_ENUM = {
  /** 视频风格 */
  STYLE: { value: "style", desc: "视频风格" },
  /** 镜头语言 */
  CAMERA: { value: "camera", desc: "镜头语言" },
  /** 主体描述 */
  SUBJECT: { value: "subject", desc: "主体描述" },
} as const;

/** `PromptTypeEnum` 的值集合（由常数物件推导）。 */
export type AidPromptTypeEnumValue = (typeof AID_PROMPT_TYPE_ENUM)[keyof typeof AID_PROMPT_TYPE_ENUM]["value"];

/** 分镜字幕识别检查点状态。（AID `SubtitleRecognitionStatus`） */
export const AID_SUBTITLE_RECOGNITION_STATUS = {
  /** 当前分镜正在同步识别。 */
  PROCESSING: { value: "PROCESSING" },
  /** 当前识别来源的精确字幕已完整写入。 */
  COMPLETED: { value: "COMPLETED" },
  /** 当前音源未识别到可用人声，已稳定回落为文本时长排布。 */
  TEXT_FALLBACK: { value: "TEXT_FALLBACK" },
  /** 当前分镜识别失败，下次导出需要重试。 */
  FAILED: { value: "FAILED" },
} as const;

/** `SubtitleRecognitionStatus` 的值集合（由常数物件推导）。 */
export type AidSubtitleRecognitionStatusValue = (typeof AID_SUBTITLE_RECOGNITION_STATUS)[keyof typeof AID_SUBTITLE_RECOGNITION_STATUS]["value"];

/** 项目级生成配置场景枚举。（AID `ProjectGenConfigScene`） */
export const AID_PROJECT_GEN_CONFIG_SCENE = {
  /** 角色提取 */
  CHARACTER_EXTRACT: { sceneCode: "main_character_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 场景提取 */
  SCENE_EXTRACT: { sceneCode: "main_scene_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 道具提取 */
  PROP_EXTRACT: { sceneCode: "main_prop_extract", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 角色形态提取 */
  CHARACTER_FORM: { sceneCode: "main_character_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 场景形态提取 */
  SCENE_FORM: { sceneCode: "main_scene_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 道具形态提取 */
  PROP_FORM: { sceneCode: "main_prop_form", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 生成角色图 */
  CHARACTER_IMAGE: { sceneCode: "main_character_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage" },
  /** 生成场景图 */
  SCENE_IMAGE: { sceneCode: "main_scene_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage" },
  /** 生成道具图 */
  PROP_IMAGE: { sceneCode: "main_prop_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "textToImage" },
  /** 角色设定卡 */
  CHARACTER_CARD_IMAGE: { sceneCode: "main_character_card_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "imageToImage" },
  /** 分镜脚本提取 */
  STORYBOARD_SCRIPT: { sceneCode: "main_storyboard_script", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 分镜图提示词（分镜画师，image-prompt） */
  STORYBOARD_STYLIST: { sceneCode: "main_storyboard_stylist", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 视频提示词-多参数版（视觉导演，video-prompt） */
  STORYBOARD_VIDEO_PROMPT: { sceneCode: "main_storyboard_video_prompt", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 视频提示词-图生视频（视觉导演图生方向，video-prompt-image） */
  STORYBOARD_VIDEO_PROMPT_IMAGE: { sceneCode: "main_storyboard_video_prompt_image", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 视频提示词-宫格版（视觉导演宫格方向，auto_grid 创作模式专用） */
  STORYBOARD_VIDEO_PROMPT_GRID: { sceneCode: "main_storyboard_video_prompt_grid", modelType: "text", needResolution: false, needAspectRatio: false, capabilityScene: null },
  /** 分镜生图 */
  STORYBOARD_IMAGE: { sceneCode: "main_storyboard_image", modelType: "image", needResolution: true, needAspectRatio: true, capabilityScene: "imageToImage" },
} as const;

/** `ProjectGenConfigScene` 的值集合（由常数物件推导）。 */
export type AidProjectGenConfigSceneValue = (typeof AID_PROJECT_GEN_CONFIG_SCENE)[keyof typeof AID_PROJECT_GEN_CONFIG_SCENE]["sceneCode"];

/** 官方风格分类字典。（AID `StyleCategoryEnum`） */
export const AID_STYLE_CATEGORY_ENUM = {
  COMIC_DRAMA: { code: "comic_drama", label: "漫剧", sortOrder: 10 },
  LIVE_ACTION: { code: "live_action", label: "真人剧", sortOrder: 20 },
  THREE_D: { code: "three_d", label: "3D", sortOrder: 30 },
  CHINESE: { code: "chinese", label: "国风", sortOrder: 40 },
  TWO_D: { code: "two_d", label: "2D", sortOrder: 50 },
  CHIBI: { code: "chibi", label: "Q版", sortOrder: 60 },
  GAME: { code: "game", label: "游戏", sortOrder: 70 },
  JAPANESE: { code: "japanese", label: "日漫", sortOrder: 80 },
  WESTERN: { code: "western", label: "欧美", sortOrder: 90 },
  KOREAN: { code: "korean", label: "韩流", sortOrder: 100 },
} as const;

/** `StyleCategoryEnum` 的值集合（由常数物件推导）。 */
export type AidStyleCategoryEnumValue = (typeof AID_STYLE_CATEGORY_ENUM)[keyof typeof AID_STYLE_CATEGORY_ENUM]["code"];

/** 视频风格来源枚举 对应数据库字段：video_style_type（AID `VideoStyleTypeEnum`） */
export const AID_VIDEO_STYLE_TYPE_ENUM = {
  /** 自定义 */
  CUSTOM: { value: "custom", desc: "自定义" },
  /** AI生成 */
  AI_GEN: { value: "ai_gen", desc: "AI生成" },
  /** 官方预设 */
  OFFICIAL: { value: "official", desc: "官方预设" },
} as const;

/** `VideoStyleTypeEnum` 的值集合（由常数物件推导）。 */
export type AidVideoStyleTypeEnumValue = (typeof AID_VIDEO_STYLE_TYPE_ENUM)[keyof typeof AID_VIDEO_STYLE_TYPE_ENUM]["value"];
