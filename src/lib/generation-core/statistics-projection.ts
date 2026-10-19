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

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import {
  readSupplierChannelHealth,
  type SupplierChannelHealthRow,
} from "@/lib/supplier-health-signal";
import { UNATTRIBUTED_SOURCE } from "@/lib/first-touch-attribution";
import { readFunnelAttribution } from "@/lib/user-attribution";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { USAGE_ASSET_KIND_LABELS, usageAssetKindForJobKind, type UsageAssetKind } from "./usage-asset-kind";

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

interface BucketAccumulator {
  quota: number;
  operations: number;
  recordIds: string[];
}

/** 同一个 job 的帐本行归一组：净额＝组内 commit 之和 − refund 之和。 */
interface JobLedgerGroup {
  rows: LedgerConsumptionRow[];
  chargedQuota: number;
  refundedQuota: number;
}

/**
 * 把一组（一个 job）的净额记进桶子：quota 只加净额一次，帐本行数与记录 id 逐行累加
 * （行数是「帐本有几行」的事实，不会因为净额为负或相抵而消失）。
 */
function addGroupToBucket(
  buckets: Map<string, BucketAccumulator>,
  key: string,
  netQuota: number,
  group: JobLedgerGroup,
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { quota: 0, operations: 0, recordIds: [] };
    buckets.set(key, bucket);
  }
  bucket.quota += netQuota;
  for (const row of group.rows) {
    bucket.operations += 1;
    if (bucket.recordIds.length < RECORD_SAMPLE_LIMIT) bucket.recordIds.push(row.operationId);
  }
}

function toBuckets(
  buckets: Map<string, BucketAccumulator>,
  /**
   * 标签来源：`Map`（模型/渠道，key 是动态 id）或**唯读字面表**（类别切面，key 是封闭值域）。
   * 只读 `get`，两种形状都满足——不必为了共用一个函式把类别表包成 Map。
   */
  labels: { get(key: string): string | undefined },
): UsageBucket[] {
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      key,
      label: labels.get(key) ?? key,
      quota: bucket.quota,
      coins: quotaToCoins(bucket.quota),
      operations: bucket.operations,
      recordIds: bucket.recordIds,
    }))
    .sort((a, b) => b.quota - a.quota || a.key.localeCompare(b.key));
}

/**
 * 帐本行的纯聚合：按日 / 按模型 / 按渠道三个切面 + 未归因 + 已退款单列。
 *
 * 口径（本刀修正 C2-1）：消耗＝**净额**。帐本上一个 job 可能有两笔 operation
 * （commit 扣费、refund 退款），只取 commit 会把已退的钱算成消耗。故先按 job 相抵成净额，
 * 净额为 0（全额退款）的 job 不进任何消耗桶、不进「未归因」，帐本行单列进 `refunded`。
 *
 * 三切面的 quota 合计、以及 byChannel + unattributed，必须逐分毫不差地等于 totalQuota
 * （有具名测试逐桶验算）。零记录的维度不出现在结果里——没记录就是没记录。
 */
export function projectConsumption(
  rows: LedgerConsumptionRow[],
  options: { partialFromDay?: string | null } = {},
): ConsumptionProjection {
  const byDay = new Map<string, BucketAccumulator>();
  const byModel = new Map<string, BucketAccumulator>();
  const byChannel = new Map<string, BucketAccumulator>();
  // 生成物类别（P2-2／D8b）：第三个切面，判准只在 usage-asset-kind.ts 一处。
  const byAssetKind = new Map<string, BucketAccumulator>();
  const modelLabels = new Map<string, string>();
  const channelLabels = new Map<string, string>();
  const unattributed: BucketAccumulator = { quota: 0, operations: 0, recordIds: [] };
  const refundedRecordIds: string[] = [];
  const refundedJobs = new Set<string>();
  const netZeroRefundedJobs = new Set<string>();

  let chargedQuota = 0;
  let refundedQuota = 0;
  let chargedOperations = 0;
  let refundedOperations = 0;
  let skippedNonFiniteRows = 0;
  let netZeroRows = 0;

  const groups = new Map<string, JobLedgerGroup>();
  for (const row of rows) {
    // 非有限金额（NaN/Infinity/DB 脏值）：跳过并记帐，不当 0 计、也不冒充一笔 operation。
    if (!Number.isFinite(row.amountQuota)) {
      skippedNonFiniteRows += 1;
      continue;
    }
    let group = groups.get(row.jobId);
    if (!group) {
      group = { rows: [], chargedQuota: 0, refundedQuota: 0 };
      groups.set(row.jobId, group);
    }
    group.rows.push(row);
    if (row.kind === "refund") {
      group.refundedQuota += row.amountQuota;
      refundedQuota += row.amountQuota;
      refundedOperations += 1;
      refundedJobs.add(row.jobId);
      if (refundedRecordIds.length < RECORD_SAMPLE_LIMIT) refundedRecordIds.push(row.operationId);
    } else {
      group.chargedQuota += row.amountQuota;
      chargedQuota += row.amountQuota;
      chargedOperations += 1;
    }
  }

  for (const [jobId, group] of groups) {
    const netQuota = group.chargedQuota - group.refundedQuota;
    if (netQuota === 0) {
      // 全额退款（或两边相抵）：不画成消耗、不落「未归因」，单列已退款桶并留下帐本行 id。
      netZeroRows += group.rows.length;
      if (group.refundedQuota > 0) netZeroRefundedJobs.add(jobId);
      continue;
    }
    // 归因锚点取该 job 的扣费行（有则优先），否则退款行——日／模型切面因此仍可回溯帐本。
    // 净额挂在扣费行的日：退款不另占一天（退款没有自己的「消耗日」），只有纯退款组才用退款行的日。
    const anchor = group.rows.find((row) => row.kind === "commit") ?? group.rows[0];
    addGroupToBucket(byDay, anchor.day, netQuota, group);
    addGroupToBucket(byModel, anchor.modelId, netQuota, group);
    modelLabels.set(anchor.modelId, anchor.modelId);
    // 类别切面的锚点与日／模型同一个 job（同一组帐本行），所以三切面合计可逐桶对帐。
    const assetKind = usageAssetKindForJobKind(anchor.jobKind);
    addGroupToBucket(byAssetKind, assetKind, netQuota, group);
    if (anchor.channelId) {
      addGroupToBucket(byChannel, anchor.channelId, netQuota, group);
      channelLabels.set(anchor.channelId, anchor.channelLabel ?? anchor.channelId);
    } else {
      unattributed.quota += netQuota;
      unattributed.operations += group.rows.length;
      for (const row of group.rows) {
        if (unattributed.recordIds.length < RECORD_SAMPLE_LIMIT) unattributed.recordIds.push(row.operationId);
      }
    }
  }

  const totalQuota = chargedQuota - refundedQuota;
  return {
    totalQuota,
    totalCoins: quotaToCoins(totalQuota),
    operations: chargedOperations + refundedOperations,
    chargedQuota,
    chargedCoins: quotaToCoins(chargedQuota),
    chargedOperations,
    refundedQuota,
    refundedCoins: quotaToCoins(refundedQuota),
    refundedOperations,
    byDay: [...byDay.entries()]
      .map(([key, bucket]) => ({
        key,
        label: key,
        quota: bucket.quota,
        coins: quotaToCoins(bucket.quota),
        operations: bucket.operations,
        recordIds: bucket.recordIds,
        // 窗口起点落在这一天中间 → 半天桶，必须标记（不许画成完整日）。
        partial: options.partialFromDay === key,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    byModel: toBuckets(byModel, modelLabels),
    byChannel: toBuckets(byChannel, channelLabels),
    // 标签走共用词表（USAGE_ASSET_KIND_LABELS）——桶键即类别值域，呼叫端不必再映射。
    byAssetKind: toBuckets(byAssetKind, { get: (key: string) => USAGE_ASSET_KIND_LABELS[key as UsageAssetKind] }),
    unattributed: {
      quota: unattributed.quota,
      coins: quotaToCoins(unattributed.quota),
      operations: unattributed.operations,
      recordIds: unattributed.recordIds,
    },
    refunded: {
      quota: refundedQuota,
      coins: quotaToCoins(refundedQuota),
      operations: refundedOperations,
      jobs: refundedJobs.size,
      fullyRefundedJobs: netZeroRefundedJobs.size,
      netZeroRows,
      recordIds: refundedRecordIds,
    },
    skippedNonFiniteRows,
  };
}

/**
 * 窗口起点（now − days）在业务日界下所落的日（YYYY-MM-DD）。
 *
 * 为什么需要它：日界是 Asia/Shanghai 的自然日，窗口却是滚动的 `now() - N days`，
 * 两者唯一必然错位的地方就是最旧那一天——它只涵盖「起点之后」的半截。
 * 标注（byDay bucket 的 partial + notes）比强行对齐诚实：对齐会凭空砍掉半天的帐。
 * 注：这里用应用时钟，与 SQL 的 now() 最多差秒级；只有当两者跨过午夜才会标错一格。
 */
export function windowStartDay(input: { days: number; now: Date; dayTimezone?: string }): string {
  const timeZone = input.dayTimezone ?? STATISTICS_DAY_TIMEZONE;
  const start = new Date(input.now.getTime() - input.days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(start);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

// ── 渠道判活（三态） ─────────────────────────────────────────────────────────
// 与 /v1/model-status 的最终裁决层同源：`readSupplierChannelHealth` 用的条件与
// readSupplierHealthSignal（scheduler withHealthyAccount 的同一把尺）逐字相同，
// 差别只在按渠道分组、且保留诚实第三态。

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

/**
 * 三态判定只看两件事：有没有能力记录、能不能调度。
 * - 没有任何当前生效能力 → unknown（帐本无据可判，绝不折叠成「不可用」或「健康」）；
 * - 有能力但一个都调度不了 → unavailable；
 * - 至少一条可调度 → available。
 */
export function channelLivenessOf(row: {
  capabilities: number;
  schedulableCapabilities: number;
}): ChannelLiveness {
  if (row.capabilities <= 0) return "unknown";
  if (row.schedulableCapabilities <= 0) return "unavailable";
  return "available";
}

export function projectChannelHealth(rows: SupplierChannelHealthRow[]): ChannelHealthEntry[] {
  return rows
    .map((row) => {
      const successCount = Number(row.success_count ?? 0);
      const failureCount = Number(row.failure_count ?? 0);
      return {
        channelId: String(row.channel_id),
        label: String(row.label ?? row.channel_id),
        liveness: channelLivenessOf({
          capabilities: Number(row.capabilities ?? 0),
          schedulableCapabilities: Number(row.schedulable_capabilities ?? 0),
        }),
        reason: String(row.reason ?? ""),
        capabilities: Number(row.capabilities ?? 0),
        schedulableCapabilities: Number(row.schedulable_capabilities ?? 0),
        successCount,
        failureCount,
        successRate: sampleRate(successCount, successCount + failureCount),
        lastSuccessAt: row.last_success_at ? new Date(String(row.last_success_at)).toISOString() : null,
        lastFailureAt: row.last_failure_at ? new Date(String(row.last_failure_at)).toISOString() : null,
      };
    })
    .sort((a, b) => {
      const order: Record<ChannelLiveness, number> = { unavailable: 0, unknown: 1, available: 2 };
      return order[a.liveness] - order[b.liveness] || a.label.localeCompare(b.label);
    });
}

// ── 剩余额度 ────────────────────────────────────────────────────────────────

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

/** 未知额度绝不当 0 加总；未知的用户单列计数。 */
export function projectRemainingQuota(
  entries: RemainingQuotaEntry[],
  coverage?: Partial<QuotaCoverage>,
): RemainingQuotaProjection {
  const known = entries.filter((entry) => entry.state === "known" && typeof entry.quota === "number");
  const knownQuota = known.reduce((sum, entry) => sum + (entry.quota ?? 0), 0);
  const coveredCount = entries.length;
  const totalIdentities = Math.max(coverage?.totalIdentities ?? coveredCount, coveredCount);
  return {
    entries: [...entries].sort((a, b) => a.billingUserId - b.billingUserId),
    knownQuota,
    knownCoins: quotaToCoins(knownQuota),
    knownCount: known.length,
    unknownCount: entries.length - known.length,
    coverage: {
      limit: coverage?.limit ?? MAX_QUOTA_USERS,
      coveredCount,
      totalIdentities,
      // 呼叫方说截断，或帐本里的身份数多于实际读取的数量——两种都算截断。
      truncated: coverage?.truncated === true || totalIdentities > coveredCount,
    },
  };
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

// ── 查询层（只读） ──────────────────────────────────────────────────────────

function mapConsumptionRow(row: Record<string, unknown>): LedgerConsumptionRow {
  return {
    operationId: String(row.operation_id),
    jobId: String(row.job_id),
    modelId: String(row.model_id ?? "未知"),
    billingUserId: row.billing_user_id === null || row.billing_user_id === undefined ? null : Number(row.billing_user_id),
    channelId: row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id),
    channelLabel: row.channel_label === null || row.channel_label === undefined ? null : String(row.channel_label),
    amountQuota: Number(row.amount ?? 0),
    // 只有明确的 refund 才是负向；其余（含旧查询缺栏位的情况）按扣费处理。
    kind: String(row.operation_kind) === "refund" ? "refund" : "commit",
    appliedAt: new Date(String(row.applied_at)).toISOString(),
    day: String(row.day),
    // 生成物类别（P2-2／D8b）：唯一的落盘事实是 `generation_job.kind`——
    // 影片 ⇒ 分镜影片，图片 ⇒ 一般静态图，其余 unclassified。判准集中在
    // usage-asset-kind.ts（本档不自己再写一份映射，避免两处漂移）。
    jobKind: row.job_kind === null || row.job_kind === undefined ? null : String(row.job_kind),
    assetKind: usageAssetKindForJobKind(row.job_kind),
  };
}

/**
 * 窗口内的帐本行（只读 SELECT）：commit（扣费）与 refund（退款）都在内——
 * 只取 commit 就是把已退的钱算成消耗（C2-1）。写入类 operation（writeoff 平台损失、
 * release 解除预留、reserve 预留）不是用户消耗，刻意排除。
 */
export async function readLedgerConsumption(
  input: { days: number; sql?: GenerationSql; excludeUserIds?: number[] } = { days: DEFAULT_WINDOW_DAYS },
): Promise<LedgerConsumptionRow[]> {
  const sql = input.sql ?? getGenerationSql();
  const days = Math.max(1, Math.min(Math.floor(input.days), MAX_WINDOW_DAYS));
  const excluded = userIdArrayLiteral(input.excludeUserIds ?? []);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT operation.id AS operation_id,
           operation.job_id AS job_id,
           operation.operation AS operation_kind,
           job.model_id AS model_id,
           job.kind AS job_kind,
           job.billing_user_id AS billing_user_id,
           operation.amount AS amount,
           operation.applied_at AS applied_at,
           to_char(operation.applied_at AT TIME ZONE ${STATISTICS_DAY_TIMEZONE}, 'YYYY-MM-DD') AS day,
           attempt.supplier_id AS channel_id,
           supplier.label AS channel_label
    FROM billing_operation operation
    JOIN generation_job job ON job.id = operation.job_id
    LEFT JOIN LATERAL (
      SELECT candidate.supplier_id
      FROM generation_attempt candidate
      WHERE candidate.job_id = operation.job_id AND candidate.status = 'succeeded'
      ORDER BY candidate.attempt_no DESC
      LIMIT 1
    ) attempt ON true
    LEFT JOIN supplier ON supplier.id = attempt.supplier_id
    LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
    WHERE operation.operation IN ('commit', 'refund')
      AND operation.status = 'applied'
      AND operation.applied_at IS NOT NULL
      AND operation.applied_at >= now() - (${String(days)}::text || ' days')::interval
      AND COALESCE(
        COALESCE(
          CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
          owner_key.user_id::bigint,
          job.billing_user_id
        ) = ANY(${excluded}::bigint[]),
        false
      ) = false
    ORDER BY operation.applied_at DESC
    LIMIT ${LEDGER_ROW_LIMIT}
  `;
  return rows.map(mapConsumptionRow);
}

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

/**
 * 窗口内有帐本行（commit/refund applied）的付费身份（billing_user_id），供剩余额度读取。
 *
 * 截断必须可见：用 `count(*) OVER ()` 一次拿到全量身份数，超过上限时 truncated=true——
 * 以前只回一组被 LIMIT 砍过的 id，展示层无从知道「合计只是前 25 个之和」。
 */
export async function readBillingIdentityCoverage(
  input: { days: number; sql?: GenerationSql; excludeUserIds?: number[] } = { days: DEFAULT_WINDOW_DAYS },
): Promise<BillingIdentityCoverage> {
  const sql = input.sql ?? getGenerationSql();
  const days = Math.max(1, Math.min(Math.floor(input.days), MAX_WINDOW_DAYS));
  const excluded = userIdArrayLiteral(input.excludeUserIds ?? []);
  const rows = await sql<{ billing_user_id: string | number; total_identities: string | number }[]>`
    SELECT identity.billing_user_id AS billing_user_id,
           count(*) OVER () AS total_identities
    FROM (
      SELECT DISTINCT job.billing_user_id AS billing_user_id
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
      WHERE operation.operation IN ('commit', 'refund')
        AND operation.status = 'applied'
        AND operation.applied_at IS NOT NULL
        AND operation.applied_at >= now() - (${String(days)}::text || ' days')::interval
        AND job.billing_user_id IS NOT NULL
        AND COALESCE(
          COALESCE(
            CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
            owner_key.user_id::bigint,
            job.billing_user_id
          ) = ANY(${excluded}::bigint[]),
          false
        ) = false
    ) identity
    ORDER BY identity.billing_user_id
    LIMIT ${MAX_QUOTA_USERS}
  `;
  const ids = rows.map((row) => Number(row.billing_user_id)).filter((id) => Number.isFinite(id));
  const counted = rows.length > 0 ? Number(rows[0].total_identities) : 0;
  const totalIdentities = Number.isFinite(counted) && counted >= ids.length ? counted : ids.length;
  return { ids, limit: MAX_QUOTA_USERS, totalIdentities, truncated: totalIdentities > ids.length };
}

/** 渠道判活（只读），走 supplier-health-signal 的同一把尺。 */
export async function readChannelHealth(sql?: GenerationSql): Promise<ChannelHealthEntry[]> {
  return projectChannelHealth(await readSupplierChannelHealth(sql));
}

export interface ChannelUsageNote {
  generatedAt: string;
  days: number;
  partial: boolean;
  notes: string[];
}

/**
 * 窗口备注（每一条都是「这个数字有边界」的如实声明，不是装饰）：
 * 帐本扫描取满、金额非有限值被跳过、有退款相减、首日半天桶、身份读取截断——
 * 五种边界都在这里明说，展示层原样列出。
 */
export function buildUsageNotes(input: {
  days: number;
  rowCount: number;
  generatedAt?: string;
  skippedNonFiniteRows?: number;
  refundedOperations?: number;
  refundedQuota?: number;
  partialFromDay?: string | null;
  quotaCoverage?: QuotaCoverage;
}): ChannelUsageNote {
  const notes: string[] = [];
  const partial = input.rowCount >= LEDGER_ROW_LIMIT;
  if (partial) {
    notes.push(`帐本扫描达上限 ${LEDGER_ROW_LIMIT} 行，总数为下界，请缩小窗口。`);
  }
  if (input.rowCount === 0) {
    notes.push(
      "窗口内没有任何已落帐的扣费记录（billing_operation commit/refund applied 为 0 行）——不是 0 消耗曲线，是还没有记录。",
    );
  }
  if (input.refundedOperations) {
    notes.push(
      `窗口内另有 ${input.refundedOperations} 笔退款帐本行（billing_operation refund/applied，quota ${input.refundedQuota ?? 0}），已按同 job 净额相减并单列「已退款」。`,
    );
  }
  if (input.partialFromDay) {
    notes.push(
      `窗口起点落在 ${input.partialFromDay}（${STATISTICS_DAY_TIMEZONE}）日中，该日是半天桶（只含起点之后的记录），已在每日消耗标记为「部分」。`,
    );
  }
  if (input.skippedNonFiniteRows) {
    notes.push(
      `帐本有 ${input.skippedNonFiniteRows} 行金额非有限值，已整行跳过（不当 0 计、也不冒充一笔 operation）——请人工查这几行帐。`,
    );
  }
  const coverage = input.quotaCoverage;
  if (coverage?.truncated) {
    notes.push(
      `窗口内付费身份共 ${coverage.totalIdentities} 个，超过单次读取上限 ${coverage.limit} 个：「剩余额度」合计只覆盖前 ${coverage.coveredCount} 个身份，不是全部身份的合计。`,
    );
  }
  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    days: input.days,
    partial,
    notes,
  };
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

/**
 * 统计页的唯一组装入口（只读）。控制面 DB 未配置时如实回 configured:false，
 * 不吐一个看起来正常的空报表（空报表比报错更会骗人）。
 */
export async function buildStatisticsProjection(input: {
  days?: number;
  sql?: GenerationSql;
  loadRemainingQuota?: (userIds: number[]) => Promise<RemainingQuotaEntry[]>;
  /** 注入时钟供测试（半天桶标记依赖「窗口起点落在哪一天」）。 */
  now?: Date;
  /** 是否计入内部流量（预设不计）。 */
  includeInternal?: boolean;
  /** 内部用户名单（预设读 env INTERNAL_USER_IDS）。 */
  internalUserIds?: number[];
  /** 激活漏斗时间窗（7 / 30，预设 30）。 */
  funnelDays?: number;
  loadRegistrations?: RegistrationLoader;
} = {}): Promise<StatisticsProjection> {
  const days = Math.max(1, Math.min(Math.floor(input.days ?? DEFAULT_WINDOW_DAYS), MAX_WINDOW_DAYS));
  const now = input.now ?? new Date();
  const generatedAt = now.toISOString();
  const partialFromDay = windowStartDay({ days, now });
  const includeInternal = input.includeInternal === true;
  const internalUserIds = input.internalUserIds ?? resolveInternalUserIds();
  const traffic = { includeInternal, internalUserIds };
  const excludeUserIds = includeInternal ? [] : internalUserIds;
  const funnelDays = input.funnelDays ?? DEFAULT_FUNNEL_DAYS;
  if (!input.sql && !generationDatabaseConfigured()) {
    return {
      window: { days, generatedAt, dayTimezone: STATISTICS_DAY_TIMEZONE, partial: false, windowStartDay: partialFromDay },
      configured: false,
      consumption: null,
      channelHealth: [],
      remainingQuota: projectRemainingQuota([]),
      traffic,
      activationFunnel: { state: "unavailable", days: funnelDays, reason: "控制面资料库未配置" },
      sources: STATISTICS_SOURCES,
      notes: ["本实例没有控制面资料库连线（GENERATION_DATABASE_URL），统计不可用。"],
    };
  }

  const sql = input.sql ?? getGenerationSql();
  const [rows, channelHealth, identityCoverage, activationFunnel] = await Promise.all([
    readLedgerConsumption({ days, sql, excludeUserIds }),
    readChannelHealth(sql).catch((error) => {
      console.error("[statistics] channel health read failed (回空清单，不猜健康)", error);
      return [] as ChannelHealthEntry[];
    }),
    readBillingIdentityCoverage({ days, sql, excludeUserIds }).catch((error) => {
      console.error("[statistics] billing identity list failed", error);
      return { ids: [], limit: MAX_QUOTA_USERS, totalIdentities: 0, truncated: false } as BillingIdentityCoverage;
    }),
    buildActivationFunnel({
      days: funnelDays,
      now,
      sql,
      internalUserIds,
      includeInternal,
      loadRegistrations: input.loadRegistrations,
    }),
  ]);

  const loadRemainingQuota = input.loadRemainingQuota ?? defaultLoadRemainingQuota;
  const remainingQuota = projectRemainingQuota(await loadRemainingQuota(identityCoverage.ids), identityCoverage);

  const usageNotes = buildUsageNotes({
    days,
    rowCount: rows.length,
    generatedAt,
    // 边界一律申报：跳过的非有限值行、退款相减、半天桶、身份截断。
    skippedNonFiniteRows: rows.filter((row) => !Number.isFinite(row.amountQuota)).length,
    refundedOperations: rows.filter((row) => row.kind === "refund" && Number.isFinite(row.amountQuota)).length,
    refundedQuota: rows
      .filter((row) => row.kind === "refund" && Number.isFinite(row.amountQuota))
      .reduce((sum, row) => sum + row.amountQuota, 0),
    partialFromDay,
    quotaCoverage: remainingQuota.coverage,
  });
  if (!includeInternal && internalUserIds.length > 0) {
    usageNotes.notes.push(
      `已剔除内部流量（用户 ${internalUserIds.join(", ")}，env INTERNAL_USER_IDS）：消耗、剩余额度、激活漏斗均不含其任务；渠道判活计数器是供应商级累计值，无法按用户拆分，不受此开关影响。`,
    );
  }
  return {
    window: {
      days,
      generatedAt: usageNotes.generatedAt,
      dayTimezone: STATISTICS_DAY_TIMEZONE,
      partial: usageNotes.partial,
      windowStartDay: partialFromDay,
    },
    configured: true,
    consumption: projectConsumption(rows, { partialFromDay }),
    channelHealth,
    remainingQuota,
    traffic,
    activationFunnel,
    sources: STATISTICS_SOURCES,
    notes: usageNotes.notes,
  };
}

/**
 * 剩余额度预设读法：new-api users.quota（与 quota-precheck 同通路、同真源）。
 * 读不到就是 unknown——凭证未配置、上游 5xx、帐号被删都如实标因，不以 0 充数。
 * 上限只在这里节流（每个身份一次上游 GET）；截断事实由 readBillingIdentityCoverage 的
 * totalIdentities/truncated 对外申报，不在这里静默吞掉。
 */
async function defaultLoadRemainingQuota(userIds: number[]): Promise<RemainingQuotaEntry[]> {
  if (userIds.length === 0) return [];
  const targets = userIds.slice(0, MAX_QUOTA_USERS);
  if (targets.length < userIds.length) {
    console.warn(
      `[statistics] remaining quota read capped at ${MAX_QUOTA_USERS} identities (given ${userIds.length}); 覆盖数已随 truncated 申报`,
    );
  }
  const { fetchGatewayUser } = await import("@/lib/gateway-admin");
  return Promise.all(
    targets.map(async (billingUserId): Promise<RemainingQuotaEntry> => {
      try {
        const user = await fetchGatewayUser(billingUserId);
        if (!user || !Number.isFinite(user.quota)) {
          return { billingUserId, state: "unknown", quota: null, coins: null, reason: "new-api 未回该用户额度" };
        }
        return {
          billingUserId,
          state: "known",
          quota: user.quota,
          coins: quotaToCoins(user.quota),
        };
      } catch (error) {
        return {
          billingUserId,
          state: "unknown",
          quota: null,
          coins: null,
          reason: error instanceof Error ? error.message : "new-api 读取失败",
        };
      }
    }),
  );
}

// ── 内部流量剔除 ─────────────────────────────────────────────────────────────
// 站长自测（117）与测试 key（82）占近 30 天绝大多数生成——混进统计就是「看起来有量」的假象。
// 内部名单唯一来源：env INTERNAL_USER_IDS（逗号分隔 new-api 用户 id）；未设置用预设名单，
// 明确设为空字串 = 没有内部用户（不剔除）。「用户」一律指任务拥有者：web:<uid> 直接取 uid，
// biz:<keyid> 取 biz_api_key.user_id（站长的 key 有记到别的计费身份上，只看 billing_user_id 会漏剔）。

export const DEFAULT_INTERNAL_USER_IDS: readonly number[] = [117, 82];

export function resolveInternalUserIds(raw: string | undefined = process.env.INTERNAL_USER_IDS): number[] {
  if (raw === undefined) return [...DEFAULT_INTERNAL_USER_IDS];
  const ids = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((id) => isPositiveUserId(id));
  return [...new Set(ids)].sort((a, b) => a - b);
}

function isPositiveUserId(id: number): boolean {
  return Number.isInteger(id) && id > 0;
}

/**
 * DB 时间 → ISO。postgres.js 回的是 Date：`String(date)` 会丢掉毫秒，同秒内建立的批次任务
 * 因此排不出先后（首单会被 id 字典序决定）——必须直接取 Date 的毫秒值。
 */
function dbTimeToIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** 整数 id → postgres 阵列字面量（只收正整数，作为绑定参数传入，不拼 SQL）。 */
function userIdArrayLiteral(ids: readonly number[]): string {
  return `{${ids.filter(isPositiveUserId).join(",")}}`;
}

// ── 激活漏斗 ────────────────────────────────────────────────────────────────
// 注册（new-api users.created_at）→ 发起过生成 → 至少一单成功 → 7 日内回访 → 现金充值。
// 每一步都是上一步的子集（严格漏斗，人数单调不增）；不在漏斗链上的事实（没回访就付费的人、
// D1 回访数）单列，不塞进漏斗改变语义。


/**
 * 非现金入帐来源：开户基线、签到、新人礼、赠送类一律不是「付费」。
 * 帐本现有来源：seed（开户基线，entry_type=opening）、redemption-sync（兑换码充值）、
 * subscription-redemption（订阅兑换）。新增赠送类来源时名称带以下任一词即自动排除。
 */
export const NON_CASH_RECHARGE_SOURCE = /seed|opening|checkin|check-in|welcome|gift|bonus|grant|promo|trial|newbie|signup|reward/i;

export function isCashRechargeSource(source: string): boolean {
  return !NON_CASH_RECHARGE_SOURCE.test(source);
}

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

/** 一个来源桶：分组键 + 该来源在各步骤的人数。 */
export function buildFunnelSourceRows(input: {
  registered: readonly number[];
  generated: readonly number[];
  succeeded: readonly number[];
  paid: readonly number[];
  attribution?: readonly FunnelAttribution[];
}): FunnelSourceRow[] {
  const sourceOf = new Map<number, string>();
  for (const row of input.attribution ?? []) {
    const source = typeof row.source === "string" && row.source.trim() ? row.source.trim() : UNATTRIBUTED_SOURCE;
    sourceOf.set(row.userId, source);
  }
  const sourceFor = (userId: number) => sourceOf.get(userId) ?? UNATTRIBUTED_SOURCE;

  const buckets = new Map<string, FunnelSourceRow>();
  const bucketFor = (source: string): FunnelSourceRow => {
    const existing = buckets.get(source);
    if (existing) return existing;
    const created: FunnelSourceRow = { source, registered: 0, generated: 0, succeeded: 0, paid: 0 };
    buckets.set(source, created);
    return created;
  };

  // 只以 registered 开桶（后续步骤都是 registered 的子集 ⇒ 每一格必定落在既有桶里，
  // 加总恒等于总数；不在 cohort 内的归因列不会凭空造出一个来源）。
  for (const userId of input.registered) bucketFor(sourceFor(userId)).registered += 1;
  for (const userId of input.generated) bucketFor(sourceFor(userId)).generated += 1;
  for (const userId of input.succeeded) bucketFor(sourceFor(userId)).succeeded += 1;
  for (const userId of input.paid) bucketFor(sourceFor(userId)).paid += 1;

  return [...buckets.values()].sort(
    (a, b) => b.registered - a.registered || a.source.localeCompare(b.source),
  );
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

/** 按业务日界切自然日（YYYY-MM-DD）。 */
export function calendarDayOf(iso: string, timeZone: string = STATISTICS_DAY_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayNumber(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

/**
 * 回访判定（D1 / 7 日内）：以首次生成的自然日为 D0，D0+1..D0+withinDays 任一天有生成即回访。
 * 同一天生成多次不算回访；超过窗口才再来也不算。
 */
export function returnedWithin(
  jobDays: readonly string[],
  withinDays: number = RETURN_WINDOW_DAYS,
): { returned: boolean; d1: boolean; firstDay: string | null } {
  if (jobDays.length === 0) return { returned: false, d1: false, firstDay: null };
  const numbers = [...new Set(jobDays.map(dayNumber))].sort((a, b) => a - b);
  const first = numbers[0];
  const firstDay = [...jobDays].sort()[0];
  const offsets = numbers.slice(1).map((value) => value - first);
  return {
    returned: offsets.some((offset) => offset >= 1 && offset <= withinDays),
    d1: offsets.includes(1),
    firstDay,
  };
}

/** 最近秩分位数（与 postgres percentile_disc 同口径）：排序后取第 ceil(p·n) 个。 */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function summarizeDurations(values: number[]): DurationSummary {
  return {
    samples: values.length,
    p50Seconds: nearestRankPercentile(values, 0.5),
    p90Seconds: nearestRankPercentile(values, 0.9),
  };
}

/**
 * 激活漏斗的纯投影。输入是三份原始事实（注册、任务、充值帐本行），
 * 内部剔除、时间窗、回访判定、现金判定都在这里一次做完——SQL 对照即对照这里的口径。
 */
export function projectActivationFunnel(input: {
  days: number;
  now: Date;
  registrations: FunnelRegistration[];
  jobs: FunnelJob[];
  recharges: FunnelRecharge[];
  internalUserIds: readonly number[];
  includeInternal: boolean;
  truncated?: boolean;
  dayTimezone?: string;
  /** 首次触达归因（可缺；缺＝全部归入未标记桶，加总仍等于总数）。 */
  attribution?: readonly FunnelAttribution[];
  /** 归因读取失败旗标（由组装层传入，投影本身不做 I/O 判断）。 */
  sourceBreakdownUnavailable?: boolean;
}): ActivationFunnelProjection {
  const timeZone = input.dayTimezone ?? STATISTICS_DAY_TIMEZONE;
  const windowStartMs = input.now.getTime() - input.days * 86_400_000;
  const internal = new Set(input.internalUserIds);

  const inWindow = input.registrations.filter((registration) => {
    const at = Date.parse(registration.registeredAt);
    return Number.isFinite(at) && at >= windowStartMs && at <= input.now.getTime();
  });
  const cohort = new Map<number, number>();
  let excludedInternalRegistrations = 0;
  for (const registration of inWindow) {
    if (!input.includeInternal && internal.has(registration.userId)) {
      excludedInternalRegistrations += 1;
      continue;
    }
    cohort.set(registration.userId, Date.parse(registration.registeredAt));
  }

  // 每个用户的任务（只计注册之后的——注册前不可能有自己的任务，防脏资料）。
  const jobsByUser = new Map<number, FunnelJob[]>();
  for (const job of input.jobs) {
    const registeredAt = cohort.get(job.userId);
    if (registeredAt === undefined) continue;
    const createdAt = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAt) || createdAt < registeredAt) continue;
    const list = jobsByUser.get(job.userId) ?? [];
    list.push(job);
    jobsByUser.set(job.userId, list);
  }

  const cashPaid = new Set<number>();
  let nonCashRechargesSkipped = 0;
  for (const recharge of input.recharges) {
    const registeredAt = cohort.get(recharge.userId);
    if (registeredAt === undefined) continue;
    if (!isCashRechargeSource(recharge.source)) {
      nonCashRechargesSkipped += 1;
      continue;
    }
    const at = Date.parse(recharge.createdAt);
    if (Number.isFinite(at) && at >= registeredAt) cashPaid.add(recharge.userId);
  }

  const todayNumber = dayNumber(calendarDayOf(input.now.toISOString(), timeZone));
  const registered = [...cohort.keys()].sort((a, b) => a - b);
  const generated: number[] = [];
  const succeeded: number[] = [];
  const returned: number[] = [];
  const paid: number[] = [];
  let d1Returned = 0;
  let returnWindowImmature = 0;
  const registerToFirstSuccess: number[] = [];
  const firstJobDurations: number[] = [];
  let firstJobUnfinished = 0;
  let firstJobNotSucceeded = 0;

  for (const userId of registered) {
    const jobs = (jobsByUser.get(userId) ?? []).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.jobId.localeCompare(b.jobId),
    );
    if (jobs.length === 0) continue;
    generated.push(userId);

    const firstJob = jobs[0];
    if (firstJob.status !== "succeeded") firstJobNotSucceeded += 1;
    if (firstJob.finishedAt) {
      firstJobDurations.push((Date.parse(firstJob.finishedAt) - Date.parse(firstJob.createdAt)) / 1000);
    } else {
      firstJobUnfinished += 1;
    }

    const successes = jobs.filter((job) => job.status === "succeeded" && job.finishedAt);
    if (successes.length === 0) continue;
    succeeded.push(userId);
    const firstSuccessFinished = Math.min(...successes.map((job) => Date.parse(job.finishedAt as string)));
    registerToFirstSuccess.push((firstSuccessFinished - (cohort.get(userId) as number)) / 1000);

    const days = jobs.map((job) => calendarDayOf(job.createdAt, timeZone));
    const verdict = returnedWithin(days);
    if (verdict.d1) d1Returned += 1;
    if (verdict.firstDay && dayNumber(verdict.firstDay) + RETURN_WINDOW_DAYS > todayNumber) returnWindowImmature += 1;
    if (!verdict.returned) continue;
    returned.push(userId);

    if (cashPaid.has(userId)) paid.push(userId);
  }

  const counts: Record<FunnelStepKey, number[]> = { registered, generated, succeeded, returned, paid };
  const steps: FunnelStep[] = FUNNEL_STEP_ORDER.map((key, index) => {
    const ids = counts[key];
    const previous = index === 0 ? null : counts[FUNNEL_STEP_ORDER[index - 1]];
    return {
      key,
      count: ids.length,
      userIds: ids,
      fromPrevious: previous === null ? null : sampleRate(ids.length, previous.length),
      fromRegistered: index === 0 ? null : sampleRate(ids.length, registered.length),
    };
  });

  return {
    state: "ok",
    days: input.days,
    windowStart: new Date(windowStartMs).toISOString(),
    includeInternal: input.includeInternal,
    internalUserIds: [...input.internalUserIds],
    excludedInternalRegistrations,
    steps,
    d1Returned,
    returnWindowImmature,
    paidAnyStage: cashPaid.size,
    nonCashRechargesSkipped,
    sources: buildFunnelSourceRows({
      registered,
      generated,
      succeeded,
      paid,
      attribution: input.attribution,
    }),
    sourceBreakdownUnavailable: input.sourceBreakdownUnavailable === true,
    timeToFirstImage: {
      registerToFirstSuccess: summarizeDurations(registerToFirstSuccess),
      firstJobCreatedToFinished: {
        ...summarizeDurations(firstJobDurations),
        unfinished: firstJobUnfinished,
        firstJobNotSucceeded,
      },
    },
    truncated: input.truncated === true,
    dayTimezone: timeZone,
  };
}

/**
 * 漏斗的任务事实（只读）：拥有者 = web:<uid> 的 uid，或 biz key 的 user_id。
 * 只读给定用户、给定起点之后的任务。
 */
export async function readFunnelJobs(input: {
  userIds: number[];
  since: Date;
  sql?: GenerationSql;
}): Promise<{ jobs: FunnelJob[]; truncated: boolean }> {
  if (input.userIds.length === 0) return { jobs: [], truncated: false };
  const sql = input.sql ?? getGenerationSql();
  const ids = userIdArrayLiteral(input.userIds);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT scoped.owner_user_id AS owner_user_id,
           scoped.job_id AS job_id,
           scoped.status AS status,
           scoped.created_at AS created_at,
           scoped.finished_at AS finished_at
    FROM (
      SELECT COALESCE(
               CASE WHEN job.tenant_id ~ '^web:[0-9]+$' THEN split_part(job.tenant_id, ':', 2)::bigint END,
               owner_key.user_id::bigint
             ) AS owner_user_id,
             job.id AS job_id,
             job.status AS status,
             job.created_at AS created_at,
             job.finished_at AS finished_at
      FROM generation_job job
      LEFT JOIN biz_api_key owner_key ON job.tenant_id = 'biz:' || owner_key.id
      WHERE job.created_at >= ${input.since.toISOString()}::timestamptz
    ) scoped
    WHERE scoped.owner_user_id = ANY(${ids}::bigint[])
    ORDER BY scoped.created_at
    LIMIT ${FUNNEL_JOB_ROW_LIMIT}
  `;
  return {
    jobs: rows.map((row) => ({
      userId: Number(row.owner_user_id),
      jobId: String(row.job_id),
      status: String(row.status),
      createdAt: dbTimeToIso(row.created_at),
      finishedAt: row.finished_at ? dbTimeToIso(row.finished_at) : null,
    })),
    truncated: rows.length >= FUNNEL_JOB_ROW_LIMIT,
  };
}

/** 漏斗的充值事实（只读）：account_ledger entry_type='recharge'，现金判定在投影层做。 */
export async function readFunnelRecharges(input: {
  userIds: number[];
  since: Date;
  sql?: GenerationSql;
}): Promise<FunnelRecharge[]> {
  if (input.userIds.length === 0) return [];
  const sql = input.sql ?? getGenerationSql();
  const ids = userIdArrayLiteral(input.userIds);
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ledger.id AS ledger_id,
           ledger.billing_user_id AS ledger_user_id,
           ledger.source AS ledger_source,
           ledger.created_at AS ledger_created_at
    FROM account_ledger ledger
    WHERE ledger.entry_type = 'recharge'
      AND ledger.amount > 0
      AND ledger.billing_user_id = ANY(${ids}::bigint[])
      AND ledger.created_at >= ${input.since.toISOString()}::timestamptz
  `;
  return rows.map((row) => ({
    ledgerId: String(row.ledger_id),
    userId: Number(row.ledger_user_id),
    source: String(row.ledger_source ?? ""),
    createdAt: dbTimeToIso(row.ledger_created_at),
  }));
}

export type RegistrationLoader = (since: Date) => Promise<{ registrations: FunnelRegistration[]; truncated: boolean }>;

/** 注册预设读法：new-api 管理 API（不直连 sqlite）。 */
async function defaultLoadRegistrations(since: Date): Promise<{ registrations: FunnelRegistration[]; truncated: boolean }> {
  const { listGatewayUsersRegisteredSince } = await import("@/lib/gateway-admin");
  const { users, truncated } = await listGatewayUsersRegisteredSince(Math.floor(since.getTime() / 1000));
  return {
    registrations: users.map((user) => ({
      userId: user.id,
      registeredAt: new Date(user.created_at * 1000).toISOString(),
    })),
    truncated,
  };
}

/** 漏斗组装：任何一段读不到就整卡 unavailable 并说原因——不画半截漏斗。 */
export async function buildActivationFunnel(input: {
  days: number;
  now: Date;
  sql: GenerationSql;
  internalUserIds: number[];
  includeInternal: boolean;
  loadRegistrations?: RegistrationLoader;
}): Promise<ActivationFunnelResult> {
  const days = (FUNNEL_WINDOW_OPTIONS as readonly number[]).includes(input.days) ? input.days : DEFAULT_FUNNEL_DAYS;
  const since = new Date(input.now.getTime() - days * 86_400_000);
  try {
    const loaded = await (input.loadRegistrations ?? defaultLoadRegistrations)(since);
    const internal = new Set(input.internalUserIds);
    const cohortIds = loaded.registrations
      .map((registration) => registration.userId)
      .filter((id) => input.includeInternal || !internal.has(id));
    const [jobResult, recharges, attribution] = await Promise.all([
      readFunnelJobs({ userIds: cohortIds, since, sql: input.sql }),
      readFunnelRecharges({ userIds: cohortIds, since, sql: input.sql }),
      readFunnelAttribution({ userIds: cohortIds, sql: input.sql }),
    ]);
    return projectActivationFunnel({
      days,
      now: input.now,
      registrations: loaded.registrations,
      jobs: jobResult.jobs,
      recharges,
      internalUserIds: input.internalUserIds,
      includeInternal: input.includeInternal,
      truncated: loaded.truncated || jobResult.truncated,
      attribution: attribution.rows,
      sourceBreakdownUnavailable: !attribution.ok,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[statistics] activation funnel unavailable", reason);
    return { state: "unavailable", days, reason };
  }
}
