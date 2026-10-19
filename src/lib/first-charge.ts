// 首充专享档（plan id `first-charge`，¥7 得 300 币，每帐号限一次）的资格判准与额度裁决。
//
// 为什么要有：项目负责人 09-28 拍板——增长杠杆只做「一次性、限首充、绑帐号」的优惠，不改正价
// （见记忆 price-no-change-0928）。正价 ¥9.9 = 100 币，本档 4 倍划算，所以「限一次」必须由
// 代码执法，否则等于变相长期降价。资格与限一次的执法点全在本档（控制面执行）。
//
// 资格（两条硬条件，都满足才算）：①该帐号在 account_ledger 从来没有 recharge 行；
// ②从未买过首充档（first_charge_claim 无该 user_id 的名额，或名额就是本单占的）。
//
// 「限一次」怎么做到并发安全：名额表 first_charge_claim 以 **user_id 为主键**，登记是
// 一句 INSERT … ON CONFLICT (user_id) DO NOTHING RETURNING（与新人礼 welcome_gift_grant
// 同一手法）。两单并发时只有一个抢到名额＝只有一张单拿 300 币，另一张按正价折算。
// 名额的 out_trade_no 与本次相同（同一张单重试）仍给全额：上游调额不幂等，
// 重试不能变成惩罚，否则「通道抖一下」就把用户的优惠永久吃掉。
//
// 三态而不是两态（重要）：只读查询回 true/false/null，null＝通道不可用＝「不知道」。
// 两处对「不知道」的处置**相反**，所以不能把它压成 false：
//   - checkout：null → 403（fail-closed，宁可少卖一次也不给不该给的 4 倍优惠）；
//   - notify 发码兜底：null → 照原价 300 币发（fail-open，钱必兑现优先，见 payment-must-fulfill-0920）。
//
// 部署拓扑：核心（…WithSql 与 productionDeps）只在控制面执行（直连控制面 Postgres）；
// Vercel 站点没有控制面库，只读资格查询走 HMAC 签名通道（signatureDomain "first-charge"）
// 转投 /image-control/api/internal/first-charge（与 welcome-gift / user-attribution 同一骨架）。
// 写侧不另开通道：额度裁决就长在 mapay-credit 的入帐通道里（src/app/api/internal/mapay-credit），
// 因为那里才是钱落地、也是 notify 的必经之路。

import { signBizKeySync } from "@/lib/biz-key-sync";
import { getGenerationSql, type GenerationSql } from "@/lib/generation-core/database";
import {
  FIRST_CHARGE_COINS,
  FIRST_CHARGE_FALLBACK_COINS,
  FIRST_CHARGE_PRICE,
} from "@/lib/plans";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

// ─────────────────────────────────────────── 常量

/** 首充全额额度（new-api quota 单位）。 */
export const FIRST_CHARGE_FULL_QUOTA = Math.round(FIRST_CHARGE_COINS * QUOTA_PER_COIN);
/** 资格不符时的额度：按正价折算（约 70 币）。 */
export const FIRST_CHARGE_FALLBACK_QUOTA = Math.round(FIRST_CHARGE_FALLBACK_COINS * QUOTA_PER_COIN);

export type FirstChargeEligibilityStatus = "eligible" | "ineligible_recharged" | "ineligible_claimed" | "unknown";

export interface FirstChargeEligibility {
  eligible: boolean;
  status: FirstChargeEligibilityStatus;
  /** 不合格/判不了的原因（简体，可展示、可写进 mapay_credit.detail）。 */
  reason?: string;
}

/** 名额（不是帐本，不存余额；只回答「这个 user 的首充名额被哪张单占了」）。 */
export interface FirstChargeClaim {
  outTradeNo: string;
  coins: number;
}

// ─────────────────────────────────────────── 纯函数（判准唯一权威）

/**
 * 资格判准（纯函数）：只看两个事实——帐本有没有 recharge 行、名额被哪张单占了。
 * outTradeNo 用于「名额就是本单占的」这一情形（同一张单重试/发码兜底仍算有资格）。
 */
export function firstChargeEligibilityOf(input: {
  hasRechargeLedgerRow: boolean;
  claimedOutTradeNo: string | null;
  outTradeNo?: string;
}): FirstChargeEligibility {
  if (input.hasRechargeLedgerRow) {
    return { eligible: false, status: "ineligible_recharged", reason: "该账号已有充值记录" };
  }
  const claimed = input.claimedOutTradeNo;
  if (claimed === null) return { eligible: true, status: "eligible" };
  if (input.outTradeNo && claimed === input.outTradeNo) {
    return { eligible: true, status: "eligible" };
  }
  return { eligible: false, status: "ineligible_claimed", reason: "该账号已购买过首充专享" };
}

// ─────────────────────────────────────────── 储存介面

export interface FirstChargeStore {
  /** 帐本里有没有 recharge 行（该帐号是否充值过）。 */
  hasRecharge(userId: number): Promise<boolean>;
  /** 该帐号的首充名额被哪张单占了（没有回 null）。 */
  readClaim(userId: number): Promise<FirstChargeClaim | null>;
  /** 登记名额：新插一笔，user_id 已存在（任何 out_trade_no）就不动。拿到名额回 true。 */
  claimSlot(userId: number, outTradeNo: string, coins: number): Promise<boolean>;
}

export interface FirstChargeDeps {
  store: FirstChargeStore;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ─────────────────────────────────────────── 只读资格查询

/** 只读资格查询（控面执行）。判不了＝status unknown、eligible false；调用方决定 fail-open/closed。 */
export async function checkFirstChargeEligibility(
  input: { userId: number; outTradeNo?: string },
  deps: FirstChargeDeps,
): Promise<FirstChargeEligibility> {
  try {
    const [hasRechargeLedgerRow, claim] = await Promise.all([
      deps.store.hasRecharge(input.userId),
      deps.store.readClaim(input.userId),
    ]);
    return firstChargeEligibilityOf({
      hasRechargeLedgerRow,
      claimedOutTradeNo: claim?.outTradeNo ?? null,
      ...(input.outTradeNo ? { outTradeNo: input.outTradeNo } : {}),
    });
  } catch (error) {
    console.error(`[first-charge] 资格查询失败 user=${input.userId}：${reasonOf(error)}`);
    return { eligible: false, status: "unknown", reason: "资格判定通道不可用" };
  }
}

// ─────────────────────────────────────────── 入帐额度裁决（钱路）

export interface FirstChargeGrant {
  /** 本次实际入帐币数（首充全额或按正价折算）。 */
  coins: number;
  amountQuota: number;
  eligible: boolean;
  /** 未能给足首充全额的原因（写进 mapay_credit.detail，供对帐与排障）。 */
  detail?: string;
}

function grantOf(coins: number, eligible: boolean, detail?: string): FirstChargeGrant {
  return {
    coins,
    amountQuota: Math.round(coins * QUOTA_PER_COIN),
    eligible,
    ...(detail ? { detail } : {}),
  };
}

/** 资格不符：按 ¥7 对应正价折算，原因写进 detail（对帐报告据此能解释这笔账）。 */
function fallbackGrant(reason: string): FirstChargeGrant {
  return grantOf(
    FIRST_CHARGE_FALLBACK_COINS,
    false,
    `${reason}；首充资格不符，按 ¥${FIRST_CHARGE_PRICE} 对应正价折算 ${FIRST_CHARGE_FALLBACK_COINS} 币`,
  );
}

/**
 * 这笔首充单该入多少币（控面执行，永不 throw）。
 * 有资格 → 抢名额（并发执法点）→ 300 币；资格不符 → 按正价折算 → 约 70 币 + detail。
 */
export async function resolveFirstChargeGrant(
  input: { userId: number; outTradeNo: string },
  deps: FirstChargeDeps,
): Promise<FirstChargeGrant> {
  const eligibility = await checkFirstChargeEligibility(input, deps);
  if (!eligibility.eligible) {
    // 含 unknown（判不了资格）：宁可按正价给，也绝不重复给 4 倍优惠。
    return fallbackGrant(eligibility.reason ?? "首充资格不符");
  }

  try {
    if (await deps.store.claimSlot(input.userId, input.outTradeNo, FIRST_CHARGE_COINS)) {
      return grantOf(FIRST_CHARGE_COINS, true);
    }
    // 名额已被占：是同一张单（重试）→ 全额；是别的单（并发/重复下单）→ 按正价折算。
    const winner = await deps.store.readClaim(input.userId);
    if (winner?.outTradeNo === input.outTradeNo) return grantOf(FIRST_CHARGE_COINS, true);
    return fallbackGrant(`首充名额已被订单 ${winner?.outTradeNo ?? "未知"} 占用（并发或重复下单）`);
  } catch (error) {
    console.error(`[first-charge] 名额登记失败 user=${input.userId}：${reasonOf(error)}`);
    return fallbackGrant("首充名额登记失败");
  }
}

// ─────────────────────────────────────────── Postgres（控制面）

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: GenerationSql): Promise<void> {
  if (!schemaReady) {
    // 与 db/migrations/031_first_charge_claim.sql 同一 DDL（幂等，首用即建，免人工迁移）。
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS first_charge_claim (
          user_id      bigint PRIMARY KEY,
          out_trade_no text NOT NULL UNIQUE,
          coins        bigint NOT NULL CHECK (coins > 0),
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

export function createPostgresFirstChargeStore(sql: GenerationSql = getGenerationSql()): FirstChargeStore {
  return {
    async hasRecharge(userId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT 1 AS hit FROM account_ledger
        WHERE billing_user_id = ${userId} AND entry_type = 'recharge'
        LIMIT 1
      `;
      return rows.length > 0;
    },
    async readClaim(userId) {
      await ensureSchema(sql);
      const rows = await sql<Row[]>`
        SELECT out_trade_no, coins FROM first_charge_claim WHERE user_id = ${userId} LIMIT 1
      `;
      if (!rows[0]) return null;
      return { outTradeNo: String(rows[0].out_trade_no), coins: Number(rows[0].coins) };
    },
    async claimSlot(userId, outTradeNo, coins) {
      await ensureSchema(sql);
      // 只插不覆盖：user_id 已有名额（任何单）就不动 —— 这是「限一次」的并发执法点。
      const rows = await sql<Row[]>`
        INSERT INTO first_charge_claim (user_id, out_trade_no, coins)
        VALUES (${userId}, ${outTradeNo}, ${coins})
        ON CONFLICT (user_id) DO NOTHING
        RETURNING user_id
      `;
      return rows.length > 0;
    },
  };
}

export function productionFirstChargeDeps(sql: GenerationSql = getGenerationSql()): FirstChargeDeps {
  return { store: createPostgresFirstChargeStore(sql) };
}

export async function checkFirstChargeEligibilityWithSql(
  sql: GenerationSql,
  input: { userId: number; outTradeNo?: string },
): Promise<FirstChargeEligibility> {
  return checkFirstChargeEligibility(input, productionFirstChargeDeps(sql));
}

export async function resolveFirstChargeGrantWithSql(
  sql: GenerationSql,
  input: { userId: number; outTradeNo: string },
): Promise<FirstChargeGrant> {
  return resolveFirstChargeGrant(input, productionFirstChargeDeps(sql));
}

// ─────────────────────────────────────────── Vercel 侧签名通道（只读资格查询）

export const FIRST_CHARGE_RELAY_SIGNATURE_DOMAIN = "first-charge";
const RELAY_PATH = "/image-control/api/internal/first-charge";
const DEFAULT_RELAY_TIMEOUT_MS = 4_000;

interface RelayOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

async function postRelay(
  body: Record<string, unknown>,
  options: RelayOptions,
): Promise<Record<string, unknown> | null> {
  const origin = process.env.GENERATION_CONTROL_PLANE_PROXY_ORIGIN?.trim().replace(/\/+$/, "");
  const secret = process.env.GENERATION_BILLING_RELAY_SECRET?.trim();
  if (!origin || !secret) return null;
  try {
    const rawBody = JSON.stringify(body);
    const timestamp = String(Date.now());
    const signature = signBizKeySync(secret, timestamp, rawBody, FIRST_CHARGE_RELAY_SIGNATURE_DOMAIN);
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
  } catch (error) {
    console.error(`[first-charge] relay failed：${reasonOf(error)}`);
    return null;
  }
}

/**
 * 只读资格查询（三态）：true＝有资格，false＝确定没有，null＝通道不可用（不知道）。
 * **不得把 null 当 false**——checkout 与发码兜底对「不知道」的处置相反，见本档头部说明。
 */
export async function readFirstChargeEligibilityViaRelay(
  input: { userId: number; outTradeNo?: string },
  options: RelayOptions = {},
): Promise<boolean | null> {
  const data = await postRelay(
    {
      op: "eligibility",
      userId: input.userId,
      ...(input.outTradeNo ? { outTradeNo: input.outTradeNo } : {}),
    },
    options,
  );
  if (!data) return null;
  return data.eligible === true;
}