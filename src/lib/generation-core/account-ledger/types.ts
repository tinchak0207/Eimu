import type { GatewayAdminUser } from "@/lib/gateway-admin";
import type { GenerationSql } from "../database";
import type { LedgerPool } from "../subscription-sku";

export type LedgerEntryType =
  | "opening"
  | "recharge"
  | "consumption"
  | "refund"
  | "transfer_out"
  | "transfer_in"
  | "adjustment"
  // REQ-D3：订阅续期的「下一期替换而非累加」——把旧期未用完余额在**写入时**作废。
  // 与 lazy 过期（读取时判定）是两件事：时间到＝不落帐；续费替换＝真的有一笔事件。
  | "expire";

export type { LedgerPool };

export type LedgerDirection = "credit" | "debit";

export interface LedgerEntryDraft {
  billingUserId: number;
  entryType: LedgerEntryType;
  /** 有号金额（quota 单位）：正 = 加项，负 = 减项。 */
  amount: number;
  /** 写入者（'billing-projection' / 'member-quota' / 'seed' / …）。 */
  source: string;
  /** 外部事实位址（'job:<id>' / 'billing-op:<id>' / 'redemption:<id>' …）。 */
  sourceRef: string;
  /** 一次性判重键。 */
  idempotencyRef: string;
  /** 池维度（REQ-D3）：未指定 = 永久池（020 既有列与所有旧呼叫端语义不变）。 */
  pool?: LedgerPool;
  /** 订阅期次身份（永久池为 null/省略）；订阅池必填。 */
  termRef?: string | null;
  /** 该期到期时刻 ISO（永久池为 null/省略）；订阅池必填。 */
  expiresAt?: string | null;
  jobId?: string | null;
  operationId?: string | null;
  counterpartyUserId?: number | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}

export interface LedgerEntry {
  id: string;
  billingUserId: number;
  entryType: LedgerEntryType;
  amount: number;
  source: string;
  sourceRef: string;
  idempotencyRef: string;
  /**
   * 池维度（可选：020 期间落地的列与测试自建的记录集没有这一栏，一律按永久池读）。
   * 判定一律走 subscription-sku 的 poolOf()，别处不得自己 `?? "permanent"`。
   */
  pool?: LedgerPool | null;
  termRef?: string | null;
  expiresAt?: string | null;
  jobId: string | null;
  operationId: string | null;
  counterpartyUserId: number | null;
  note: string | null;
  createdAt: string;
}

export interface PostLedgerResult {
  /** 真正落地的 idempotency_ref。 */
  inserted: string[];
  /** 已存在（重放/并发）而被 ON CONFLICT 跳过的。 */
  duplicates: string[];
  /** 本地契约检查拒收（方向不符、缺来源、金额非整数等）——记帐端 bug，必须可见。 */
  rejected: { idempotencyRef: string; reason: string }[];
  /** SQL/连线层失败（记帐端不挡钱路，只回报）。 */
  errors: string[];
}

export interface AccountBalance {
  billingUserId: number;
  /** Σ amount（quota 单位，可为负）。 */
  quota: number;
  coins: number;
  credits: number;
  debits: number;
  entryCount: number;
  /** 各类型加总（未出现的类型不列出——没帐就是没帐）。 */
  byType: Partial<Record<LedgerEntryType, { quota: number; entries: number }>>;
}

/**
 * 基线不可得的类别（E1-b D-2）：决定呼叫端能不能安全地动上游。
 *
 *   store_unavailable    帐本储存层未配置（C 端降级实例，没有帐本权威）→ 呼叫端照旧走钱路
 *   upstream_unavailable 上游 users.quota 读不到（基线不明）→ 帐本权威实例上不得动上游
 *   ledger_unavailable   基线行落不了地（INSERT 失败／回读不到基线行）→ 不得动上游
 */
export type OpeningFailureKind = "store_unavailable" | "upstream_unavailable" | "ledger_unavailable";

export interface OpeningSeedResult {
  billingUserId: number;
  /** true = 本次真的种进去（第一次）；false = 已有基线（重放幂等）或基线不可得。 */
  seeded: boolean;
  /**
   * 基线值（**经回读确认**帐本里真的有这一行的 amount）；不可得为 null。
   *
   * 为什么只有回读确认过的基线才回非 null（E1-b D-2 必修）：基线 INSERT 失败时若仍回
   * 上游读数，呼叫端会以为「基线就绪」→ 照常动上游并记增量，但帐本里没有基线行；
   * 之后 lazy 种子读到**扣款后**的 users.quota 当基线 → 同一笔消费算两次，差额永久存在。
   */
  baselineQuota: number | null;
  reason?: string;
  /** baselineQuota === null 时的分类；null = 基线已就位（回读确认过）。 */
  failure?: OpeningFailureKind | null;
  /** 基线行是否经**回读确认**存在（不是「函式回了非 null」）。 */
  verified?: boolean;
}

export interface OpeningDeps {
  sql?: GenerationSql;
  fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
  now?: () => Date;
}

/** 基线闸门的完整结论（呼叫端据 `blocked` 决定能不能动上游）。 */
export interface BaselineGuardResult {
  /** 全部身份的基线都经回读确认存在。 */
  ready: boolean;
  /**
   * **不得动上游**：帐本储存层已配置（有帐本权威）、但基线不成立——包括
   * ①基线行落不了地（ledger_unavailable）②上游 users.quota 读不到（upstream_unavailable）。
   * 储存层未配置的降级实例（C 端站点副本）回 false：那里本来就没有帐本权威，不改变既有行为。
   */
  blocked: boolean;
  /** 不可得的身份与分类（ready=false 时非空）。 */
  failures: { billingUserId: number; failure: OpeningFailureKind; reason: string }[];
}

export interface PendingWriteOutcome {
  posted: boolean;
  reason?: string;
}

/**
 * 写入器共通依赖。`fetchUser` 是基线读法的注入点（测试与 worker 用同一条生产通路：
 * 默认 fetchGatewayUser）。基线种不进去＝放弃记这次增量（见 ensureOpeningBeforeWrite）。
 */
export interface LedgerWriterDeps {
  sql?: GenerationSql;
  fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
}

export interface RechargeIngestSummary {
  scanned: number;
  charged: number;
  /** 基线前兑换、以「充值＋冲销」两条腿入帐的笔数（净额 0，仅为让来源可见）。 */
  chargedBaselineAbsorbed: number;
  skippedUnused: number;
  /** 基线前且连冲销腿都写不进去（挡下）的笔数——非 0 即为待查。 */
  skippedBeforeBaseline: number;
  skippedNoUser: number;
  /** REQ-D3：带订阅 SKU 标记的码（由 subscription.ts 的订阅通道入帐，本通道**不得**再记一笔）。 */
  skippedSubscription: number;
  errors: string[];
}
