// 管理员调额（加/减余额、人工补正）：一个 API 同时写两层，取代手写 SQL。
//
// 为什么要有：以前人工补额只能在 new-api SQLite 里同一事务「伪造一张已兑换的
// redemptions 行 + UPDATE users SET quota」，再等 ~10 分钟 worker 把它同步进
// account_ledger。只改 users.quota 会裂成两层：预检（上游 quota）放行，但客户
// GET /v1/quota（读 account_ledger）看不到余额。
//
// 记账路径与新人礼（welcome-gift.ts）同一条，失败语义逐条照抄：
//   ① 占位 admin_account_adjustment（按 Idempotency-Key；上游调额本身不幂等，必须先占位）
//   ② 基线 ensureAccountBaselinesWithStatus（blocked ⇒ 不动上游，占位改 failed 可重占）
//   ③ 上游 users.quota ±N（adjustGatewayUserQuotaExact）；抛错时复读 quota：
//        未变 ⇒ failed（同一个键可重试）；已变/读不到 ⇒ unknown（不自动重试，人工核对）
//   ④ 占位改 applied
//   ⑤ 帐本 adjustment 行（idempotency_ref = ledgerRef.adjustment("admin-adjust:<key>")，UNIQUE）
//
// 占位状态：pending（不自动重试）/ applied / failed（可重占）/ unknown（不自动重试）。
// 同一个键换了 userId 或金额 ⇒ conflict（路由回 409），永不把旧键挪用到另一笔。
//
// 部署拓扑：只在控制面执行（控制面 Postgres + 上游管理凭证），路由已列入
// control-plane-proxy-routes.mjs。

import { adjustGatewayUserQuotaExact, fetchGatewayUser } from "@/lib/gateway-admin";
import {
  ensureAccountBaselinesWithStatus,
  readAccountBalance,
  recordAdjustment,
} from "@/lib/generation-core/account-ledger";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

// ─────────────────────────────────────────── 常量与校验（纯函数）

/** 单笔调额绝对值上限（币）。 */
export const ADMIN_ADJUSTMENT_MAX_COINS = 100_000;
export const ADMIN_ADJUSTMENT_NOTE_MAX = 500;
export const ADMIN_ADJUSTMENT_LEDGER_SOURCE = "admin-adjust";

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** 帐本 sourceRef（帐本 idempotency_ref = ledgerRef.adjustment(本值)）。 */
export function adminAdjustmentSourceRef(idempotencyKey: string): string {
  return `admin-adjust:${idempotencyKey}`;
}

export function adminAdjustmentLedgerNote(operator: string, note: string): string {
  return `管理员调额（${operator}）：${note}`.slice(0, ADMIN_ADJUSTMENT_NOTE_MAX);
}

export interface AdminAdjustmentInput {
  idempotencyKey: string;
  userId: number;
  coins: number;
  amountQuota: number;
  note: string;
}

/** 请求校验。回 { input } 或 { error }（路由回 400）。 */
export function parseAdminAdjustmentRequest(
  idempotencyKeyHeader: string | null | undefined,
  body: unknown,
): { input: AdminAdjustmentInput } | { error: string } {
  const idempotencyKey = (idempotencyKeyHeader ?? "").trim();
  if (!idempotencyKey) return { error: "缺少 Idempotency-Key 请求头。" };
  if (!IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
    return { error: "Idempotency-Key 只能含字母、数字、. _ : -，长度 1-128。" };
  }
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const userId = raw.userId;
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    return { error: "userId 必须是正整数。" };
  }
  const coins = raw.coins;
  if (typeof coins !== "number" || !Number.isFinite(coins) || coins === 0) {
    return { error: "coins 必须是非零数字（可为负）。" };
  }
  if (Math.abs(coins) > ADMIN_ADJUSTMENT_MAX_COINS) {
    return { error: `coins 绝对值不得超过 ${ADMIN_ADJUSTMENT_MAX_COINS}。` };
  }
  const amountQuota = Math.round(coins * QUOTA_PER_COIN);
  if (amountQuota === 0) return { error: "coins 太小，折合额度为 0。" };
  const note = typeof raw.note === "string" ? raw.note.trim() : "";
  if (!note) return { error: "note 必填。" };
  if (note.length > ADMIN_ADJUSTMENT_NOTE_MAX) return { error: `note 不得超过 ${ADMIN_ADJUSTMENT_NOTE_MAX} 字。` };
  return { input: { idempotencyKey, userId, coins, amountQuota, note } };
}

// ─────────────────────────────────────────── 核心

export type AdminAdjustmentClaimStatus = "pending" | "applied" | "failed" | "unknown";

export interface AdminAdjustmentClaim {
  status: AdminAdjustmentClaimStatus;
  userId: number;
  amountQuota: number;
  detail: string | null;
}

export type AdminAdjustmentStatus =
  /** 本次调额成功（上游已动）。 */
  | "applied"
  /** 同一个键以前已成功，本次重放不动上游。 */
  | "already_applied"
  /** 已占位但结果未定（pending/unknown），不自动动上游，需人工核对。 */
  | "in_flight"
  /** 本次没成（基线不可得/上游明确没动/储存层不可用）；同一个键可重试。 */
  | "failed"
  /** 同一个键已用于另一笔（userId 或金额不同）——路由回 409。 */
  | "conflict";

export interface AdminAdjustmentResult {
  status: AdminAdjustmentStatus;
  userId: number;
  coins: number;
  /** account_ledger 余额（币）；仅 applied/already_applied 且读得到时给。 */
  balance_coins?: number;
  /** 帐本行是否本次落地（仅 applied 时给；false 由对帐报告负责）。 */
  ledger_posted?: boolean;
  reason?: string;
}

export interface AdminAdjustmentStore {
  readClaim(idempotencyKey: string): Promise<AdminAdjustmentClaim | null>;
  /**
   * 占位：新插 pending，或把同一笔（同 userId、同金额）的 failed 重新占成 pending。
   * 拿到占位回 true。
   */
  claim(input: {
    idempotencyKey: string;
    sourceRef: string;
    userId: number;
    amountQuota: number;
    operator: string;
    note: string;
  }): Promise<boolean>;
  mark(idempotencyKey: string, status: Exclude<AdminAdjustmentClaimStatus, "pending">, detail?: string): Promise<void>;
}

export interface AdminAdjustmentDeps {
  store: AdminAdjustmentStore;
  ensureBaseline(userId: number): Promise<{ ready: boolean; blocked: boolean; reason?: string }>;
  readUpstreamQuota(userId: number): Promise<number | null>;
  adjustUpstream(userId: number, deltaQuota: number): Promise<void>;
  recordLedger(input: {
    userId: number;
    amountQuota: number;
    sourceRef: string;
    note: string;
  }): Promise<{ posted: boolean; reason?: string }>;
  /** account_ledger 余额（quota 单位）。 */
  readLedgerBalanceQuota(userId: number): Promise<number>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameAdjustment(claim: AdminAdjustmentClaim, input: AdminAdjustmentInput): boolean {
  return claim.userId === input.userId && claim.amountQuota === input.amountQuota;
}

async function withBalance(
  result: AdminAdjustmentResult,
  deps: AdminAdjustmentDeps,
): Promise<AdminAdjustmentResult> {
  try {
    const quota = await deps.readLedgerBalanceQuota(result.userId);
    return { ...result, balance_coins: quota / QUOTA_PER_COIN };
  } catch (error) {
    console.error(`[admin-adjust] user=${result.userId} 读帐本余额失败：${reasonOf(error)}`);
    return result;
  }
}

/** 已落定的占位 → 结果（failed 回 null＝允许重新占位）。 */
async function settledResult(
  claim: AdminAdjustmentClaim,
  input: AdminAdjustmentInput,
  deps: AdminAdjustmentDeps,
): Promise<AdminAdjustmentResult | null> {
  const base = { userId: input.userId, coins: input.coins };
  if (!sameAdjustment(claim, input)) {
    return {
      status: "conflict",
      userId: input.userId,
      coins: input.coins,
      reason: `该 Idempotency-Key 已用于 user=${claim.userId}、额度 ${claim.amountQuota / QUOTA_PER_COIN} 币`,
    };
  }
  if (claim.status === "applied") return withBalance({ status: "already_applied", ...base }, deps);
  if (claim.status === "pending" || claim.status === "unknown") {
    return { status: "in_flight", ...base, reason: `占位状态 ${claim.status}${claim.detail ? `：${claim.detail}` : ""}` };
  }
  return null;
}

/**
 * 管理员调额（控制面执行）。永不 throw：所有失败都回 status。
 */
export async function applyAdminAccountAdjustment(
  input: AdminAdjustmentInput,
  operator: string,
  deps: AdminAdjustmentDeps,
): Promise<AdminAdjustmentResult> {
  const { idempotencyKey, userId, coins, amountQuota } = input;
  const sourceRef = adminAdjustmentSourceRef(idempotencyKey);
  const fail = (reason: string): AdminAdjustmentResult => ({ status: "failed", userId, coins, reason });

  let claimed = false;
  try {
    const existing = await deps.store.readClaim(idempotencyKey);
    if (existing) {
      const settled = await settledResult(existing, input, deps);
      if (settled) return settled;
    }
    claimed = await deps.store.claim({ idempotencyKey, sourceRef, userId, amountQuota, operator, note: input.note });
    if (!claimed) {
      const winner = await deps.store.readClaim(idempotencyKey);
      const settled = winner ? await settledResult(winner, input, deps) : null;
      return settled ?? { status: "in_flight", userId, coins, reason: "占位被并发请求取得" };
    }
  } catch (error) {
    console.error(`[admin-adjust] 占位阶段失败 key=${idempotencyKey}：${reasonOf(error)}`);
    if (claimed) await deps.store.mark(idempotencyKey, "failed", "占位后读写失败").catch(() => {});
    return fail("储存层不可用");
  }

  // ① 基线（动上游之前）。基线不成立＝上游变动无法归属 → 不动上游，释放占位可重试。
  let baseline: { ready: boolean; blocked: boolean; reason?: string };
  try {
    baseline = await deps.ensureBaseline(userId);
  } catch (error) {
    baseline = { ready: false, blocked: true, reason: reasonOf(error) };
  }
  if (baseline.blocked) {
    await deps.store.mark(idempotencyKey, "failed", `基线不可得：${baseline.reason ?? ""}`.slice(0, 500)).catch(() => {});
    return fail("基线不可得");
  }

  // ② 上游调额。抛错时复读 quota 判定「明确没动」还是「结果不明」。
  const beforeQuota = await deps.readUpstreamQuota(userId).catch(() => null);
  try {
    await deps.adjustUpstream(userId, amountQuota);
  } catch (error) {
    const afterQuota = await deps.readUpstreamQuota(userId).catch(() => null);
    const untouched = beforeQuota !== null && afterQuota !== null && afterQuota === beforeQuota;
    const detail = `上游调额失败：${reasonOf(error)}`.slice(0, 500);
    console.error(
      `[admin-adjust] key=${idempotencyKey} user=${userId} ${detail}（${untouched ? "quota 未变，允许重试" : "结果不明，停止自动重试"}）`,
    );
    await deps.store.mark(idempotencyKey, untouched ? "failed" : "unknown", detail).catch(() => {});
    return untouched
      ? fail("上游调额失败（quota 未变，可用同一个 Idempotency-Key 重试）")
      : { status: "in_flight", userId, coins, reason: "上游调额结果不明，需人工核对后处理" };
  }

  await deps.store.mark(idempotencyKey, "applied").catch((error) => {
    // 停在 pending 也不会双发（pending 不自动重试），只记日志。
    console.error(`[admin-adjust] key=${idempotencyKey} 已调额但占位未能改为 applied：${reasonOf(error)}`);
  });

  // ③ 帐本增量（基线就绪时才记；否则由对帐报告指出差额）。
  let ledgerPosted = false;
  if (baseline.ready) {
    const ledger = await deps
      .recordLedger({ userId, amountQuota, sourceRef, note: adminAdjustmentLedgerNote(operator, input.note) })
      .catch((error) => ({ posted: false, reason: reasonOf(error) }));
    ledgerPosted = ledger.posted;
    if (!ledger.posted) {
      console.error(`[admin-adjust] key=${idempotencyKey} user=${userId} 帐本行未落地（${ledger.reason ?? "重放"}）——由对帐报告负责`);
    }
  }

  return withBalance({ status: "applied", userId, coins, ledger_posted: ledgerPosted }, deps);
}

// ─────────────────────────────────────────── 生产依赖（控制面 Postgres + 上游管理 API）

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/035_admin_account_adjustment.sql 同一 DDL（幂等，首用即建）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS admin_account_adjustment (
          idempotency_key text PRIMARY KEY,
          source_ref      text NOT NULL UNIQUE,
          user_id         bigint NOT NULL,
          amount_quota    bigint NOT NULL CHECK (amount_quota <> 0),
          operator        text NOT NULL,
          note            text NOT NULL,
          status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
          detail          text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS admin_account_adjustment_user_idx
          ON admin_account_adjustment (user_id, created_at DESC)
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

type Row = Record<string, unknown>;

export function createPostgresAdminAdjustmentStore(sql: GenerationSql = getGenerationSql()): AdminAdjustmentStore {
  return {
    async readClaim(idempotencyKey) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT status, user_id, amount_quota, detail
        FROM admin_account_adjustment WHERE idempotency_key = ${idempotencyKey} LIMIT 1
      `;
      const row = rows[0];
      if (!row || typeof row.status !== "string") return null;
      return {
        status: row.status as AdminAdjustmentClaimStatus,
        userId: Number(row.user_id),
        amountQuota: Number(row.amount_quota),
        detail: row.detail == null ? null : String(row.detail),
      };
    },
    async claim({ idempotencyKey, sourceRef, userId, amountQuota, operator, note }) {
      await ensureSchema(sql);
      // 只有「同一笔」（同 userId、同金额）的 failed 才可重占；不同笔由读路径判 conflict。
      const rows = await sql<Row[]>`
        INSERT INTO admin_account_adjustment
          (idempotency_key, source_ref, user_id, amount_quota, operator, note, status)
        VALUES (${idempotencyKey}, ${sourceRef}, ${userId}, ${amountQuota}, ${operator}, ${note}, 'pending')
        ON CONFLICT (idempotency_key) DO UPDATE
          SET status = 'pending', detail = NULL, operator = EXCLUDED.operator, note = EXCLUDED.note, updated_at = now()
          WHERE admin_account_adjustment.status = 'failed'
            AND admin_account_adjustment.user_id = EXCLUDED.user_id
            AND admin_account_adjustment.amount_quota = EXCLUDED.amount_quota
        RETURNING idempotency_key
      `;
      return rows.length > 0;
    },
    async mark(idempotencyKey, status, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE admin_account_adjustment
        SET status = ${status}, detail = ${detail ?? null}, updated_at = now()
        WHERE idempotency_key = ${idempotencyKey}
      `;
    },
  };
}

export function productionAdminAdjustmentDeps(sql: GenerationSql = getGenerationSql()): AdminAdjustmentDeps {
  const fetchUser = async (id: number) => fetchGatewayUser(id);
  return {
    store: createPostgresAdminAdjustmentStore(sql),
    async ensureBaseline(userId) {
      const guard = await ensureAccountBaselinesWithStatus([userId], { sql, fetchUser });
      return { ready: guard.ready, blocked: guard.blocked, reason: guard.failures[0]?.reason };
    },
    async readUpstreamQuota(userId) {
      const user = await fetchGatewayUser(userId);
      return user ? Math.round(Number(user.quota) || 0) : null;
    },
    adjustUpstream: adjustGatewayUserQuotaExact,
    recordLedger: ({ userId, amountQuota, sourceRef, note }) =>
      recordAdjustment(
        { billingUserId: userId, amountQuota, sourceRef, note, source: ADMIN_ADJUSTMENT_LEDGER_SOURCE },
        { sql, fetchUser },
      ),
    async readLedgerBalanceQuota(userId) {
      return (await readAccountBalance(userId, { sql })).quota;
    },
  };
}
