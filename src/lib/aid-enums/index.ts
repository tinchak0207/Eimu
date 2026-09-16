/**
 * AID enums 匯總出口（刀 5 尾）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；`git/trees?recursive=1` 列出的 51 個 enum 檔**全數抓取成功，0 失敗**）
 * 逐字原則：成員名、欄位值（value/desc/code/label/name/sortOrder/sceneCode…）、成員上方註解原文
 *   一律照抄；中文未翻譯、未簡繁轉換、未改寫。各檔頭有完整聲明。
 *
 * 本目錄為純資料常數，**無函式**（AID 的 `getByValue`/`of`/`fromCode`/`isValid` 等查表方法一律不搬：
 * 本站尚無呼叫端，且此目錄職責限於「值域字典」；要查表時由消費端自建或後續另案）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 全 51 檔處置表（入庫 37 / 排除 14；逐個點名，可稽核）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── 入庫 37 個 ──
 * creation.ts（7）  aid-interface/…/enums/
 *   CreationStepEnum           創作流水線 7 步（SERIES_DEFAULT -1 亦逐字保留）
 *   CreationModeEnum           創作模式 i2v/multi/pro/auto_grid
 *   ProjectTypeEnum            series/movie
 *   ProjectStatusEnum          0..5（含審核三態，逐字保留；本站映射見 creation-flow-steps.ts）
 *   EpisodeStatusEnum          0..5（同上）
 *   ScriptTypeEnum             plot/monologue
 *   ScriptStatusEnum           0草稿/1使用/2历史版本
 * generation.ts（11）
 *   GenModeEnum                economy/performance
 *   GenerateModeEnum           text / text_to_image / … / audio（9 種生成方式）
 *   GenTypeEnum                image/grid/i2v/multi/edge/upload_video/compose
 *   GenResultTargetEnum        asset/gen_record
 *   ModelTypeEnum              image/video/audio
 *   MediaTypeEnum              image/video
 *   MediaType（media/enums）    IMAGE/VIDEO/TEXT/AUDIO（與 MediaTypeEnum 不同域，並存）
 *   ProductTypeEnum            asset/storyboard/video
 *   AspectRatioEnum            13 種畫面比例
 *   DispatchMode               DIRECT/CALLBACK_FIRST/POLL_ONLY
 *   MediaTaskStatus            PENDING…CANCELLED（8 態）
 * storyboard.ts（7）
 *   StoryboardShotDensityEnum  精简/标准/细拆 模式
 *   VideoPromptContinuityMode  none/previous_prompt
 *   PromptTypeEnum             style/camera/subject
 *   SubtitleRecognitionStatus  PROCESSING/COMPLETED/TEXT_FALLBACK/FAILED
 *   ProjectGenConfigScene      16 個項目級生成配置場景（含 needResolution/needAspectRatio/capabilityScene）
 *   StyleCategoryEnum          10 個官方風格分類（含 sortOrder）
 *   VideoStyleTypeEnum         custom/ai_gen/official
 * asset.ts（4）
 *   AssetTypeEnum              style/scene/character/prop/file/pose/effect/expression
 *   AssetSourceTypeEnum        1手动填写/2单集提取/3全集全局提取
 *   AssetCenterCategoryEnum    15 個資產中心分類（code→業務表映射見註解）
 *   AudioSourceEnum            1 AI文字配音/2 用户上传
 * billing.ts（8）
 *   BillingMode                FIXED/SKU
 *   ChargeType                 TEXT/IMAGE/VIDEO
 *   MeterType                  TOKEN/PER_IMAGE/PER_SECOND/SKU_PACKAGE/PER_CHAR
 *   SettleMode                 DIRECT_SETTLE/REFUND_ONLY
 *   TextSettleStatus           INIT/PROCESSING/DONE/PARTIAL_DONE（原為 final class 常量）
 *   MediaBillingStatus         INIT/FROZEN/SETTLING/REFUNDING/SUCCESS/FAILED
 *   ExtractBillingStatus       INIT/FROZEN/SETTLING/REFUNDING/SUCCESS/PARTIAL_SUCCESS/FAILED
 *   BillingConstants           17 個 public static final 純量常數（查表方法與 private 比例集合不搬）
 *
 * ── 排除 14 個（逐個理由）──
 * 【A】審核／運營配套（4 個）——用戶裁定「配套不要」；本站無審核隊列
 *   AuditActionEnum            aid_comic_audit_record.action（提交/通过/驳回/发布/下架/回撤）→ 純審核隊列服務
 *   AuditTargetTypeEnum        aid_comic_audit_record.target_type（project/episode）→ 同上
 *   （ProjectStatusEnum / EpisodeStatusEnum 內的審核三態值**未剔除**：它們是狀態值域的一部分，
 *     剔掉會使 0..5 值域破裂；本站的收斂映射已在 creation-flow-steps.ts 誠實聲明。）
 * 【B】RuoYi / Spring 框架自帶通用 enums（9 個）——非 AID 產品語義，且本站無對應機制
 *   BusinessStatus（aid-common）    SUCCESS/FAIL  操作狀態，RuoYi 日誌專用
 *   BusinessType（aid-common）      INSERT/UPDATE/… 業務操作類型，RuoYi 操作日誌專用
 *   DataSourceType（aid-common）    MASTER/SLAVE  主從庫，本站 D1/Blob 無此概念
 *   DesensitizedType（aid-common）  脫敏規則；**且其成員值為 Java `Function` 物件**（帶正則邏輯），
 *                                   非純資料、無法逐字轉常數
 *   HttpMethod（aid-common）        GET/POST/…  Spring MVC，框架層非產品語義
 *   LimitType（aid-common）         DEFAULT/IP  限流策略，RuoYi 註解專用
 *   LoginType（aid-common）         password/sms/email/wechat  憑證登入分類；本站登入為
 *                                   OAuth/第三方（emu-oauth、github-login、wechat-login）＋後台 scrypt，
 *                                   值集不映射，搬入會誤導
 *   OperatorType（aid-common）      OTHER/MANAGE/MOBILE  操作人類別，RuoYi 日誌專用
 *   UserStatus（aid-common）        OK/DISABLE/DELETED  用戶狀態，RuoYi 用戶表專用
 * 【C】通用 0/1 狀態編碼（2 個）——本站無 char(1) "0"/"1" 狀態欄慣例（啟停一律用 boolean，
 *     見 admin-pools.ts `enabled: boolean`），搬入等於引入一套不存在的儲存約定
 *   CommonEnableStatusEnum          ENABLE("0")/DISABLE("1")
 *   CommonYesNoEnum                 NO("0")/YES("1")
 * 【D】非資料型別（1 個）
 *   IBaseEnum（aid-common）         Java `interface`，只有 `getValue()/getDesc()` 方法簽名，無值域可搬
 * 【E】已由我方等價資產覆蓋（0 個另列，僅說明）
 *   無。以下檔案雖與我方資產主題重疊，但**值域不重疊或我方缺該字典，故仍入庫**：
 *   - AspectRatioEnum（13 值）vs 我方 `AspectRatio` union（15 值，`generation-model-catalog/types.ts`）：
 *     **互有差集**（實測：交集 11 值；AID 獨有 1:2、2:1；我方獨有 1:4、1:8、4:1、8:1）
 *     —— 兩套獨立值域，不互相取代。
 *   - CreationStepEnum vs `creation-flow-steps.ts`：後者是**白名單改寫後**的本站 7 步（砍 SERIES_DEFAULT、
 *     加 key、簡體 label），本檔是**逐字原樣**；兩者並存，交叉一致性由測試把關。
 *   - PromptTypeEnum（style/camera/subject）vs `lens-language-library.ts` 的 12 個 group：
 *     後者是 DB `aid_prompt_lib.prompt_type` 的**細分**詞庫分組，前者是粗分類 enum，層級不同。
 *   - StyleCategoryEnum vs `kunpeng-style-library.json`：不同來源、不同值域，無覆蓋關係。
 *
 * ── 未盡事項（如實列出，不粉飾）──
 * 1. 本目錄只建了「值域字典」，**尚無消費端**（無 import）。刀 5 的接線（讓生成管線/前端真的吃這些值）
 *    不在本片範圍，故目前入庫 = 可 import 的常數模組，不等於「已被使用」。
 * 2. AID 的查表方法（getByValue/of/fromCode）未搬；若後續需要，消費端須自建或另案補 type guard。
 * 3. `ProjectStatusEnum`/`EpisodeStatusEnum` 的審核三態值逐字保留（見【A】說明），
 *    本站端到端語義仍以 `creation-flow-steps.ts` 的三態映射為準。
 */

// ── creation.ts（7 個）──
export { AID_CREATION_STEP_ENUM, AID_CREATION_MODE_ENUM, AID_PROJECT_TYPE_ENUM, AID_PROJECT_STATUS_ENUM, AID_EPISODE_STATUS_ENUM, AID_SCRIPT_TYPE_ENUM, AID_SCRIPT_STATUS_ENUM } from "./creation";
export type { AidCreationStepEnumValue, AidCreationModeEnumValue, AidProjectTypeEnumValue, AidProjectStatusEnumValue, AidEpisodeStatusEnumValue, AidScriptTypeEnumValue, AidScriptStatusEnumValue } from "./creation";

// ── generation.ts（11 個）──
export { AID_GEN_MODE_ENUM, AID_GENERATE_MODE_ENUM, AID_GEN_TYPE_ENUM, AID_GEN_RESULT_TARGET_ENUM, AID_MODEL_TYPE_ENUM, AID_MEDIA_TYPE_ENUM, AID_MEDIA_TYPE, AID_PRODUCT_TYPE_ENUM, AID_ASPECT_RATIO_ENUM, AID_DISPATCH_MODE, AID_MEDIA_TASK_STATUS } from "./generation";
export type { AidGenModeEnumValue, AidGenerateModeEnumValue, AidGenTypeEnumValue, AidGenResultTargetEnumValue, AidModelTypeEnumValue, AidMediaTypeEnumValue, AidMediaTypeValue, AidProductTypeEnumValue, AidAspectRatioEnumValue, AidDispatchModeValue, AidMediaTaskStatusValue } from "./generation";

// ── storyboard.ts（7 個）──
export { AID_STORYBOARD_SHOT_DENSITY_ENUM, AID_VIDEO_PROMPT_CONTINUITY_MODE, AID_PROMPT_TYPE_ENUM, AID_SUBTITLE_RECOGNITION_STATUS, AID_PROJECT_GEN_CONFIG_SCENE, AID_STYLE_CATEGORY_ENUM, AID_VIDEO_STYLE_TYPE_ENUM } from "./storyboard";
export type { AidStoryboardShotDensityEnumValue, AidVideoPromptContinuityModeValue, AidPromptTypeEnumValue, AidSubtitleRecognitionStatusValue, AidProjectGenConfigSceneValue, AidStyleCategoryEnumValue, AidVideoStyleTypeEnumValue } from "./storyboard";

// ── asset.ts（4 個）──
export { AID_ASSET_TYPE_ENUM, AID_ASSET_SOURCE_TYPE_ENUM, AID_ASSET_CENTER_CATEGORY_ENUM, AID_AUDIO_SOURCE_ENUM } from "./asset";
export type { AidAssetTypeEnumValue, AidAssetSourceTypeEnumValue, AidAssetCenterCategoryEnumValue, AidAudioSourceEnumValue } from "./asset";

// ── billing.ts（8 個）──
export { AID_BILLING_MODE, AID_CHARGE_TYPE, AID_METER_TYPE, AID_SETTLE_MODE, AID_TEXT_SETTLE_STATUS, AID_MEDIA_BILLING_STATUS, AID_EXTRACT_BILLING_STATUS, AID_BILLING_CONSTANTS } from "./billing";
export type { AidBillingModeValue, AidChargeTypeValue, AidMeterTypeValue, AidSettleModeValue, AidMediaBillingStatusValue, AidExtractBillingStatusValue } from "./billing";
