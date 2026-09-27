// 管理側統計視圖的只讀投影層（PRD REQ-C2「Statistics 統計視圖」）。
//
// 斷頭台紀律（本檔存在的理由）：這裡的每一個數字都必須能指回一條真實記錄——
// 消費/用量指回 `billing_operation` 的**淨額**（operation='commit' 的 applied 行
// 減 operation='refund' 的 applied 行，同窗口逐 job 相抵——退款是另一筆 operation，
// 只看 commit 就是把已退的錢算成消耗）；
// 渠道歸因指回 `generation_attempt`（delivered 的那次嘗試）→ `supplier`；
// 渠道判活指回 `supplier_capability` / `supplier` / `supplier_account`（與
// `supplier-health-signal.ts` 同一把尺）；剩餘額度指回 new-api `users.quota`
// （`fetchGatewayUser`，與 quota-precheck 的生產讀法同源）。
//
// 四條禁令（違反 = 假報表）：
// 1. 無事件源的數字不畫：沒有帳本行的日子就是「沒有記錄」，不補 0 曲線；
//    沒有 capability 行的渠道就是 unknown，不猜測健康。
// 2. 樣本不足不畫 0：比率樣本 < MIN_RATE_SAMPLES 時回 `insufficient`，
//    展示層畫「資料不足」而不是 0%——0% 是一句假話。
// 3. 只讀：本檔一條 INSERT / UPDATE / DELETE 都沒有（有具名測試守門）。
// 4. **截斷必須可見**（本刀新增）：帳本掃描、身份讀取、金額解析三處都有上限／
//    異常值——取滿、超上限、金額非有限值一律如實標記（partial / truncated /
//    skipped），不許把「部分之和」畫成全量，也不許把非有限值靜默當 0 再算一筆。
//
// 順帶說明為何不重算「健康分」：scheduler 判活的尺只有「能不能調度」
// （enabled + health_status <> disabled + 未冷卻），沒有任何連續評分。
// 自己造一個 0-100 健康分就是自造健康度，故只回三態 + 真實計數器原值。

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import {
  readSupplierChannelHealth,
  type SupplierChannelHealthRow,
} from "@/lib/supplier-health-signal";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";

/** 比率的最小樣本門檻：與 routing-telemetry 的 latencyP80（<3 樣本回 null）同一把尺。 */
export const MIN_RATE_SAMPLES = 3;
/** 每個聚合桶最多帶回幾條帳本行 id（供「數字→記錄」對照，不是全量）。 */
export const RECORD_SAMPLE_LIMIT = 5;
/** 「每日」的日界時區：業務在 CST，UTC 日界會把晚間消耗切到前一天。 */
export const STATISTICS_DAY_TIMEZONE = "Asia/Shanghai";
export const DEFAULT_WINDOW_DAYS = 7;
export const MAX_WINDOW_DAYS = 30;
/** 帳本掃描上限；取滿即標 partial（總數變下界，必須如實說）。 */
export const LEDGER_ROW_LIMIT = 5_000;
/** 剩餘額度讀取上限（每個用戶一次上游 GET，避免統計頁打爆 new-api）；超上限必須標 truncated。 */
export const MAX_QUOTA_USERS = 25;
/** 激活漏斗時間窗（天）。 */
export const FUNNEL_WINDOW_OPTIONS = [7, 30] as const;
export const DEFAULT_FUNNEL_DAYS = 30;
/** 回訪判定：首次生成日之後 1..RETURN_WINDOW_DAYS 個自然日內另有一天有生成。 */
export const RETURN_WINDOW_DAYS = 7;
/** 漏斗取任務行的上限；取滿即標 truncated（後續步驟變下界）。 */
export const FUNNEL_JOB_ROW_LIMIT = 20_000;

/** 帳本 operation：commit＝扣費（正向），refund＝退款（同一 job 的負向，用來抵消費）。 */
export type LedgerOperationKind = "commit" | "refund";

/** quota 單位 → 幣（與 task-response.resolveTaskCostCoins 同一匯率與精度）。 */
export function quotaToCoins(quota: number): number {
  return Math.round((quota / QUOTA_PER_COIN) * 1e6) / 1e6;
}

/** 一條帳本消費行（billing_operation commit/refund applied，已 join 完模型與渠道）。 */
export interface LedgerConsumptionRow {
  operationId: string;
  jobId: string;
  modelId: string;
  billingUserId: number | null;
  /** delivered 那次嘗試的供應商 id；無成功嘗試 → null（未歸因，不猜）。 */
  channelId: string | null;
  channelLabel: string | null;
  /** 帳本行原值（一律 >= 0）；方向由 `kind` 決定，refund 是負向。 */
  amountQuota: number;
  /** 帳本 operation：commit＝扣費，refund＝退款（同窗口同 job 相減）。 */
  kind: LedgerOperationKind;
  appliedAt: string;
  /** 已按 STATISTICS_DAY_TIMEZONE 切好的日界（YYYY-MM-DD）。 */
  day: string;
}

/** 樣本是否足夠撐起一個比率。不足時 `value` 缺席——不許拿 0 冒充。 */
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
  /** 該桶前 RECORD_SAMPLE_LIMIT 條帳本行 id（數字→記錄對照）。 */
  recordIds: string[];
  /**
   * 只有「按日」桶會用到：true = 這一天的窗口起點落在該日中間（半天桶，
   * 只統計起點之後的記錄），不是一個完整日的量。標註而非對齊：見 windowStartDay。
   */
  partial?: boolean;
}

export interface ConsumptionProjection {
  /** 淨消耗 = Σ(commit.applied) − Σ(refund.applied)（同窗口逐 job 相抵，可為負）。 */
  totalQuota: number;
  totalCoins: number;
  /** 計入的帳本行數（commit + refund；金額非有限值的行已跳過、不計）。 */
  operations: number;
  /** 扣費總額（Σ commit.applied）——淨額的減項來源，單列供對帳。 */
  chargedQuota: number;
  chargedCoins: number;
  chargedOperations: number;
  /** 已退款總額（Σ refund.applied，正數）。 */
  refundedQuota: number;
  refundedCoins: number;
  refundedOperations: number;
  byDay: UsageBucket[];
  byModel: UsageBucket[];
  byChannel: UsageBucket[];
  /** 帳本有行但找不到 delivered 嘗試的淨消耗——如實單列，不攤進任何渠道。 */
  unattributed: { quota: number; coins: number; operations: number; recordIds: string[] };
  /** 退款單列（不攤進任何消耗桶、不落「未歸因」）：口徑變了，數字才能對上帳本。 */
  refunded: RefundedBucket;
  /** 金額非有限值而被跳過的帳本行數（不當 0 計、不冒充一筆 operation）。 */
  skippedNonFiniteRows: number;
}

/**
 * 已退款單列桶：退款是**另一筆** operation，不是消耗的一部分。
 * 全額退款的 job（同窗口扣費與退款相抵為 0）整個從消耗桶移出，只在這裡留痕＋帳本行 id。
 */
export interface RefundedBucket {
  /** Σ refund.applied（正數，單位 quota）。 */
  quota: number;
  coins: number;
  /** 退款帳本行數。 */
  operations: number;
  /** 涉及的 job 數。 */
  jobs: number;
  /** 同窗口扣費與退款相抵為 0 的 job 數（全額退款）。 */
  fullyRefundedJobs: number;
  /** 這些相抵為 0 的 job 的帳本行數（不進任何消耗桶，計在已退款桶）。 */
  netZeroRows: number;
  recordIds: string[];
}

interface BucketAccumulator {
  quota: number;
  operations: number;
  recordIds: string[];
}

/** 同一個 job 的帳本行歸一組：淨額＝組內 commit 之和 − refund 之和。 */
interface JobLedgerGroup {
  rows: LedgerConsumptionRow[];
  chargedQuota: number;
  refundedQuota: number;
}

/**
 * 把一組（一個 job）的淨額記進桶子：quota 只加淨額一次，帳本行數與記錄 id 逐行累加
 * （行數是「帳本有幾行」的事實，不會因為淨額為負或相抵而消失）。
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
  labels: Map<string, string>,
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
 * 帳本行的純聚合：按日 / 按模型 / 按渠道三個切面 + 未歸因 + 已退款單列。
 *
 * 口徑（本刀修正 C2-1）：消耗＝**淨額**。帳本上一個 job 可能有兩筆 operation
 * （commit 扣費、refund 退款），只取 commit 會把已退的錢算成消耗。故先按 job 相抵成淨額，
 * 淨額為 0（全額退款）的 job 不進任何消耗桶、不進「未歸因」，帳本行單列進 `refunded`。
 *
 * 三切面的 quota 合計、以及 byChannel + unattributed，必須逐分毫不差地等於 totalQuota
 * （有具名測試逐桶驗算）。零記錄的維度不出現在結果裡——沒記錄就是沒記錄。
 */
export function projectConsumption(
  rows: LedgerConsumptionRow[],
  options: { partialFromDay?: string | null } = {},
): ConsumptionProjection {
  const byDay = new Map<string, BucketAccumulator>();
  const byModel = new Map<string, BucketAccumulator>();
  const byChannel = new Map<string, BucketAccumulator>();
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
    // 非有限金額（NaN/Infinity/DB 髒值）：跳過並記帳，不當 0 計、也不冒充一筆 operation。
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
      // 全額退款（或兩邊相抵）：不畫成消耗、不落「未歸因」，單列已退款桶並留下帳本行 id。
      netZeroRows += group.rows.length;
      if (group.refundedQuota > 0) netZeroRefundedJobs.add(jobId);
      continue;
    }
    // 歸因錨點取該 job 的扣費行（有則優先），否則退款行——日／模型切面因此仍可回溯帳本。
    // 淨額掛在扣費行的日：退款不另佔一天（退款沒有自己的「消耗日」），只有純退款組才用退款行的日。
    const anchor = group.rows.find((row) => row.kind === "commit") ?? group.rows[0];
    addGroupToBucket(byDay, anchor.day, netQuota, group);
    addGroupToBucket(byModel, anchor.modelId, netQuota, group);
    modelLabels.set(anchor.modelId, anchor.modelId);
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
        // 窗口起點落在這一天中間 → 半天桶，必須標記（不許畫成完整日）。
        partial: options.partialFromDay === key,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    byModel: toBuckets(byModel, modelLabels),
    byChannel: toBuckets(byChannel, channelLabels),
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
 * 窗口起點（now − days）在業務日界下所落的日（YYYY-MM-DD）。
 *
 * 為什麼需要它：日界是 Asia/Shanghai 的自然日，窗口卻是滾動的 `now() - N days`，
 * 兩者唯一必然錯位的地方就是最舊那一天——它只涵蓋「起點之後」的半截。
 * 標註（byDay bucket 的 partial + notes）比強行對齊誠實：對齊會憑空砍掉半天的帳。
 * 註：這裡用應用時鐘，與 SQL 的 now() 最多差秒級；只有當兩者跨過午夜才會標錯一格。
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

// ── 渠道判活（三態） ─────────────────────────────────────────────────────────
// 與 /v1/model-status 的最終裁決層同源：`readSupplierChannelHealth` 用的條件與
// readSupplierHealthSignal（scheduler withHealthyAccount 的同一把尺）逐字相同，
// 差別只在按渠道分組、且保留誠實第三態。

export type ChannelLiveness = "available" | "unavailable" | "unknown";

export interface ChannelHealthEntry {
  channelId: string;
  label: string;
  liveness: ChannelLiveness;
  reason: string;
  capabilities: number;
  schedulableCapabilities: number;
  /** supplier 表上的真實計數器（非推算）。 */
  successCount: number;
  failureCount: number;
  successRate: SampleRate;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export const CHANNEL_LIVENESS_LABEL: Record<ChannelLiveness, string> = {
  available: "可用",
  unavailable: "不可用",
  unknown: "無法判定",
};

/**
 * 三態判定只看兩件事：有沒有能力記錄、能不能調度。
 * - 沒有任何當前生效能力 → unknown（帳本無據可判，絕不折疊成「不可用」或「健康」）；
 * - 有能力但一個都調度不了 → unavailable；
 * - 至少一條可調度 → available。
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

// ── 剩餘額度 ────────────────────────────────────────────────────────────────

export type QuotaState = "known" | "unknown";

export interface RemainingQuotaEntry {
  billingUserId: number;
  state: QuotaState;
  quota: number | null;
  coins: number | null;
  reason?: string;
}

/**
 * 覆蓋率：剩餘額度合計**只是被讀到的那幾個身份之和**（每個身份一次上游 GET，有硬上限）。
 * 身份數超過上限時 truncated=true，展示層必須標出來——把部分之和畫成全量就是假數字。
 */
export interface QuotaCoverage {
  /** 讀取上限（MAX_QUOTA_USERS）。 */
  limit: number;
  /** 實際嘗試讀取的身份數（= entries.length，含 unknown）。 */
  coveredCount: number;
  /** 窗口內全部付費身份數（帳本 count，不是樣本）。 */
  totalIdentities: number;
  /** true = 身份數超過上限，合計只覆蓋前 coveredCount 個。 */
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

/** 未知額度絕不當 0 加總；未知的用戶單列計數。 */
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
      // 呼叫方說截斷，或帳本裡的身份數多於實際讀取的數量——兩種都算截斷。
      truncated: coverage?.truncated === true || totalIdentities > coveredCount,
    },
  };
}

export interface StatisticsSourceRow {
  metric: string;
  source: string;
  note: string;
}

/** 每個數字指回哪張表——回報與 UI 共用同一份簽名。 */
export const STATISTICS_SOURCES: StatisticsSourceRow[] = [
  {
    metric: "用量 / 每日消耗 / 模型分佈 / 渠道用量",
    source: "billing_operation (operation IN ('commit','refund') AND status='applied') ⋈ generation_job",
    note: "淨額口徑：同一 job 同窗口內 Σcommit − Σrefund；全額退款不計入消耗、單列「已退款」。amount 為 quota 原值（1 幣 = 500000）。",
  },
  {
    metric: "渠道歸因",
    source: "generation_attempt (status='succeeded') → supplier",
    note: "取該任務實際交付的那次嘗試；找不到成功嘗試的行單列「未歸因」，不攤派。",
  },
  {
    metric: "渠道判活（三態）",
    source: "supplier_capability / supplier / supplier_account",
    note: "與 scheduler 及 /v1/model-status 執行側裁決同一把尺；無能力記錄者為 unknown。",
  },
  {
    metric: "剩餘額度",
    source: "new-api users.quota（GET /api/user/{id}）",
    note: `與 quota-precheck 同通路；讀不到即 unknown，不以 0 代替。每個身份一次上游 GET，上限 ${MAX_QUOTA_USERS} 個——超過即標 truncated 並如實給出覆蓋數。`,
  },
  {
    metric: "激活漏斗：註冊",
    source: "new-api users.created_at（GET /api/user/ 管理分頁）",
    note: "滾動窗口 now − 7/30 天內註冊；預設剔除 INTERNAL_USER_IDS。",
  },
  {
    metric: "激活漏斗：生成 / 成功 / 回訪 / 首圖耗時",
    source: "generation_job（擁有者 = web:<uid> 或 biz_api_key.user_id）",
    note: `回訪 = 首次生成自然日（${STATISTICS_DAY_TIMEZONE}）後 1..${RETURN_WINDOW_DAYS} 日內另有一天有生成；首圖耗時取 succeeded 任務 finished_at，分位數為最近秩（同 percentile_disc）。`,
  },
  {
    metric: "激活漏斗：付費",
    source: "account_ledger (entry_type='recharge', amount > 0)",
    note: "排除 seed/簽到/新人禮/贈送類來源；只計註冊之後的現金入帳。漏斗付費步要求已走完回訪步，未回訪即付費的人數單列。",
  },
  {
    metric: "模型三態",
    source: "GET /api/user/model-status（與 /v1/model-status 同一份判活）",
    note: "由管理頁直接消費既有端點，不在此層重算。",
  },
];

// ── 查詢層（只讀） ──────────────────────────────────────────────────────────

function mapConsumptionRow(row: Record<string, unknown>): LedgerConsumptionRow {
  return {
    operationId: String(row.operation_id),
    jobId: String(row.job_id),
    modelId: String(row.model_id ?? "未知"),
    billingUserId: row.billing_user_id === null || row.billing_user_id === undefined ? null : Number(row.billing_user_id),
    channelId: row.channel_id === null || row.channel_id === undefined ? null : String(row.channel_id),
    channelLabel: row.channel_label === null || row.channel_label === undefined ? null : String(row.channel_label),
    amountQuota: Number(row.amount ?? 0),
    // 只有明確的 refund 才是負向；其餘（含舊查詢缺欄位的情況）按扣費處理。
    kind: String(row.operation_kind) === "refund" ? "refund" : "commit",
    appliedAt: new Date(String(row.applied_at)).toISOString(),
    day: String(row.day),
  };
}

/**
 * 窗口內的帳本行（只讀 SELECT）：commit（扣費）與 refund（退款）都在內——
 * 只取 commit 就是把已退的錢算成消耗（C2-1）。寫入類 operation（writeoff 平台損失、
 * release 解除預留、reserve 預留）不是用戶消耗，刻意排除。
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

/** 窗口內有帳本行的付費身份讀取結果：ids 只是樣本，覆蓋事實一起回。 */
export interface BillingIdentityCoverage {
  ids: number[];
  /** 讀取上限（每個身份一次上游 GET）。 */
  limit: number;
  /** 窗口內全部付費身份數（DB count(*) OVER ()，不是樣本長度）。 */
  totalIdentities: number;
  /** true = 身份數超過上限，ids 只是前 limit 個。 */
  truncated: boolean;
}

/**
 * 窗口內有帳本行（commit/refund applied）的付費身份（billing_user_id），供剩餘額度讀取。
 *
 * 截斷必須可見：用 `count(*) OVER ()` 一次拿到全量身份數，超過上限時 truncated=true——
 * 以前只回一組被 LIMIT 砍過的 id，展示層無從知道「合計只是前 25 個之和」。
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

/** 渠道判活（只讀），走 supplier-health-signal 的同一把尺。 */
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
 * 窗口備註（每一條都是「這個數字有邊界」的如實聲明，不是裝飾）：
 * 帳本掃描取滿、金額非有限值被跳過、有退款相減、首日半天桶、身份讀取截斷——
 * 五種邊界都在這裡明說，展示層原樣列出。
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
    notes.push(`帳本掃描達上限 ${LEDGER_ROW_LIMIT} 行，總數為下界，請縮小窗口。`);
  }
  if (input.rowCount === 0) {
    notes.push(
      "窗口內沒有任何已落帳的扣費記錄（billing_operation commit/refund applied 為 0 行）——不是 0 消耗曲線，是還沒有記錄。",
    );
  }
  if (input.refundedOperations) {
    notes.push(
      `窗口內另有 ${input.refundedOperations} 筆退款帳本行（billing_operation refund/applied，quota ${input.refundedQuota ?? 0}），已按同 job 淨額相減並單列「已退款」。`,
    );
  }
  if (input.partialFromDay) {
    notes.push(
      `窗口起點落在 ${input.partialFromDay}（${STATISTICS_DAY_TIMEZONE}）日中，該日是半天桶（只含起點之後的記錄），已在每日消耗標記為「部分」。`,
    );
  }
  if (input.skippedNonFiniteRows) {
    notes.push(
      `帳本有 ${input.skippedNonFiniteRows} 行金額非有限值，已整行跳過（不當 0 計、也不冒充一筆 operation）——請人工查這幾行帳。`,
    );
  }
  const coverage = input.quotaCoverage;
  if (coverage?.truncated) {
    notes.push(
      `窗口內付費身份共 ${coverage.totalIdentities} 個，超過單次讀取上限 ${coverage.limit} 個：「剩餘額度」合計只覆蓋前 ${coverage.coveredCount} 個身份，不是全部身份的合計。`,
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
    /** 窗口起點所落的日界（YYYY-MM-DD）——該日為半天桶，與 byDay 的 partial 標記同源。 */
    windowStartDay: string;
  };
  configured: boolean;
  consumption: ConsumptionProjection | null;
  channelHealth: ChannelHealthEntry[];
  remainingQuota: RemainingQuotaProjection;
  /** 內部流量口徑：消耗/剩餘額度/漏斗三處共用同一份名單與開關。 */
  traffic: { includeInternal: boolean; internalUserIds: number[] };
  activationFunnel: ActivationFunnelResult;
  sources: StatisticsSourceRow[];
  notes: string[];
}

/**
 * 統計頁的唯一組裝入口（只讀）。控制面 DB 未配置時如實回 configured:false，
 * 不吐一個看起來正常的空報表（空報表比報錯更會騙人）。
 */
export async function buildStatisticsProjection(input: {
  days?: number;
  sql?: GenerationSql;
  loadRemainingQuota?: (userIds: number[]) => Promise<RemainingQuotaEntry[]>;
  /** 注入時鐘供測試（半天桶標記依賴「窗口起點落在哪一天」）。 */
  now?: Date;
  /** 是否計入內部流量（預設不計）。 */
  includeInternal?: boolean;
  /** 內部用戶名單（預設讀 env INTERNAL_USER_IDS）。 */
  internalUserIds?: number[];
  /** 激活漏斗時間窗（7 / 30，預設 30）。 */
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
      activationFunnel: { state: "unavailable", days: funnelDays, reason: "控制面資料庫未配置" },
      sources: STATISTICS_SOURCES,
      notes: ["本實例沒有控制面資料庫連線（GENERATION_DATABASE_URL），統計不可用。"],
    };
  }

  const sql = input.sql ?? getGenerationSql();
  const [rows, channelHealth, identityCoverage, activationFunnel] = await Promise.all([
    readLedgerConsumption({ days, sql, excludeUserIds }),
    readChannelHealth(sql).catch((error) => {
      console.error("[statistics] channel health read failed (回空清單，不猜健康)", error);
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
    // 邊界一律申報：跳過的非有限值行、退款相減、半天桶、身份截斷。
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
      `已剔除內部流量（用戶 ${internalUserIds.join(", ")}，env INTERNAL_USER_IDS）：消耗、剩餘額度、激活漏斗均不含其任務；渠道判活計數器是供應商級累計值，無法按用戶拆分，不受此開關影響。`,
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
 * 剩餘額度預設讀法：new-api users.quota（與 quota-precheck 同通路、同真源）。
 * 讀不到就是 unknown——憑證未配置、上游 5xx、帳號被刪都如實標因，不以 0 充數。
 * 上限只在這裡節流（每個身份一次上游 GET）；截斷事實由 readBillingIdentityCoverage 的
 * totalIdentities/truncated 對外申報，不在這裡靜默吞掉。
 */
async function defaultLoadRemainingQuota(userIds: number[]): Promise<RemainingQuotaEntry[]> {
  if (userIds.length === 0) return [];
  const targets = userIds.slice(0, MAX_QUOTA_USERS);
  if (targets.length < userIds.length) {
    console.warn(
      `[statistics] remaining quota read capped at ${MAX_QUOTA_USERS} identities (given ${userIds.length}); 覆蓋數已隨 truncated 申報`,
    );
  }
  const { fetchGatewayUser } = await import("@/lib/gateway-admin");
  return Promise.all(
    targets.map(async (billingUserId): Promise<RemainingQuotaEntry> => {
      try {
        const user = await fetchGatewayUser(billingUserId);
        if (!user || !Number.isFinite(user.quota)) {
          return { billingUserId, state: "unknown", quota: null, coins: null, reason: "new-api 未回該用戶額度" };
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
          reason: error instanceof Error ? error.message : "new-api 讀取失敗",
        };
      }
    }),
  );
}

// ── 內部流量剔除 ─────────────────────────────────────────────────────────────
// 站長自測（117）與測試 key（82）佔近 30 天絕大多數生成——混進統計就是「看起來有量」的假象。
// 內部名單唯一來源：env INTERNAL_USER_IDS（逗號分隔 new-api 用戶 id）；未設置用預設名單，
// 明確設為空字串 = 沒有內部用戶（不剔除）。「用戶」一律指任務擁有者：web:<uid> 直接取 uid，
// biz:<keyid> 取 biz_api_key.user_id（站長的 key 有記到別的計費身份上，只看 billing_user_id 會漏剔）。

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
 * DB 時間 → ISO。postgres.js 回的是 Date：`String(date)` 會丟掉毫秒，同秒內建立的批次任務
 * 因此排不出先後（首單會被 id 字典序決定）——必須直接取 Date 的毫秒值。
 */
function dbTimeToIso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** 整數 id → postgres 陣列字面量（只收正整數，作為綁定參數傳入，不拼 SQL）。 */
function userIdArrayLiteral(ids: readonly number[]): string {
  return `{${ids.filter(isPositiveUserId).join(",")}}`;
}

// ── 激活漏斗 ────────────────────────────────────────────────────────────────
// 註冊（new-api users.created_at）→ 發起過生成 → 至少一單成功 → 7 日內回訪 → 現金充值。
// 每一步都是上一步的子集（嚴格漏斗，人數單調不增）；不在漏斗鏈上的事實（沒回訪就付費的人、
// D1 回訪數）單列，不塞進漏斗改變語義。


/**
 * 非現金入帳來源：開戶基線、簽到、新人禮、贈送類一律不是「付費」。
 * 帳本現有來源：seed（開戶基線，entry_type=opening）、redemption-sync（兌換碼充值）、
 * subscription-redemption（訂閱兌換）。新增贈送類來源時名稱帶以下任一詞即自動排除。
 */
export const NON_CASH_RECHARGE_SOURCE = /seed|opening|checkin|check-in|welcome|gift|bonus|grant|promo|trial|newbie|signup|reward/i;

export function isCashRechargeSource(source: string): boolean {
  return !NON_CASH_RECHARGE_SOURCE.test(source);
}

export interface FunnelRegistration {
  userId: number;
  /** ISO 時間（new-api users.created_at 秒 → ISO）。 */
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

export interface FunnelStep {
  key: FunnelStepKey;
  count: number;
  userIds: number[];
  /** 相對上一步的轉化率（第一步為 null）；分母 < MIN_RATE_SAMPLES 為 insufficient。 */
  fromPrevious: SampleRate | null;
  /** 相對註冊數的轉化率（第一步為 null）。 */
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
  /** 窗口內註冊、但因內部名單被剔除的人數。 */
  excludedInternalRegistrations: number;
  steps: FunnelStep[];
  /** 成功用戶中，首次生成日的下一個自然日（D1）有生成的人數。 */
  d1Returned: number;
  /** 成功用戶中，首次生成日 + RETURN_WINDOW_DAYS 尚未走完（回訪窗口未成熟）的人數。 */
  returnWindowImmature: number;
  /** 窗口內註冊且有現金充值的人數（不論是否走完前面步驟）。 */
  paidAnyStage: number;
  /** 被判為非現金而排除的 recharge 帳本行數。 */
  nonCashRechargesSkipped: number;
  timeToFirstImage: {
    /** 註冊 → 首個 succeeded 任務的 finished_at。 */
    registerToFirstSuccess: DurationSummary;
    /** 首單（最早建立的任務）created_at → finished_at；未結束的首單不計入樣本，單列。 */
    firstJobCreatedToFinished: DurationSummary & { unfinished: number; firstJobNotSucceeded: number };
  };
  /** 註冊讀取或任務讀取觸頂：人數為下界。 */
  truncated: boolean;
  dayTimezone: string;
}

export interface ActivationFunnelUnavailable {
  state: "unavailable";
  days: number;
  reason: string;
}

export type ActivationFunnelResult = ActivationFunnelProjection | ActivationFunnelUnavailable;

/** 按業務日界切自然日（YYYY-MM-DD）。 */
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
 * 回訪判定（D1 / 7 日內）：以首次生成的自然日為 D0，D0+1..D0+withinDays 任一天有生成即回訪。
 * 同一天生成多次不算回訪；超過窗口才再來也不算。
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

/** 最近秩分位數（與 postgres percentile_disc 同口徑）：排序後取第 ceil(p·n) 個。 */
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
 * 激活漏斗的純投影。輸入是三份原始事實（註冊、任務、充值帳本行），
 * 內部剔除、時間窗、回訪判定、現金判定都在這裡一次做完——SQL 對照即對照這裡的口徑。
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

  // 每個用戶的任務（只計註冊之後的——註冊前不可能有自己的任務，防髒資料）。
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
 * 漏斗的任務事實（只讀）：擁有者 = web:<uid> 的 uid，或 biz key 的 user_id。
 * 只讀給定用戶、給定起點之後的任務。
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

/** 漏斗的充值事實（只讀）：account_ledger entry_type='recharge'，現金判定在投影層做。 */
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

/** 註冊預設讀法：new-api 管理 API（不直連 sqlite）。 */
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

/** 漏斗組裝：任何一段讀不到就整卡 unavailable 並說原因——不畫半截漏斗。 */
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
    const [jobResult, recharges] = await Promise.all([
      readFunnelJobs({ userIds: cohortIds, since, sql: input.sql }),
      readFunnelRecharges({ userIds: cohortIds, since, sql: input.sql }),
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
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error("[statistics] activation funnel unavailable", reason);
    return { state: "unavailable", days, reason };
  }
}
