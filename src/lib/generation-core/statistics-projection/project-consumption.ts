import { USAGE_ASSET_KIND_LABELS, usageAssetKindForJobKind, type UsageAssetKind } from "../usage-asset-kind";
import { LEDGER_ROW_LIMIT, RECORD_SAMPLE_LIMIT, STATISTICS_DAY_TIMEZONE, quotaToCoins, type ChannelUsageNote, type ConsumptionProjection, type LedgerConsumptionRow, type QuotaCoverage, type UsageBucket } from "./types";

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
