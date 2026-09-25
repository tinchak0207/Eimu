/**
 * AID 資產中心 enums。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；本次共抓取 AID 目錄樹列出的全部 51 個 enum 檔，0 失敗；本檔收錄其中 4 個）
 * 來源檔（4 個，路徑相對 repo 根）：
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetSourceTypeEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/AssetCenterCategoryEnum.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/enums/AudioSourceEnum.java
 * 逐字保留：每個 enum 的成員名（→ TS 物件鍵）、成員欄位值（value/desc/code/label/sortOrder 等
 *   一律按 AID 欄位名原樣輸出）、以及成員上方的 Javadoc 或 `//` 註解原文。中文 desc **一字未改、
 *   未翻譯、未做簡繁轉換、未「優化」**。鍵序＝AID 宣告序。
 * 白名單改寫（僅此三處，其餘逐行等價）：
 *   1. Java `enum` → TS `as const` 常數物件（＋由常數物件推導的值集合型別 `Aid<X>Value`）。
 *   2. 命名空間加前綴 `AID_`（`CreationModeEnum` → `AID_CREATION_MODE_ENUM`），避免與本站常數撞名。
 *   3. 無欄位的純名稱 enum（如 `MediaTaskStatus`）在 TS 以 `{ value: "<成員名>" }` 表示，
 *      以維持與其他 enum 一致的取值面（Java 側其值即 `name()`）。
 * 不搬入（如實聲明，非靜默省略）：
 *   - AID 的 static 查表／工具方法（`getByValue` / `of` / `fromCode` / `isCrossGroupSwitch` 等）
 *     與 `isValid*`——本站此目錄只放純資料常數，無邏輯；查表由消費端自建或後續另案。
 *   - `BillingConstants` 的查表方法與 private 比例集合（邏輯，本站另有估算器）；
 *     其 public static final 純量常數逐字保留。
 *
 * 本檔為純資料常數，無函式、無副作用。
 *
 * 收錄取捨（全 51 檔的處置表）見同目錄 `index.ts` 檔頭。
 */

/** 资产类型枚举 对应数据库字段：asset_type（AID `AssetTypeEnum`） */
export const AID_ASSET_TYPE_ENUM = {
  /** 风格 */
  STYLE: { value: "style", desc: "风格" },
  /** 场景 */
  SCENE: { value: "scene", desc: "场景" },
  /** 角色 */
  CHARACTER: { value: "character", desc: "角色" },
  /** 道具 */
  PROP: { value: "prop", desc: "道具" },
  /** 文件 */
  FILE: { value: "file", desc: "文件" },
  /** 姿势 */
  POSE: { value: "pose", desc: "姿势" },
  /** 特效 */
  EFFECT: { value: "effect", desc: "特效" },
  /** 表情 */
  EXPRESSION: { value: "expression", desc: "表情" },
} as const;

/** `AssetTypeEnum` 的值集合（由常數物件推導）。 */
export type AidAssetTypeEnumValue = (typeof AID_ASSET_TYPE_ENUM)[keyof typeof AID_ASSET_TYPE_ENUM]["value"];

/** 资产来源枚举 对应数据库字段：source_type（AID `AssetSourceTypeEnum`） */
export const AID_ASSET_SOURCE_TYPE_ENUM = {
  /** 手动填写 */
  MANUAL: { value: 1, desc: "手动填写" },
  /** 单集提取 */
  SINGLE_EXTRACT: { value: 2, desc: "单集提取" },
  /** 全集全局提取 */
  GLOBAL_EXTRACT: { value: 3, desc: "全集全局提取" },
} as const;

/** `AssetSourceTypeEnum` 的值集合（由常數物件推導）。 */
export type AidAssetSourceTypeEnumValue = (typeof AID_ASSET_SOURCE_TYPE_ENUM)[keyof typeof AID_ASSET_SOURCE_TYPE_ENUM]["value"];

/** 资产中心统一分类编码枚举。 贯穿分类树、个人资产列表、资产明细三个接口，每个分类映射到对应业务表，按 userId 隔离查询。（AID `AssetCenterCategoryEnum`） */
export const AID_ASSET_CENTER_CATEGORY_ENUM = {
  /** 剧本 -> aid_comic_script */
  SCRIPT: { code: "script", name: "剧本" },
  /** 角色 -> aid_role_prop_scene(assetType=character) */
  ROLE: { code: "role", name: "角色" },
  /** 场景 -> aid_role_prop_scene(assetType=scene) */
  SCENE: { code: "scene", name: "场景" },
  /** 道具 -> aid_role_prop_scene(assetType=prop) */
  PROP: { code: "prop", name: "道具" },
  /** 角色设定 -> aid_role_prop_scene_form(主资产=character) */
  ROLE_SETTING: { code: "role_setting", name: "角色设定" },
  /** 场景设定 -> aid_role_prop_scene_form(主资产=scene) */
  SCENE_SETTING: { code: "scene_setting", name: "场景设定" },
  /** 道具设定 -> aid_role_prop_scene_form(主资产=prop) */
  PROP_SETTING: { code: "prop_setting", name: "道具设定" },
  /** 角色图 -> aid_role_prop_scene_form_image(主资产=character) */
  ROLE_IMAGE: { code: "role_image", name: "角色图" },
  /** 场景图 -> aid_role_prop_scene_form_image(主资产=scene) */
  SCENE_IMAGE: { code: "scene_image", name: "场景图" },
  /** 道具图 -> aid_role_prop_scene_form_image(主资产=prop) */
  PROP_IMAGE: { code: "prop_image", name: "道具图" },
  /** 分镜脚本 -> aid_storyboard */
  STORYBOARD_SCRIPT: { code: "storyboard_script", name: "分镜脚本" },
  /** 分镜脚本图 -> aid_gen_record(genType in image,grid) */
  STORYBOARD_IMAGE: { code: "storyboard_image", name: "分镜脚本图" },
  /** 分镜视频 -> aid_gen_record(genType in i2v,multi,edge) */
  STORYBOARD_VIDEO: { code: "storyboard_video", name: "分镜视频" },
  /** 配音 -> aid_audio_record */
  DUBBING: { code: "dubbing", name: "配音" },
  /** 预览视频 -> aid_episode_editor */
  PREVIEW_VIDEO: { code: "preview_video", name: "预览视频" },
} as const;

/** `AssetCenterCategoryEnum` 的值集合（由常數物件推導）。 */
export type AidAssetCenterCategoryEnumValue = (typeof AID_ASSET_CENTER_CATEGORY_ENUM)[keyof typeof AID_ASSET_CENTER_CATEGORY_ENUM]["code"];

/** 配音来源枚举 对应数据库字段：audio_source（AID `AudioSourceEnum`） */
export const AID_AUDIO_SOURCE_ENUM = {
  /** AI文字配音 */
  AI_TTS: { value: 1, desc: "AI文字配音" },
  /** 用户上传 */
  USER_UPLOAD: { value: 2, desc: "用户上传" },
} as const;

/** `AudioSourceEnum` 的值集合（由常數物件推導）。 */
export type AidAudioSourceEnumValue = (typeof AID_AUDIO_SOURCE_ENUM)[keyof typeof AID_AUDIO_SOURCE_ENUM]["value"];
