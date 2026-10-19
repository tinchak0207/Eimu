/**
 * AID 创作流水线 enums（专案／剧集／剧本／创作步骤）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；本次共抓取 AID 目录树列出的全部 51 个 enum 档，0 失败；本档收录其中 7 个）
 * 来源档（7 个，路径相对 repo 根）：
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationStepEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/CreationModeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProjectTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ProjectStatusEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/EpisodeStatusEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ScriptTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/ScriptStatusEnum.java
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

/** 创作流水线步骤枚举。（AID `CreationStepEnum`） */
export const AID_CREATION_STEP_ENUM = {
  /** 剧集模式下项目主表固定值 */
  SERIES_DEFAULT: { value: -1, desc: "剧集默认" },
  /** 项目配置 */
  GLOBAL_SETTING: { value: 1, desc: "项目配置" },
  /** 剧本创作 */
  SCRIPT: { value: 2, desc: "剧本创作" },
  /** 素材准备 */
  ASSET: { value: 3, desc: "素材准备" },
  /** 分镜设计 */
  STORYBOARD: { value: 4, desc: "分镜设计" },
  /** 视频生成 */
  VIDEO: { value: 5, desc: "视频生成" },
  /** 音画同步 */
  AUDIO: { value: 6, desc: "音画同步" },
  /** 成品预览 */
  PREVIEW: { value: 7, desc: "成品预览" },
} as const;

/** `CreationStepEnum` 的值集合（由常数物件推导）。 */
export type AidCreationStepEnumValue = (typeof AID_CREATION_STEP_ENUM)[keyof typeof AID_CREATION_STEP_ENUM]["value"];

/** 创作模式枚举 对应数据库字段：creation_mode（AID `CreationModeEnum`） */
export const AID_CREATION_MODE_ENUM = {
  /** 图生视频 */
  I2V: { value: "i2v", desc: "图生视频" },
  /** 多参生视频 */
  MULTI: { value: "multi", desc: "多参生视频" },
  /** 专业版 */
  PRO: { value: "pro", desc: "专业版" },
  /** 自动宫格模式 */
  AUTO_GRID: { value: "auto_grid", desc: "自动宫格模式" },
} as const;

/** `CreationModeEnum` 的值集合（由常数物件推导）。 */
export type AidCreationModeEnumValue = (typeof AID_CREATION_MODE_ENUM)[keyof typeof AID_CREATION_MODE_ENUM]["value"];

/** 项目类型枚举 对应数据库字段：project_type（AID `ProjectTypeEnum`） */
export const AID_PROJECT_TYPE_ENUM = {
  /** 剧集 */
  SERIES: { value: "series", desc: "剧集" },
  /** 电影 */
  MOVIE: { value: "movie", desc: "电影" },
} as const;

/** `ProjectTypeEnum` 的值集合（由常数物件推导）。 */
export type AidProjectTypeEnumValue = (typeof AID_PROJECT_TYPE_ENUM)[keyof typeof AID_PROJECT_TYPE_ENUM]["value"];

/** 项目状态枚举 对应数据库字段：status（AID `ProjectStatusEnum`） */
export const AID_PROJECT_STATUS_ENUM = {
  /** 草稿 */
  DRAFT: { value: 0, desc: "草稿" },
  /** 制作中 */
  PROCESSING: { value: 1, desc: "制作中" },
  /** 完成未提交 */
  FINISHED_UNSUBMITTED: { value: 2, desc: "完成未提交" },
  /** 审核中 */
  AUDITING: { value: 3, desc: "审核中" },
  /** 审核通过 */
  AUDIT_PASSED: { value: 4, desc: "审核通过" },
  /** 审核失败 */
  AUDIT_FAILED: { value: 5, desc: "审核失败" },
} as const;

/** `ProjectStatusEnum` 的值集合（由常数物件推导）。 */
export type AidProjectStatusEnumValue = (typeof AID_PROJECT_STATUS_ENUM)[keyof typeof AID_PROJECT_STATUS_ENUM]["value"];

/** 剧集状态枚举 对应数据库字段：status（AID `EpisodeStatusEnum`） */
export const AID_EPISODE_STATUS_ENUM = {
  /** 草稿 */
  DRAFT: { value: 0, desc: "草稿" },
  /** 制作中 */
  PROCESSING: { value: 1, desc: "制作中" },
  /** 完成未审核 */
  FINISHED_UNAUDITED: { value: 2, desc: "完成未审核" },
  /** 审核中 */
  AUDITING: { value: 3, desc: "审核中" },
  /** 审核通过 */
  AUDIT_PASSED: { value: 4, desc: "审核通过" },
  /** 审核失败 */
  AUDIT_FAILED: { value: 5, desc: "审核失败" },
} as const;

/** `EpisodeStatusEnum` 的值集合（由常数物件推导）。 */
export type AidEpisodeStatusEnumValue = (typeof AID_EPISODE_STATUS_ENUM)[keyof typeof AID_EPISODE_STATUS_ENUM]["value"];

/** 剧本类型枚举 对应数据库字段：script_type（AID `ScriptTypeEnum`） */
export const AID_SCRIPT_TYPE_ENUM = {
  /** 剧情演绎 */
  PLOT: { value: "plot", desc: "剧情演绎" },
  /** 真人解说漫 */
  MONOLOGUE: { value: "monologue", desc: "真人解说漫" },
} as const;

/** `ScriptTypeEnum` 的值集合（由常数物件推导）。 */
export type AidScriptTypeEnumValue = (typeof AID_SCRIPT_TYPE_ENUM)[keyof typeof AID_SCRIPT_TYPE_ENUM]["value"];

/** 剧本状态枚举 对应数据库字段：status（AID `ScriptStatusEnum`） */
export const AID_SCRIPT_STATUS_ENUM = {
  /** 草稿 */
  DRAFT: { value: 0, desc: "草稿" },
  /** 使用 */
  IN_USE: { value: 1, desc: "使用" },
  /** 历史版本 */
  HISTORY: { value: 2, desc: "历史版本" },
} as const;

/** `ScriptStatusEnum` 的值集合（由常数物件推导）。 */
export type AidScriptStatusEnumValue = (typeof AID_SCRIPT_STATUS_ENUM)[keyof typeof AID_SCRIPT_STATUS_ENUM]["value"];
