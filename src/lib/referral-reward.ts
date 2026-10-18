// 邀请奖励（控制面执行）：绑定 → 被邀请人首图成功 → 双方各发一次额度。
//
// 口径（唯一真源，测试钉住）：
//   ①绑定只在「被邀请人还没成功出过图」时成立——已经在用的老用户点谁的连结都不算新邀请；
//     首次绑定胜出（ON CONFLICT DO NOTHING），不能被后来的连结改绑。
//   ②发奖时机＝被邀请人第一次成功出图（激活），不是注册：小号注册不出图拿不到任何东西。
//   ③同一个邀请人最多领 MAX_REWARDED_INVITES 次；超过后被邀请人照发，邀请人不发（记 skipped）。
//   ④上游调额不幂等 → 与新人礼同一套「先占位、再动上游、再记帐本」状态机：
//     pending（已占位，不自动重试）→ applied / failed（上游明确没动，可重占）/ unknown（不明，人工核对）。
//   ⑤上游调额失败＝整轮停（系统性故障不连打），下一轮 worker 再试。

import { adjustGatewayUserQuotaExact, fetchGatewayUser } from "@/lib/gateway-admin";
import { ensureAccountBaselinesWithStatus, recordAdjustment } from "@/lib/generation-core/account-ledger";
import type { GenerationSql } from "@/lib/generation-core/database";
import { INVITEE_REWARD_IMAGES, INVITER_REWARD_IMAGES, MAX_REWARDED_INVITES, REFEREE_REWARD_COINS, REFERRAL_REWARD_COINS } from "@/lib/plans";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

// ─────────────────────────────────────────── 常量（金额口径在 plans.ts，定价页与发放同源）

export { INVITEE_REWARD_IMAGES, INVITER_REWARD_IMAGES, MAX_REWARDED_INVITES };

export const INVITER_REWARD_COINS = REFERRAL_REWARD_COINS;
export const INVITEE_REWARD_COINS = REFEREE_REWARD_COINS;

export const REFERRAL_LEDGER_SOURCE = "referral";

export type ReferralRole = "inviter" | "invitee";
export type ReferralRewardStatus = "pending" | "applied" | "failed" | "unknown" | "skipped";

export function referralRewardRef(inviteeId: number, role: ReferralRole): string {
  return `referral:${inviteeId}:${role}:v1`;
}

export function referralRewardQuota(role: ReferralRole): number {
  return Math.round((role === "inviter" ? INVITER_REWARD_COINS : INVITEE_REWARD_COINS) * QUOTA_PER_COIN);
}

// ─────────────────────────────────────────── 储存介面

export interface ReferralCandidate {
  inviteeId: number;
  inviterId: number;
  /** 两个角色各自的现状（没有行＝未处理）。 */
  inviterStatus: ReferralRewardStatus | null;
  inviteeStatus: ReferralRewardStatus | null;
}

export interface ReferralStore {
  /** 绑定邀请关系；只在被邀请人未成功出图且尚未绑定时写入。写入回 true。 */
  bind(inviteeId: number, inviterId: number): Promise<boolean>;
  /** 已绑定、被邀请人已有成功出图、且至少一个角色未结清（无行或 failed）。 */
  listCandidates(limit: number): Promise<ReferralCandidate[]>;
  /** 邀请人已领（applied/pending/unknown）的次数。 */
  countInviterRewards(inviterId: number): Promise<number>;
  /** 占位：新插 pending，或把 failed 重占成 pending。拿到回 true。 */
  claim(input: { inviteeId: number; role: ReferralRole; beneficiaryId: number; inviterId: number; amountQuota: number }): Promise<boolean>;
  mark(inviteeId: number, role: ReferralRole, status: Exclude<ReferralRewardStatus, "pending">, detail?: string): Promise<void>;
  /** 直接记一笔 skipped（不动上游）。 */
  skip(input: { inviteeId: number; role: ReferralRole; beneficiaryId: number; inviterId: number; detail: string }): Promise<void>;
}

export interface ReferralDeps {
  store: ReferralStore;
  ensureBaseline(userId: number): Promise<{ ready: boolean; blocked: boolean; reason?: string }>;
  readUpstreamQuota(userId: number): Promise<number | null>;
  adjustUpstream(userId: number, deltaQuota: number): Promise<void>;
  recordLedger(input: { userId: number; amountQuota: number; sourceRef: string; note: string }): Promise<{ posted: boolean; reason?: string }>;
}

export interface ReferralRunReport {
  granted: number;
  skipped: number;
  failed: number;
  aborted: boolean;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settled(status: ReferralRewardStatus | null): boolean {
  return status !== null && status !== "failed";
}

type GrantOutcome = "granted" | "lost_race" | "failed" | "abort";

async function grantOnce(
  deps: ReferralDeps,
  input: { inviteeId: number; role: ReferralRole; beneficiaryId: number; inviterId: number },
): Promise<GrantOutcome> {
  const amountQuota = referralRewardQuota(input.role);
  const claimed = await deps.store.claim({ ...input, amountQuota });
  if (!claimed) return "lost_race";

  let baseline: { ready: boolean; blocked: boolean; reason?: string };
  try {
    baseline = await deps.ensureBaseline(input.beneficiaryId);
  } catch (error) {
    baseline = { ready: false, blocked: true, reason: reasonOf(error) };
  }
  if (baseline.blocked) {
    await deps.store.mark(input.inviteeId, input.role, "failed", `基线不可得：${baseline.reason ?? ""}`.slice(0, 500)).catch(() => {});
    return "failed";
  }

  const before = await deps.readUpstreamQuota(input.beneficiaryId).catch(() => null);
  try {
    await deps.adjustUpstream(input.beneficiaryId, amountQuota);
  } catch (error) {
    const after = await deps.readUpstreamQuota(input.beneficiaryId).catch(() => null);
    const untouched = before !== null && after !== null && after === before;
    const detail = `上游调额失败：${reasonOf(error)}`.slice(0, 500);
    console.error(`[referral] invitee=${input.inviteeId} role=${input.role} ${detail}（${untouched ? "quota 未变" : "结果不明"}）`);
    await deps.store.mark(input.inviteeId, input.role, untouched ? "failed" : "unknown", detail).catch(() => {});
    return "abort";
  }

  await deps.store.mark(input.inviteeId, input.role, "applied").catch((error) => {
    console.error(`[referral] invitee=${input.inviteeId} role=${input.role} 已加额但未能标 applied：${reasonOf(error)}`);
  });

  if (baseline.ready) {
    const coins = amountQuota / QUOTA_PER_COIN;
    const note = input.role === "inviter"
      ? `邀请奖励：好友 #${input.inviteeId} 出了第一张图，${coins} 币`
      : `受邀奖励：经好友 #${input.inviterId} 邀请，首图后 ${coins} 币`;
    const ledger = await deps
      .recordLedger({ userId: input.beneficiaryId, amountQuota, sourceRef: referralRewardRef(input.inviteeId, input.role), note })
      .catch((error) => ({ posted: false, reason: reasonOf(error) }));
    if (!ledger.posted) console.error(`[referral] invitee=${input.inviteeId} role=${input.role} 帐本行未落地（${ledger.reason ?? "重放"}）`);
  }
  return "granted";
}

/** 跑一轮发奖。永不 throw（储存层错误除外，由呼叫方 try/catch）。 */
export async function runReferralRewardsOnce(deps: ReferralDeps, limit = 50): Promise<ReferralRunReport> {
  const report: ReferralRunReport = { granted: 0, skipped: 0, failed: 0, aborted: false };
  const candidates = await deps.store.listCandidates(limit);
  for (const c of candidates) {
    // 被邀请人先发（它不受上限约束）。
    if (!settled(c.inviteeStatus)) {
      const outcome = await grantOnce(deps, { inviteeId: c.inviteeId, role: "invitee", beneficiaryId: c.inviteeId, inviterId: c.inviterId });
      if (outcome === "granted") report.granted += 1;
      else if (outcome === "failed") report.failed += 1;
      else if (outcome === "abort") {
        report.failed += 1;
        report.aborted = true;
        return report;
      }
    }
    if (!settled(c.inviterStatus)) {
      const used = await deps.store.countInviterRewards(c.inviterId);
      if (used >= MAX_REWARDED_INVITES) {
        await deps.store.skip({ inviteeId: c.inviteeId, role: "inviter", beneficiaryId: c.inviterId, inviterId: c.inviterId, detail: `已达上限 ${MAX_REWARDED_INVITES}` });
        report.skipped += 1;
        continue;
      }
      const outcome = await grantOnce(deps, { inviteeId: c.inviteeId, role: "inviter", beneficiaryId: c.inviterId, inviterId: c.inviterId });
      if (outcome === "granted") report.granted += 1;
      else if (outcome === "failed") report.failed += 1;
      else if (outcome === "abort") {
        report.failed += 1;
        report.aborted = true;
        return report;
      }
    }
  }
  return report;
}

// ─────────────────────────────────────────── Postgres

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/028_referral.sql 同一 DDL（幂等，首用即建）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS referral_binding (
          invitee_id bigint PRIMARY KEY,
          inviter_id bigint NOT NULL,
          bound_at   timestamptz NOT NULL DEFAULT now(),
          CHECK (invitee_id <> inviter_id)
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS referral_binding_inviter_idx ON referral_binding (inviter_id)`;
      await sql`
        CREATE TABLE IF NOT EXISTS referral_reward (
          invitee_id      bigint NOT NULL,
          role            text NOT NULL CHECK (role IN ('inviter', 'invitee')),
          beneficiary_id  bigint NOT NULL,
          inviter_id      bigint NOT NULL,
          idempotency_ref text NOT NULL UNIQUE,
          amount_quota    bigint NOT NULL,
          status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown', 'skipped')),
          detail          text,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (invitee_id, role)
        )
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

type Row = Record<string, unknown>;

function asStatus(value: unknown): ReferralRewardStatus | null {
  return typeof value === "string" ? (value as ReferralRewardStatus) : null;
}

export function createPostgresReferralStore(sql: GenerationSql): ReferralStore {
  return {
    async bind(inviteeId, inviterId) {
      if (inviteeId === inviterId) return false;
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        INSERT INTO referral_binding (invitee_id, inviter_id)
        SELECT ${inviteeId}, ${inviterId}
        WHERE NOT EXISTS (
          SELECT 1 FROM generation_job
          WHERE status = 'succeeded'
            AND (billing_user_id = ${inviteeId} OR tenant_id = ${`web:${inviteeId}`})
        )
        AND NOT EXISTS (
          SELECT 1 FROM referral_binding AS existing
          WHERE existing.invitee_id = ${inviterId}
            AND existing.inviter_id = ${inviteeId}
        )
        ON CONFLICT (invitee_id) DO NOTHING
        RETURNING invitee_id
      `;
      return rows.length > 0;
    },
    async listCandidates(limit) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT b.invitee_id, b.inviter_id,
               (SELECT status FROM referral_reward r WHERE r.invitee_id = b.invitee_id AND r.role = 'inviter') AS inviter_status,
               (SELECT status FROM referral_reward r WHERE r.invitee_id = b.invitee_id AND r.role = 'invitee') AS invitee_status
        FROM referral_binding b
        WHERE EXISTS (
            SELECT 1 FROM generation_job j
            WHERE j.status = 'succeeded'
              AND (j.billing_user_id = b.invitee_id OR j.tenant_id = 'web:' || b.invitee_id::text)
          )
          AND (
            SELECT count(*) FROM referral_reward r
            WHERE r.invitee_id = b.invitee_id AND r.status <> 'failed'
          ) < 2
        ORDER BY b.bound_at
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        inviteeId: Number(row.invitee_id),
        inviterId: Number(row.inviter_id),
        inviterStatus: asStatus(row.inviter_status),
        inviteeStatus: asStatus(row.invitee_status),
      }));
    },
    async countInviterRewards(inviterId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT count(*)::int AS n FROM referral_reward
        WHERE role = 'inviter' AND beneficiary_id = ${inviterId} AND status IN ('pending', 'applied', 'unknown')
      `;
      return Number(rows[0]?.n ?? 0);
    },
    async claim({ inviteeId, role, beneficiaryId, inviterId, amountQuota }) {
      await ensureSchema(sql);
      const insertReward = async (tx: GenerationSql) => {
        const rows = await tx<Row[]>`
          INSERT INTO referral_reward (invitee_id, role, beneficiary_id, inviter_id, idempotency_ref, amount_quota, status)
          VALUES (${inviteeId}, ${role}, ${beneficiaryId}, ${inviterId}, ${referralRewardRef(inviteeId, role)}, ${amountQuota}, 'pending')
          ON CONFLICT (invitee_id, role) DO UPDATE
            SET status = 'pending', detail = NULL, amount_quota = EXCLUDED.amount_quota, updated_at = now()
            WHERE referral_reward.status = 'failed'
          RETURNING invitee_id
        `;
        return rows.length > 0;
      };
      if (role !== "inviter") return insertReward(sql);

      // 次数与占位（加额）同一事务。advisory lock 挡住「还没有行」的缺口，FOR UPDATE 锁已有奖励行。
      return sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${inviterId})`;
        const locked = await tx<Row[]>`
          SELECT invitee_id FROM referral_reward
          WHERE role = 'inviter' AND beneficiary_id = ${inviterId}
            AND status IN ('pending', 'applied', 'unknown')
          FOR UPDATE
        `;
        if (locked.length >= MAX_REWARDED_INVITES) return false;
        return insertReward(tx as unknown as GenerationSql);
      });
    },
    async mark(inviteeId, role, status, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE referral_reward SET status = ${status}, detail = ${detail ?? null}, updated_at = now()
        WHERE invitee_id = ${inviteeId} AND role = ${role}
      `;
    },
    async skip({ inviteeId, role, beneficiaryId, inviterId, detail }) {
      await ensureSchema(sql);
      await sql`
        INSERT INTO referral_reward (invitee_id, role, beneficiary_id, inviter_id, idempotency_ref, amount_quota, status, detail)
        VALUES (${inviteeId}, ${role}, ${beneficiaryId}, ${inviterId}, ${referralRewardRef(inviteeId, role)}, 0, 'skipped', ${detail})
        ON CONFLICT (invitee_id, role) DO UPDATE
          SET status = 'skipped', detail = EXCLUDED.detail, updated_at = now()
          WHERE referral_reward.status = 'failed'
      `;
    },
  };
}

export function productionReferralDeps(sql: GenerationSql): ReferralDeps {
  const fetchUser = async (id: number) => fetchGatewayUser(id);
  return {
    store: createPostgresReferralStore(sql),
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
      recordAdjustment({ billingUserId: userId, amountQuota, sourceRef, note, source: REFERRAL_LEDGER_SOURCE }, { sql, fetchUser }),
  };
}

export async function runReferralRewardsWithSql(sql: GenerationSql): Promise<ReferralRunReport> {
  return runReferralRewardsOnce(productionReferralDeps(sql));
}
