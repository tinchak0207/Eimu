/**
 * AID 計費 enums（與本站 reserve / commit / refund 口徑對照用）。
 *
 * 輪子來源：gzxx-2025/aid-server（MIT License，Copyright (c) 2026 光子讯息(杭州)科技有限公司）
 * 上游 commit：bbd2a58faffd6a0315af8f6a71902ca8adb5a308
 * 取得日：2026-09-15（GitHub raw；本次共抓取 AID 目錄樹列出的全部 51 個 enum 檔，0 失敗；本檔收錄其中 8 個）
 * 來源檔（8 個，路徑相對 repo 根）：
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/BillingMode.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/ChargeType.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/MeterType.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/SettleMode.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/TextSettleStatus.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/media/enums/MediaBillingStatus.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/rps/enums/ExtractBillingStatus.java
 *   - aid-interface/aid-interface-main/src/main/java/com/aid/billing/enums/BillingConstants.java
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

/** 计费模式枚举（AID `BillingMode`） */
export const AID_BILLING_MODE = {
  FIXED: { code: "FIXED", desc: "固定价格" },
  SKU: { code: "SKU", desc: "SKU规则计费" },
} as const;

/** `BillingMode` 的值集合（由常數物件推導）。 */
export type AidBillingModeValue = (typeof AID_BILLING_MODE)[keyof typeof AID_BILLING_MODE]["code"];

/** 计费业务类型：文本 / 图片 / 视频（AID `ChargeType`） */
export const AID_CHARGE_TYPE = {
  TEXT: { code: "TEXT", desc: "文本生成" },
  IMAGE: { code: "IMAGE", desc: "图片生成" },
  VIDEO: { code: "VIDEO", desc: "视频生成" },
} as const;

/** `ChargeType` 的值集合（由常數物件推導）。 */
export type AidChargeTypeValue = (typeof AID_CHARGE_TYPE)[keyof typeof AID_CHARGE_TYPE]["code"];

/** 统一计费口径枚举：决定金额计算公式的唯一分发依据。（AID `MeterType`） */
export const AID_METER_TYPE = {
  /** 按 token 用量计费（文本 LLM、Gemini 图片等） */
  TOKEN: { value: "TOKEN" },
  /** 按单张固定价计费（wan/jimeng 图片等） */
  PER_IMAGE: { value: "PER_IMAGE" },
  /** 按视频秒数计费（阿里/即梦视频等） */
  PER_SECOND: { value: "PER_SECOND" },
  /** 按 SKU 整包价计费（豆包视频等） */
  SKU_PACKAGE: { value: "SKU_PACKAGE" },
  /** 按文本字符数计费（TTS 语音合成：minimax / 豆包等） */
  PER_CHAR: { value: "PER_CHAR" },
} as const;

/** `MeterType` 的值集合（由常數物件推導）。 */
export type AidMeterTypeValue = (typeof AID_METER_TYPE)[keyof typeof AID_METER_TYPE]["value"];

/** 结算策略：描述任务完成后如何处理预扣与实际金额的差异。（AID `SettleMode`） */
export const AID_SETTLE_MODE = {
  /** 直接结算：预扣金额即为最终金额（图片/视频适用，成功转消费、失败全退） */
  DIRECT_SETTLE: { code: "DIRECT_SETTLE", desc: "直接结算" },
  /** 差额退款：预扣偏大，完成后按实际用量退差额，不补扣（文本模型适用） */
  REFUND_ONLY: { code: "REFUND_ONLY", desc: "差额退款" },
} as const;

/** `SettleMode` 的值集合（由常數物件推導）。 */
export type AidSettleModeValue = (typeof AID_SETTLE_MODE)[keyof typeof AID_SETTLE_MODE]["code"];

/** AID `TextSettleStatus`（文本差额结算状态：通过DB字段 text_settle_status 做CAS，防止并发重复退款。）之 public static final 純量常數。 */
export const AID_TEXT_SETTLE_STATUS = {
  /** 未开始（初始状态，新建任务默认值） */
  INIT: "INIT",
  /** 处理中（CAS抢到的线程持有） */
  PROCESSING: "PROCESSING",
  /** 已完成（终态，幂等标记） */
  DONE: "DONE",
  /** 部分补扣完成（TOKEN 补扣余额不足，待后续追补） */
  PARTIAL_DONE: "PARTIAL_DONE",
} as const;

export const AID_MEDIA_BILLING_STATUS = {
  /** 初始状态：尚未执行计费。 */
  INIT: { value: "INIT" },
  /** 预冻结成功：费用已从余额冻结到冻结余额，等待任务完成后结算或退回。 */
  FROZEN: { value: "FROZEN" },
  /** 结算中：FROZEN → SETTLING，防止重复结算。 */
  SETTLING: { value: "SETTLING" },
  /** 退款中：FROZEN → REFUNDING，防止重复退款。 */
  REFUNDING: { value: "REFUNDING" },
  /** 结算成功：任务成功，冻结金额已从 frozenBalance 扣减并累加到 totalConsumption。 */
  SUCCESS: { value: "SUCCESS" },
  /** 计费失败：预冻结失败（预扣余额不足），或任务失败后冻结金额已退回。 */
  FAILED: { value: "FAILED" },
} as const;

/** `MediaBillingStatus` 的值集合（由常數物件推導）。 */
export type AidMediaBillingStatusValue = (typeof AID_MEDIA_BILLING_STATUS)[keyof typeof AID_MEDIA_BILLING_STATUS]["value"];

/** 资产提取任务计费状态枚举（AID `ExtractBillingStatus`） */
export const AID_EXTRACT_BILLING_STATUS = {
  /** 初始 */
  INIT: { value: "INIT" },
  /** 已冻结 */
  FROZEN: { value: "FROZEN" },
  /** 结算中（FROZEN → SETTLING，防止重复结算） */
  SETTLING: { value: "SETTLING" },
  /** 退款中（FROZEN → REFUNDING，防止重复退款） */
  REFUNDING: { value: "REFUNDING" },
  /** 已结算 */
  SUCCESS: { value: "SUCCESS" },
  /** 部分补扣完成（TOKEN 补扣余额不足，待后续追补） */
  PARTIAL_SUCCESS: { value: "PARTIAL_SUCCESS" },
  /** 已退回 */
  FAILED: { value: "FAILED" },
} as const;

/** `ExtractBillingStatus` 的值集合（由常數物件推導）。 */
export type AidExtractBillingStatusValue = (typeof AID_EXTRACT_BILLING_STATUS)[keyof typeof AID_EXTRACT_BILLING_STATUS]["value"];

/** AID `BillingConstants`（计费模块常量）之 public static final 純量常數。 */
export const AID_BILLING_CONSTANTS = {
  /** 账户余额、冻结金额、消费与退款流水统一保留的小数位数。 */
  ACCOUNT_AMOUNT_SCALE: 4,
  /** 计费模式 */
  MODE_FIXED: "FIXED",
  MODE_SKU: "SKU",
  /** SKU匹配策略 */
  MATCH_STRATEGY_FIRST_HIT: "FIRST_HIT",
  /** 模型基础倍率配置分类：原价（元）乘此值换算为积分。 */
  MODEL_PRICE_MULTIPLIER_CATEGORY: "media",
  /** 模型基础倍率配置名（aid_config）。 */
  MODEL_PRICE_MULTIPLIER_KEY: "ai_billing_global_multiplier",
  /** 模型基础倍率缓存时间。 */
  MODEL_PRICE_MULTIPLIER_CACHE_TTL_MS: 5000,
  /** 开源默认口径：1 元官方原价换算为 100 积分。 */
  DEFAULT_MODEL_PRICE_MULTIPLIER: "100",
  /** 文本模型默认字符转Token比例：约2个中文字符算1个Token（结算降级路径使用） */
  DEFAULT_CHAR_TO_TOKEN_RATIO: 2,
  /** 统一字符转Token换算：5个字 = 4个token → tokens = ceil(chars * 4 / 5) */
  CHAR_TO_TOKEN_NUMERATOR: 4,
  CHAR_TO_TOKEN_DENOMINATOR: 5,
  /** 文本模型默认预估输出字数 */
  DEFAULT_ESTIMATED_OUTPUT_CHARS: 2000,
  /**
   * 数据来源：doc/usedoc/image/openai_imagee2 § "Cost and latency" / "Calculating costs"。
   * 官方给出 gpt-image-2 各 quality × size 的图像成本（USD），输出 token 单价 $30/1M（=$0.00003/token）。
   * 预估输出 token = 官方成本 ÷ $0.00003，向上取整并适度留余，保证预扣 ≥ 实际
   * （SKU settleMode=REFUND_ONLY 只退不补，宁高勿低，避免触发 TOKEN 补扣）。
   * Low    : 方图 $0.006→200, 竖图 $0.005→170, 横图 $0.005→170
   * Medium : 方图 $0.053→1800, 竖图 $0.041→1400, 横图 $0.041→1400
   * High   : 方图 $0.211→7100, 竖图 $0.165→5500, 横图 $0.165→5500
   * auto / 缺省 → 按 High 取最高；朝向未知 → 按方图（同档最高）取最高
   * gpt-image-2 编辑模式下，单张参考图高保真输入 token 预估（官方称恒以高保真处理输入图，编辑请求 input token 显著增加）
   */
  GPT_IMAGE2_INPUT_TOKENS_PER_REF_IMAGE: 1800,
  /** 结算策略（与SettleMode枚举对应） */
  SETTLE_DIRECT: "DIRECT_SETTLE",
  SETTLE_REFUND_ONLY: "REFUND_ONLY",
  /** Usage来源 */
  USAGE_PROVIDER: "PROVIDER_USAGE",
  USAGE_ESTIMATE: "ESTIMATE",
} as const;
