// 管理侧统计视图的只读投影层（PRD REQ-C2「Statistics 统计视图」）。
//
// 断头台纪律（本档存在的理由）：这里的每一个数字都必须能指回一条真实记录——
// 消费/用量指回 `billing_operation` 的**净额**（operation='commit' 的 applied 行
// 减 operation='refund' 的 applied 行，同窗口逐 job 相抵——退款是另一笔 operation，
// 只看 commit 就是把已退的钱算成消耗）；
// 渠道归因指回 `generation_attempt`（delivered 的那次尝试）→ `supplier`；
// 渠道判活指回 `supplier_capability` / `supplier` / `supplier_account`（与
// `supplier-health-signal.ts` 同一把尺）；剩余额度指回 new-api `users.quota`
// （`fetchGatewayUser`，与 quota-precheck 的生产读法同源）。
//
// 四条禁令（违反 = 假报表）：
// 1. 无事件源的数字不画：没有帐本行的日子就是「没有记录」，不补 0 曲线；
//    没有 capability 行的渠道就是 unknown，不猜测健康。
// 2. 样本不足不画 0：比率样本 < MIN_RATE_SAMPLES 时回 `insufficient`，
//    展示层画「资料不足」而不是 0%——0% 是一句假话。
// 3. 只读：本档一条 INSERT / UPDATE / DELETE 都没有（有具名测试守门）。
// 4. **截断必须可见**（本刀新增）：帐本扫描、身份读取、金额解析三处都有上限／
//    异常值——取满、超上限、金额非有限值一律如实标记（partial / truncated /
//    skipped），不许把「部分之和」画成全量，也不许把非有限值静默当 0 再算一笔。
//
// 顺带说明为何不重算「健康分」：scheduler 判活的尺只有「能不能调度」
// （enabled + health_status <> disabled + 未冷却），没有任何连续评分。
// 自己造一个 0-100 健康分就是自造健康度，故只回三态 + 真实计数器原值。

export {
  MIN_RATE_SAMPLES,
  RECORD_SAMPLE_LIMIT,
  STATISTICS_DAY_TIMEZONE,
  DEFAULT_WINDOW_DAYS,
  MAX_WINDOW_DAYS,
  LEDGER_ROW_LIMIT,
  MAX_QUOTA_USERS,
  FUNNEL_WINDOW_OPTIONS,
  DEFAULT_FUNNEL_DAYS,
  RETURN_WINDOW_DAYS,
  FUNNEL_JOB_ROW_LIMIT,
  quotaToCoins,
  sampleRate,
  CHANNEL_LIVENESS_LABEL,
  STATISTICS_SOURCES,
  DEFAULT_INTERNAL_USER_IDS,
  NON_CASH_RECHARGE_SOURCE,
  FUNNEL_STEP_ORDER,
} from "./statistics-projection/types";
export { projectConsumption, windowStartDay, buildUsageNotes } from "./statistics-projection/project-consumption";
export { channelLivenessOf, projectChannelHealth, projectRemainingQuota } from "./statistics-projection/project-revenue";
export { isCashRechargeSource, buildFunnelSourceRows, calendarDayOf, returnedWithin, nearestRankPercentile, projectActivationFunnel } from "./statistics-projection/project-activation";
export { readLedgerConsumption, readBillingIdentityCoverage, readChannelHealth, buildStatisticsProjection, resolveInternalUserIds, readFunnelJobs, readFunnelRecharges, buildActivationFunnel } from "./statistics-projection/queries";
export type {
  LedgerOperationKind,
  LedgerConsumptionRow,
  SampleRate,
  UsageBucket,
  ConsumptionProjection,
  RefundedBucket,
  ChannelLiveness,
  ChannelHealthEntry,
  QuotaState,
  RemainingQuotaEntry,
  QuotaCoverage,
  RemainingQuotaProjection,
  StatisticsSourceRow,
  BillingIdentityCoverage,
  ChannelUsageNote,
  StatisticsProjection,
  FunnelRegistration,
  FunnelJob,
  FunnelRecharge,
  FunnelStepKey,
  FunnelAttribution,
  FunnelSourceRow,
  FunnelStep,
  DurationSummary,
  ActivationFunnelProjection,
  ActivationFunnelUnavailable,
  ActivationFunnelResult,
  RegistrationLoader,
} from "./statistics-projection/types";
