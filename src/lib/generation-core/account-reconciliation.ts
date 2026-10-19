// REQ-E1b 跨层对帐（我方帐本 vs new-api users.quota 变动）——只读，永不改写任一侧。
//
// 为什么需要它：REQ-E1a 把对外余额的权威搬回我方帐本，但 new-api 内核仍在 relay 前
// 扣 users.quota（第二个 writer，BA-07 的结构性缺口）。双写不消除（项目负责人 09-23 裁定），
// 改成「双写必可解释」：本档定期比对两层，把差值逐笔定位到 job／operation／billing_user。
//
// 三条硬纪律：
//   1. **只读**：本档没有任何 INSERT/UPDATE/DELETE（具名测试守门），不自动改写任一侧。
//   2. **歧义冻结**：差值解释不完（残差 ≠ 0）→ state='unknown'，如实列出「未定位差额」，
//      沿用既有的 unknown 语义（人工对帐），不猜、不自动补帐。**但「歧义」只指残差**：
//      findings 自相抵销使残差为 0（孤儿帐本行与上游事件互相对冲）不是歧义——差额已逐笔
//      定位得完，如实归 explained；帐本尚未接管（无 opening 基线且零帐本行）也不是歧义，
//      是 lazy 种帐未触及——如实归 unseeded，不比较、不告警，免得噪音淹没真漂移。
//   3. **告警沿用既有通道**：console.error 的结构化行（与 [billing-reconcile] 同一条），
//      不新造通知机制；差值超过门槛（或出现未定位差额）即告警。
//
// 判别口径（哪些 new-api 变动「应该」有帐本行）——由 E1a 的写入器契约决定：
//   billing_operation reserve  amount > 0  → 应有 consumption 帐本行（legacy 上游扣款）
//   billing_operation reserve  amount = 0  → 无（gate 零额快车道，不动上游）
//   billing_operation commit   projection  → 应有 consumption 帐本行（投影扣款）
//   billing_operation commit   一般        → 无（只作结算凭证，钱在 reserve 已扣）
//   billing_operation refund               → 应有 refund 帐本行
//   billing_operation writeoff             → 无（平台自身损失，不动用户余额）
//   billing_operation release              → 无（解除预留，不动上游余额）

import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { fetchGatewayUser } from "@/lib/gateway-admin";
import {
  computeAccountBalance,
  readAccountLedger,
  type LedgerEntry,
} from "./account-ledger";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { quotaToCoins } from "./statistics-projection";

type Row = Record<string, unknown>;

/** 差值告警门槛（quota 单位）：默认 1 币。低于门槛的零头不叫事故，超过就是。 */
export const DEFAULT_DRIFT_ALERT_QUOTA = QUOTA_PER_COIN;
/** 每次对帐最多扫几个身份（每个身份一次上游 GET，避免打爆 new-api）。 */
export const MAX_RECONCILE_USERS = 50;

export type BillingOperationKind = "reserve" | "commit" | "release" | "refund" | "writeoff";

/** new-api 侧的变动事件（billing_operation applied 行）。 */
export interface UpstreamBalanceEvent {
  operationId: string;
  jobId: string;
  operation: BillingOperationKind;
  /** 帐本行原值（>= 0）。 */
  amountQuota: number;
  idempotencyRef: string;
  appliedAt: string;
}

export type LedgerExpectation =
  | { expected: "consumption"; amountQuota: number }
  | { expected: "refund"; amountQuota: number }
  | { expected: "none"; reason: string };

/**
 * 这笔上游帐务事件「应该」在我方帐本留下什么（纯函式，独立于任何实作）。
 * 这是两层判别口径的唯一权威——新增 operation 种类必须先改这里与其测试。
 */
export function expectedLedgerEntryForOperation(event: UpstreamBalanceEvent): LedgerExpectation {
  const amount = Math.round(event.amountQuota);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { expected: "none", reason: "金额为 0（不动上游余额）" };
  }
  if (event.operation === "refund") return { expected: "refund", amountQuota: amount };
  if (event.operation === "reserve") {
    // gate 零额快车道的 reserve 金额必为 0，走上面的 early return；非零 reserve = legacy
    // 真扣上游，故应有 consumption 帐本行。
    return { expected: "consumption", amountQuota: amount };
  }
  if (event.operation === "commit") {
    return event.idempotencyRef.startsWith("projection:")
      ? { expected: "consumption", amountQuota: amount }
      : { expected: "none", reason: "commit 只作结算凭证（钱已在 reserve 扣）" };
  }
  if (event.operation === "writeoff") {
    return { expected: "none", reason: "writeoff 是平台自身损失，不影响用户余额" };
  }
  return { expected: "none", reason: "release 解除预留，不动上游余额" };
}

export type ReconciliationFindingKind =
  | "unrecorded_upstream_change"
  | "orphan_ledger_entry"
  | "subscription_expiry"
  | "unexplained_difference"
  | "balance_unavailable";

/** 一笔可逐笔解释／定位的差额（billing_user + job／operation／entry 三选一必填到能指认）。 */
export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  billingUserId: number;
  /** 有号：对「new-api − 我方帐本」这个差值的贡献。 */
  quota: number;
  coins: number;
  jobId: string | null;
  operationId: string | null;
  entryId: string | null;
  detail: string;
}

/**
 * - matched：两层逐位相等且无任何疑点。
 * - explained：差额被 findings 逐笔定位完（残差 0，含差额本就为 0 但 findings 自相抵销）。
 * - unseeded：帐本尚未接管（无 opening 基线且零帐本行，lazy 种帐未触及）——不比较、不告警。
 * - unknown：残差解释不完，歧义冻结交人工。
 */
export type ReconciliationState = "matched" | "explained" | "unseeded" | "unknown";

export interface AccountReconciliationRow {
  billingUserId: number;
  /** 我方帐本净额（Σ amount）。 */
  ourNetQuota: number;
  ourNetCoins: number;
  /** new-api users.quota；读不到为 null（不以 0 代替）。 */
  newApiQuota: number | null;
  /** newApiQuota − ourNetQuota；上游读不到或 unseeded（不比较）为 null。 */
  differenceQuota: number | null;
  differenceCoins: number | null;
  state: ReconciliationState;
  ledgerEntries: number;
  findings: ReconciliationFinding[];
  /** 解释不完的部分（有号）。解释完为 0。 */
  unlocatedQuota: number;
}

export interface AccountReconciliationReport {
  generatedAt: string;
  configured: boolean;
  thresholdQuota: number;
  users: AccountReconciliationRow[];
  totals: {
    users: number;
    matched: number;
    explained: number;
    unseeded: number;
    unknown: number;
    findings: number;
    unlocatedQuota: number;
  };
  alerts: string[];
  notes: string[];
}

export interface ReconcileRowInput {
  billingUserId: number;
  entries: LedgerEntry[];
  newApiQuota: number | null;
  upstreamEvents: UpstreamBalanceEvent[];
}

/**
 * 单一身份的对帐（纯函式）。帐本未接管（无 opening 且零行）→ 'unseeded'（不比较）；
 * 差额能逐笔定位完（残差 0，含抵销归零）→ 'explained'；有残差 → 'unknown'（冻结人工）。
 *
 * 差值定义：difference = newApiQuota − ourNetQuota。
 * 每个 finding 的 quota 都是「它解释了多少 difference」的有号贡献：
 *   - 上游动了、我方帐本没记 → 贡献 = 该笔应记的方向（consumption 负、refund 正）
 *   - 帐本记了、上游没有对应事件 → 反向贡献（我方多记）
 */
export function reconcileAccountRow(input: ReconcileRowInput): AccountReconciliationRow {
  const balance = computeAccountBalance(input.entries, input.billingUserId);

  // ⓪ 帐本尚未接管：无 opening 基线（entry_type='opening'，即 lazy 种帐写入的
  //    seed:<user>:v1 行）且零帐本行——该身份从未被任何读/写路径触及，比较毫无意义。
  //    上游有大额 quota 与 applied 事件也不是歧义，是「尚未接管」：不比较、不告警，
  //    报告里如实列 unseeded（new-api 值仍展示，差额不计算）。
  const hasOpeningEntry = input.entries.some((entry) => entry.entryType === "opening");
  if (!hasOpeningEntry && balance.entryCount === 0) {
    return {
      billingUserId: input.billingUserId,
      ourNetQuota: 0,
      ourNetCoins: 0,
      newApiQuota: input.newApiQuota === null ? null : Math.round(input.newApiQuota),
      differenceQuota: null,
      differenceCoins: null,
      state: "unseeded",
      ledgerEntries: 0,
      findings: [],
      unlocatedQuota: 0,
    };
  }

  const findings: ReconciliationFinding[] = [];
  // **opening 基线时间截断**：种子语义＝「以种帐当时的 users.quota 种入 opening」，基线
  // 时刻之前的上游 applied 事件已被 opening 吸收（两层在种帐一刻逐位相等），再对它们
  // 逐笔要求帐本行必产生假 unrecorded（生产实锤：user 82 的 1026 笔事件 1022 笔在种帐前，
  // 巨额假解释额把 6 个两层相等身份全推进 unknown）。对帐契约从基线起算：早于 opening
  // createdAt 的事件不参与比对；无 opening 行（尚未接管或人工输入）则不截断。
  const openingTimes = input.entries
    .filter((entry) => entry.entryType === "opening")
    .map((entry) => entry.createdAt)
    .sort();
  const seedAt = openingTimes.length > 0 ? openingTimes[0] : null;
  const baselineEvents =
    seedAt === null
      ? input.upstreamEvents
      : input.upstreamEvents.filter((event) => event.appliedAt >= seedAt);
  const byOperationId = new Map<string, LedgerEntry>();
  for (const entry of input.entries) {
    if (entry.operationId) byOperationId.set(entry.operationId, entry);
  }
  const upstreamIds = new Set(baselineEvents.map((event) => event.operationId));

  // ① 上游动了、我方帐本没有对应行（最常见的漂移：记帐端掉了一笔）。
  for (const event of baselineEvents) {
    const expectation = expectedLedgerEntryForOperation(event);
    if (expectation.expected === "none") continue;
    const recorded = byOperationId.get(event.operationId);
    if (recorded && recorded.entryType === expectation.expected) continue;
    const sign = expectation.expected === "consumption" ? -1 : 1;
    const quota = sign * expectation.amountQuota;
    findings.push({
      kind: "unrecorded_upstream_change",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: event.jobId,
      operationId: event.operationId,
      entryId: recorded?.id ?? null,
      detail:
        `上游 ${event.operation} 已落地 ${expectation.amountQuota} quota（job=${event.jobId}），` +
        `我方帐本缺对应 ${expectation.expected} 帐本行${recorded ? `（operation 已挂著 ${recorded.entryType} 行，类型不符）` : ""}`,
    });
  }

  // ② 我方帐本记了、上游没有对应事件（我方多记 / 上游回滚了却没撤帐）。
  for (const entry of input.entries) {
    if (!entry.operationId) continue;
    // expire 行在上游本就无对应事件（口径差，见 ③），不进孤儿判定，避免双重解释。
    if (entry.entryType === "expire") continue;
    if (upstreamIds.has(entry.operationId)) continue;
    // writeoff/opening/recharge/adjustment 没有 operation_id（见 E1a 写入器契约），不会走到这里。
    // 贡献 = −entry.amount：consumption 记了 −100（我方偏低）⇒ 差值 +100；refund 记了 +100 ⇒ 差值 −100。
    const quota = -entry.amount;
    findings.push({
      kind: "orphan_ledger_entry",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: entry.jobId,
      operationId: entry.operationId,
      entryId: entry.id,
      detail: `我方帐本 ${entry.entryType} 行 ${entry.id}（${entry.amount} quota）在上游找不到对应 applied 事件，需人工核对`,
    });
  }

  // ③ 订阅池过期作废行（E1-b D3 残差）：续期替换按池口径作废旧期残额，是我方帐本的
  //    减项；上游 users.quota 没有「池过期」语义，永无对应事件。这是**口径差不是漂移**——
  //    必须逐笔定位为 explained，否则每张到期订阅都把对帐推进 unknown＋误触告警。
  //    贡献 = −entry.amount（expire 为负数 ⇒ 正值），恰为这些行抬高通数的差额。
  for (const entry of input.entries) {
    if (entry.entryType !== "expire") continue;
    const quota = -entry.amount;
    findings.push({
      kind: "subscription_expiry",
      billingUserId: input.billingUserId,
      quota,
      coins: quotaToCoins(quota),
      jobId: entry.jobId,
      operationId: null,
      entryId: entry.id,
      detail:
        `订阅池过期作废：帐本行 ${entry.id}（${entry.amount} quota，term=${entry.termRef ?? "?"}，` +
        `到期 ${entry.expiresAt ?? "?"}）按池口径扣减，上游 users.quota 无此语义——口径差，非漂移`,
    });
  }

  const explained = findings.reduce((sum, finding) => sum + finding.quota, 0);
  if (input.newApiQuota === null) {
    findings.push({
      kind: "balance_unavailable",
      billingUserId: input.billingUserId,
      quota: 0,
      coins: 0,
      jobId: null,
      operationId: null,
      entryId: null,
      detail: "new-api 未回该用户额度（上游不可达或帐号被删）——两层无法比对，不假设相等",
    });
    return {
      billingUserId: input.billingUserId,
      ourNetQuota: balance.quota,
      ourNetCoins: balance.coins,
      newApiQuota: null,
      differenceQuota: null,
      differenceCoins: null,
      state: "unknown",
      ledgerEntries: balance.entryCount,
      findings,
      unlocatedQuota: 0,
    };
  }

  const difference = Math.round(input.newApiQuota) - balance.quota;
  const residual = difference - explained;
  const base = {
    billingUserId: input.billingUserId,
    ourNetQuota: balance.quota,
    ourNetCoins: balance.coins,
    newApiQuota: Math.round(input.newApiQuota),
    differenceQuota: difference,
    differenceCoins: quotaToCoins(difference),
    ledgerEntries: balance.entryCount,
    findings,
  };

  // 两层相等且没有任何疑点 = matched。
  if (difference === 0 && findings.length === 0) {
    return { ...base, state: "matched", unlocatedQuota: 0 };
  }
  // 差额被 findings 逐笔定位完（残差 0）= explained：每一笔都能说出是哪个 job/operation
  // 造成的。**不要求 difference ≠ 0**——findings 自相抵销（孤儿帐本行与上游事件互冲、差额
  // 恰为 0）同样是「解释得完」，不是歧义；拿这个前提会把它们坠进 unknown＋假告警。
  if (residual === 0) {
    return { ...base, state: "explained", unlocatedQuota: 0 };
  }

  // 残差：差额扣掉已定位的解释后仍有余（典型：有人直接在 new-api 后台改额度，或上游
  // 补偿/折扣）。冻结为 unknown，交人工——不猜、不自动补帐、不改写任一侧。
  findings.push({
    kind: "unexplained_difference",
    billingUserId: input.billingUserId,
    quota: residual,
    coins: quotaToCoins(residual),
    jobId: null,
    operationId: null,
    entryId: null,
    detail:
      `两层差额 ${difference} quota（new-api − 我方帐本）扣掉已定位的 ${explained} 后仍余 ${residual}，` +
      `找不到对应的 job／operation——人工核对 new-api 后台操作或上游补偿`,
  });
  return { ...base, state: "unknown", unlocatedQuota: residual, findings };
}

// ─────────────────────────────────────────── 差值门槛与告警（沿用既有通道）

export function driftAlertQuota(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ACCOUNT_RECONCILE_ALERT_QUOTA ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_DRIFT_ALERT_QUOTA;
}

/**
 * 一列对帐结果该不该告警：差值超门槛，或出现「解释不完」的残差（unknown）。
 * unseeded（帐本未接管）不比较也不告警——那是尚未接管的身份，不是事故。
 * 用既有的结构化 console.error（与 [billing-reconcile] 同一条通道）——不新造告警机制。
 */
export function driftAlerts(row: AccountReconciliationRow, thresholdQuota: number): string[] {
  const alerts: string[] = [];
  if (row.state === "unseeded") return alerts;
  if (row.newApiQuota === null) {
    alerts.push(`user=${row.billingUserId} 上游额度读不到，两层无法比对（我方帐本 ${row.ourNetQuota} quota）`);
    return alerts;
  }
  const drift = Math.abs(row.differenceQuota ?? 0);
  if (drift === 0 && row.state === "matched") return alerts;
  if (row.state === "unknown" && row.findings.some((finding) => finding.kind === "unexplained_difference")) {
    alerts.push(`user=${row.billingUserId} 对帐出现未定位差额（我方 ${row.ourNetQuota} vs 上游 ${row.newApiQuota} quota）`);
  } else if (drift >= thresholdQuota) {
    alerts.push(
      `user=${row.billingUserId} 两层差额 ${row.differenceQuota} quota（门槛 ${thresholdQuota}）` +
        `${row.state === "explained" ? "，已逐笔定位，仍需入帐或更正" : ""}`,
    );
  }
  return alerts;
}

// ─────────────────────────────────────────── 查询与组装（只读）

function mapUpstreamEvent(row: Row): UpstreamBalanceEvent {
  return {
    operationId: String(row.operation_id),
    jobId: String(row.job_id),
    operation: String(row.operation) as BillingOperationKind,
    amountQuota: Number(row.amount ?? 0),
    idempotencyRef: String(row.idempotency_ref ?? ""),
    appliedAt: new Date(String(row.applied_at)).toISOString(),
  };
}

/** 上游侧事实：该身份所有已落地的帐务事件（只读 SELECT）。 */
export async function readUpstreamBalanceEvents(
  billingUserId: number,
  deps: { sql?: GenerationSql } = {},
): Promise<UpstreamBalanceEvent[]> {
  const sql = deps.sql ?? getGenerationSql();
  const rows = await sql<Row[]>`
    SELECT operation.id AS operation_id, operation.job_id AS job_id, operation.operation AS operation,
           operation.amount AS amount, operation.idempotency_ref AS idempotency_ref,
           operation.applied_at AS applied_at
    FROM billing_operation operation
    JOIN generation_job job ON job.id = operation.job_id
    WHERE job.billing_user_id = ${billingUserId}
      AND operation.status = 'applied'
      AND operation.applied_at IS NOT NULL
    ORDER BY operation.applied_at, operation.id
  `;
  return rows.map(mapUpstreamEvent);
}

/**
 * 对帐对象：近期有帐本行或帐务事件的身份（UNION 两侧，因为漂移的定义就是两边不齐）。
 * 截断如实回报（truncated=true 时报表必须标明只覆盖前 N 个身份）。
 */
export async function readReconciliationSubjects(
  input: { limit?: number; sql?: GenerationSql } = {},
): Promise<{ ids: number[]; limit: number; truncated: boolean }> {
  const sql = input.sql ?? getGenerationSql();
  const limit = Math.max(1, Math.min(input.limit ?? MAX_RECONCILE_USERS, 500));
  const rows = await sql<{ billing_user_id: string | number; total_identities: string | number }[]>`
    SELECT identity.billing_user_id AS billing_user_id, count(*) OVER () AS total_identities
    FROM (
      SELECT DISTINCT billing_user_id FROM account_ledger
      UNION
      SELECT DISTINCT job.billing_user_id AS billing_user_id
      FROM billing_operation operation
      JOIN generation_job job ON job.id = operation.job_id
      WHERE job.billing_user_id IS NOT NULL
    ) identity
    WHERE identity.billing_user_id IS NOT NULL
    ORDER BY identity.billing_user_id
    LIMIT ${limit}
  `;
  const ids = rows.map((row) => Number(row.billing_user_id)).filter((id) => Number.isFinite(id));
  const counted = rows.length > 0 ? Number(rows[0].total_identities) : 0;
  return { ids, limit, truncated: Number.isFinite(counted) && counted > ids.length };
}

export interface ReconcileDeps {
  sql?: GenerationSql;
  /** 上游额度读法（默认 fetchGatewayUser，与 quota-precheck／统计同通路）。 */
  fetchUser?: (userId: number) => Promise<{ quota: number } | null>;
  readEvents?: (billingUserId: number) => Promise<UpstreamBalanceEvent[]>;
  now?: Date;
  /** 告警出口（默认 console.error，沿用既有通道）。 */
  alert?: (message: string) => void;
}

/**
 * 跨层对帐主入口（只读）。预设对象 = 近期有帐本行或帐务事件的身份；
 * 也可指定 billingUserIds（人工排障／单一用户核帐）。
 *
 * 永不改写任一侧：本函式只 SELECT 帐本、只 GET 上游，结果以报表与告警输出。
 */
export async function reconcileAccountBalances(
  input: { billingUserIds?: number[]; limit?: number } = {},
  deps: ReconcileDeps = {},
): Promise<AccountReconciliationReport> {
  const threshold = driftAlertQuota();
  const generatedAt = (deps.now ?? new Date()).toISOString();
  const notes: string[] = [];
  if (!generationDatabaseConfigured() && !deps.sql) {
    return {
      generatedAt,
      configured: false,
      thresholdQuota: threshold,
      users: [],
      totals: { users: 0, matched: 0, explained: 0, unseeded: 0, unknown: 0, findings: 0, unlocatedQuota: 0 },
      alerts: [],
      notes: ["本实例没有控制面资料库连线（GENERATION_DATABASE_URL），跨层对帐不可用。"],
    };
  }
  const sql = deps.sql ?? getGenerationSql();
  let ids = input.billingUserIds?.filter((id) => Number.isInteger(id) && id > 0) ?? null;
  if (!ids) {
    const subjects = await readReconciliationSubjects({ limit: input.limit ?? MAX_RECONCILE_USERS, sql });
    ids = subjects.ids;
    if (subjects.truncated) {
      notes.push(`对帐身份超过单轮上限 ${subjects.limit} 个，本轮只覆盖前 ${subjects.ids.length} 个（不是全部）。`);
    }
  }
  if (ids.length === 0) notes.push("没有任何身份有帐本行或帐务事件——不是「对帐通过」，是还没有可对的帐。");

  const fetchUser = deps.fetchUser ?? (async (userId: number) => {
    const user = await fetchGatewayUser(userId);
    return user && Number.isFinite(user.quota) ? { quota: Number(user.quota) } : null;
  });
  const readEvents = deps.readEvents ?? ((billingUserId: number) => readUpstreamBalanceEvents(billingUserId, { sql }));
  const alert = deps.alert ?? ((message: string) => console.error(`[account-reconcile] ${message}`));

  const users: AccountReconciliationRow[] = [];
  const alerts: string[] = [];
  for (const billingUserId of ids) {
    let newApiQuota: number | null = null;
    try {
      const user = await fetchUser(billingUserId);
      newApiQuota = user ? Number(user.quota) : null;
    } catch (error) {
      console.error(`[account-reconcile] user=${billingUserId} 上游额度读取失败`, error);
      newApiQuota = null;
    }
    const entries = await readAccountLedger(billingUserId, { sql });
    const upstreamEvents = await readEvents(billingUserId);
    const row = reconcileAccountRow({ billingUserId, entries, newApiQuota, upstreamEvents });
    users.push(row);
    for (const message of driftAlerts(row, threshold)) {
      alerts.push(message);
      alert(message);
    }
  }

  const totals = {
    users: users.length,
    matched: users.filter((row) => row.state === "matched").length,
    explained: users.filter((row) => row.state === "explained").length,
    unseeded: users.filter((row) => row.state === "unseeded").length,
    unknown: users.filter((row) => row.state === "unknown").length,
    findings: users.reduce((sum, row) => sum + row.findings.length, 0),
    unlocatedQuota: users.reduce(
      (sum, row) => sum + row.findings.filter((finding) => finding.kind === "unexplained_difference").reduce((part, finding) => part + finding.quota, 0),
      0,
    ),
  };
  if (totals.unknown > 0) {
    notes.push(`${totals.unknown} 个身份对帐未定（歧义冻结，人工核对；本轮不自动改写任一侧）。`);
  }
  if (totals.unseeded > 0) {
    notes.push(`${totals.unseeded} 个身份帐本尚未接管（无 opening 基线且零帐本行，lazy 种帐未触及）——不比较、不告警。`);
  }
  return { generatedAt, configured: true, thresholdQuota: threshold, users, totals, alerts, notes };
}

/**
 * 文字报表（给人看的那一份）：每个身份一行差额 + 差额清单逐笔贴出。
 * 确定性输出（无时钟以外的随机），可直接当验收样本。
 */
export function formatAccountReconciliationReport(report: AccountReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`# 跨层对帐报告（我方帐本 vs new-api users.quota） ${report.generatedAt}`);
  lines.push(
    `# 身份 ${report.totals.users}（matched ${report.totals.matched} / explained ${report.totals.explained} / ` +
      `unseeded ${report.totals.unseeded} / unknown ${report.totals.unknown}）门槛 ${report.thresholdQuota} quota`,
  );
  for (const row of report.users) {
    const difference =
      row.state === "unseeded" ? "不比较（帐本未接管）" : row.differenceQuota === null ? "上游不可读" : String(row.differenceQuota);
    lines.push(
      `[${row.state}] user=${row.billingUserId} 我方帐本=${row.ourNetQuota} quota(${row.ourNetCoins} 币) ` +
        `new-api=${row.newApiQuota === null ? "unknown" : row.newApiQuota} 差额=${difference} 帐本行=${row.ledgerEntries}`,
    );
    for (const finding of row.findings) {
      lines.push(
        `    - ${finding.kind} ${finding.quota >= 0 ? "+" : ""}${finding.quota} quota ` +
          `job=${finding.jobId ?? "-"} operation=${finding.operationId ?? "-"} entry=${finding.entryId ?? "-"} :: ${finding.detail}`,
      );
    }
  }
  for (const alert of report.alerts) lines.push(`! 告警：${alert}`);
  for (const note of report.notes) lines.push(`~ ${note}`);
  return lines.join("\n");
}
