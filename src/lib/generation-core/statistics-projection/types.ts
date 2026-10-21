import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import type { UsageAssetKind } from "../usage-asset-kind";

/** 比率的最小样本门槛：与 routing-telemetry 的 latencyP80（<3 样本回 null）同一把尺。 */
export const MIN_RATE_SAMPLES = 3;
/** 每个聚合桶最多带回几条帐本行 id（供「数字→记录」对照，不是全量）。 */
export const RECORD_SAMPLE_LIMIT = 5;
/** 「每日」的日界时区：业务在 CST，UTC 日界会把晚间消耗切到前一天。 */
export const STATISTICS_DAY_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 30;
/** 帐本扫描上限；取满即标 partial（总数变下界，必须如实说）。 */
export const LEDGER_ROW_LIMIT = 5_000;
/** 剩余额度读取上限（每个用户一次上游 GET，避免统计页打爆 new-api）；超上限必须标 truncated。 */
export const MAX_QUOTA_USERS = 25;
/** 激活漏斗时间窗（天）。 */
export const FUNNEL_WINDOW_OPTIONS = [7, 30] as const;
export const DEFAULT_FUNNEL_DAYS = 30;
/** 回访判定：首次生成日之后 1..RETURN_WINDOW_DAYS 个自然日内另有一天有生成。 */
export const RETURN_WINDOW_DAYS = 7;
/** 漏斗取任务行的上限；取满即标 truncated（后续步骤变下界）。 */
export const FUNNEL_JOB_ROW_LIMIT = 20_000;

/** 帐本 operation：commit＝扣费（正向），refund＝退款（同一 job 的负向，用来抵消费）。 */
export type LedgerOperationKind = "commit" | "refund";

/** quota 单位 → 币（与 task-response.resolveTaskCostCoins 同一汇率与精度）。 */
export function quotaToCoins(quota: number): number {
  return Math.round((quota / QUOTA_PER_COIN) * 1e6) / 1e6;
}

/** 一条帐本消费行（billing_operation commit/refund applied，已 join 完模型与渠道）。 */
export interface LedgerConsumptionRow {
  operationId: string;
  jobId: string;
  modelId: string;
  billingUserId: number | null;
  /** delivered 那次尝试的供应商 id；无成功尝试 → null（未归因，不猜）。 */
  channelId: string | null;
  channelLabel: string | null;
  /** 帐本行原值（一律 >= 0）；方向由 `kind` 决定，refund 是负向。 */
  amountQuota: number;
  /** 帐本 operation：commit＝扣费，refund＝退款（同窗口同 job 相减）。 */
  kind: LedgerOperationKind;
  appliedAt: string;
  /** 已按 STATISTICS_DAY_TIMEZONE 切好的日界（YYYY-MM-DD）。 */
  day: string;
  /** `generation_job.kind` 原值（`image_generate`／`image_edit`／`video_generate`）；缺栏＝null。 */
  jobKind?: string | null;
  /**
   * 生成物类别（P2-2／D8b）：由 `jobKind` 判得，**不猜**（判不出来＝`unclassified`）。
   * 真源与判准见 `usage-asset-kind.ts` 的档头（含「D8b 的角色/场景/道具目前无落盘事实」的诚实边界）。
   */
  assetKind?: UsageAssetKind;
}

/** 样本是否足够撑起一个比率。不足时 `value` 缺席——不许拿 0 冒充。 */
export type SampleRate =
  | { state: "ok"; samples: number; value: number }
  | { state: "insufficient"; samples: number; minimum: number };

export function sampleRate(successes: number, attempts: number): SampleRate {
  if (attempts < MIN_RATE_SAMPLES) {
    return { state: "insufficient", samples: attempts, minimum: MIN_RATE_SAMPLES };
  }
  return { state: "ok", samples: attempts, value: successes / attempts };
}

export interface UsageBucket {
  key: string;
  label: string;
  quota: number;
  coins: number;
  operations: number;
  /** 该桶前 RECORD_SAMPLE_LIMIT 条帐本行 id（数字→记录对照）。 */
  recordIds: string[];
  /**
   * 只有「按日」桶会用到：true = 这一天的窗口起点落在该日中间（半天桶，
   * 只统计起点之后的记录），不是一个完整日的量。标注而非对齐：见 windowStartDay。
   */
  partial?: boolean;
}

export interface ConsumptionProjection {
  /** 净消耗 = Σ(commit.applied) − Σ(refund.applied)（同窗口逐 job 相抵，可为负）。 */
  totalQuota: number;
  totalCoins: number;
  /** 计入的帐本行数（commit + refund；金额非有限值的行已跳过、不计）。 */
  operations: number;
  /** 扣费总额（Σ commit.applied）——净额的减项来源，单列供对帐。 */
  chargedQuota: number;
  chargedCoins: number;
  chargedOperations: number;
  /** 已退款总额（Σ refund.applied，正数）。 */
  refundedQuota: number;
  refundedCoins: number;
  refundedOperations: number;
  byDay: UsageBucket[];
  byModel: UsageBucket[];
  byChannel: UsageBucket[];
  /**
   * 生成物类别切面（P2-2／D8b）：分镜影片／一般图片／未归类。
   * **诚实边界**：D8b 的角色／场景／道具在提交端尚无落盘事实（见 usage-asset-kind.ts 档头），
   * 因此目前不会出现这三桶——不是漏算，是还没有可判的资料；补法是提交端把类别盖章落盘。
   * 零记录的类别不出现（与其他切面同语义）。
   */
  byAssetKind: UsageBucket[];
  /** 帐本有行但找不到 delivered 尝试的净消耗——如实单列，不摊进任何渠道。 */
  unattributed: { quota: number; coins: number; operations: number; recordIds: string[] };
  /** 退款单列（不摊进任何消耗桶、不落「未归因」）：口径变了，数字才能对上帐本。 */
  refunded: RefundedBucket;
  /** 金额非有限值而被跳过的帐本行数（不当 0 计、不冒充一笔 operation）。 */
  skippedNonFiniteRows: number;
}

/**
 * 已退款单列桶：退款是**另一笔** operation，不是消耗的一部分。
 * 全额退款的 job（同窗口扣费与退款相抵为 0）整个从消耗桶移出，只在这里留痕＋帐本行 id。
 */
export interface RefundedBucket {
  /** Σ refund.applied（正数，单位 quota）。 */
  quota: number;
  coins: number;
  /** 退款帐本行数。 */
  operations: number;
  /** 涉及的 job 数。 */
  jobs: number;
  /** 同窗口扣费与退款相抵为 0 的 job 数（全额退款）。 */
  fullyRefundedJobs: number;
  /** 这些相抵为 0 的 job 的帐本行数（不进任何消耗桶，计在已退款桶）。 */
  netZeroRows: number;
  recordIds: string[];
}

export type ChannelLiveness = "available" | "unavailable" | "unknown";

export interface ChannelHealthEntry {
  channelId: string;
  label: string;
  liveness: ChannelLiveness;
  reason: string;
  capabilities: number;
  schedulableCapabilities: number;
  /** supplier 表上的真实计数器（非推算）。 */
  successCount: number;
  failureCount: number;
  successRate: SampleRate;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export const CHANNEL_LIVENESS_LABEL: Record<ChannelLiveness, string> = {
  available: "可用",
  unavailable: "不可用",
  unknown: "无法判定",
};

export type QuotaState = "known" | "unknown";

export interface RemainingQuotaEntry {
  billingUserId: number;
  state: QuotaState;
  quota: number | null;
  coins: number | null;
  reason?: string;
}

/**
 * 覆盖率：剩余额度合计**只是被读到的那几个身份之和**（每个身份一次上游 GET，有硬上限）。
 * 身份数超过上限时 truncated=true，展示层必须标出来——把部分之和画成全量就是假数字。
 */
export interface QuotaCoverage {
  /** 读取上限（MAX_QUOTA_USERS）。 */
  limit: number;
  /** 实际尝试读取的身份数（= entries.length，含 unknown）。 */
  coveredCount: number;
  /** 窗口内全部付费身份数（帐本 count，不是样本）。 */
  totalIdentities: number;
  /** true = 身份数超过上限，合计只覆盖前 coveredCount 个。 */
  truncated: boolean;
}

export interface RemainingQuotaProjection {
  entries: RemainingQuotaEntry[];
  knownQuota: number;
  knownCoins: number;
  knownCount: number;
  unknownCount: number;
  coverage: QuotaCoverage;
}

export interface StatisticsSourceRow {
  metric: string;
  source: string;
  note: string;
}

/** 每个数字指回哪张表——回报与 UI 共用同一份签名。 */
export const STATISTICS_SOURCES: StatisticsSourceRow[] = [
  {
    metric: "用量 / 每日消耗 / 模型分布 / 渠道用量",
    source: "billing_operation (operation IN ('commit','refund') AND status='applied') ⋈ generation_job",
    note: "净额口径：同一 job 同窗口内 Σcommit − Σrefund；全额退款不计入消耗、单列「已退款」。amount 为 quota 原值（1 币 = 500000）。",
  },
  {
    metric: "渠道归因",
    source: "generation_attempt (status='succeeded') → supplier",
    note: "取该任务实际交付的那次尝试；找不到成功尝试的行单列「未归因」，不摊派。",
  },
  {
    metric: "渠道判活（三态）",
    source: "supplier_capability / supplier / supplier_account",
    note: "与 scheduler 及 /v1/model-status 执行侧裁决同一把尺；无能力记录者为 unknown。",
  },
  {
    metric: "剩余额度",
    source: "new-api users.quota（GET /api/user/{id}）",
    note: `与 quota-precheck 同通路；读不到即 unknown，不以 0 代替。每个身份一次上游 GET，上限 ${MAX_QUOTA_USERS} 个——超过即标 truncated 并如实给出覆盖数。`,
  },
  {
    metric: "激活漏斗：注册",
    source: "new-api users.created_at（GET /api/user/ 管理分页）",
    note: "滚动窗口 now − 7/30 天内注册；预设剔除 INTERNAL_USER_IDS。",
  },
  {
    metric: "激活漏斗：生成 / 成功 / 回访 / 首图耗时",
    source: "generation_job（拥有者 = web:<uid> 或 biz_api_key.user_id）",
    note: `回访 = 首次生成自然日（${STATISTICS_DAY_TIMEZONE}）后 1..${RETURN_WINDOW_DAYS} 日内另有一天有生成；首图耗时取 succeeded 任务 finished_at，分位数为最近秩（同 percentile_disc）。`,
  },
  {
    metric: "激活漏斗：付费",
    source: "account_ledger (entry_type='recharge', amount > 0)",
    note: "排除 seed/签到/新人礼/赠送类来源；只计注册之后的现金入帐。漏斗付费步要求已走完回访步，未回访即付费的人数单列。",
  },
  {
    metric: "模型三态",
    source: "GET /api/user/model-status（与 /v1/model-status 同一份判活）",
    note: "由管理页直接消费既有端点，不在此层重算。",
  },
];

/** 窗口内有帐本行的付费身份读取结果：ids 只是样本，覆盖事实一起回。 */
export interface BillingIdentityCoverage {
  ids: number[];
  /** 读取上限（每个身份一次上游 GET）。 */
  limit: number;
  /** 窗口内全部付费身份数（DB count(*) OVER ()，不是样本长度）。 */
  totalIdentities: number;
  /** true = 身份数超过上限，ids 只是前 limit 个。 */
  truncated: boolean;
}

export interface ChannelUsageNote {
  generatedAt: string;
  days: number;
  partial: boolean;
  notes: string[];
}

export interface StatisticsProjection {
  window: {
    days: number;
    generatedAt: string;
    dayTimezone: string;
    partial: boolean;
    /** 窗口起点所落的日界（YYYY-MM-DD）——该日为半天桶，与 byDay 的 partial 标记同源。 */
    windowStartDay: string;
  };
  configured: boolean;
  consumption: ConsumptionProjection | null;
  channelHealth: ChannelHealthEntry[];
  remainingQuota: RemainingQuotaProjection;
  /** 内部流量口径：消耗/剩余额度/漏斗三处共用同一份名单与开关。 */
  traffic: { includeInternal: boolean; internalUserIds: number[] };
  activationFunnel: ActivationFunnelResult;
  sources: StatisticsSourceRow[];
  notes: string[];
}

export const DEFAULT_INTERNAL_USER_IDS: readonly number[] = [117, 82];

/**
 * 非现金入帐来源：开户基线、签到、新人礼、赠送类一律不是「付费」。
 * 帐本现有来源：seed（开户基线，entry_type=opening）、redemption-sync（兑换码充值）、
 * subscription-redemption（订阅兑换）。新增赠送类来源时名称带以下任一词即自动排除。
 */
export const NON_CASH_RECHARGE_SOURCE = /seed|opening|checkin|check-in|welcome|gift|bonus|grant|promo|trial|newbie|signup|reward/i;

export interface FunnelRegistration {
  userId: number;
  /** ISO 时间（new-api users.created_at 秒 → ISO）。 */
  registeredAt: string;
}

export interface FunnelJob {
  userId: number;
  jobId: string;
  status: string;
  createdAt: string;
  finishedAt: string | null;
}

export interface FunnelRecharge {
  ledgerId: string;
  userId: number;
  source: string;
  createdAt: string;
}

export type FunnelStepKey = "registered" | "generated" | "succeeded" | "returned" | "paid";
export const FUNNEL_STEP_ORDER: readonly FunnelStepKey[] = ["registered", "generated", "succeeded", "returned", "paid"];

/**
 * 注册来源事实（first-touch）：userId → 分组键（`user_attribution.signup_source`）。
 * 没有列的用户（存量用户、cookie 被清掉的）归入 `UNATTRIBUTED_SOURCE`——
 * 不猜成 'direct'（direct 是一句真话：首触当下确实没带任何来源）。
 */
export interface FunnelAttribution {
  userId: number;
  source: string | null;
}

/** 按来源拆分的漏斗（每一格都是总漏斗对应步骤的子集，加总 = 总数）。 */
export interface FunnelSourceRow {
  source: string;
  registered: number;
  generated: number;
  succeeded: number;
  paid: number;
}

export interface FunnelStep {
  key: FunnelStepKey;
  count: number;
  userIds: number[];
  /** 相对上一步的转化率（第一步为 null）；分母 < MIN_RATE_SAMPLES 为 insufficient。 */
  fromPrevious: SampleRate | null;
  /** 相对注册数的转化率（第一步为 null）。 */
  fromRegistered: SampleRate | null;
}

export interface DurationSummary {
  samples: number;
  p50Seconds: number | null;
  p90Seconds: number | null;
}

export interface ActivationFunnelProjection {
  state: "ok";
  days: number;
  windowStart: string;
  includeInternal: boolean;
  internalUserIds: number[];
  /** 窗口内注册、但因内部名单被剔除的人数。 */
  excludedInternalRegistrations: number;
  steps: FunnelStep[];
  /** 成功用户中，首次生成日的下一个自然日（D1）有生成的人数。 */
  d1Returned: number;
  /** 成功用户中，首次生成日 + RETURN_WINDOW_DAYS 尚未走完（回访窗口未成熟）的人数。 */
  returnWindowImmature: number;
  /** 窗口内注册且有现金充值的人数（不论是否走完前面步骤）。 */
  paidAnyStage: number;
  /**
   * 按注册来源（first-touch）拆分的漏斗：每来源的注册 / 发起 / 成功 / 付费人数。
   * 各来源的每一格加总恒等于总漏斗对应步骤的人数（有具名测试）；没有归因事实的用户
   * 归入 `UNATTRIBUTED_SOURCE` 桶（展示层本地化为「未标记」）。
   */
  sources: FunnelSourceRow[];
  /** 归因读取失败（例如 025 迁移未套用）：`sources` 只剩未标记桶，必须在 UI 说出来。 */
  sourceBreakdownUnavailable: boolean;
  /** 被判为非现金而排除的 recharge 帐本行数。 */
  nonCashRechargesSkipped: number;
  timeToFirstImage: {
    /** 注册 → 首个 succeeded 任务的 finished_at。 */
    registerToFirstSuccess: DurationSummary;
    /** 首单（最早建立的任务）created_at → finished_at；未结束的首单不计入样本，单列。 */
    firstJobCreatedToFinished: DurationSummary & { unfinished: number; firstJobNotSucceeded: number };
  };
  /** 注册读取或任务读取触顶：人数为下界。 */
  truncated: boolean;
  dayTimezone: string;
}

export interface ActivationFunnelUnavailable {
  state: "unavailable";
  days: number;
  reason: string;
}

export type ActivationFunnelResult = ActivationFunnelProjection | ActivationFunnelUnavailable;

export type RegistrationLoader = (since: Date) => Promise<{ registrations: FunnelRegistration[]; truncated: boolean }>;
