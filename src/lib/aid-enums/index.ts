/**
 * AID enums 汇总出口（刀 5 尾）。
 *
 * 轮子来源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；`git/trees?recursive=1` 列出的 51 个 enum 档**全数抓取成功，0 失败**）
 * 逐字原则：成员名、栏位值（value/desc/code/label/name/sortOrder/sceneCode…）、成员上方注解原文
 *   一律照抄；中文未翻译、未简繁转换、未改写。各档头有完整声明。
 *
 * 本目录为纯资料常数，**无函式**（AID 的 `getByValue`/`of`/`fromCode`/`isValid` 等查表方法一律不搬：
 * 本站尚无呼叫端，且此目录职责限于「值域字典」；要查表时由消费端自建或后续另案）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 全 51 档处置表（入库 37 / 排除 14；逐个点名，可稽核）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ── 入库 37 个 ──
 * creation.ts（7）  aid-interface/…/enums/
 *   CreationStepEnum           创作流水线 7 步（SERIES_DEFAULT -1 亦逐字保留）
 *   CreationModeEnum           创作模式 i2v/multi/pro/auto_grid
 *   ProjectTypeEnum            series/movie
 *   ProjectStatusEnum          0..5（含审核三态，逐字保留；本站映射见 creation-flow-steps.ts）
 *   EpisodeStatusEnum          0..5（同上）
 *   ScriptTypeEnum             plot/monologue
 *   ScriptStatusEnum           0草稿/1使用/2历史版本
 * generation.ts（11）
 *   GenModeEnum                economy/performance
 *   GenerateModeEnum           text / text_to_image / … / audio（9 种生成方式）
 *   GenTypeEnum                image/grid/i2v/multi/edge/upload_video/compose
 *   GenResultTargetEnum        asset/gen_record
 *   ModelTypeEnum              image/video/audio
 *   MediaTypeEnum              image/video
 *   MediaType（media/enums）    IMAGE/VIDEO/TEXT/AUDIO（与 MediaTypeEnum 不同域，并存）
 *   ProductTypeEnum            asset/storyboard/video
 *   AspectRatioEnum            13 种画面比例
 *   DispatchMode               DIRECT/CALLBACK_FIRST/POLL_ONLY
 *   MediaTaskStatus            PENDING…CANCELLED（8 态）
 * storyboard.ts（7）
 *   StoryboardShotDensityEnum  精简/标准/细拆 模式
 *   VideoPromptContinuityMode  none/previous_prompt
 *   PromptTypeEnum             style/camera/subject
 *   SubtitleRecognitionStatus  PROCESSING/COMPLETED/TEXT_FALLBACK/FAILED
 *   ProjectGenConfigScene      16 个项目级生成配置场景（含 needResolution/needAspectRatio/capabilityScene）
 *   StyleCategoryEnum          10 个官方风格分类（含 sortOrder）
 *   VideoStyleTypeEnum         custom/ai_gen/official
 * asset.ts（4）
 *   AssetTypeEnum              style/scene/character/prop/file/pose/effect/expression
 *   AssetSourceTypeEnum        1手动填写/2单集提取/3全集全局提取
 *   AssetCenterCategoryEnum    15 个资产中心分类（code→业务表映射见注解）
 *   AudioSourceEnum            1 AI文字配音/2 用户上传
 * billing.ts（8）
 *   BillingMode                FIXED/SKU
 *   ChargeType                 TEXT/IMAGE/VIDEO
 *   MeterType                  TOKEN/PER_IMAGE/PER_SECOND/SKU_PACKAGE/PER_CHAR
 *   SettleMode                 DIRECT_SETTLE/REFUND_ONLY
 *   TextSettleStatus           INIT/PROCESSING/DONE/PARTIAL_DONE（原为 final class 常量）
 *   MediaBillingStatus         INIT/FROZEN/SETTLING/REFUNDING/SUCCESS/FAILED
 *   ExtractBillingStatus       INIT/FROZEN/SETTLING/REFUNDING/SUCCESS/PARTIAL_SUCCESS/FAILED
 *   BillingConstants           17 个 public static final 纯量常数（查表方法与 private 比例集合不搬）
 *
 * ── 排除 14 个（逐个理由）──
 * 【A】审核／运营配套（4 个）——用户裁定「配套不要」；本站无审核队列
 *   AuditActionEnum            aid_comic_audit_record.action（提交/通过/驳回/发布/下架/回撤）→ 纯审核队列服务
 *   AuditTargetTypeEnum        aid_comic_audit_record.target_type（project/episode）→ 同上
 *   （ProjectStatusEnum / EpisodeStatusEnum 内的审核三态值**未剔除**：它们是状态值域的一部分，
 *     剔掉会使 0..5 值域破裂；本站的收敛映射已在 creation-flow-steps.ts 诚实声明。）
 * 【B】RuoYi / Spring 框架自带通用 enums（9 个）——非 AID 产品语义，且本站无对应机制
 *   BusinessStatus（aid-common）    SUCCESS/FAIL  操作状态，RuoYi 日志专用
 *   BusinessType（aid-common）      INSERT/UPDATE/… 业务操作类型，RuoYi 操作日志专用
 *   DataSourceType（aid-common）    MASTER/SLAVE  主从库，本站 D1/Blob 无此概念
 *   DesensitizedType（aid-common）  脱敏规则；**且其成员值为 Java `Function` 物件**（带正则逻辑），
 *                                   非纯资料、无法逐字转常数
 *   HttpMethod（aid-common）        GET/POST/…  Spring MVC，框架层非产品语义
 *   LimitType（aid-common）         DEFAULT/IP  限流策略，RuoYi 注解专用
 *   LoginType（aid-common）         password/sms/email/wechat  凭证登入分类；本站登入为
 *                                   OAuth/第三方（emu-oauth、github-login、wechat-login）＋后台 scrypt，
 *                                   值集不映射，搬入会误导
 *   OperatorType（aid-common）      OTHER/MANAGE/MOBILE  操作人类别，RuoYi 日志专用
 *   UserStatus（aid-common）        OK/DISABLE/DELETED  用户状态，RuoYi 用户表专用
 * 【C】通用 0/1 状态编码（2 个）——本站无 char(1) "0"/"1" 状态栏惯例（启停一律用 boolean，
 *     见 admin-pools.ts `enabled: boolean`），搬入等于引入一套不存在的储存约定
 *   CommonEnableStatusEnum          ENABLE("0")/DISABLE("1")
 *   CommonYesNoEnum                 NO("0")/YES("1")
 * 【D】非资料型别（1 个）
 *   IBaseEnum（aid-common）         Java `interface`，只有 `getValue()/getDesc()` 方法签名，无值域可搬
 * 【E】已由我方等价资产覆盖（0 个另列，仅说明）
 *   无。以下档案虽与我方资产主题重叠，但**值域不重叠或我方缺该字典，故仍入库**：
 *   - AspectRatioEnum（13 值）vs 我方 `AspectRatio` union（15 值，`generation-model-catalog/types.ts`）：
 *     **互有差集**（实测：交集 11 值；AID 独有 1:2、2:1；我方独有 1:4、1:8、4:1、8:1）
 *     —— 两套独立值域，不互相取代。
 *   - CreationStepEnum vs `creation-flow-steps.ts`：后者是**白名单改写后**的本站 7 步（砍 SERIES_DEFAULT、
 *     加 key、简体 label），本档是**逐字原样**；两者并存，交叉一致性由测试把关。
 *   - PromptTypeEnum（style/camera/subject）vs `lens-language-library.ts` 的 12 个 group：
 *     后者是 DB `aid_prompt_lib.prompt_type` 的**细分**词库分组，前者是粗分类 enum，层级不同。
 *   - StyleCategoryEnum vs `kunpeng-style-library.json`：不同来源、不同值域，无覆盖关系。
 *
 * ── 未尽事项（如实列出，不粉饰）──
 * 1. 本目录只建了「值域字典」，**尚无消费端**（无 import）。刀 5 的接线（让生成管线/前端真的吃这些值）
 *    不在本片范围，故目前入库 = 可 import 的常数模组，不等于「已被使用」。
 * 2. AID 的查表方法（getByValue/of/fromCode）未搬；若后续需要，消费端须自建或另案补 type guard。
 * 3. `ProjectStatusEnum`/`EpisodeStatusEnum` 的审核三态值逐字保留（见【A】说明），
 *    本站端到端语义仍以 `creation-flow-steps.ts` 的三态映射为准。
 */

// ── creation.ts（7 个）──
export { AID_CREATION_STEP_ENUM, AID_CREATION_MODE_ENUM, AID_PROJECT_TYPE_ENUM, AID_PROJECT_STATUS_ENUM, AID_EPISODE_STATUS_ENUM, AID_SCRIPT_TYPE_ENUM, AID_SCRIPT_STATUS_ENUM } from "./creation";
export type { AidCreationStepEnumValue, AidCreationModeEnumValue, AidProjectTypeEnumValue, AidProjectStatusEnumValue, AidEpisodeStatusEnumValue, AidScriptTypeEnumValue, AidScriptStatusEnumValue } from "./creation";

// ── generation.ts（11 个）──
export { AID_GEN_MODE_ENUM, AID_GENERATE_MODE_ENUM, AID_GEN_TYPE_ENUM, AID_GEN_RESULT_TARGET_ENUM, AID_MODEL_TYPE_ENUM, AID_MEDIA_TYPE_ENUM, AID_MEDIA_TYPE, AID_PRODUCT_TYPE_ENUM, AID_ASPECT_RATIO_ENUM, AID_DISPATCH_MODE, AID_MEDIA_TASK_STATUS } from "./generation";
export type { AidGenModeEnumValue, AidGenerateModeEnumValue, AidGenTypeEnumValue, AidGenResultTargetEnumValue, AidModelTypeEnumValue, AidMediaTypeEnumValue, AidMediaTypeValue, AidProductTypeEnumValue, AidAspectRatioEnumValue, AidDispatchModeValue, AidMediaTaskStatusValue } from "./generation";

// ── storyboard.ts（7 个）──
export { AID_STORYBOARD_SHOT_DENSITY_ENUM, AID_VIDEO_PROMPT_CONTINUITY_MODE, AID_PROMPT_TYPE_ENUM, AID_SUBTITLE_RECOGNITION_STATUS, AID_PROJECT_GEN_CONFIG_SCENE, AID_STYLE_CATEGORY_ENUM, AID_VIDEO_STYLE_TYPE_ENUM } from "./storyboard";
export type { AidStoryboardShotDensityEnumValue, AidVideoPromptContinuityModeValue, AidPromptTypeEnumValue, AidSubtitleRecognitionStatusValue, AidProjectGenConfigSceneValue, AidStyleCategoryEnumValue, AidVideoStyleTypeEnumValue } from "./storyboard";

// ── asset.ts（4 个）──
export { AID_ASSET_TYPE_ENUM, AID_ASSET_SOURCE_TYPE_ENUM, AID_ASSET_CENTER_CATEGORY_ENUM, AID_AUDIO_SOURCE_ENUM } from "./asset";
export type { AidAssetTypeEnumValue, AidAssetSourceTypeEnumValue, AidAssetCenterCategoryEnumValue, AidAudioSourceEnumValue } from "./asset";

// ── billing.ts（8 个）──
export { AID_BILLING_MODE, AID_CHARGE_TYPE, AID_METER_TYPE, AID_SETTLE_MODE, AID_TEXT_SETTLE_STATUS, AID_MEDIA_BILLING_STATUS, AID_EXTRACT_BILLING_STATUS, AID_BILLING_CONSTANTS } from "./billing";
export type { AidBillingModeValue, AidChargeTypeValue, AidMeterTypeValue, AidSettleModeValue, AidMediaBillingStatusValue, AidExtractBillingStatusValue } from "./billing";
