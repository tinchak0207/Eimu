// mPay 回调落地存证（mapay_order_intake）：把「钱到了」这件事在履约副作用之前先写进控制面。
//
// 为什么：2026-09-19 真实订单 IMGMU7UH9SFF9A21D 被支付商推送 6 次、我方全回 500
// （履约时打到一条已死的 gateway 默认 URL）。旧流程在 fulfillMapayRedemption 之前
// **不写任何落地记录**，履约一炸这笔订单在数据库零痕迹，只能靠支付商后台才发现。
// 本表在验签通过、支付成功后、任何履约副作用之前落一条存证；履约成功标 fulfilled，
// 失败由 cron sweep（见 sweepMapayIntakeOnce）用既有幂等路径重投。
//
// 分工（与 mapay-credit.ts 同构）：
//   Vercel 站点没有控制面 DB，notify 经 HMAC 签名通道（signatureDomain "mapay-intake"）
//   转投 /image-control/api/internal/mapay-intake（与 mapay-credit / welcome-gift 同一骨架）。
//   控制面侧的 store / sweep 才直连控制面 Postgres。

import { signBizKeySync } from "@/lib/biz-key-sync";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";
import {
  createPostgresMapayCreditStore,
  runMapayCreditWithSql,
  type MapayCreditOutcome,
  type MapayCreditStatus,
} from "@/lib/mapay-credit";
import { fulfillMapayRedemption, type MapayRedemptionPlan } from "@/lib/mapay-redemption";
import { mapayMoneyAcceptable } from "@/lib/mapay";
import { FIRST_CHARGE_PLAN_ID, resolvePricingPlan } from "@/lib/plans";
import { resolveFirstChargeGrantWithSql } from "@/lib/first-charge";
import { parseSeatOrderParam, seatOrderEntitlementCoins } from "@/lib/team-seat-order";
import { fulfillSeatOrder } from "@/lib/team-seat-fulfillment";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

// ─────────────────────────────────────────── 常量／型别

export type MapayIntakeState = "received" | "fulfilled" | "parked";
export type MapayIntakeDelivery = "direct_credit" | "redemption_code";

/** 存证通道结果词（控制面回传、Vercel 侧判定都用它）。 */
export type MapayIntakeRecordOutcome = "recorded" | "unavailable";
export type MapayIntakeFulfilledOutcome = "fulfilled" | "unavailable";

export interface MapayIntakeRecord {
  outTradeNo: string;
  rawParams: Record<string, string>;
  money: string | null;
  planId: string | null;
  param: string | null;
  userId: number | null;
  state: MapayIntakeState;
  delivery: MapayIntakeDelivery | null;
  detail: string | null;
  sweepAttempts: number;
  createdAt: string;
}

export interface MapayIntakeInput {
  orderId: string;
  rawParams: Record<string, string>;
  money?: string | null;
  planId?: string | null;
  param?: string | null;
  userId?: number | null;
}

/** sweep 连续失败上限：达到即 parked（上游调额不幂等，宁可停不可双发）。 */
export const MAPAY_INTAKE_MAX_SWEEP_ATTEMPTS = 6;
/** 只挑落地超过 10 分钟仍 received 的行（给 notify 自身履约留出时间）。 */
const DEFAULT_SWEEP_MIN_AGE_MS = 10 * 60_000;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────── 控制面 Postgres 储存

export interface MapayIntakeStore {
  /** upsert：已存在且不是 received（fulfilled/parked）时不降级；返回落库后的状态名供日志。 */
  record(input: MapayIntakeInput): Promise<MapayIntakeState>;
  get(orderId: string): Promise<MapayIntakeRecord | null>;
  markFulfilled(orderId: string, delivery: MapayIntakeDelivery, detail?: string): Promise<void>;
  markParked(orderId: string, detail: string): Promise<void>;
  /** 失败计数 +1，返回累计次数。 */
  bumpAttempts(orderId: string, detail: string): Promise<number>;
  listStale(cutoff: Date, limit: number): Promise<MapayIntakeRecord[]>;
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/037_mapay_order_intake.sql 同一 DDL（幂等，首用即建）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS mapay_order_intake (
          out_trade_no   text PRIMARY KEY,
          raw_params     jsonb NOT NULL,
          money          text,
          plan_id        text,
          param          text,
          user_id        bigint,
          state          text NOT NULL CHECK (state IN ('received', 'fulfilled', 'parked')),
          delivery       text CHECK (delivery IN ('direct_credit', 'redemption_code')),
          detail         text,
          sweep_attempts integer NOT NULL DEFAULT 0,
          created_at     timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS mapay_order_intake_state_created_idx
          ON mapay_order_intake (state, created_at)
      `;
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

type Row = Record<string, unknown>;

function mapRow(row: Row): MapayIntakeRecord {
  return {
    outTradeNo: String(row.out_trade_no),
    rawParams: (row.raw_params ?? {}) as Record<string, string>,
    money: row.money === null || row.money === undefined ? null : String(row.money),
    planId: row.plan_id === null || row.plan_id === undefined ? null : String(row.plan_id),
    param: row.param === null || row.param === undefined ? null : String(row.param),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    state: String(row.state) as MapayIntakeState,
    delivery: (row.delivery ?? null) as MapayIntakeDelivery | null,
    detail: row.detail === null || row.detail === undefined ? null : String(row.detail),
    sweepAttempts: Number(row.sweep_attempts ?? 0),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ""),
  };
}

export function createPostgresMapayIntakeStore(sql: GenerationSql): MapayIntakeStore {
  return {
    async record(input) {
      await ensureSchema(sql);
      // upsert：raw 参数可覆盖（回调重放可能补齐字段），但状态只在 received 时更新，
      // 绝不把 fulfilled/parked 降级回 received（否则 sweep 会重复跑一笔已交付的单）。
      const rows = await sql<Row[]>`
        INSERT INTO mapay_order_intake (out_trade_no, raw_params, money, plan_id, param, user_id, state)
        VALUES (
          ${input.orderId},
          ${sql.json((input.rawParams ?? {}) as never)},
          ${input.money ?? null},
          ${input.planId ?? null},
          ${input.param ?? null},
          ${input.userId ?? null},
          'received'
        )
        ON CONFLICT (out_trade_no) DO UPDATE SET
          raw_params = EXCLUDED.raw_params,
          money      = EXCLUDED.money,
          plan_id    = EXCLUDED.plan_id,
          param      = EXCLUDED.param,
          user_id    = EXCLUDED.user_id,
          updated_at = now()
        WHERE mapay_order_intake.state = 'received'
        RETURNING state
      `;
      if (rows[0]) return String(rows[0].state) as MapayIntakeState;
      const current = await sql<Row[]>`
        SELECT state FROM mapay_order_intake WHERE out_trade_no = ${input.orderId} LIMIT 1
      `;
      return current[0] ? (String(current[0].state) as MapayIntakeState) : "received";
    },
    async get(orderId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT out_trade_no, raw_params, money, plan_id, param, user_id, state, delivery, detail, sweep_attempts, created_at
        FROM mapay_order_intake WHERE out_trade_no = ${orderId} LIMIT 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async markFulfilled(orderId, delivery, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE mapay_order_intake
        SET state = 'fulfilled', delivery = ${delivery}, detail = ${detail ?? null}, updated_at = now()
        WHERE out_trade_no = ${orderId}
      `;
    },
    async markParked(orderId, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE mapay_order_intake
        SET state = 'parked', detail = ${detail.slice(0, 500)}, updated_at = now()
        WHERE out_trade_no = ${orderId}
      `;
    },
    async bumpAttempts(orderId, detail) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        UPDATE mapay_order_intake
        SET sweep_attempts = sweep_attempts + 1, detail = ${detail.slice(0, 500)}, updated_at = now()
        WHERE out_trade_no = ${orderId}
        RETURNING sweep_attempts
      `;
      return rows[0] ? Number(rows[0].sweep_attempts) : 0;
    },
    async listStale(cutoff, limit) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT out_trade_no, raw_params, money, plan_id, param, user_id, state, delivery, detail, sweep_attempts, created_at
        FROM mapay_order_intake
        WHERE state = 'received' AND created_at < ${cutoff}
        ORDER BY created_at ASC
        LIMIT ${limit}
      `;
      return rows.map(mapRow);
    },
  };
}

// ─────────────────────────────────────────── cron sweep（控面执行）

export interface MapayIntakeSweepResult {
  scanned: number;
  fulfilled: number;
  parked: number;
  skipped: number;
  failed: number;
}

type ResolvedIntake =
  | { kind: "seat"; userId: number; planId: string; amountQuota: number; detail: string; plan: null }
  | { kind: "bound"; userId: number; planId: string; amountQuota: number; detail?: string; plan: MapayRedemptionPlan }
  | { kind: "unbound"; userId: null; planId: string; amountQuota: null; detail?: string; plan: MapayRedemptionPlan };

/**
 * 由存证行重算入帐口径（与 /api/internal/mapay-credit 同一段解析逻辑）：
 * seat: 走席位；静态/custom 套餐走标价；首充按同源裁决函数。**额度一律服务端重算**。
 */
async function resolveIntake(sql: GenerationSql, row: MapayIntakeRecord): Promise<ResolvedIntake | { error: string }> {
  const seat = parseSeatOrderParam(row.param);
  if (seat) {
    const coins = seatOrderEntitlementCoins(seat);
    if (coins === null) return { error: "席位订单参数不合法" };
    return {
      kind: "seat",
      userId: seat.teamUserId,
      planId: row.param ?? "",
      amountQuota: Math.round(coins * QUOTA_PER_COIN),
      detail: `团队席位 ${seat.tier}/${seat.cycle} × ${seat.seats} 席（${coins} 币）`,
      plan: null,
    };
  }
  const planId = row.planId ?? row.param ?? "";
  const plan = resolvePricingPlan(planId);
  if (!plan) return { error: `无法解析套餐：${planId}` };
  let coins = plan.coins;
  let detail: string | undefined;
  if (plan.id === FIRST_CHARGE_PLAN_ID && row.userId) {
    const grant = await resolveFirstChargeGrantWithSql(sql, { userId: row.userId, outTradeNo: row.outTradeNo });
    coins = Math.round(grant.amountQuota / QUOTA_PER_COIN);
    detail = grant.detail;
  }
  const amountQuota = Math.round(coins * QUOTA_PER_COIN);
  const redemptionPlan: MapayRedemptionPlan = { id: plan.id, name: plan.name, price: plan.price, coins };
  return row.userId
    ? { kind: "bound", userId: row.userId, planId: plan.id, amountQuota, detail, plan: redemptionPlan }
    : { kind: "unbound", userId: null, planId: plan.id, amountQuota: null, detail, plan: redemptionPlan };
}

async function recordSweepFailure(store: MapayIntakeStore, orderId: string, detail: string): Promise<void> {
  const attempts = await store.bumpAttempts(orderId, `sweep: ${detail}`);
  if (attempts >= MAPAY_INTAKE_MAX_SWEEP_ATTEMPTS) {
    await store.markParked(orderId, `sweep: 连续失败 ${attempts} 次：${detail}`);
    console.error(`[mapay-intake] sweep parked order=${orderId} attempts=${attempts}：${detail}`);
  }
}

/**
 * 挑 state='received' 且落地超过 minAge 的行，用既有幂等路径重投履约（cron 每分钟一次）。
 *
 * 铁律（上游调额 /api/user/manage 不幂等）：
 *   - 已达幂等键（mapay_credit=applied / 兑换码同名同额已存在）→ 视作已交付，只补标 fulfilled。
 *   - mapay_credit=pending/unknown → **绝不自动重试**（结果未定，重投会双发），跳过留人工。
 *   - 连续失败超过 6 次 → parked 并告警。
 */
export async function sweepMapayIntakeOnce(
  sql: GenerationSql,
  options: { minAgeMs?: number; limit?: number; now?: number } = {},
): Promise<MapayIntakeSweepResult> {
  const store = createPostgresMapayIntakeStore(sql);
  const creditStore = createPostgresMapayCreditStore(sql);
  const minAgeMs = options.minAgeMs ?? DEFAULT_SWEEP_MIN_AGE_MS;
  const limit = options.limit ?? 20;
  const cutoff = new Date((options.now ?? Date.now()) - minAgeMs);

  const result: MapayIntakeSweepResult = { scanned: 0, fulfilled: 0, parked: 0, skipped: 0, failed: 0 };
  const rows = await store.listStale(cutoff, limit);

  for (const row of rows) {
    result.scanned += 1;
    try {
      const resolved = await resolveIntake(sql, row);
      if ("error" in resolved) {
        await store.markParked(row.outTradeNo, `sweep: ${resolved.error}`);
        result.parked += 1;
        continue;
      }

      if (resolved.kind === "seat") {
        const existing: MapayCreditStatus | null = (await creditStore.get(row.outTradeNo))?.status ?? null;
        if (existing === "applied") {
          await store.markFulfilled(row.outTradeNo, "direct_credit", "sweep: 上游已加额");
          result.fulfilled += 1;
          continue;
        }
        if (existing !== null && existing !== "failed") {
          // pending/unknown：结果未定，重投会双发 —— 跳过。
          result.skipped += 1;
          continue;
        }
        const seat = await fulfillSeatOrder(
          { param: row.param, money: row.money ?? undefined, orderId: row.outTradeNo },
          {
            creditSeatOrder: ({ orderId, userId, param }) =>
              runMapayCreditWithSql(sql, {
                orderId,
                userId,
                planId: param,
                amountQuota: resolved.amountQuota,
                detail: resolved.detail,
              }),
          },
        );
        if (seat.handled && !seat.ok) {
          // 金额不符 / 参数不合法：绝不入帐，置 parked 留人工（不是网络抖动）。
          await store.markParked(row.outTradeNo, `sweep: 席位拒绝 ${seat.code}`);
          result.parked += 1;
          continue;
        }
        if (seat.handled && seat.ok && seat.credited) {
          await store.markFulfilled(row.outTradeNo, "direct_credit", "sweep: 席位已入帐");
          result.fulfilled += 1;
          continue;
        }
        await recordSweepFailure(store, row.outTradeNo, `席位入帐未落地（${seat.handled && seat.ok ? seat.outcome : "unknown"}）`);
        result.failed += 1;
        continue;
      }

      if (!resolved.plan || !mapayMoneyAcceptable(row.money ?? undefined, resolved.plan.price)) {
        // 回调金额与同源价表不符：绝不入帐，置 parked 留人工。
        await store.markParked(row.outTradeNo, `sweep: 金额与套餐报价不符（money=${row.money ?? "null"}）`);
        result.parked += 1;
        continue;
      }

      if (resolved.kind === "bound") {
        const existing: MapayCreditStatus | null = (await creditStore.get(row.outTradeNo))?.status ?? null;
        if (existing === "applied") {
          await store.markFulfilled(row.outTradeNo, "direct_credit", "sweep: 上游已加额");
          result.fulfilled += 1;
          continue;
        }
        if (existing !== null && existing !== "failed") {
          result.skipped += 1;
          continue;
        }
        const outcome: MapayCreditOutcome = await runMapayCreditWithSql(sql, {
          orderId: row.outTradeNo,
          userId: resolved.userId,
          planId: resolved.planId,
          amountQuota: resolved.amountQuota,
          detail: resolved.detail,
        });
        if (outcome === "credited" || outcome === "already_credited") {
          await store.markFulfilled(row.outTradeNo, "direct_credit", `sweep: ${outcome}`);
          result.fulfilled += 1;
          continue;
        }
        if (outcome === "in_flight") {
          result.skipped += 1;
          continue;
        }
        // failed（上游明确没动）→ 退回旧兑换码流程兜底（钱必兑现，见 payment-must-fulfill-0920）。
        await fulfillMapayRedemption({ orderId: row.outTradeNo, plan: resolved.plan });
        await store.markFulfilled(row.outTradeNo, "redemption_code", "sweep: 直达入帐不可用，退回兑换码");
        result.fulfilled += 1;
        continue;
      }

      // unbound（未登入下单，旧格式 param）：只有兑换码一条通道。
      await fulfillMapayRedemption({ orderId: row.outTradeNo, plan: resolved.plan });
      await store.markFulfilled(row.outTradeNo, "redemption_code", "sweep: 兑换码");
      result.fulfilled += 1;
    } catch (error) {
      await recordSweepFailure(store, row.outTradeNo, reasonOf(error)).catch(() => {});
      result.failed += 1;
    }
  }

  if (result.scanned > 0) {
    console.log(
      `[mapay-intake] sweep scanned=${result.scanned} fulfilled=${result.fulfilled} ` +
        `parked=${result.parked} skipped=${result.skipped} failed=${result.failed}`,
    );
  }
  return result;
}

// ─────────────────────────────────────────── Vercel 侧签名通道
// 本节逐行复制 mapay-credit.ts 的 HMAC relay 骨架（signBizKeySync 签名通道），
// 白名单只改三处：signatureDomain → "mapay-intake"、relay 目标路由 →
// /image-control/api/internal/mapay-intake、payload 栏位。
// 签名/时间戳/header/错误处理/超时一律照抄，不得精简。

export const MAPAY_INTAKE_RELAY_SIGNATURE_DOMAIN = "mapay-intake";
const RELAY_PATH = "/image-control/api/internal/mapay-intake";
const DEFAULT_RELAY_TIMEOUT_MS = 8_000;

interface RelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function postRelay(body: Record<string, unknown>, options: RelayOptions): Promise<string> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return "unavailable";
  try {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, MAPAY_INTAKE_RELAY_SIGNATURE_DOMAIN);
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
    if (!res.ok) return "unavailable";
    const data = (await res.json().catch(() => null)) as { ok?: boolean; outcome?: unknown } | null;
    if (!data?.ok || typeof data.outcome !== "string") return "unavailable";
    return data.outcome;
  } catch (error) {
    console.error(`[mapay-intake] relay failed：${reasonOf(error)}`);
    return "unavailable";
  }
}

/**
 * 请控制面给这张单落地一条存证（upsert，永不 throw）。
 * **必须**在验签通过、支付成功后、任何履约副作用之前调用。
 */
export async function recordMapayIntakeViaRelay(
  input: MapayIntakeInput,
  options: RelayOptions = {},
): Promise<MapayIntakeRecordOutcome> {
  return (await postRelay(
    {
      op: "record",
      orderId: input.orderId,
      rawParams: input.rawParams,
      money: input.money ?? null,
      planId: input.planId ?? null,
      param: input.param ?? null,
      userId: input.userId ?? null,
    },
    options,
  )) as MapayIntakeRecordOutcome;
}

/** 履约落地后回标 fulfilled（永不 throw；失败只记日志，sweep 会幂等补）。 */
export async function markMapayIntakeFulfilledViaRelay(
  input: { orderId: string; delivery: MapayIntakeDelivery; detail?: string },
  options: RelayOptions = {},
): Promise<MapayIntakeFulfilledOutcome> {
  return (await postRelay(
    { op: "fulfilled", orderId: input.orderId, delivery: input.delivery, detail: input.detail ?? null },
    options,
  )) as MapayIntakeFulfilledOutcome;
}