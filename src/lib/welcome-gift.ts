// 新人礼（welcome gift）：任何用户首次登录即得「约 5 张标准图」的额度，无需签到、无需充值。
//
// 为什么要有：2026-09-27 生产实测，近 30 天 29 位新注册用户只有 5 人出过图；new-api 新用户
// 初始 quota=0，唯一免费额度来源是签到，13/29 人 quota 仍为 0 ⇒ 根本出不了图。
//
// 记账（不另造第二套帐，沿用管理员调额同一条路径，见 admin/biz-keys/provision）：
//   ① 先种基线 ensureAccountBaselinesWithStatus（account-ledger 顺序铁律 2b：先基线→动上游→记增量）
//   ② 上游 users.quota +N（adjustGatewayUserQuotaExact，内核执法点/供货水位）
//   ③ 我方帐本 account_ledger 记一笔 adjustment（余额权威，REQ-E1a），
//      idempotency_ref = ledgerRef.adjustment("welcome:<uid>:v1") —— UNIQUE，重放不双算
//   两边差额由 account-reconciliation 对帐报告负责（记帐不挡钱路，纪律 3）。
//
// 幂等（上游调额本身不幂等，所以必须在动上游之前先「占位」）：
//   welcome_gift_grant(user_id PK) 是一张**占位表**（不是帐本，不存金额余额）：
//     pending  已占位、正在/曾经尝试动上游 —— 不再自动重试（进程崩在中途＝宁可少发不可双发）
//     applied  上游已加额（帐本行随后落地，失败由对帐报告兜底）
//     failed   上游明确没动（调额失败且复读 quota 未变）—— 允许下次登录重新占位
//     unknown  上游结果不明（调额抛错且复读 quota 已变/读不到）—— 不自动重试，人工核对
//   占位用 INSERT … ON CONFLICT DO UPDATE … WHERE status='failed' RETURNING：
//   并发两次登录只有一个拿到占位，另一个直接 no-op。
//
// 资格：该用户在 generation_job 没有任何 succeeded 记录（web 租户 `web:<uid>` 或
// billing_user_id=<uid>，后者覆盖 agent/biz key 归属到该用户的出图）。已出过图的老用户不发。
//
// 部署拓扑：本档的核心（grantWelcomeGift）只在控制面执行（直连控制面 Postgres + 上游管理凭证）；
// Vercel 站点没有控制面 DB，走 HMAC 签名通道转投 /image-control/api/internal/welcome-gift
// （与 newapi-session-token 同一骨架）。
//
// 站内通知（「新人礼：已送你 N 币，够生成约 5 张图」）由 Vercel 登录路径写入
// （welcome-gift-login.ts，复用 notification-store）：占位表 noticed_at 为空＝通知待送，
// 送达后经同一通道 op=noticed 回执。这样登录时发放与运维回溯发放的用户都只收到一次通知，
// 且本档不依赖 notification-store（控制面不必同步那一族文件）。

import { signBizKeySync } from "@/lib/biz-key-sync";
import {
  adjustGatewayUserQuotaExact,
  fetchGatewayUser,
  listGatewayUsers,
  type GatewayAdminUser,
} from "@/lib/gateway-admin";
import { ensureAccountBaselinesWithStatus, recordAdjustment } from "@/lib/generation-core/account-ledger";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";
import { DEFAULT_IMAGE_MODEL_ID, imageGenerationCoins } from "@/lib/provider-config";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

// ─────────────────────────────────────────── 常量（单一权威）

/** 新人礼折合的标准图张数。 */
export const WELCOME_GIFT_IMAGE_COUNT = 5;

/** 一张「标准图」的币价 = 默认模型、默认档位的真实定价（不写死魔数，定价变动自动跟随）。 */
export const WELCOME_GIFT_STANDARD_IMAGE_COINS = imageGenerationCoins(DEFAULT_IMAGE_MODEL_ID);

/** 新人礼币数。 */
export const WELCOME_GIFT_COINS = WELCOME_GIFT_IMAGE_COUNT * WELCOME_GIFT_STANDARD_IMAGE_COINS;

/** 新人礼额度（new-api quota 单位）。 */
export const WELCOME_GIFT_QUOTA = Math.round(WELCOME_GIFT_COINS * QUOTA_PER_COIN);

/** 幂等键（帐本 sourceRef；帐本 idempotency_ref = ledgerRef.adjustment(本键)）。 */
export function welcomeGiftRef(userId: number): string {
  return `welcome:${userId}:v1`;
}

export const WELCOME_GIFT_LEDGER_SOURCE = "welcome-gift";

/** 站内通知文案（简体中文、直白、无 emoji）。 */
export function welcomeGiftNotice(
  coins: number = WELCOME_GIFT_COINS,
  images: number = WELCOME_GIFT_IMAGE_COUNT,
): { title: string; body: string } {
  return {
    title: `新人礼：已送你 ${coins} 币，够生成约 ${images} 张图`,
    body: "无需签到、无需充值，额度已到账，现在就能开始出图。",
  };
}

// ─────────────────────────────────────────── 核心

export type WelcomeClaimStatus = "pending" | "applied" | "failed" | "unknown";

export type WelcomeGiftStatus =
  /** 本次发放成功（上游已加额）。 */
  | "granted"
  /** 以前已发过（applied）。 */
  | "already_granted"
  /** 已有成功出图记录，不发。 */
  | "ineligible"
  /** 已占位但结果未定（pending/unknown），不再自动动上游。 */
  | "in_flight"
  /** 本次没发成（基线不可得/上游明确失败/储存层不可用），下次登录会再试。 */
  | "unavailable";

export interface WelcomeGiftResult {
  status: WelcomeGiftStatus;
  userId: number;
  amountQuota: number;
  coins: number;
  /** 已发放但站内通知尚未送达（登录路径据此写通知并回执）。 */
  noticePending: boolean;
  reason?: string;
}

export interface WelcomeClaim {
  status: WelcomeClaimStatus;
  /** 站内通知是否已送达（noticed_at 非空）。 */
  noticed: boolean;
}

export interface WelcomeGiftStore {
  readClaim(userId: number): Promise<WelcomeClaim | null>;
  hasSucceededGeneration(userId: number): Promise<boolean>;
  /** 占位：新插 pending，或把 failed 重新占成 pending。拿到占位回 true。 */
  claim(userId: number, idempotencyRef: string, amountQuota: number): Promise<boolean>;
  mark(userId: number, status: Exclude<WelcomeClaimStatus, "pending">, detail?: string): Promise<void>;
  /** 站内通知已送达的回执（只对 applied 生效；重复回执无副作用）。 */
  markNoticed(userId: number): Promise<boolean>;
  /** B 端计费账户（biz key 归属）——回溯时排除。 */
  listBizBillingUserIds(): Promise<number[]>;
}

export interface WelcomeGiftDeps {
  store: WelcomeGiftStore;
  ensureBaseline(userId: number): Promise<{ ready: boolean; blocked: boolean; reason?: string }>;
  readUpstreamQuota(userId: number): Promise<number | null>;
  adjustUpstream(userId: number, deltaQuota: number): Promise<void>;
  recordLedger(input: { userId: number; amountQuota: number; sourceRef: string }): Promise<{ posted: boolean; reason?: string }>;
  listUsers(): Promise<GatewayAdminUser[]>;
  amountQuota?: number;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(
  status: WelcomeGiftStatus,
  userId: number,
  amountQuota: number,
  reason?: string,
  noticePending = false,
): WelcomeGiftResult {
  return {
    status,
    userId,
    amountQuota,
    coins: amountQuota / QUOTA_PER_COIN,
    noticePending,
    ...(reason ? { reason } : {}),
  };
}

function claimToResult(claim: WelcomeClaim, userId: number, amountQuota: number): WelcomeGiftResult | null {
  if (claim.status === "applied") return result("already_granted", userId, amountQuota, undefined, !claim.noticed);
  if (claim.status === "pending" || claim.status === "unknown") {
    return result("in_flight", userId, amountQuota, `占位状态 ${claim.status}`);
  }
  return null; // failed → 允许重新占位
}

/**
 * 发新人礼（控制面执行）。永不 throw：任何失败都只回 status，调用方（登录路径）不受影响。
 */
export async function grantWelcomeGift(userId: number, deps: WelcomeGiftDeps): Promise<WelcomeGiftResult> {
  const amountQuota = deps.amountQuota ?? WELCOME_GIFT_QUOTA;
  if (!Number.isInteger(userId) || userId <= 0) return result("unavailable", userId, amountQuota, "userId 非法");

  let claimed = false;
  try {
    const existing = await deps.store.readClaim(userId);
    const settled = existing ? claimToResult(existing, userId, amountQuota) : null;
    if (settled) return settled;

    if (await deps.store.hasSucceededGeneration(userId)) return result("ineligible", userId, amountQuota);

    claimed = await deps.store.claim(userId, welcomeGiftRef(userId), amountQuota);
    if (!claimed) {
      const winner = await deps.store.readClaim(userId);
      return (winner && claimToResult(winner, userId, amountQuota)) ?? result("in_flight", userId, amountQuota, "占位被并发请求取得");
    }
  } catch (error) {
    console.error(`[welcome-gift] 占位阶段失败 user=${userId}：${reasonOf(error)}`);
    if (claimed) await deps.store.mark(userId, "failed", "占位后读写失败").catch(() => {});
    return result("unavailable", userId, amountQuota, "储存层不可用");
  }

  // ① 基线（动上游之前）。基线不成立＝上游变动无法归属 → 不动上游，释放占位下次再试。
  let baseline: { ready: boolean; blocked: boolean; reason?: string };
  try {
    baseline = await deps.ensureBaseline(userId);
  } catch (error) {
    baseline = { ready: false, blocked: true, reason: reasonOf(error) };
  }
  if (baseline.blocked) {
    await deps.store.mark(userId, "failed", `基线不可得：${baseline.reason ?? ""}`.slice(0, 500)).catch(() => {});
    return result("unavailable", userId, amountQuota, "基线不可得");
  }

  // ② 上游加额。抛错时复读 quota 判定「明确没动」还是「结果不明」。
  const beforeQuota = await deps.readUpstreamQuota(userId).catch(() => null);
  try {
    await deps.adjustUpstream(userId, amountQuota);
  } catch (error) {
    const afterQuota = await deps.readUpstreamQuota(userId).catch(() => null);
    const untouched = beforeQuota !== null && afterQuota !== null && afterQuota === beforeQuota;
    const detail = `上游调额失败：${reasonOf(error)}`.slice(0, 500);
    console.error(`[welcome-gift] user=${userId} ${detail}（${untouched ? "quota 未变，允许重试" : "结果不明，停止自动重试"}）`);
    await deps.store.mark(userId, untouched ? "failed" : "unknown", detail).catch(() => {});
    return untouched
      ? result("unavailable", userId, amountQuota, "上游调额失败")
      : result("in_flight", userId, amountQuota, "上游调额结果不明");
  }

  await deps.store.mark(userId, "applied").catch((error) => {
    // 占位停在 pending 也不会双发（pending 不自动重试），只记日志。
    console.error(`[welcome-gift] user=${userId} 已加额但占位状态未能改为 applied：${reasonOf(error)}`);
  });

  // ③ 帐本增量（基线就绪时才记；否则由对帐报告指出差额）。
  if (baseline.ready) {
    const ledger = await deps
      .recordLedger({ userId, amountQuota, sourceRef: welcomeGiftRef(userId) })
      .catch((error) => ({ posted: false, reason: reasonOf(error) }));
    if (!ledger.posted) {
      console.error(`[welcome-gift] user=${userId} 帐本行未落地（${ledger.reason ?? "重放"}）——由对帐报告负责`);
    }
  }

  // ④ 站内通知由登录路径送达（noticePending=true），见 welcome-gift-login.ts。
  return result("granted", userId, amountQuota, undefined, true);
}

// ─────────────────────────────────────────── 回溯（既有用户）

export interface WelcomeGiftBackfillSummary {
  dryRun: boolean;
  scanned: number;
  excluded: number;
  counts: Record<WelcomeGiftStatus | "eligible", number>;
  userIds: Partial<Record<WelcomeGiftStatus | "eligible", number[]>>;
}

/** 回溯候选：普通用户（role<10）、启用状态、不是 B 端计费账户。 */
export function welcomeGiftBackfillCandidates(users: GatewayAdminUser[], bizBillingUserIds: number[]): number[] {
  const biz = new Set(bizBillingUserIds);
  return users
    .filter((user) => Number.isInteger(user.id) && user.id > 0)
    .filter((user) => (user.role ?? 1) < 10)
    .filter((user) => user.status === undefined || user.status === 1)
    .filter((user) => !biz.has(user.id))
    .map((user) => user.id)
    .sort((a, b) => a - b);
}

/**
 * 对所有「从未有过 succeeded 生成」的既有用户各发一次（同一幂等键，与登录路径共享占位表 ⇒
 * 回溯与登录并发也只发一次）。逐个串行，任意重放安全。
 */
export async function backfillWelcomeGifts(
  deps: WelcomeGiftDeps,
  options: { dryRun?: boolean } = {},
): Promise<WelcomeGiftBackfillSummary> {
  const dryRun = options.dryRun === true;
  const users = await deps.listUsers();
  const candidates = welcomeGiftBackfillCandidates(users, await deps.store.listBizBillingUserIds());
  const summary: WelcomeGiftBackfillSummary = {
    dryRun,
    scanned: users.length,
    excluded: users.length - candidates.length,
    counts: { granted: 0, already_granted: 0, ineligible: 0, in_flight: 0, unavailable: 0, eligible: 0 },
    userIds: {},
  };
  const tally = (key: WelcomeGiftStatus | "eligible", userId: number) => {
    summary.counts[key] += 1;
    (summary.userIds[key] ??= []).push(userId);
  };

  for (const userId of candidates) {
    if (dryRun) {
      const claim = await deps.store.readClaim(userId);
      const settled = claim ? claimToResult(claim, userId, deps.amountQuota ?? WELCOME_GIFT_QUOTA) : null;
      if (settled) tally(settled.status, userId);
      else if (await deps.store.hasSucceededGeneration(userId)) tally("ineligible", userId);
      else tally("eligible", userId);
      continue;
    }
    tally((await grantWelcomeGift(userId, deps)).status, userId);
  }
  return summary;
}

// ─────────────────────────────────────────── 生产依赖（控制面 Postgres + 上游管理 API）

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/024_welcome_gift_grant.sql 同一 DDL（幂等，首用即建，免人工迁移）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS welcome_gift_grant (
          user_id         bigint PRIMARY KEY,
          idempotency_ref text NOT NULL UNIQUE,
          amount_quota    bigint NOT NULL CHECK (amount_quota > 0),
          status          text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
          detail          text,
          noticed_at      timestamptz,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
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

export function createPostgresWelcomeGiftStore(sql: GenerationSql = getGenerationSql()): WelcomeGiftStore {
  return {
    async readClaim(userId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT status, noticed_at FROM welcome_gift_grant WHERE user_id = ${userId} LIMIT 1
      `;
      const status = rows[0]?.status;
      if (typeof status !== "string") return null;
      return { status: status as WelcomeClaimStatus, noticed: rows[0]?.noticed_at != null };
    },
    async hasSucceededGeneration(userId) {
      const rows = await sql<Row[]>`
        SELECT 1 AS hit FROM generation_job
        WHERE status = 'succeeded'
          AND (billing_user_id = ${userId} OR tenant_id = ${`web:${userId}`})
        LIMIT 1
      `;
      return rows.length > 0;
    },
    async claim(userId, idempotencyRef, amountQuota) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        INSERT INTO welcome_gift_grant (user_id, idempotency_ref, amount_quota, status)
        VALUES (${userId}, ${idempotencyRef}, ${amountQuota}, 'pending')
        ON CONFLICT (user_id) DO UPDATE
          SET status = 'pending', detail = NULL, amount_quota = EXCLUDED.amount_quota, updated_at = now()
          WHERE welcome_gift_grant.status = 'failed'
        RETURNING user_id
      `;
      return rows.length > 0;
    },
    async mark(userId, status, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE welcome_gift_grant
        SET status = ${status}, detail = ${detail ?? null}, updated_at = now()
        WHERE user_id = ${userId}
      `;
    },
    async markNoticed(userId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        UPDATE welcome_gift_grant SET noticed_at = now(), updated_at = now()
        WHERE user_id = ${userId} AND status = 'applied' AND noticed_at IS NULL
        RETURNING user_id
      `;
      return rows.length > 0;
    },
    async listBizBillingUserIds() {
      const rows = await sql<Row[]>`SELECT DISTINCT user_id FROM biz_api_key WHERE user_id IS NOT NULL`;
      return rows.map((row) => Number(row.user_id)).filter((id) => Number.isInteger(id) && id > 0);
    },
  };
}

export function productionWelcomeGiftDeps(sql: GenerationSql = getGenerationSql()): WelcomeGiftDeps {
  const fetchUser = async (id: number) => fetchGatewayUser(id);
  return {
    store: createPostgresWelcomeGiftStore(sql),
    async ensureBaseline(userId) {
      const guard = await ensureAccountBaselinesWithStatus([userId], { sql, fetchUser });
      return { ready: guard.ready, blocked: guard.blocked, reason: guard.failures[0]?.reason };
    },
    async readUpstreamQuota(userId) {
      const user = await fetchGatewayUser(userId);
      return user ? Math.round(Number(user.quota) || 0) : null;
    },
    adjustUpstream: adjustGatewayUserQuotaExact,
    recordLedger: ({ userId, amountQuota, sourceRef }) =>
      recordAdjustment(
        {
          billingUserId: userId,
          amountQuota,
          sourceRef,
          note: `新人礼：${amountQuota / QUOTA_PER_COIN} 币（约 ${WELCOME_GIFT_IMAGE_COUNT} 张标准图）`,
          source: WELCOME_GIFT_LEDGER_SOURCE,
        },
        { sql, fetchUser },
      ),
    listUsers: () => listGatewayUsers(),
  };
}

// ─────────────────────────────────────────── Vercel 侧签名通道（登录路径用）

export const WELCOME_GIFT_RELAY_SIGNATURE_DOMAIN = "welcome-gift";
const RELAY_PATH = "/image-control/api/internal/welcome-gift";
const DEFAULT_RELAY_TIMEOUT_MS = 4_000;

function isWelcomeGiftStatus(value: unknown): value is WelcomeGiftStatus {
  return (
    value === "granted" ||
    value === "already_granted" ||
    value === "ineligible" ||
    value === "in_flight" ||
    value === "unavailable"
  );
}

interface RelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function postRelay(body: Record<string, unknown>, options: RelayOptions): Promise<Record<string, unknown> | null> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  const rawBody = JSON.stringify(body);
  const timestamp = String(Date.now());
  const signature = signBizKeySync(secret, timestamp, rawBody, WELCOME_GIFT_RELAY_SIGNATURE_DOMAIN);
  const res = await (options.fetchImpl ?? fetch)(`${origin}${RELAY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Biz-Key-Sync-Timestamp": timestamp,
      "X-Biz-Key-Sync-Signature": signature,
    },
    body: rawBody,
    cache: "no-store",
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_RELAY_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return data?.ok === true ? data : null;
}

/** 请控制面发新人礼。env 缺一或失败 → null（不挡登录）。 */
export async function grantWelcomeGiftViaRelay(
  userId: number,
  options: RelayOptions = {},
): Promise<WelcomeGiftResult | null> {
  try {
    const data = await postRelay({ op: "grant", userId }, options);
    const payload = data?.result as Partial<WelcomeGiftResult> | undefined;
    if (!payload || !isWelcomeGiftStatus(payload.status)) return null;
    const amountQuota = Number(payload.amountQuota);
    return result(
      payload.status,
      userId,
      Number.isFinite(amountQuota) && amountQuota > 0 ? amountQuota : WELCOME_GIFT_QUOTA,
      undefined,
      payload.noticePending === true,
    );
  } catch (error) {
    console.error(`[welcome-gift] relay grant failed user=${userId}：${reasonOf(error)}`);
    return null;
  }
}

/** 站内通知已送达的回执。失败回 false（下次登录会再送一次通知——宁可多一条提示，不丢提示）。 */
export async function ackWelcomeGiftNoticeViaRelay(userId: number, options: RelayOptions = {}): Promise<boolean> {
  try {
    return (await postRelay({ op: "noticed", userId }, options)) !== null;
  } catch (error) {
    console.error(`[welcome-gift] relay ack failed user=${userId}：${reasonOf(error)}`);
    return false;
  }
}
