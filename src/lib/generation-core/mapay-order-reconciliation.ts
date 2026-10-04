// 付款对帐器（本任务核心）——用**支付商自己的资料**独立对帐「支付商回报已付款 vs 我方已履约」。
//
// 为什么需要它：2026-09-19 真单 out_trade_no=IMGMU7UH9SFF9A21D（梦芽 starter 100 金币，实付
// ¥9.93）支付成功，我方 notify handler 回 500、从未履约，而我方资料库零痕迹、数月无人发现。
// 根本缺陷＝**没有任何机制用支付商的资料独立对帐已付款 vs 已履约**（我方帐本正是被测物，
// 拿它断言「付了多少钱」是同源断言——见 AGENTS.md 禁同源断言）。本档补上这条独立对帐。
//
// 形态照抄 account-reconciliation.ts（跨层对帐），沿用同一套三条硬纪律：
//   1. **只读**：本档不得对我方帐本／额度有任何写入（具名测试守门，测试只作变更探针，不作证明）。
//      补交付动作（fulfillMapayOrderManually）是**另一个具名汇出**，永不从对帐主入口被呼叫。
//   2. **歧义冻结**：定位不完的一律 verdict='unknown' 并如实列出；不猜、不自动补帐。
//      特别节：**人工补偿码（MANUAL-*、MPFIX993-0919 这类未用 `MP<单号>` 命名的码）无法从
//      命名反推归属**——只当「疑似相关」候选列出，不当履约证据；这类单归「需人工判定的未履约」，
//      manualReview=true，**不得自动补交付**（避免与人工已补的 1500 币叠成双份）。
//   3. **告警沿用既有通道**：console.error 的结构化行（与 [account-reconcile] 同一条），不新造通知机制。
//
// 判定口径：对每个「支付商回报已付款」的 out_trade_no，检查我方是否有任一履约证据——
//   (a) mapay_credit 存在且 status='applied'，或
//   (b) 存在兑换码 `MP<单号后18位>` 且 quota 相符，或
//   (c) account_ledger 有 `redemption:<out_trade_no>` 的 recharge 行。
// 三者皆无 → verdict='paid_unfulfilled'（09-19 那笔就落在这个桶）。
//
// 取数口径（2026-10-04 生产实证）：上游 `act=order` 是「按单号单查」**不是列表端点**（不带
// 单号回 code:0；成功码是 1）。故候选单号由我方已知单号推导（mapay_order_intake／mapay_credit／
// account_ledger 的 `redemption:<单号>`／兑换码名 `MP<单号后18位>` 可反推者），再逐笔查支付商
// 真实状态。「候选 0 或全部查无」＝看不到订单，**不得**当成健康（见 health 路由）。

import { resolvePricingPlan, PLANS, FIRST_CHARGE_PLAN } from "@/lib/plans";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";
import { listGatewayRedemptions, type GatewayRedemption } from "@/lib/gateway-admin";
import { resolveMapayOrderBinding } from "@/lib/mapay-order-param";
import { runMapayCreditWithSql, type MapayCreditOutcome, type MapayCreditStatus } from "@/lib/mapay-credit";
import {
  fetchMapayOrder,
  type MapayOrder,
} from "@/lib/mapay-orders";
import { generationDatabaseConfigured, getGenerationSql, type GenerationSql } from "./database";
import { quotaToCoins } from "./statistics-projection";

type Row = Record<string, unknown>;

/** 默认滚动窗口：近 30 天（支付商 API 查询越界没有意义；真单是 09-19，仍在窗口内可验）。 */
export const MAPAY_RECONCILE_WINDOW_DAYS_DEFAULT = 30;
/** cron 呼叫节流：默认 30 分钟一次（支付商 API 不该被每分钟打爆）。 */
export const MAPAY_RECONCILE_INTERVAL_MS_DEFAULT = 30 * 60_000;
/** 系统自动建的兑换码命名（`mapayOrderRedemptionName` = MP + 单号后 18 位）。 */
const SYSTEM_REDEMPTION_NAME = /^MP[A-Z0-9]{6,}$/;

export type MapayOrderVerdict = "fulfilled" | "paid_unfulfilled" | "unknown";

export interface MapayOrderEvidence {
  creditStatus: MapayCreditStatus | null;
  redemption: { name: string; quota: number; used: boolean; createdAt: string | null } | null;
  ledgerRecharge: { amountQuota: number; createdAt: string } | null;
}

export interface MapayOrderFinding {
  outTradeNo: string;
  tradeNo: string | null;
  money: number | null;
  paidAt: string | null;
  /** 认得出的套餐应发 quota；认不出为 null（此时兑换码只看存在、不比对额度）。 */
  expectedQuota: number | null;
  planId: string | null;
  verdict: MapayOrderVerdict;
  evidence: {
    mapayCreditApplied: boolean;
    redemptionCode: boolean;
    ledgerRecharge: boolean;
  };
  /** 需人工判定（含人工补偿码痕迹 / 证据读取失败 / 额度不符的歧义）——不得自动补交付。 */
  manualReview: boolean;
  /** 疑似相关、但无法从命名归属的人工补偿码（只列出供人工判断，不当履约证据）。 */
  manualCompensationCandidates: string[];
  reason: string;
}

export interface MapayOrderReconciliationReport {
  generatedAt: string;
  configured: boolean;
  window: { since: string; until: string };
  /** 本轮是否为 `?orders=` 显式探针（只查指定单号，不从我方表推导候选）。 */
  explicitProbe: boolean;
  /** 支付商回报已付款的单数（本轮实际判定的集合）。 */
  checked: number;
  fulfilled: number;
  paidUnfulfilled: MapayOrderFinding[];
  unknown: MapayOrderFinding[];
  residue: {
    /** 本轮查询的候选单号数（我方已知单号：intake／credit／ledger／兑换码反推）。 */
    candidates: number;
    /** 支付商实际查到订单实体的单数。 */
    found: number;
    paid: number;
    notPaid: number;
    /** 候选单号在支付商「查无此单」的数量。 */
    notFound: number;
    /** 逐笔查询失败的单号（通道／上游错误）——非空时**不得**回报健康。 */
    queryErrors: string[];
    /** **看不到任何订单实体**（候选 0 或全部查无）＝「看不到」不是健康。 */
    upstreamEmpty: boolean;
    /** 读不到的证据来源（card 未列 = 全部可读）。 */
    evidenceUnreadable: string[];
    notes: string[];
  };
  lastFulfilledAt: string | null;
  alerts: string[];
  notes: string[];
}

// ─────────────────────────────────────────── 套餐解析（纯函式）

export interface ResolvedOrderPlan {
  planId: string;
  coins: number;
  quota: number;
}

/**
 * 从订单认出「买了什么档」。优先序（精度由高到低）：
 *   ① `param` 自签还原 planId（已登入下单的单才有；最精确）
 *   ② `name` 内的金币数（`... 100金币`）
 *   ③ `money` 对档位价格（容忍渠道手续费）
 * 都认不出 → null（对帐器不猜，兑换码只按存在判定）。
 */
export function resolveOrderPlan(order: MapayOrder, env: NodeJS.ProcessEnv = process.env): ResolvedOrderPlan | null {
  const param = typeof order.raw.param === "string" ? order.raw.param : null;
  if (param) {
    const bound = resolveMapayOrderBinding(param, env);
    const plan = resolvePricingPlan(bound?.planId ?? param.split(".")[0] ?? "");
    if (plan) return { planId: plan.id, coins: plan.coins, quota: plan.coins * QUOTA_PER_COIN };
  }
  const fromName = /(\d+)\s*金币/.exec(order.name ?? "");
  if (fromName) {
    const coins = Number(fromName[1]);
    if (Number.isFinite(coins) && coins > 0) return { planId: `coins:${coins}`, coins, quota: coins * QUOTA_PER_COIN };
  }
  if (order.money !== null) {
    const match = [...PLANS, FIRST_CHARGE_PLAN].find(
      (plan) => Math.abs(order.money as number - plan.price) <= Math.max(0.5, plan.price * 0.05),
    );
    if (match) return { planId: match.id, coins: match.coins, quota: match.coins * QUOTA_PER_COIN };
  }
  return null;
}

// ─────────────────────────────────────────── 判定（纯函式，唯一权威）

export interface ClassifyInput {
  order: MapayOrder;
  evidence: MapayOrderEvidence;
  expectedQuota: number | null;
  planId: string | null;
  manualCompensationCandidates: string[];
  /** 任一证据来源读不到 ⇒ true：无法证明「未履约」时一律冻结 unknown，不误判成 paid_unfulfilled。 */
  evidenceUnreadable: boolean;
}

/**
 * 单笔已付款订单的判定。这是「已付款 vs 已履约」判别口径的唯一权威——
 * 新增履约证据种类必须先改这里与其测试。
 */
export function classifyMapayPaidOrder(input: ClassifyInput): MapayOrderFinding {
  const { order, evidence } = input;
  const base = {
    outTradeNo: order.outTradeNo,
    tradeNo: order.tradeNo,
    money: order.money,
    paidAt: order.paidAt,
    expectedQuota: input.expectedQuota,
    planId: input.planId,
    manualCompensationCandidates: input.manualCompensationCandidates,
  };
  const creditApplied = evidence.creditStatus === "applied";
  const ledgerHit = evidence.ledgerRecharge !== null;
  const redemptionHit =
    evidence.redemption !== null && (input.expectedQuota === null || evidence.redemption.quota === input.expectedQuota);

  if (creditApplied || ledgerHit || redemptionHit) {
    return {
      ...base,
      verdict: "fulfilled",
      evidence: { mapayCreditApplied: creditApplied, redemptionCode: redemptionHit, ledgerRecharge: ledgerHit },
      manualReview: false,
      reason:
        `已履约证据：` +
        [
          creditApplied ? "mapay_credit=applied" : null,
          redemptionHit ? `兑换码 ${evidence.redemption?.name}` : null,
          ledgerHit ? "account_ledger recharge(redemption:<单号>)" : null,
        ]
          .filter(Boolean)
          .join("、"),
    };
  }

  // 兑换码存在但 quota 不符（例：首充兜底只发 70 币，或码被重用）＝歧义，不当已履约也不当未履约。
  if (evidence.redemption && input.expectedQuota !== null && evidence.redemption.quota !== input.expectedQuota) {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason:
        `兑换码 ${evidence.redemption.name} 存在但 quota=${evidence.redemption.quota} 与应发 ${input.expectedQuota} 不符——` +
        `歧义冻结，人工核对（不自动补交付，避免双份）`,
    };
  }

  // 已占位但结果未定（pending/unknown）：上游调额不幂等，不得再开第二条发放通道。
  if (evidence.creditStatus === "pending" || evidence.creditStatus === "unknown") {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason: `mapay_credit 已占位（status=${evidence.creditStatus}）但入帐结果未定——人工核对，不得再发放`,
    };
  }

  if (input.evidenceUnreadable) {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason: "履约证据来源读取失败，无法证明已履约或未履约——歧义冻结，下轮重试或人工核对",
    };
  }

  const manualHit = input.manualCompensationCandidates.length > 0;
  return {
    ...base,
    verdict: "paid_unfulfilled",
    evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
    manualReview: manualHit,
    reason: manualHit
      ? `支付商回报已付款，三条系统履约证据皆无；侦测到疑似人工补偿码（${input.manualCompensationCandidates.join("、")}）` +
        `——命名无法反推归属，归「需人工判定的未履约」，**不得自动补交付**`
      : "支付商回报已付款，但 mapay_credit/兑换码/account_ledger 三条履约证据皆无——未履约",
  };
}

/** 疑似人工补偿码：MMDD（付款日）或金额分数出现在码名里。只作候选，不当证据。 */
export function manualCompensationCandidatesFor(
  order: MapayOrder,
  redemptions: GatewayRedemption[],
): string[] {
  const mmdd = order.paidAt ? beijingMmdd(order.paidAt) : null;
  const cents = order.money !== null ? Math.round(order.money * 100) : null;
  const names = new Set<string>();
  for (const redemption of redemptions) {
    const name = (redemption.name ?? "").trim();
    if (!name || SYSTEM_REDEMPTION_NAME.test(name)) continue;
    if (mmdd && name.includes(mmdd)) names.add(name);
    else if (cents !== null && name.includes(String(cents))) names.add(name);
  }
  return [...names];
}

function beijingMmdd(iso: string): string | null {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  const beijing = new Date(date.getTime() + 8 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(beijing.getUTCMonth() + 1)}${pad(beijing.getUTCDate())}`;
}

// ─────────────────────────────────────────── 证据读取（只读 SELECT / 只读 GET）

interface CreditEvidence {
  status: MapayCreditStatus;
  userId: number;
  updatedAt: string | null;
}

interface LedgerRechargeEvidence {
  billingUserId: number;
  amountQuota: number;
  createdAt: string;
}

async function readMapayCreditEvidence(
  sql: GenerationSql,
  outTradeNos: string[],
): Promise<Map<string, CreditEvidence>> {
  if (outTradeNos.length === 0) return new Map();
  const rows = await sql<Row[]>`
    SELECT out_trade_no, user_id, status, updated_at
    FROM mapay_credit
    WHERE out_trade_no = ANY(${outTradeNos}::text[])
  `;
  const map = new Map<string, CreditEvidence>();
  for (const row of rows) {
    map.set(String(row.out_trade_no), {
      status: String(row.status) as MapayCreditStatus,
      userId: Number(row.user_id),
      updatedAt: row.updated_at ? new Date(String(row.updated_at)).toISOString() : null,
    });
  }
  return map;
}

async function readLedgerRechargeEvidence(
  sql: GenerationSql,
  outTradeNos: string[],
): Promise<Map<string, LedgerRechargeEvidence>> {
  if (outTradeNos.length === 0) return new Map();
  const refs = outTradeNos.map((outTradeNo) => `redemption:${outTradeNo}`);
  const rows = await sql<Row[]>`
    SELECT source_ref, billing_user_id, amount, created_at
    FROM account_ledger
    WHERE source_ref = ANY(${refs}::text[])
      AND entry_type = 'recharge'
  `;
  const map = new Map<string, LedgerRechargeEvidence>();
  for (const row of rows) {
    const ref = String(row.source_ref ?? "");
    const outTradeNo = ref.startsWith("redemption:") ? ref.slice("redemption:".length) : ref;
    map.set(outTradeNo, {
      billingUserId: Number(row.billing_user_id),
      amountQuota: Number(row.amount),
      createdAt: new Date(String(row.created_at)).toISOString(),
    });
  }
  return map;
}

// ─────────────────────────────────────────── 候选单号（我方已知单号；全部只读 SELECT）

/** 单号字元集（与 tools/inspect-mapay-order.ts 同一保守判准）。 */
const OUT_TRADE_NO_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * 由系统兑换码名 `MP<单号后18位>` 反推候选单号：只有后 18 位＝完整单号（单号长度 ≤18）
 * 才可反推；名里超过 18 位＝已被截断，丢弃不猜（查无此单自然会落在 notFound）。
 */
export function mapayCandidateOrderNumbersFromRedemptionNames(names: string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!SYSTEM_REDEMPTION_NAME.test(name)) continue;
    const candidate = name.slice(2);
    if (candidate.length > 18) continue;
    if (!OUT_TRADE_NO_PATTERN.test(candidate)) continue;
    out.push(candidate);
  }
  return out;
}

/** 候选单号正规化：trim、去重、只留合法单号字元集。 */
export function normalizeMapayOrderCandidates(raw: string[]): string[] {
  const seen = new Set<string>();
  for (const value of raw) {
    const order = (value ?? "").trim();
    if (!OUT_TRADE_NO_PATTERN.test(order)) continue;
    seen.add(order);
  }
  return [...seen];
}

async function readIntakeOrderNumbers(sql: GenerationSql): Promise<string[]> {
  const rows = await sql<Row[]>`SELECT out_trade_no FROM mapay_order_intake`;
  return rows.map((row) => String(row.out_trade_no ?? "")).filter(Boolean);
}

async function readCreditOrderNumbers(sql: GenerationSql): Promise<string[]> {
  const rows = await sql<Row[]>`SELECT out_trade_no FROM mapay_credit`;
  return rows.map((row) => String(row.out_trade_no ?? "")).filter(Boolean);
}

async function readLedgerRedemptionOrderNumbers(sql: GenerationSql): Promise<string[]> {
  const rows = await sql<Row[]>`SELECT source_ref FROM account_ledger WHERE source_ref LIKE 'redemption:%'`;
  return rows
    .map((row) => String(row.source_ref ?? ""))
    .filter((ref) => ref.startsWith("redemption:"))
    .map((ref) => ref.slice("redemption:".length))
    .filter((order) => OUT_TRADE_NO_PATTERN.test(order));
}

// ─────────────────────────────────────────── 主入口（只读）

export interface MapayReconcileDeps {
  sql?: GenerationSql;
  /**
   * 逐笔向支付商查单（按商户单号）——对帐的权威取数来源。找不到回 null（查无此单），
   * 业务／通道错误应抛错（呼叫端如实记进 queryErrors，不当健康）。
   */
  fetchOrder?: (outTradeNo: string) => Promise<MapayOrder | null>;
  listRedemptions?: () => Promise<GatewayRedemption[]>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** 告警出口（默认 console.error，沿用既有通道）。 */
  alert?: (message: string) => void;
  /**
   * 显式探针（只读）：只查这些单号，**不**从我方表推导候选。给 orchestrator 验证历史单用。
   */
  orders?: string[];
}

function alertLine(finding: MapayOrderFinding): string {
  return (
    `out_trade_no=${finding.outTradeNo} verdict=${finding.verdict} money=${finding.money ?? "?"} ` +
    `paid_at=${finding.paidAt ?? "?"} ${finding.reason}`
  );
}

/**
 * 付款对帐主入口（只读）。永不写我方帐本／额度：只 GET 支付商与上游、只 SELECT 我方表，
 * 结果以报表与告警输出。找不到的未履约单**不会**被自动补交付——补交付是另一个
 * 需人工显式呼叫的 fulfillMapayOrderManually。
 */
export async function reconcileMapayOrders(
  window: { since?: Date | string; until?: Date | string } = {},
  deps: MapayReconcileDeps = {},
): Promise<MapayOrderReconciliationReport> {
  const now = deps.now ?? new Date();
  const until = window.until ? new Date(window.until) : now;
  const since =
    window.since ? new Date(window.since) : new Date(until.getTime() - MAPAY_RECONCILE_WINDOW_DAYS_DEFAULT * 24 * 3600_000);
  const generatedAt = now.toISOString();
  const alerts: string[] = [];
  const notes: string[] = [];
  const explicitOrders = deps.orders && deps.orders.length > 0 ? normalizeMapayOrderCandidates(deps.orders) : null;
  const explicitProbe = explicitOrders !== null;
  const emptyReport = (message: string): MapayOrderReconciliationReport => ({
    generatedAt,
    configured: false,
    window: { since: since.toISOString(), until: until.toISOString() },
    explicitProbe,
    checked: 0,
    fulfilled: 0,
    paidUnfulfilled: [],
    unknown: [],
    residue: {
      candidates: 0,
      found: 0,
      paid: 0,
      notPaid: 0,
      notFound: 0,
      queryErrors: [],
      upstreamEmpty: false,
      evidenceUnreadable: [],
      notes: [],
    },
    lastFulfilledAt: null,
    alerts: [],
    notes: [message],
  });

  if (!generationDatabaseConfigured() && !deps.sql) {
    return emptyReport("本实例没有控制面资料库连线（GENERATION_DATABASE_URL），付款对帐不可用。");
  }
  const sql = deps.sql ?? getGenerationSql();
  const env = deps.env ?? process.env;
  const alert = deps.alert ?? ((message: string) => console.error(`[mapay-order-reconcile] ${message}`));
  const evidenceUnreadable: string[] = [];

  // 兑换码：既作履约证据，也作候选单号来源（`MP<后18位>` 可反推）。读不到就只剩我方表候选。
  let redemptions: GatewayRedemption[] = [];
  try {
    redemptions = await (deps.listRedemptions ?? (() => listGatewayRedemptions({ pages: 10, pageSize: 100 })))();
  } catch (error) {
    evidenceUnreadable.push("redemptions");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] 上游兑换码读取失败：${reason}`);
  }

  // 候选单号：显式探针 → 只用指定单号；否则由我方已知单号推导（intake／credit／ledger／兑换码反推）。
  const candidatePool: string[] = [];
  if (explicitOrders) {
    candidatePool.push(...explicitOrders);
    notes.push(`显式探针：只查指定 ${explicitOrders.length} 笔单号（不从我方表推导候选）。`);
  } else {
    try {
      candidatePool.push(...(await readIntakeOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("mapay_order_intake");
      console.error(`[mapay-order-reconcile] mapay_order_intake 候选读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      candidatePool.push(...(await readCreditOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("mapay_credit");
      console.error(`[mapay-order-reconcile] mapay_credit 候选读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      candidatePool.push(...(await readLedgerRedemptionOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("account_ledger");
      console.error(`[mapay-order-reconcile] account_ledger 候选读取失败：${error instanceof Error ? error.message : String(error)}`);
    }
    candidatePool.push(...mapayCandidateOrderNumbersFromRedemptionNames(redemptions.map((item) => item.name ?? "")));
  }
  const candidates = normalizeMapayOrderCandidates(candidatePool);

  // 逐笔向支付商查真实状态（上游 act=order 无法列举，只能按我方已知单号单查）。
  const fetchOrder = deps.fetchOrder ?? ((outTradeNo: string) => fetchMapayOrder(outTradeNo));
  const foundOrders: MapayOrder[] = [];
  const queryErrors: string[] = [];
  let notFound = 0;
  for (const outTradeNo of candidates) {
    try {
      const order = await fetchOrder(outTradeNo);
      if (order) foundOrders.push(order);
      else notFound += 1;
    } catch (error) {
      queryErrors.push(outTradeNo);
      console.error(`[mapay-order-reconcile] 单号 ${outTradeNo} 查询失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const paidOrders = foundOrders.filter((order) => order.paid);
  const notPaid = foundOrders.length - paidOrders.length;
  const outTradeNos = paidOrders.map((order) => order.outTradeNo);

  // 「看不到订单」≠健康：候选 0 或全部查无都要如实标示，不得当成「全部已履约」。
  const upstreamEmpty = foundOrders.length === 0;
  if (upstreamEmpty) {
    notes.push(
      candidates.length === 0
        ? "我方无任何已知候选单号可查——对帐无从证明健康。"
        : `候选 ${candidates.length} 笔单号在支付商全部查无订单实体——「看不到订单」不等于健康。`,
    );
  }
  if (notFound > 0 && !upstreamEmpty) notes.push(`${notFound} 笔候选单号在支付商查无此单。`);
  if (queryErrors.length > 0) {
    notes.push(`${queryErrors.length} 笔候选单号查询失败（通道／上游错误）——不得视为健康。`);
  }

  // 履约证据各自读；读不到如实记录，并让「证明不了」的单冻结 unknown。
  let creditMap = new Map<string, CreditEvidence>();
  let ledgerMap = new Map<string, LedgerRechargeEvidence>();

  try {
    creditMap = await readMapayCreditEvidence(sql, outTradeNos);
  } catch (error) {
    evidenceUnreadable.push("mapay_credit");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] mapay_credit 读取失败：${reason}`);
  }
  try {
    ledgerMap = await readLedgerRechargeEvidence(sql, outTradeNos);
  } catch (error) {
    evidenceUnreadable.push("account_ledger");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] account_ledger 读取失败：${reason}`);
  }
  const redemptionByName = new Map<string, GatewayRedemption>();
  for (const redemption of redemptions) {
    const name = (redemption.name ?? "").trim();
    if (name) redemptionByName.set(name, redemption);
  }
  const readable = evidenceUnreadable.length === 0;

  const findings: MapayOrderFinding[] = [];
  let lastFulfilledAtMs = 0;
  for (const order of paidOrders) {
    const plan = resolveOrderPlan(order, env);
    const codeName = `MP${order.outTradeNo.slice(-18)}`;
    const redemption = redemptionByName.get(codeName) ?? null;
    const evidence: MapayOrderEvidence = {
      creditStatus: creditMap.get(order.outTradeNo)?.status ?? null,
      redemption: redemption
        ? {
            name: redemption.name ?? codeName,
            quota: Number(redemption.quota ?? 0),
            used: (redemption.status ?? 0) === 2,
            createdAt: redemption.created_time ? new Date(redemption.created_time * 1000).toISOString() : null,
          }
        : null,
      ledgerRecharge: ledgerMap.get(order.outTradeNo) ?? null,
    };
    const finding = classifyMapayPaidOrder({
      order,
      evidence,
      expectedQuota: plan?.quota ?? null,
      planId: plan?.planId ?? null,
      manualCompensationCandidates: manualCompensationCandidatesFor(order, redemptions),
      evidenceUnreadable: !readable,
    });
    findings.push(finding);
    if (finding.verdict === "fulfilled") {
      const stamp = evidence.ledgerRecharge?.createdAt ?? evidence.redemption?.createdAt ?? null;
      if (stamp) lastFulfilledAtMs = Math.max(lastFulfilledAtMs, new Date(stamp).getTime());
    }
    if (finding.verdict !== "fulfilled") {
      const line = alertLine(finding);
      alerts.push(line);
      alert(line);
    }
  }

  const paidUnfulfilled = findings.filter((finding) => finding.verdict === "paid_unfulfilled");
  const unknown = findings.filter((finding) => finding.verdict === "unknown");
  if (unknown.length > 0) notes.push(`${unknown.length} 笔已付款单未能判定（歧义冻结，人工核对；本轮不自动补交付）。`);
  if (paidUnfulfilled.length > 0) {
    notes.push(`${paidUnfulfilled.length} 笔已付款未履约——需人工处理；对帐器本身不补交付。`);
  }
  if (evidenceUnreadable.length > 0) {
    notes.push(`证据来源读取失败：${evidenceUnreadable.join("、")}——这些单的「未履约」判定不可信，已冻结为 unknown。`);
  }
  return {
    generatedAt,
    configured: true,
    window: { since: since.toISOString(), until: until.toISOString() },
    explicitProbe,
    checked: paidOrders.length,
    fulfilled: findings.filter((finding) => finding.verdict === "fulfilled").length,
    paidUnfulfilled,
    unknown,
    residue: {
      candidates: candidates.length,
      found: foundOrders.length,
      paid: paidOrders.length,
      notPaid,
      notFound,
      queryErrors,
      upstreamEmpty,
      evidenceUnreadable,
      notes: [],
    },
    lastFulfilledAt: lastFulfilledAtMs > 0 ? new Date(lastFulfilledAtMs).toISOString() : null,
    alerts,
    notes,
  };
}

// ─────────────────────────────────────────── cron 节流入口

let lastMapayReconcileAt = 0;

/**
 * cron 用单次入口：自带节流（默认 30 分钟一次；MAPAY_RECONCILE_INTERVAL_MS 可调），
 * 避免每分钟都打支付商 API。回 null＝本轮被节流或未配置。
 */
export async function runMapayOrderReconciliationOnce(
  deps: MapayReconcileDeps = {},
  now = Date.now(),
): Promise<MapayOrderReconciliationReport | null> {
  const raw = Number(process.env.MAPAY_RECONCILE_INTERVAL_MS ?? "");
  const intervalMs = Number.isFinite(raw) && raw > 0 ? raw : MAPAY_RECONCILE_INTERVAL_MS_DEFAULT;
  if (now - lastMapayReconcileAt < intervalMs) return null;
  lastMapayReconcileAt = now;
  try {
    return await reconcileMapayOrders({}, deps);
  } catch (error) {
    console.error("[mapay-order-reconcile] 本轮对帐异常（下一轮重试）", error);
    return null;
  }
}

// ─────────────────────────────────────────── 人工补交付（显式；永不自动跑）

export interface ManualFulfillInput {
  outTradeNo: string;
  userId: number;
  /** 套餐 id（starter/popular/pro/first-charge/custom:<coins>）。 */
  planId: string;
  /** 操作人备注（写进 mapay_credit.detail 供人工追溯）。 */
  note?: string;
}

export interface ManualFulfillResult {
  outcome: MapayCreditOutcome;
  planId: string;
  amountQuota: number;
}

/**
 * **需人工显式呼叫**的补交付动作（不是对帐器预设行为）。走既有幂等入帐路径
 * `runMapayCreditWithSql`（mapay_credit 占位 + 上游调额 + account_ledger recharge，
 * 幂等键=out_trade_no），因此对同一张单重复呼叫只入帐一次。
 *
 * 为什么不自动：人工补偿码（MANUAL-…／MPFIX…）无法从命名反推归属，自动补可能与人工
 * 已补的额度叠成双份。operator 必须明确给 (outTradeNo, userId, planId)——不猜归属。
 */
export async function fulfillMapayOrderManually(
  input: ManualFulfillInput,
  deps: { sql?: GenerationSql } = {},
): Promise<ManualFulfillResult> {
  const plan = resolvePricingPlan(input.planId);
  if (!plan) throw new Error(`未知的套餐 id：${input.planId}`);
  if (!Number.isInteger(input.userId) || input.userId <= 0) throw new Error(`userId 必须是正整数（收到 ${input.userId}）`);
  if (!input.outTradeNo.trim()) throw new Error("outTradeNo 必填");
  const sql = deps.sql ?? getGenerationSql();
  const amountQuota = plan.coins * QUOTA_PER_COIN;
  const outcome = await runMapayCreditWithSql(sql, {
    orderId: input.outTradeNo.trim(),
    userId: input.userId,
    planId: plan.id,
    amountQuota,
    detail: `人工补交付${input.note ? `：${input.note}` : ""}`.slice(0, 500),
  });
  return { outcome, planId: plan.id, amountQuota };
}

// ─────────────────────────────────────────── 文字报表

export function formatMapayOrderReconciliationReport(report: MapayOrderReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`# mPay 付款对帐报告（支付商已付款 vs 我方已履约） ${report.generatedAt}`);
  lines.push(
    `# 窗口 ${report.window.since} ~ ${report.window.until}｜已付款单 ${report.checked}｜` +
      `已履约 ${report.fulfilled}｜未履约 ${report.paidUnfulfilled.length}｜未定 ${report.unknown.length}`,
  );
  const render = (finding: MapayOrderFinding) => {
    const plan = finding.planId ?? "未知套餐";
    const worst = finding.expectedQuota !== null ? `${quotaToCoins(finding.expectedQuota)} 币` : "额度未知";
    lines.push(
      `[${finding.verdict}] ${finding.outTradeNo} money=${finding.money ?? "?"} plan=${plan} 应发=${worst}` +
        `${finding.manualReview ? " ⚠需人工判定" : ""}`,
    );
    lines.push(`    ${finding.reason}`);
    for (const name of finding.manualCompensationCandidates) lines.push(`    ? 疑似人工补偿码：${name}`);
  };
  for (const finding of report.paidUnfulfilled) render(finding);
  for (const finding of report.unknown) render(finding);
  lines.push(`~ 最近一次成功履约：${report.lastFulfilledAt ?? "（窗口内无）"}`);
  for (const alert of report.alerts) lines.push(`! 告警：${alert}`);
  for (const note of report.notes) lines.push(`~ ${note}`);
  return lines.join("\n");
}