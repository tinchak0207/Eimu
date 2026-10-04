// mPay 付款直达入帐（控制面执行）：notify 验签通过 → 直接给下单用户加额，不再生成兑换码。
//
// 为什么：旧流程 notify 只发兑换码，靠用户回跳 /pricing 自动兑换。用户付完关掉分页
// ＝钱已付、额度没到（2026-09-19 实案同族事故）。绑了 userId 的订单（见 mapay-order-param.ts）
// 让 notify 能直接入帐，把「用户回跳」这条必要条件从钱路上摘掉。
//
// 记账（沿用管理员调额同一条路径，不另造第二套帐）：
//   ① 先占位 mapay_credit（主键 out_trade_no）——上游 new-api 调额本身不幂等，
//      必须在动上游之前先占位，同一张单永远只加一次额；**占位一旦存在就不再重占**
//      （就算状态是 failed）：重放/重试若再动一次上游，就会和已退回旧流程生成的
//      兑换码叠成双份。
//   ② 种基线 ensureAccountBaselinesWithStatus（account-ledger 顺序铁律：先基线→动上游→记增量）
//   ③ 上游 users.quota +N（adjustGatewayUserQuotaExact，内核执法点/供货水位）
//   ④ 我方帐本 account_ledger 记一笔 recharge（余额权威；真实现金单走默认
//      redemption-sync 来源 = 计入营收）。幂等键 = `redemption:<out_trade_no>`（UNIQUE），
//      重放不双算。两边差额由 account-reconciliation 对帐报告负责（记帐不挡钱路）。
//
// 状态机（mapay_credit.status）：
//   pending  已占位、正在/曾经尝试动上游 —— 不再自动重试（进程崩在中途＝宁可少发不可双发）
//   applied  上游已加额（帐本行随后落地，失败由对帐报告兜底）
//   failed   上游明确没动（调额抛错且复读 quota 未变）—— 可安全退回旧兑换码流程
//   unknown  上游结果不明（调额抛错且复读 quota 已变/读不到）—— 不自动重试，人工核对
//
// 部署拓扑：核心（runMapayCreditWithSql）只在控制面执行（直连控制面 Postgres + 上游管理凭证）；
// Vercel 站点没有控制面 DB，notify/return 经 HMAC 签名通道（signatureDomain "mapay-credit"）
// 转投 /image-control/api/internal/mapay-credit（与 welcome-gift / user-attribution 同一骨架）。

import { signBizKeySync } from "@/lib/biz-key-sync";
import { adjustGatewayUserQuotaExact, fetchGatewayUser, type GatewayAdminUser } from "@/lib/gateway-admin";
import {
  ensureAccountBaselinesWithStatus,
  recordRecharge,
} from "@/lib/generation-core/account-ledger";
import type { GenerationSql } from "@/lib/generation-core/database";

// ─────────────────────────────────────────── 常量

/** 帐本幂等键 = `redemption:<out_trade_no>`（recordRecharge 内置；重放不双算）。 */
export type MapayCreditStatus = "pending" | "applied" | "failed" | "unknown";

/**
 * 对外统一结果词表（控制面回传、Vercel 侧判定都用它）：
 *   credited          本次入帐成功
 *   already_credited  之前已入帐（applied）—— 重放
 *   failed            上游明确没动 —— 呼叫方可安全退回旧兑换码流程
 *   in_flight         已占位但结果未定（pending/unknown）—— 不得再开第二条发放通道
 *   none              没有这张单（未占位）
 *   unavailable       通道不可用（env 缺失/网络/签名失败）
 */
export type MapayCreditOutcome =
  | "credited"
  | "already_credited"
  | "failed"
  | "in_flight"
  | "none"
  | "unavailable";

export interface MapayCreditRecord {
  orderId: string;
  userId: number;
  planId: string;
  amountQuota: number;
  status: MapayCreditStatus;
}

export interface MapayCreditInput {
  orderId: string;
  userId: number;
  planId: string;
  amountQuota: number;
  /** 入帐口径说明（写进 mapay_credit.detail；如首充资格不符、按正价折算）。 */
  detail?: string;
}

// ─────────────────────────────────────────── 储存介面

export interface MapayCreditStore {
  /** 占位：新插 pending（已存在则不动）。拿到回 true。 */
  claim(input: MapayCreditInput): Promise<boolean>;
  get(orderId: string): Promise<MapayCreditRecord | null>;
  mark(orderId: string, status: Exclude<MapayCreditStatus, "pending">, detail?: string): Promise<void>;
}

export interface MapayCreditDeps {
  store: MapayCreditStore;
  ensureBaseline(userId: number): Promise<{ ready: boolean; blocked: boolean; reason?: string }>;
  readUpstreamQuota(userId: number): Promise<number | null>;
  adjustUpstream(userId: number, deltaQuota: number): Promise<void>;
  recordLedger(input: { userId: number; amountQuota: number; orderId: string }): Promise<{ posted: boolean; reason?: string }>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 已占位记录 → 结果词（重放路径的判定，占位表是唯一幂等键）。 */
function outcomeOfExisting(record: MapayCreditRecord | null): MapayCreditOutcome {
  if (!record) return "in_flight";
  if (record.status === "applied") return "already_credited";
  // failed＝上游明确没动，可安全退回旧流程；pending/unknown＝结果未定，不得再发一次。
  return record.status === "failed" ? "failed" : "in_flight";
}

/**
 * 跑一笔入帐（永不 throw；上游调额异常与储存层异常都在内部收敛成结果词）。
 * 幂等键 = out_trade_no：同一张单重放只入帐一次。
 */
export async function runMapayCreditOnce(
  deps: MapayCreditDeps,
  input: MapayCreditInput,
): Promise<MapayCreditOutcome> {
  const amountQuota = Math.round(input.amountQuota);
  if (!Number.isFinite(amountQuota) || amountQuota <= 0) return "failed";

  const claimed = await deps.store.claim({ ...input, amountQuota });
  if (!claimed) return outcomeOfExisting(await deps.store.get(input.orderId));

  let baseline: { ready: boolean; blocked: boolean; reason?: string };
  try {
    baseline = await deps.ensureBaseline(input.userId);
  } catch (error) {
    baseline = { ready: false, blocked: true, reason: reasonOf(error) };
  }
  if (baseline.blocked) {
    // 基线不可得＝帐本权威写不进去；不动上游（退回旧流程，不静默发钱）。
    await deps.store
      .mark(input.orderId, "failed", `基线不可得：${baseline.reason ?? ""}`.slice(0, 500))
      .catch(() => {});
    return "failed";
  }

  const before = await deps.readUpstreamQuota(input.userId).catch(() => null);
  try {
    await deps.adjustUpstream(input.userId, amountQuota);
  } catch (error) {
    const after = await deps.readUpstreamQuota(input.userId).catch(() => null);
    const untouched = before !== null && after !== null && after === before;
    const detail = `上游调额失败：${reasonOf(error)}`.slice(0, 500);
    console.error(
      `[mapay-credit] order=${input.orderId} user=${input.userId} ${detail}（${untouched ? "quota 未变" : "结果不明"}）`,
    );
    await deps.store.mark(input.orderId, untouched ? "failed" : "unknown", detail).catch(() => {});
    return untouched ? "failed" : "in_flight";
  }

  await deps.store.mark(input.orderId, "applied", input.detail).catch((error) => {
    console.error(
      `[mapay-credit] order=${input.orderId} 已加额但未能标 applied：${reasonOf(error)}`,
    );
  });

  if (baseline.ready) {
    // 帐本行（recharge，来源＝现金通道）：幂等键 `redemption:<out_trade_no>` 挡重放，
    // 帐本行缺失只记日志、不回退发放（对帐报告负责）。
    const ledger = await deps
      .recordLedger({ userId: input.userId, amountQuota, orderId: input.orderId })
      .catch((error) => ({ posted: false, reason: reasonOf(error) }));
    if (!ledger.posted) {
      console.error(`[mapay-credit] order=${input.orderId} 帐本行未落地（${ledger.reason ?? "重放"}）`);
    }
  }
  return "credited";
}

// ─────────────────────────────────────────── Postgres

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/030_mapay_credit.sql 同一 DDL（幂等，首用即建）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS mapay_credit (
          out_trade_no text PRIMARY KEY,
          user_id      bigint NOT NULL,
          plan_id      text NOT NULL,
          amount_quota bigint NOT NULL CHECK (amount_quota > 0),
          status       text NOT NULL CHECK (status IN ('pending', 'applied', 'failed', 'unknown')),
          detail       text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
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

function mapRow(row: Row): MapayCreditRecord {
  return {
    orderId: String(row.out_trade_no),
    userId: Number(row.user_id),
    planId: String(row.plan_id),
    amountQuota: Number(row.amount_quota),
    status: String(row.status) as MapayCreditStatus,
  };
}

export function createPostgresMapayCreditStore(sql: GenerationSql): MapayCreditStore {
  return {
    async claim({ orderId, userId, planId, amountQuota }) {
      await ensureSchema(sql);
      // 只插不覆盖：占位一旦存在（含 failed）就不再重占，重放永远只入帐一次。
      const rows = await sql<Row[]>`
        INSERT INTO mapay_credit (out_trade_no, user_id, plan_id, amount_quota, status)
        VALUES (${orderId}, ${userId}, ${planId}, ${amountQuota}, 'pending')
        ON CONFLICT (out_trade_no) DO NOTHING
        RETURNING out_trade_no
      `;
      return rows.length > 0;
    },
    async get(orderId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT out_trade_no, user_id, plan_id, amount_quota, status
        FROM mapay_credit WHERE out_trade_no = ${orderId} LIMIT 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },
    async mark(orderId, status, detail) {
      await ensureSchema(sql);
      await sql`
        UPDATE mapay_credit SET status = ${status}, detail = ${detail ?? null}, updated_at = now()
        WHERE out_trade_no = ${orderId}
      `;
    },
  };
}

export function productionMapayCreditDeps(sql: GenerationSql): MapayCreditDeps {
  const fetchUser = async (id: number): Promise<GatewayAdminUser | null> => fetchGatewayUser(id);
  return {
    store: createPostgresMapayCreditStore(sql),
    async ensureBaseline(userId) {
      const guard = await ensureAccountBaselinesWithStatus([userId], { sql, fetchUser });
      return { ready: guard.ready, blocked: guard.blocked, reason: guard.failures[0]?.reason };
    },
    async readUpstreamQuota(userId) {
      const user = await fetchGatewayUser(userId);
      return user ? Math.round(Number(user.quota) || 0) : null;
    },
    adjustUpstream: adjustGatewayUserQuotaExact,
    recordLedger: ({ userId, amountQuota, orderId }) =>
      recordRecharge({ billingUserId: userId, amountQuota, redemptionId: orderId }, { sql, fetchUser }),
  };
}

export async function runMapayCreditWithSql(
  sql: GenerationSql,
  input: MapayCreditInput,
): Promise<MapayCreditOutcome> {
  return runMapayCreditOnce(productionMapayCreditDeps(sql), input);
}

// ─────────────────────────────────────────── Vercel 侧签名通道

export const MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN = "mapay-credit";
const RELAY_PATH = "/image-control/api/internal/mapay-credit";
const DEFAULT_RELAY_TIMEOUT_MS = 8_000;

interface RelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function postRelay(body: Record<string, unknown>, options: RelayOptions): Promise<MapayCreditOutcome> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return "unavailable";
  try {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, MAPAY_CREDIT_RELAY_SIGNATURE_DOMAIN);
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
    return data.outcome as MapayCreditOutcome;
  } catch (error) {
    console.error(`[mapay-credit] relay failed：${reasonOf(error)}`);
    return "unavailable";
  }
}

/**
 * 请控制面给这张单入帐（幂等）。永不 throw：
 * credited/already_credited＝钱已落地（不必再发兑换码）；failed/unavailable＝退回旧流程；
 * in_flight＝已占位结果未定，不得再发兑换码（防双发）。
 */
export async function creditMapayOrderViaRelay(
  input: { orderId: string; userId: number; planId: string },
  options: RelayOptions = {},
): Promise<MapayCreditOutcome> {
  return postRelay({ op: "credit", ...input }, options);
}

/** 只读：这张单在控面是什么状态（return 页据此决定显示「已到账」还是走兑换码）。 */
export async function readMapayCreditStatusViaRelay(
  orderId: string,
  options: RelayOptions = {},
): Promise<MapayCreditOutcome> {
  return postRelay({ op: "status", orderId }, options);
}

/** 是否已确定入帐（本次或先前）。 */
export function isMapayCreditSettled(outcome: MapayCreditOutcome): boolean {
  return outcome === "credited" || outcome === "already_credited";
}

/**
 * 入帐结果 → 发放通道（notify／return 共用，唯一决策表）：
 *   direct      钱已落地，不再生成兑换码
 *   redemption  入帐通道明确不可用（failed/unavailable）→ 退回旧兑换码流程
 *   hold        已占位但结果未定 → 不开第二条通道，交人工核对
 */
export type MapayDeliveryChannel = "direct" | "redemption" | "hold" | "none";

export function mapayDeliveryFor(outcome: MapayCreditOutcome): MapayDeliveryChannel {
  if (isMapayCreditSettled(outcome)) return "direct";
  if (outcome === "in_flight") return "hold";
  if (outcome === "failed" || outcome === "unavailable") return "redemption";
  return "none";
}