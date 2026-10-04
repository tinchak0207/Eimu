/**
 * AID 生成能力 enums（生成模式／抽卡类型／模型与媒体分类／画面比例／任务驱动）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；本次共抓取 AID 目录树列出的全部 51 个 enum 档，0 失败；本档收录其中 11 个）
 * 来源档（11 个，路径相对 repo 根）：
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenModeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenerateModeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/GenResultTargetEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ModelTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/MediaTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaType.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProductTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/AspectRatioEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/DispatchMode.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaTaskStatus.java
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

/** 生成模式枚举 对应数据库字段：default_gen_mode（AID `GenModeEnum`） */
export const AID_GEN_MODE_ENUM = {
  /** 经济模式 */
  ECONOMY: { value: "economy", desc: "经济模式" },
  /** 性能模式 */
  PERFORMANCE: { value: "performance", desc: "性能模式" },
} as const;

/** `GenModeEnum` 的值集合（由常数物件推导）。 */
export type AidGenModeEnumValue = (typeof AID_GEN_MODE_ENUM)[keyof typeof AID_GEN_MODE_ENUM]["value"];

/** AI模型生成模式枚举。（AID `GenerateModeEnum`） */
export const AID_GENERATE_MODE_ENUM = {
  /** 纯文本大模型（对应 model_type=text） */
  TEXT: { value: "text", desc: "文本大模型" },
  /** 文生图（对应 model_type=image） */
  TEXT_TO_IMAGE: { value: "text_to_image", desc: "文生图" },
  /** 图生图（对应 model_type=image） */
  IMAGE_TO_IMAGE: { value: "image_to_image", desc: "图生图" },
  /** 图片编辑（对应 model_type=image） */
  IMAGE_EDIT: { value: "image_edit", desc: "图片编辑" },
  /** 图片高清 / 超分辨率（对应 model_type=image） */
  IMAGE_UPSCALE: { value: "image_upscale", desc: "图片高清" },
  /** 文生视频（对应 model_type=video） */
  TEXT_TO_VIDEO: { value: "text_to_video", desc: "文生视频" },
  /** 图生视频（对应 model_type=video；含首尾帧） */
  IMAGE_TO_VIDEO: { value: "image_to_video", desc: "图生视频" },
  /** 视频生视频（对应 model_type=video；多图视频 / 视频续写） */
  VIDEO_TO_VIDEO: { value: "video_to_video", desc: "视频生视频" },
  /** 纯音频（对应 model_type=audio） */
  AUDIO: { value: "audio", desc: "音频" },
} as const;

/** `GenerateModeEnum` 的值集合（由常数物件推导）。 */
export type AidGenerateModeEnumValue = (typeof AID_GENERATE_MODE_ENUM)[keyof typeof AID_GENERATE_MODE_ENUM]["value"];

/** 生成抽卡记录类型枚举 对应数据库字段：gen_type（AID `GenTypeEnum`） */
export const AID_GEN_TYPE_ENUM = {
  /** 单图 */
  IMAGE: { value: "image", desc: "单图" },
  /** 九宫格 */
  GRID: { value: "grid", desc: "九宫格" },
  /** 图生视频 */
  I2V: { value: "i2v", desc: "图生视频" },
  /** 多参视频 */
  MULTI: { value: "multi", desc: "多参视频" },
  /** 首尾视频 */
  EDGE: { value: "edge", desc: "首尾视频" },
  /** 用户上传视频（区别于 AI 生成视频，归入视频大类，可被设为分镜主视频） */
  UPLOAD_VIDEO: { value: "upload_video", desc: "上传视频" },
  /** 配音合成视频（配音贴回分镜视频 / 成片合成产物，归入视频大类，可被设为分镜主视频） */
  COMPOSE: { value: "compose", desc: "配音合成视频" },
} as const;

/** `GenTypeEnum` 的值集合（由常数物件推导）。 */
export type AidGenTypeEnumValue = (typeof AID_GEN_TYPE_ENUM)[keyof typeof AID_GEN_TYPE_ENUM]["value"];

/** 生成结果存储目标枚举 用于区分回调结果写入哪张表（AID `GenResultTargetEnum`） */
export const AID_GEN_RESULT_TARGET_ENUM = {
  /** 资产表 aid_comic_asset */
  ASSET: { value: "asset", desc: "资产表" },
  /** 抽卡记录表 aid_gen_record */
  GEN_RECORD: { value: "gen_record", desc: "抽卡记录表" },
} as const;

/** `GenResultTargetEnum` 的值集合（由常数物件推导）。 */
export type AidGenResultTargetEnumValue = (typeof AID_GEN_RESULT_TARGET_ENUM)[keyof typeof AID_GEN_RESULT_TARGET_ENUM]["value"];

/** AI模型分类枚举 对应数据库字段：model_type（AID `ModelTypeEnum`） */
export const AID_MODEL_TYPE_ENUM = {
  /** 生图 */
  IMAGE: { value: "image", desc: "生图" },
  /** 生视频 */
  VIDEO: { value: "video", desc: "生视频" },
  /** 配音 */
  AUDIO: { value: "audio", desc: "配音" },
} as const;

/** `ModelTypeEnum` 的值集合（由常数物件推导）。 */
export type AidModelTypeEnumValue = (typeof AID_MODEL_TYPE_ENUM)[keyof typeof AID_MODEL_TYPE_ENUM]["value"];

/** 媒体文件类型枚举 用于区分生成产物是图片还是视频（AID `MediaTypeEnum`） */
export const AID_MEDIA_TYPE_ENUM = {
  /** 图片 */
  IMAGE: { value: "image", desc: "图片" },
  /** 视频 */
  VIDEO: { value: "video", desc: "视频" },
} as const;

/** `MediaTypeEnum` 的值集合（由常数物件推导）。 */
export type AidMediaTypeEnumValue = (typeof AID_MEDIA_TYPE_ENUM)[keyof typeof AID_MEDIA_TYPE_ENUM]["value"];

export const AID_MEDIA_TYPE = {
  /** 图片任务。 */
  IMAGE: { value: "IMAGE" },
  /** 视频任务。 */
  VIDEO: { value: "VIDEO" },
  /** 文本生成任务（Chat Completions 等）。 */
  TEXT: { value: "TEXT" },
  /** 音频 / 语音合成任务（TTS）。 */
  AUDIO: { value: "AUDIO" },
} as const;

/** `MediaType` 的值集合（由常数物件推导）。 */
export type AidMediaTypeValue = (typeof AID_MEDIA_TYPE)[keyof typeof AID_MEDIA_TYPE]["value"];

/** 产物类型枚举 用于区分生成的产物属于哪种业务类型（AID `ProductTypeEnum`） */
export const AID_PRODUCT_TYPE_ENUM = {
  /** 资产（角色/场景/道具等） */
  ASSET: { value: "asset", desc: "资产" },
  /** 分镜内容 */
  STORYBOARD: { value: "storyboard", desc: "分镜" },
  /** 视频 */
  VIDEO: { value: "video", desc: "视频" },
} as const;

/** `ProductTypeEnum` 的值集合（由常数物件推导）。 */
export type AidProductTypeEnumValue = (typeof AID_PRODUCT_TYPE_ENUM)[keyof typeof AID_PRODUCT_TYPE_ENUM]["value"];

/** 画面比例枚举 对应数据库字段：aspect_ratio（AID `AspectRatioEnum`） */
export const AID_ASPECT_RATIO_ENUM = {
  /** 16:9 横屏 */
  RATIO_16_9: { value: "16:9", desc: "横屏" },
  /** 9:16 竖屏 */
  RATIO_9_16: { value: "9:16", desc: "竖屏" },
  /** 1:1 方形 */
  RATIO_1_1: { value: "1:1", desc: "方形" },
  /** 4:3 传统屏 */
  RATIO_4_3: { value: "4:3", desc: "传统屏" },
  /** 3:4 竖版传统 */
  RATIO_3_4: { value: "3:4", desc: "竖版传统" },
  /** 3:2 经典横屏 */
  RATIO_3_2: { value: "3:2", desc: "经典横屏" },
  /** 2:3 经典竖屏 */
  RATIO_2_3: { value: "2:3", desc: "经典竖屏" },
  /** 21:9 超宽屏 */
  RATIO_21_9: { value: "21:9", desc: "超宽屏" },
  /** 9:21 超长竖屏 */
  RATIO_9_21: { value: "9:21", desc: "超长竖屏" },
  /** 2:1 宽银幕 */
  RATIO_2_1: { value: "2:1", desc: "宽银幕" },
  /** 1:2 长竖屏 */
  RATIO_1_2: { value: "1:2", desc: "长竖屏" },
  /** 4:5 社交媒体竖版 */
  RATIO_4_5: { value: "4:5", desc: "社交媒体竖版" },
  /** 5:4 社交媒体横版 */
  RATIO_5_4: { value: "5:4", desc: "社交媒体横版" },
} as const;

/** `AspectRatioEnum` 的值集合（由常数物件推导）。 */
export type AidAspectRatioEnumValue = (typeof AID_ASPECT_RATIO_ENUM)[keyof typeof AID_ASPECT_RATIO_ENUM]["value"];

/** 任务调度模式：决定任务提交后由哪种机制驱动到终态。（AID `DispatchMode`） */
export const AID_DISPATCH_MODE = {
  /** 同步直返：流式文本、同步图片，不走调度中心 */
  DIRECT: { value: "DIRECT" },
  /** 回调优先：先等上游回调通知，超时后转轮询兜底 */
  CALLBACK_FIRST: { value: "CALLBACK_FIRST" },
  /** 纯轮询：不支持回调的供应商，完全由调度中心驱动 */
  POLL_ONLY: { value: "POLL_ONLY" },
} as const;

/** `DispatchMode` 的值集合（由常数物件推导）。 */
export type AidDispatchModeValue = (typeof AID_DISPATCH_MODE)[keyof typeof AID_DISPATCH_MODE]["value"];

export const AID_MEDIA_TASK_STATUS = {
  /** 任务已创建，尚未进入供应商处理。 */
  PENDING: { value: "PENDING" },
  /** 任务排队等待中：并发数已满，等待前面的任务完成后自动提交。 */
  QUEUED: { value: "QUEUED" },
  /** 任务已提交到供应商，等待轮询完成（旧状态，兼容已有任务）。 */
  PROCESSING: { value: "PROCESSING" },
  /** 等待回调通知（回调优先模式）。 */
  WAIT_CALLBACK: { value: "WAIT_CALLBACK" },
  /** 等待调度中心轮询（纯轮询或回调超时后）。 */
  WAIT_POLL: { value: "WAIT_POLL" },
  /** 任务处理成功。 */
  SUCCEEDED: { value: "SUCCEEDED" },
  /** 任务处理失败。 */
  FAILED: { value: "FAILED" },
  CANCELLED: { value: "CANCELLED" },
} as const;

/** `MediaTaskStatus` 的值集合（由常数物件推导）。 */
export type AidMediaTaskStatusValue = (typeof AID_MEDIA_TASK_STATUS)[keyof typeof AID_MEDIA_TASK_STATUS]["value"];
