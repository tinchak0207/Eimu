// REQ-E1a 我方帐本（余额权威）——「客户可见余额的权威归我方帐本」（暴君 2026-09-23 裁定）。
//
// 为什么要有本档：waoowaoo BA-07「账本唯一 writer」。new-api 内核在 relay 前扣
// `users.quota`，与我方帐本构成双写（B1 真转移更让两层同时变动）；只要对外余额直接
// 读 new-api，我方就永远说不清「这个数字是怎么来的」。本档把对外余额的计算源搬回
// 我方帐本：`account_ledger` 是 append-only 的有号流水，余额 = Σ amount（单一公式，
// 见 computeAccountBalance）。new-api 的 users.quota 降格为「上游供货水位」与内核
// 执法点，只作对帐另一侧（见 account-reconciliation.ts）。
//
// 加项 / 减项（完整判别表，权威在本档）：
//   + opening      上线基线（以 new-api 当时 users.quota 种入，可为负）
//   + recharge     充值入帐（new-api 兑换码被使用）
//   + refund       任务退款
//   + transfer_in  B1 成员收到分配
//   ± adjustment   管理员加减额度（建户初始额度／人工补正）
//   − consumption  消费扣费（legacy reserve 的上游扣款、gate path 投影扣款）
//   − transfer_out B1 主帐划出给成员
//   不入帐：writeoff（平台自身损失，不影响用户 users.quota）。
//
// REQ-D3（订阅 SKU）在原模型上加**一个维度**（不新造第二条帐务通道）：每一列可标
//   pool        'permanent'（默认）｜'subscription'
//   term_ref    'sub:<订阅 id>:term:<期次序号>'（永久池 NULL）
//   expires_at  该期到期时刻（订阅池必填）
// 两个余额口径（单一权威在本档 + subscription-sku.ts）：
//   book(user)      = Σ amount                                    ← 帐面净额（对帐用，不变）
//   available(user) = 永久池 Σ + **未过期**订阅池 Σ（读取时 lazy 判定，不依赖 cron）
// 加减项新增一种：
//   − expire       订阅续期替换：旧期未用完余额在写入时作废（见 subscription.ts）
//
// 四条纪律：
//   1. append-only：只 INSERT。错帐靠再 INSERT 一笔反向 adjustment 更正，不改历史
//      （本档没有任何 UPDATE/DELETE account_ledger 的语句，测试具名守门）。
//   2. 幂等：每笔帐带 `idempotency_ref`（UNIQUE）。写入端重放同一件事 = 命中
//      ON CONFLICT DO NOTHING，不双算。
//   2b. 顺序铁律：**先 ensureAccountBaselines() 种基线，再动上游，最后记增量**。
//      颠倒顺序 = 基线已含该笔增量 + 帐本再记一次 = 双算（见 ensureAccountBaselines 注释）。
//   3. 不挡钱路：记帐失败只 console.error + 回传 false，永不让计费/上游调整路径失败。
//      差额由 E1b 的对帐报告如实指出（可解释优先于假装同步成功）。
//      唯一例外（E1-b D-2）：**基线不成立时不得动上游**——没有基线的上游变动无法归属，
//      lazy 种子之后会把它算进基线 ⇒ 同一笔增量算两次、差额永久存在。故此种情况回
//      blocked=true，由呼叫端在动上游之前就停手（见 ensureAccountBaselinesWithStatus）。
//   4. 方向由 entry_type 决定（signed 类型只有 opening/adjustment），签名不符的行
//      一律拒收——宁可不记，不记错方向的帐。

import { randomUUID } from "node:crypto";

import { fetchGatewayUser, listGatewayRedemptions, type GatewayAdminUser, type GatewayRedemption } from "@/lib/gateway-admin";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { quotaToCoins } from "./statistics-projection";
import {
  LEDGER_POOL_DEFAULT,
  computePoolBalances,
  isLedgerPool,
  parseSubscriptionCodeMarker,
  planConsumptionLegs,
  planRefundLegs,
  poolOf,
  subscriptionTermRef,
  type ConsumedPoolLeg,
  type LedgerPool,
  type PoolBalances,
} from "./subscription-sku";

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

/**
 * 每个 entry_type 的法定方向。`signed` = 加减皆可（基线可为负；人工调整两个方向
 * 都是合法更正）。这张表是「余额模型」的单一权威，不得在别处另立第二份判别。
 */
export const LEDGER_ENTRY_DIRECTION: Record<LedgerEntryType, LedgerDirection | "signed"> = {
  opening: "signed",
  recharge: "credit",
  consumption: "debit",
  refund: "credit",
  transfer_in: "credit",
  transfer_out: "debit",
  adjustment: "signed",
  expire: "debit",
};

/** 会计恒等式用的方向分类：opening/adjustment 按实际符号判。 */
export function ledgerDirectionOf(entryType: LedgerEntryType, amount: number): LedgerDirection {
  const fixed = LEDGER_ENTRY_DIRECTION[entryType];
  if (fixed === "credit") return "credit";
  if (fixed === "debit") return "debit";
  return amount >= 0 ? "credit" : "debit";
}

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

// ─────────────────────────────────────────── 纯函式：契约检查与余额

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

/**
 * 帐本行契约（纯函式，可单独测）：方向、来源、幂等键、金额。
 * 回 null = 可入帐；回字串 = 拒收原因。
 *
 * 金额 0 的唯一例外是 `opening`：0 基线是一句真话（「此刻这个身份没有可入帐的历史
 * 净额」），且它定下「哪一刻之后的充值才该入帐」的时间界线。其余类型 0 一律拒收。
 */
export function validateLedgerEntryDraft(draft: LedgerEntryDraft): string | null {
  if (!isFiniteInteger(draft.billingUserId) || draft.billingUserId <= 0) {
    return `billing_user_id 必须是正整数（收到 ${String(draft.billingUserId)}）`;
  }
  if (!isFiniteInteger(draft.amount)) {
    return `amount 必须是整数 quota（收到 ${String(draft.amount)}）`;
  }
  if (draft.amount === 0 && draft.entryType !== "opening") {
    return `amount 0 只允许出现在 opening 基线（${draft.entryType} 的 0 是空帐）`;
  }
  const direction = LEDGER_ENTRY_DIRECTION[draft.entryType];
  if (direction === undefined) return `未知的 entry_type：${String(draft.entryType)}`;
  if (direction === "credit" && draft.amount < 0) {
    return `${draft.entryType} 是加项，不得为负（收到 ${draft.amount}）`;
  }
  if (direction === "debit" && draft.amount > 0) {
    return `${draft.entryType} 是减项，不得为正（收到 ${draft.amount}）`;
  }
  if (!draft.source.trim()) return "source 必填（哪个写入器记的帐）";
  if (!draft.sourceRef.trim()) return "source_ref 必填（这笔帐指回哪一件外部事实）";
  if (!draft.idempotencyRef.trim()) return "idempotency_ref 必填（重放不得双算）";
  // 池维度契约（REQ-D3）：池值必须合法；订阅池的每一列必须带期次与到期时刻——
  // 没有这两个栏位，读取端就只能靠定时任务改余额（违反「过期只在读取时 lazy 判定」）。
  if (draft.pool !== undefined && !isLedgerPool(draft.pool)) {
    return `未知的 pool：${String(draft.pool)}`;
  }
  const pool = draft.pool ?? LEDGER_POOL_DEFAULT;
  if (pool === "subscription") {
    if (typeof draft.termRef !== "string" || !draft.termRef.trim()) {
      return "订阅池的帐本行必须带 term_ref（期次身份）";
    }
    if (typeof draft.expiresAt !== "string" || !Number.isFinite(Date.parse(draft.expiresAt))) {
      return `订阅池的帐本行必须带可解析的 expires_at（收到 ${String(draft.expiresAt)}）`;
    }
  }
  return null;
}

/**
 * 余额公式（唯一口径）：Σ amount。同一份帐本记录集在任何地方只能算出一个数字。
 * 非有限值整行跳过并回报（跳过的笔数计进 skippedRows——不当 0 加、不静默吞）。
 */
export function computeAccountBalance(
  entries: LedgerEntry[],
  billingUserId?: number,
): AccountBalance & { skippedRows: number } {
  const rows = billingUserId === undefined ? entries : entries.filter((entry) => entry.billingUserId === billingUserId);
  let quota = 0;
  let credits = 0;
  let debits = 0;
  let skippedRows = 0;
  const byType: AccountBalance["byType"] = {};
  for (const row of rows) {
    if (!Number.isFinite(row.amount)) {
      skippedRows += 1;
      continue;
    }
    quota += row.amount;
    if (ledgerDirectionOf(row.entryType, row.amount) === "credit") credits += row.amount;
    else debits += row.amount;
    const bucket = byType[row.entryType] ?? { quota: 0, entries: 0 };
    bucket.quota += row.amount;
    bucket.entries += 1;
    byType[row.entryType] = bucket;
  }
  return {
    billingUserId: billingUserId ?? Number.NaN,
    quota,
    coins: quotaToCoins(quota),
    credits,
    debits,
    entryCount: rows.length - skippedRows,
    byType,
    skippedRows,
  };
}

/**
 * 对外余额读取口的回应形体（`/v1/quota` 的契约）：与 2026-08-29 事故后定下的形状
 * **逐字相同**（success / balance_coins / currency）——本刀改的是数字的来源，不是形状。
 * 放在这里是为了让「契约」有一条可被真实断言的路径（路由只负责包 NextResponse）。
 * 币值换算沿用 statistics-projection 的 quotaToCoins（同一条换算式，不另立第二份）。
 */
export const QUOTA_RESPONSE_CURRENCY = "coins";

export function quotaResponseBody(quota: number): { success: true; balance_coins: number; currency: string } {
  return { success: true, balance_coins: quotaToCoins(quota), currency: QUOTA_RESPONSE_CURRENCY };
}

// ─────────────────────────────────────────── 纯函式：契约检查（幂等键）

/** 写入器用的幂等键约定（单一权威，别处不得自拼）。 */
export const ledgerRef = {
  opening: (userId: number) => `seed:${userId}:v1`,
  consumption: (operationId: string) => `billing-op:${operationId}:debit`,
  refund: (operationId: string) => `billing-op:${operationId}:credit`,
  /** 非首条出资腿/退款腿的幂等键（首条永远用上面那两个，维持既有帐本行的键不变）。 */
  consumptionLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:debit:${legIndex}`,
  refundLeg: (operationId: string, legIndex: number) => `billing-op:${operationId}:credit:${legIndex}`,
  transferOut: (transferId: string) => `transfer:${transferId}:out`,
  transferIn: (transferId: string) => `transfer:${transferId}:in`,
  recharge: (redemptionId: string | number) => `redemption:${String(redemptionId)}`,
  /** 基线冲销腿：充值发生在开户基线之前（金额已含在 opening 内）时的对冲行（见 ingest）。 */
  rechargeBaselineOffset: (redemptionId: string | number) => `redemption:${String(redemptionId)}:opening-offset`,
  adjustment: (sourceRef: string) => `adjustment:${sourceRef}`,
  /** REQ-D3 期次发放幂等键：(订阅 id, 期次序号)（不变量 ③）。 */
  subscriptionTerm: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}`,
  /** 续期替换（把上一期未用完余额作废）的幂等键。 */
  subscriptionReplace: (subscriptionId: string, termIndex: number) => `subscription:${subscriptionId}:term:${termIndex}:replace`,
  /**
   * 音乐生成按次扣费的幂等键（chargeId = `music:<keyId>:<ref>`，见 lib/music-charge.ts）。
   * 音乐没有 generation_job，也就没有 billing_operation.id ⇒ 不能沿用 consumption(operationId)
   * 那条键；这里给音乐单独一个约定（幂等键是单一权威，别处不得自拼）。
   */
  musicCharge: (chargeId: string) => `music-charge:${chargeId}:debit`,
} as const;

// ─────────────────────────────────────────── 写入层

type Row = Record<string, unknown>;

function mapLedgerRow(row: Row): LedgerEntry {
  return {
    id: String(row.id),
    billingUserId: Number(row.billing_user_id),
    entryType: String(row.entry_type) as LedgerEntryType,
    amount: Number(row.amount),
    source: String(row.source),
    sourceRef: String(row.source_ref),
    idempotencyRef: String(row.idempotency_ref),
    pool: isLedgerPool(row.pool) ? row.pool : LEDGER_POOL_DEFAULT,
    termRef: row.term_ref === null || row.term_ref === undefined ? null : String(row.term_ref),
    expiresAt:
      row.expires_at === null || row.expires_at === undefined ? null : new Date(String(row.expires_at)).toISOString(),
    jobId: row.job_id === null || row.job_id === undefined ? null : String(row.job_id),
    operationId: row.operation_id === null || row.operation_id === undefined ? null : String(row.operation_id),
    counterpartyUserId:
      row.counterparty_user_id === null || row.counterparty_user_id === undefined
        ? null
        : Number(row.counterparty_user_id),
    note: row.note === null || row.note === undefined ? null : String(row.note),
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

/** 帐本储存层可用吗（C 端 Vercel 没有控制面库 ⇒ 走降级，不炸）。 */
export function accountLedgerStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return generationDatabaseConfigured(env);
}

function metadataJson(draft: LedgerEntryDraft): string {
  try {
    return JSON.stringify({
      ...(draft.metadata ?? {}),
      entry_type: draft.entryType,
      source_ref: draft.sourceRef,
      pool: draft.pool ?? LEDGER_POOL_DEFAULT,
      ...(draft.termRef ? { term_ref: draft.termRef } : {}),
      ...(draft.expiresAt ? { expires_at: draft.expiresAt } : {}),
    });
  } catch {
    return JSON.stringify({ entry_type: draft.entryType, source_ref: draft.sourceRef, unserializable: true });
  }
}

async function insertLedgerRow(sql: GenerationSql, id: string, draft: LedgerEntryDraft): Promise<Row[]> {
  return sql<Row[]>`
    INSERT INTO account_ledger (
      id, billing_user_id, entry_type, amount, source, source_ref, idempotency_ref,
      job_id, operation_id, counterparty_user_id, note, metadata_json,
      pool, term_ref, expires_at
    ) VALUES (
      ${id}, ${draft.billingUserId}, ${draft.entryType}, ${draft.amount}, ${draft.source},
      ${draft.sourceRef}, ${draft.idempotencyRef}, ${draft.jobId ?? null}, ${draft.operationId ?? null},
      ${draft.counterpartyUserId ?? null}, ${draft.note ?? null}, ${metadataJson(draft)}::jsonb,
      ${draft.pool ?? LEDGER_POOL_DEFAULT}, ${draft.termRef ?? null}, ${draft.expiresAt ?? null}
    )
    ON CONFLICT (idempotency_ref) DO NOTHING
    RETURNING id, idempotency_ref
  `;
}

/**
 * 记一批帐（append-only + 幂等）。多笔时包在一个事务里——转移的两条腿要嘛都记、
 * 要嘛都不记（单腿落地 = 我方帐本自己制造不对称）。
 *
 * 永不 throw：本地契约拒收与 SQL 失败都只是回报值（记帐不挡钱路，第 3 条纪律）。
 */
export async function postLedgerEntries(
  drafts: LedgerEntryDraft[],
  deps: { sql?: GenerationSql; newId?: () => string } = {},
): Promise<PostLedgerResult> {
  const result: PostLedgerResult = { inserted: [], duplicates: [], rejected: [], errors: [] };
  const accepted: { id: string; draft: LedgerEntryDraft }[] = [];
  for (const draft of drafts) {
    const reason = validateLedgerEntryDraft(draft);
    if (reason) {
      result.rejected.push({ idempotencyRef: draft?.idempotencyRef ?? "(missing)", reason });
      console.error(`[account-ledger] 拒收帐本行 ref=${String(draft?.idempotencyRef)}：${reason}`);
      continue;
    }
    accepted.push({ id: (deps.newId ?? randomUUID)(), draft });
  }
  if (accepted.length === 0) return result;

  const sql = deps.sql ?? getGenerationSql();
  const write = async (handle: GenerationSql): Promise<void> => {
    for (const item of accepted) {
      const rows = await insertLedgerRow(handle, item.id, item.draft);
      if (rows[0]) result.inserted.push(item.draft.idempotencyRef);
      else result.duplicates.push(item.draft.idempotencyRef);
    }
  };

  try {
    if (accepted.length > 1 && typeof sql.begin === "function") {
      await sql.begin(async (tx) => {
        await write(tx as unknown as GenerationSql);
      });
    } else {
      await write(sql);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    result.errors.push(reason);
    console.error(`[account-ledger] 记帐失败（不挡钱路，差额由对帐报告负责）：${reason}`);
  }
  return result;
}

// ─────────────────────────────────────────── 读取层

export async function readAccountLedger(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<LedgerEntry[]> {
  const sql = deps.sql ?? getGenerationSql();
  const rows = await sql<Row[]>`
    SELECT id, billing_user_id, entry_type, amount, source, source_ref, idempotency_ref,
           job_id, operation_id, counterparty_user_id, note, created_at,
           pool, term_ref, expires_at
    FROM account_ledger
    WHERE billing_user_id = ${billingUserId}
    ORDER BY created_at, id
  `;
  return rows.map(mapLedgerRow);
}

/** 对外余额的唯一读法：取该身份帐本 → Σ amount。 */
export async function readAccountBalance(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<AccountBalance & { skippedRows: number }> {
  const entries = await readAccountLedger(billingUserId, deps);
  return computeAccountBalance(entries, billingUserId);
}

/**
 * 池余额的唯一读法（REQ-D3）：取该身份帐本 → 按池分堆 + **读取时 lazy 判定过期**。
 * 纯函式在 subscription-sku.ts（computePoolBalances），本函式只负责把帐本喂进去。
 */
export async function readPoolBalances(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<PoolBalances & { entries: LedgerEntry[] }> {
  const entries = await readAccountLedger(billingUserId, deps);
  const balances = computePoolBalances(entries, deps.nowMs ?? Date.now());
  return { ...balances, entries };
}

/**
 * **可用余额**（不变量 ①）：永久池 + 未过期订阅池。对外读取口与配额预检共用这一条。
 * 回 null ＝ 读不出来（储存层未配置／查询失败）——呼叫端据此走既有降级路径，
 * 绝不让「读不到」被当成 0 或当成「足够」。
 */
export async function readAvailableQuota(
  billingUserId: number,
  deps: { sql?: GenerationSql; nowMs?: number } = {},
): Promise<number | null> {
  try {
    const balances = await readPoolBalances(billingUserId, deps);
    return balances.availableQuota;
  } catch (error) {
    console.error(
      `[account-ledger] 可用余额读取失败 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ─────────────────────────────────────────── 基线（种子）

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

interface OpeningDeps {
  sql?: GenerationSql;
  fetchUser?: (userId: number) => Promise<GatewayAdminUser | null>;
  now?: () => Date;
}

type OpeningRead =
  | { status: "found"; amount: number }
  | { status: "absent" }
  | { status: "error"; reason: string };

/**
 * 读基线行（唯一判据：帐本里真的有这一行）。查询文本与写入端同一条幂等键，
 * 成功／失败／并发三条路径共用 ⇒ 「基线就绪」永远是回读的结论，不是函式回传值的推论。
 */
async function readOpeningRow(sql: GenerationSql, billingUserId: number): Promise<OpeningRead> {
  try {
    const rows = await sql<Row[]>`
      SELECT amount FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(billingUserId)} LIMIT 1
    `;
    if (!rows[0]) return { status: "absent" };
    const amount = Number(rows[0].amount);
    if (!Number.isFinite(amount)) return { status: "error", reason: `基线行金额非有限值（${String(rows[0].amount)}）` };
    return { status: "found", amount };
  } catch (error) {
    return { status: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 种入/确认基线：**上线基线 = new-api 当时的 users.quota**（历史净额已含在里面，
 * 故本表只记基线之后的增量，不得双算既有历史）。
 *
 * 幂等机制：idempotency_ref = `seed:<userId>:v1` 且 UNIQUE ⇒ 同一份 new-api 基线
 * 重放两次，第二次命中 ON CONFLICT DO NOTHING（实测见测试「重放不双算」）。
 *
 * 呼叫时机：对外余额第一次被读、或任何写入器动手前（见 ensureOpeningBeforeWrite）。
 * 「先种基线、后记增量」是防双算的关键：若先记了一笔扣费再种基线，基线已经含了
 * 那笔扣费 ⇒ 两边都算。
 */
export async function ensureAccountOpening(
  billingUserId: number,
  deps: OpeningDeps = {},
): Promise<OpeningSeedResult> {
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "帐本储存层未配置",
      failure: "store_unavailable",
      verified: false,
    };
  }
  const sql = deps.sql ?? getGenerationSql();

  const existing = await readOpeningRow(sql, billingUserId);
  if (existing.status === "error") {
    // 读不到（连线/语法/权限）：既不能说基线在、也不能说不在 ⇒ 回不可得（不得猜）。
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: `基线回读失败：${existing.reason}`,
      failure: "ledger_unavailable",
      verified: false,
    };
  }
  if (existing.status === "found") {
    return { billingUserId, seeded: false, baselineQuota: existing.amount, reason: "已有基线（重放）", failure: null, verified: true };
  }

  const fetchUser = deps.fetchUser ?? fetchGatewayUser;
  let user: GatewayAdminUser | null;
  try {
    user = await fetchUser(billingUserId);
  } catch (error) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: `基线读取失败：${error instanceof Error ? error.message : String(error)}`,
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!user || !Number.isFinite(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "new-api 未回该用户额度（基线不明）",
      failure: "upstream_unavailable",
      verified: false,
    };
  }
  if (!Number.isInteger(user.quota)) {
    return {
      billingUserId,
      seeded: false,
      baselineQuota: null,
      reason: "上游额度非整数，基线不可信",
      failure: "upstream_unavailable",
      verified: false,
    };
  }

  // 0 基线也照样入帐（amount=0 的 opening）：它不改变任何金额，但把「基线时刻」记下来，
  // 充值同步据此判断「这笔充值是否已含在基线里」。
  const posted = await postLedgerEntries(
    [
      {
        billingUserId,
        entryType: "opening",
        amount: Math.round(user.quota),
        source: "seed",
        sourceRef: `new-api:users/${billingUserId}@${(deps.now ?? (() => new Date()))().toISOString()}`,
        idempotencyRef: ledgerRef.opening(billingUserId),
        note: "上线基线：以 new-api users.quota 为起点，历史净额已含在此",
        metadata: { baseline_source: "new-api/users.quota" },
      },
    ],
    { sql },
  );

  // 唯一判据＝回读：INSERT 回报成功但读不到（或 INSERT 直接失败）都算基线未落地，
  // 一律回 null（呼叫端据此 503／不动上游），**不得**回一个上游读数当作「基线就绪」。
  const confirmed = await readOpeningRow(sql, billingUserId);
  if (confirmed.status !== "found") {
    const reason =
      confirmed.status === "error"
        ? `基线回读失败：${confirmed.reason}`
        : posted.errors[0] ?? posted.rejected[0]?.reason ?? "基线未落地（回读不到基线行）";
    console.error(`[account-ledger] 基线未落地 user=${billingUserId}（${reason}）——不得当成基线就绪`);
    return { billingUserId, seeded: false, baselineQuota: null, reason, failure: "ledger_unavailable", verified: false };
  }
  if (posted.inserted.length > 0) {
    return { billingUserId, seeded: true, baselineQuota: confirmed.amount, failure: null, verified: true };
  }
  return {
    billingUserId,
    seeded: false,
    baselineQuota: confirmed.amount,
    reason: posted.duplicates.length > 0 ? "并发种入（另一写入者已种）" : "基线已落地（回读确认）",
    failure: null,
    verified: true,
  };
}

/** 批量种基线（上线迁移工具用）。逐个幂等 ⇒ 整批可任意重放。 */
export async function seedAccountOpenings(
  billingUserIds: number[],
  deps: OpeningDeps = {},
): Promise<{ seeded: number[]; skipped: OpeningSeedResult[] }> {
  const seeded: number[] = [];
  const skipped: OpeningSeedResult[] = [];
  for (const userId of [...new Set(billingUserIds.filter((id) => Number.isInteger(id) && id > 0))]) {
    const result = await ensureAccountOpening(userId, deps);
    if (result.seeded) seeded.push(userId);
    else skipped.push(result);
  }
  return { seeded, skipped };
}

/**
 * 基线保证（**必须在动上游之前呼叫**，这是防双算的关键顺序）：
 *
 *   先种基线 →[上游扣/加]→ 再记增量
 *
 * 为什么顺序不能颠倒：基线取的是「当下 new-api users.quota」，若先动了上游再种基线，
 * 那笔增量已经被算进基线里，帐本再把同一件事记一次 = 双算（本刀端到端测试实锤：
 * B1 分配若不先种基线，主帐帐本会凭空少 2,000,000）。反之「先种基线、后动上游」是
 * 安全的：多种的基线是无害的（余额仍等于上游），而缺记的增量由 E1b 对帐报告负责。
 *
 * **基线就绪的判据＝回读确认**（不是「函式回了非 null」）：见 ensureOpeningBeforeWrite。
 * 基线不可得 → 放弃记这次增量；帐本权威实例（储存层已配置）上**连上游都不准动**，
 * 否则就留下一笔没有基线归属的上游变动，之后 lazy 种子读到变动后的 users.quota 当基线
 * ⇒ 同一笔增量算两次、差额永久存在（E1-b D-2 实测）。
 */
export async function ensureAccountBaselines(
  billingUserIds: number[],
  deps: LedgerWriterDeps = {},
): Promise<boolean> {
  return (await ensureAccountBaselinesWithStatus(billingUserIds, deps)).ready;
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

export async function ensureAccountBaselinesWithStatus(
  billingUserIds: number[],
  deps: LedgerWriterDeps = {},
): Promise<BaselineGuardResult> {
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    return {
      ready: false,
      blocked: false,
      failures: billingUserIds.map((billingUserId) => ({
        billingUserId,
        failure: "store_unavailable" as const,
        reason: "帐本储存层未配置",
      })),
    };
  }
  const sql = deps.sql ?? getGenerationSql();
  return ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser);
}

async function ensureOpeningBeforeWrite(
  billingUserIds: number[],
  sql: GenerationSql,
  fetchUser?: LedgerWriterDeps["fetchUser"],
): Promise<BaselineGuardResult> {
  // 帐本权威实例＝储存层已配置。降级实例没有帐本可记，挡上游只会弄坏可用性。
  const authoritative = accountLedgerStoreEnabled();
  for (const userId of [...new Set(billingUserIds)]) {
    const result = await ensureAccountOpening(userId, { sql, fetchUser });
    // 判据是「回读确认过的基线行」，不是回传值非 null（result.verified 由 readOpeningRow 定案）。
    if (result.baselineQuota !== null && result.verified !== false) continue;
    const failure: OpeningFailureKind = result.failure ?? "ledger_unavailable";
    const blocked = authoritative && failure !== "store_unavailable";
    console.error(
      `[account-ledger] 基线不可得 user=${userId}（${failure}：${result.reason}）——本次增量不记帐` +
        `${blocked ? "，且不得动上游（基线不成立＝上游变动无法归属）" : ""}`,
    );
    return { ready: false, blocked, failures: [{ billingUserId: userId, failure, reason: result.reason ?? "" }] };
  }
  return { ready: true, blocked: false, failures: [] };
}

// ─────────────────────────────────────────── 写入器（各钱路径呼叫）

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

async function withOpeningGuard(
  billingUserIds: number[],
  drafts: LedgerEntryDraft[],
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  if (!accountLedgerStoreEnabled() && !deps.sql) return { posted: false, reason: "帐本储存层未配置" };
  const sql = deps.sql ?? getGenerationSql();
  try {
    if (!(await ensureOpeningBeforeWrite(billingUserIds, sql, deps.fetchUser))) {
      return { posted: false, reason: "基线不可得，放弃记帐（对帐报告负责）" };
    }
    const result = await postLedgerEntries(drafts, { sql });
    if (result.errors.length > 0) return { posted: false, reason: result.errors[0] };
    if (result.rejected.length > 0) return { posted: false, reason: result.rejected[0].reason };
    return { posted: result.inserted.length > 0, reason: result.duplicates.length > 0 ? "已记过（重放）" : undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[account-ledger] 帐本写入异常（不挡钱路）：${reason}`);
    return { posted: false, reason };
  }
}

/** 消费扣费（legacy reserve 的上游扣款、gate path 投影扣款）。amount 取正数入帐为减项。
 *
 * REQ-D3：扣款**按池拆腿**（预设先扣订阅池、再扣永久池，见 CONSUMPTION_POOL_ORDER）。
 * 没有任何订阅资料时，只有一条永久池腿、幂等键与 020 期间逐字相同（行为零变化）。
 * 读帐本失败＝回退单一永久池腿：记帐永不挡钱路，池归属的缺口由对帐报告指出。
 */
export async function recordConsumption(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 指定扣款池（省略＝按 CONSUMPTION_POOL_ORDER 自动选）。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金额为 0，无帐可记" };
  const legs = await resolveConsumptionLegs(input.billingUserId, amount, input.pool, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "consumption" as const,
      amount: -leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.consumption(input.operationId) : ledgerRef.consumptionLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/**
 * 订阅池的「当前期」：未过期的期中最早到期的那一期（先到期先扣）。
 * 纯读帐本；拿不到就回 null（呼叫端据此不指定期次，不制造无效的订阅帐本行）。
 */
async function resolveConsumptionLegs(
  billingUserId: number,
  amountQuota: number,
  forcedPool: LedgerPool | undefined,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const permanentOnly = [{ pool: LEDGER_POOL_DEFAULT, termRef: null, expiresAt: null, amountQuota }];
  if (!accountLedgerStoreEnabled() && !deps.sql) return permanentOnly;
  if (forcedPool === "permanent") return permanentOnly;
  try {
    const balances = computePoolBalances(await readAccountLedger(billingUserId, deps), Date.now());
    const planned = planConsumptionLegs(amountQuota, balances);
    const legs = forcedPool === "subscription" ? planned.filter((leg) => leg.pool === "subscription") : planned;
    if (legs.length === 0) return permanentOnly;
    return legs.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 池余额读取失败，本次消费记在永久池 user=${billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return permanentOnly;
  }
}

/** 退款入帐（billing_operation refund applied 对应的上游 credit）。
 *
 * REQ-D3 **按原出资归还**：退款回到原本出资的池——订阅消耗退订阅池、永久消耗退永久池，
 * 不跨池搬。出资腿的事实来自帐本本身的消费行（不是重算一遍计划，避免两处口径漂移）。
 */
export async function recordRefund(
  input: {
    billingUserId: number;
    amountQuota: number;
    jobId: string;
    operationId: string;
    source: string;
    /** 帐本没有该 operation 的消费行时（历史资料）的兜底池。 */
    pool?: LedgerPool;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.abs(Math.round(input.amountQuota));
  if (amount === 0) return { posted: false, reason: "金额为 0，无帐可记" };
  const legs = await resolveRefundLegs(input, amount, deps);
  const drafts: LedgerEntryDraft[] = legs.map((leg, index) => {
    const primary = legs.length === 1;
    return {
      billingUserId: input.billingUserId,
      entryType: "refund" as const,
      amount: leg.amountQuota,
      source: input.source,
      sourceRef: `billing-op:${input.operationId}`,
      idempotencyRef: primary ? ledgerRef.refund(input.operationId) : ledgerRef.refundLeg(input.operationId, index + 1),
      pool: leg.pool,
      termRef: leg.termRef,
      expiresAt: leg.expiresAt,
      jobId: input.jobId,
      operationId: input.operationId,
      metadata: { amount_quota_abs: leg.amountQuota, pool_legs: legs.length, pool_leg_index: index + 1 },
    };
  });
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

async function resolveRefundLegs(
  input: { billingUserId: number; operationId: string; pool?: LedgerPool },
  amountQuota: number,
  deps: LedgerWriterDeps,
): Promise<{ pool: LedgerPool; termRef: string | null; expiresAt: string | null; amountQuota: number }[]> {
  const fallback = [
    {
      pool: input.pool ?? LEDGER_POOL_DEFAULT,
      termRef: null as string | null,
      expiresAt: null as string | null,
      amountQuota,
    },
  ];
  if (!accountLedgerStoreEnabled() && !deps.sql) return fallback;
  try {
    const entries = await readAccountLedger(input.billingUserId, deps);
    const consumed: ConsumedPoolLeg[] = entries
      .filter((entry) => entry.operationId === input.operationId && entry.entryType === "consumption" && entry.amount < 0)
      .map((entry) => ({
        pool: poolOf(entry),
        termRef: entry.termRef ?? null,
        expiresAt: entry.expiresAt ?? null,
        consumedQuota: Math.abs(entry.amount),
      }));
    if (consumed.length === 0) return fallback;
    const balances = computePoolBalances(entries, Date.now());
    const current = balances.terms.find((term) => !term.expired && term.expiresAt);
    const planned = planRefundLegs(amountQuota, consumed, {
      nowMs: Date.now(),
      ...(current && current.termRef !== "(no-term)" ? { currentTerm: { termRef: current.termRef, expiresAt: current.expiresAt as string } } : {}),
    });
    if (planned.length === 0) return fallback;
    return planned.map((leg) => ({ ...leg }));
  } catch (error) {
    console.error(
      `[account-ledger] 出资腿读取失败，本次退款记在兜底池 user=${input.billingUserId}：${error instanceof Error ? error.message : String(error)}`,
    );
    return fallback;
  }
}

/**
 * B1 分配/回收 = 真转移：主帐 −Δ、成员 +Δ，**两条腿同一个事务**记帐（单腿落地
 * = 我方帐本自己制造不对称）。amountQuota 传正数（划出方向），回收时呼叫端传负数
 * 由本函式翻向：正 = 主帐→成员，负 = 成员→主帐。
 */
export async function recordTransfer(
  input: {
    teamUserId: number;
    memberUserId: number;
    amountQuota: number;
    transferId: string;
    source: string;
    memberKeyId?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "转移金额为 0，无帐可记" };
  const outgoing = amount > 0;
  const magnitude = Math.abs(amount);
  const from = outgoing ? input.teamUserId : input.memberUserId;
  const to = outgoing ? input.memberUserId : input.teamUserId;
  const metadata = { transfer_id: input.transferId, member_key_id: input.memberKeyId ?? null };
  return withOpeningGuard(
    [from, to],
    [
      {
        billingUserId: from,
        entryType: "transfer_out",
        amount: -magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferOut(input.transferId),
        counterpartyUserId: to,
        metadata,
      },
      {
        billingUserId: to,
        entryType: "transfer_in",
        amount: magnitude,
        source: input.source,
        sourceRef: `transfer:${input.transferId}`,
        idempotencyRef: ledgerRef.transferIn(input.transferId),
        counterpartyUserId: from,
        metadata,
      },
    ],
    deps,
  );
}

/** 充值入帐（兑换码被使用）。source 决定「现金 / 非现金」语义（投影层据此判付费）。 */
export async function recordRecharge(
  input: {
    billingUserId: number;
    amountQuota: number;
    redemptionId: string | number;
    redemptionKey?: string;
    redeemedAt?: string | null;
    /** 省略＝现金通道（`redemption-sync`）；人工发码必须传非现金来源。 */
    source?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "充值金额非正数" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "recharge",
        amount,
        source: input.source ?? REDEMPTION_CASH_SOURCE,
        sourceRef: `redemption:${String(input.redemptionId)}`,
        idempotencyRef: ledgerRef.recharge(input.redemptionId),
        note: "new-api 兑换码已使用（充值入帐）",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null },
      },
    ],
    deps,
  );
}

/**
 * REQ-D3 期次切换（订阅池入帐，**不变量 ③**）：一次写入「本期发放」与（可选）「上一期
 * 未用完余额作废」。
 *
 *   发放行：entry_type=recharge、pool='subscription'、term_ref='sub:<id>:term:<n>'，
 *           expires_at = 本期到期时刻；幂等键 = `subscription:<id>:term:<n>`（就是
 *           「(订阅 id, 期次序号)」那条不变量）。
 *   替换行：entry_type=expire、amount = −旧期未用完额（写入时作废；replace 语义）。
 *           两行同一批 ⇒ 同一个事务，要嘛都记、要嘛都不记（不会出现「旧额已作废、
 *           新额却没发」的净损失）。
 *
 * 重放防护两层：①呼叫端先按 source_ref（redemption:<id>）判断同一张码是否已发过；
 * ②帐本 UNIQUE(idempotency_ref) 挡并发（同一期次只会落一次）。
 */
export async function recordSubscriptionTermSwitch(
  input: {
    billingUserId: number;
    subscriptionId: string;
    /** 本期期次序号（从 1 起算）。 */
    termIndex: number;
    /** 本期额度（quota）。 */
    termQuota: number;
    /** 本期到期时刻 ISO。 */
    expiresAt: string;
    /** 发放来源（'redemption:<id>'）。 */
    sourceRef: string;
    sku: string;
    grantedAt?: string | null;
    redemptionKey?: string | null;
    /** 要作废的上一期未用完余额（>0 才写 expire 行；由 subscription.ts 依替换语义算出）。 */
    replaced?: { termIndex: number; termRef: string; expiresAt: string; amountQuota: number } | null;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.termQuota);
  if (!Number.isFinite(amount) || amount <= 0) return { posted: false, reason: "期次额度非正数" };
  const drafts: LedgerEntryDraft[] = [
    {
      billingUserId: input.billingUserId,
      entryType: "recharge",
      amount,
      source: "subscription-redemption",
      sourceRef: input.sourceRef,
      idempotencyRef: ledgerRef.subscriptionTerm(input.subscriptionId, input.termIndex),
      pool: "subscription",
      termRef: subscriptionTermRef(input.subscriptionId, input.termIndex),
      expiresAt: input.expiresAt,
      note: `订阅期次发放（第 ${input.termIndex} 期）`,
      metadata: {
        subscription_id: input.subscriptionId,
        sku: input.sku,
        term_index: input.termIndex,
        granted_at: input.grantedAt ?? null,
        redemption_key: input.redemptionKey ?? null,
      },
    },
  ];
  if (input.replaced && Math.round(input.replaced.amountQuota) > 0) {
    const replaced = Math.round(input.replaced.amountQuota);
    drafts.push({
      billingUserId: input.billingUserId,
      entryType: "expire",
      amount: -replaced,
      source: "subscription-redemption",
      sourceRef: `${input.sourceRef}/replace-term-${input.replaced.termIndex}`,
      idempotencyRef: ledgerRef.subscriptionReplace(input.subscriptionId, input.replaced.termIndex),
      pool: "subscription",
      termRef: input.replaced.termRef,
      expiresAt: input.replaced.expiresAt,
      note: `续期替换：第 ${input.replaced.termIndex} 期未用完余额作废`,
      metadata: {
        subscription_id: input.subscriptionId,
        replaced_term_index: input.replaced.termIndex,
        replaced_quota: replaced,
        renewal_mode: "replace",
      },
    });
  }
  return withOpeningGuard([input.billingUserId], drafts, deps);
}

/** 管理员加减额度（建户初始额度、人工补正）。sourceRef 必填且要能指回操作人。 */
export async function recordAdjustment(
  input: {
    billingUserId: number;
    amountQuota: number;
    sourceRef: string;
    note: string;
    source?: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  if (!Number.isFinite(amount) || amount === 0) return { posted: false, reason: "调整金额为 0，无帐可记" };
  return withOpeningGuard(
    [input.billingUserId],
    [
      {
        billingUserId: input.billingUserId,
        entryType: "adjustment",
        amount,
        source: input.source ?? "admin",
        sourceRef: input.sourceRef,
        idempotencyRef: ledgerRef.adjustment(input.sourceRef),
        note: input.note.slice(0, 500),
      },
    ],
    deps,
  );
}

// ─────────────────────────────────────────── 充值入帐（上游兑换码 → 帐本）

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

type RedemptionReader = (input: { pages: number; pageSize: number }) => Promise<GatewayRedemption[]>;

/** 现金通道（mPay 真实单）的帐本来源：投影层据此把该行计入「付费」。 */
export const REDEMPTION_CASH_SOURCE = "redemption-sync";
/**
 * 人工发码 / 赠送码的帐本来源。**必须**命中 statistics-projection 的
 * NON_CASH_RECHARGE_SOURCE（`gift`）——人工码没有外部现金流入，记成现金＝谎报营收。
 */
export const REDEMPTION_MANUAL_SOURCE = "gift-manual-code";
/** 基线冲销腿的来源（净额 0，两条腿成对，永不单独出现在帐上）。 */
export const REDEMPTION_BASELINE_OFFSET_SOURCE = "opening-offset";

/**
 * 兑换码是不是「真金白银买来的」。唯一判据＝mPay 发码时的命名约定
 * （`mapay-redemption.mapayOrderRedemptionName` = `MP` + out_trade_no 后 18 码）。
 * 人工码（eimu1500 / MANUAL-* / tier-* / gift）一律非现金——帐本语义上不是营收。
 */
export function isCashBackedRedemptionName(name: string | null | undefined): boolean {
  return /^MP[A-Z0-9]{6,}$/.test((name ?? "").trim());
}

/**
 * 基线前（`redeemed_time` 早于开户基线行）的充值入帐：**两条腿同一批**——
 *
 *   recharge       +Q  ← 让「这笔钱从哪来」在帐本上可见（营收/漏斗的唯一事实源）
 *   adjustment     −Q  ← 冲销：该笔额度在开户基线（opening，读自 new-api 当时余额）里
 *                        已经算过一次，若只记 recharge 就是凭空多一份钱。
 *
 * 净额恒为 0 ⇒ 余额（Σ amount）与既有帐本逐位相同；两腿由 postLedgerEntries 包在
 * 同一事务（`ON CONFLICT` 幂等），扫描重放不双算。缺腿自愈：先读两把幂等键，
 * 只补缺的那条——不会出现「recharge 在、冲销不在」的单腿漂移。
 */
async function recordBaselineAbsorbedRecharge(
  input: {
    billingUserId: number;
    amountQuota: number;
    redemptionId: string | number;
    redemptionKey?: string;
    redeemedAt?: string | null;
    source: string;
  },
  deps: LedgerWriterDeps = {},
): Promise<PendingWriteOutcome> {
  const amount = Math.round(input.amountQuota);
  const sql = deps.sql;
  if (!sql) return { posted: false, reason: "帐本储存层未配置" };
  try {
    const rechargeRef = ledgerRef.recharge(input.redemptionId);
    const offsetRef = ledgerRef.rechargeBaselineOffset(input.redemptionId);
    const existing = await sql<Row[]>`
      SELECT idempotency_ref FROM account_ledger
      WHERE idempotency_ref IN (${rechargeRef}, ${offsetRef})
    `;
    const seen = new Set(existing.map((row) => String(row.idempotency_ref)));
    if (seen.has(rechargeRef) && seen.has(offsetRef)) {
      return { posted: false, reason: "已记过（重放）" };
    }
    const sourceRef = `redemption:${String(input.redemptionId)}`;
    const drafts: LedgerEntryDraft[] = [];
    if (!seen.has(rechargeRef)) {
      drafts.push({
        billingUserId: input.billingUserId,
        entryType: "recharge",
        amount,
        source: input.source,
        sourceRef,
        idempotencyRef: rechargeRef,
        note: "new-api 兑换码已使用（充值入帐，金额已含在开户基线内）",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null, baseline_absorbed: true },
      });
    }
    if (!seen.has(offsetRef)) {
      drafts.push({
        billingUserId: input.billingUserId,
        entryType: "adjustment",
        amount: -amount,
        source: REDEMPTION_BASELINE_OFFSET_SOURCE,
        sourceRef,
        idempotencyRef: offsetRef,
        note: "冲销：该笔充值已含在开户基线（opening）内，避免双算",
        metadata: { redemption_key: input.redemptionKey ?? null, redeemed_at: input.redeemedAt ?? null, baseline_absorbed: true },
      });
    }
    const result = await postLedgerEntries(drafts, { sql });
    if (result.errors.length > 0) return { posted: false, reason: result.errors[0] };
    if (result.rejected.length > 0) return { posted: false, reason: result.rejected[0].reason };
    return { posted: result.inserted.length > 0, reason: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[account-ledger] 基线冲销入帐异常（不挡钱路）：${reason}`);
    return { posted: false, reason };
  }
}

/**
 * 充值入帐：把 new-api「已被使用」的兑换码同步成我方帐本的 recharge 加项。
 *
 * 为什么读上游而不是在发码时记帐：mPay 回调只是**产生**兑换码（`fulfillMapayRedemption`），
 * 真正入帐要用户在 new-api 端兑换（`POST /api/user/topup`）。发码即记 = 未被兑换的码
 * 凭空变成余额；故一律以「上游记录显示已使用」为唯一入帐依据（同时涵盖人工发码）。
 *
 * 两种来源，两套语义（现金判定在投影层按 `source` 做，此处只负责如实标记）：
 *   - mPay 真实单（name=`MP…`）→ source=`redemption-sync`，是现金营收。
 *   - 人工发码 / 赠送码 → source=`gift-manual-code`（命中 NON_CASH_RECHARGE_SOURCE），
 *     额度有效但不是现金流入，禁止混进付费漏斗。
 *
 * 防双算（关键）：`redeemed_time` **晚于该身份基线入帐时间**的码直接入帐；早于基线的
 * （额度已含在 opening 里）入帐**两条腿**——recharge +Q 让「钱从哪来」在帐上可见，
 * adjustment −Q 冲销防双算（净额 0）。旧版是直接丢弃这类码，导致 09-19 前后所有
 * 已兑换码在帐本上完全消失（营收恒为 0 的根因之一）。
 *
 * 幂等：idempotency_ref = `redemption:<id>`（冲销腿 `…:opening-offset`）⇒ 周期性重扫
 * 不会重复入帐。
 */
export async function ingestRedeemedRecharges(
  input: { pages?: number; pageSize?: number } = {},
  deps: { sql?: GenerationSql; readRedemptions?: RedemptionReader; fetchUser?: OpeningDeps["fetchUser"] } = {},
): Promise<RechargeIngestSummary> {
  const summary: RechargeIngestSummary = {
    scanned: 0,
    charged: 0,
    chargedBaselineAbsorbed: 0,
    skippedUnused: 0,
    skippedBeforeBaseline: 0,
    skippedNoUser: 0,
    skippedSubscription: 0,
    errors: [],
  };
  if (!accountLedgerStoreEnabled() && !deps.sql) {
    summary.errors.push("帐本储存层未配置");
    return summary;
  }
  const sql = deps.sql ?? getGenerationSql();
  const reader: RedemptionReader = deps.readRedemptions ?? listGatewayRedemptions;

  let items: GatewayRedemption[];
  try {
    items = await reader({ pages: Math.max(1, Math.min(input.pages ?? 20, 50)), pageSize: Math.max(1, Math.min(input.pageSize ?? 100, 100)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    summary.errors.push(reason);
    console.error(`[account-ledger] 兑换码读取失败：${reason}`);
    return summary;
  }

  for (const item of items) {
    summary.scanned += 1;
    const redeemedAtSec = Number(item.redeemed_time ?? 0);
    const usedUserId = Number(item.used_user_id ?? 0);
    if (!(redeemedAtSec > 0)) {
      summary.skippedUnused += 1;
      continue;
    }
    if (!(usedUserId > 0)) {
      summary.skippedNoUser += 1;
      continue;
    }
    // REQ-D3 防双算（关键）：带订阅 SKU 标记的兑换码**只**走订阅通道（subscription.ts
    // 建订阅＋发期次，记在订阅池）。这里若照旧记一笔 recharge，同一张码就会同时产生
    // 「永久充值」与「订阅发放」两笔入帐 = 凭空多一笔钱。
    if (parseSubscriptionCodeMarker(item.name)) {
      summary.skippedSubscription += 1;
      continue;
    }
    const opening = await ensureAccountOpening(usedUserId, { sql, fetchUser: deps.fetchUser });
    if (opening.baselineQuota === null) {
      // 基线不明（上游 user 读不到/额度非整数）⇒ 不入帐，留给对帐报告解释。
      summary.skippedNoUser += 1;
      continue;
    }
    const openingRow = await sql<Row[]>`
      SELECT created_at FROM account_ledger WHERE idempotency_ref = ${ledgerRef.opening(usedUserId)} LIMIT 1
    `;
    // 基线时刻 = 这笔充值是否已含在基线里的分界线。基线行写入失败时保守取 now
    // （宁可漏记一笔旧充值让对帐报告指出，也不把已含在基线里的钱再加一次）。
    const openingAtMs = openingRow[0] ? new Date(String(openingRow[0].created_at)).getTime() : Date.now();
    const source = isCashBackedRedemptionName(item.name) ? REDEMPTION_CASH_SOURCE : REDEMPTION_MANUAL_SOURCE;
    const common = {
      billingUserId: usedUserId,
      amountQuota: Number(item.quota ?? 0),
      redemptionId: item.id,
      redemptionKey: item.key,
      redeemedAt: new Date(redeemedAtSec * 1000).toISOString(),
    };
    if (redeemedAtSec * 1000 < openingAtMs) {
      // 基线前兑换：额度已含在 opening 内 ⇒ 记「充值 + 冲销」两条腿，净额 0 但可见。
      const absorbed = await recordBaselineAbsorbedRecharge({ ...common, source }, { sql });
      if (absorbed.posted) summary.chargedBaselineAbsorbed += 1;
      else if (absorbed.reason && !/重放/.test(absorbed.reason)) {
        summary.skippedBeforeBaseline += 1;
        summary.errors.push(`redemption ${item.id}: ${absorbed.reason}`);
      }
      continue;
    }
    const outcome = await recordRecharge({ ...common, source }, { sql });
    if (outcome.posted) summary.charged += 1;
    else if (outcome.reason && !/重放/.test(outcome.reason)) summary.errors.push(`redemption ${item.id}: ${outcome.reason}`);
  }
  return summary;
}
