// 付款對帳器（本任務核心）——用**支付商自己的資料**獨立對帳「支付商回報已付款 vs 我方已履約」。
//
// 為什麼需要它：2026-09-19 真單 out_trade_no=IMGMU7UH9SFF9A21D（夢芽 starter 100 金币，實付
// ¥9.93）支付成功，我方 notify handler 回 500、從未履約，而我方資料庫零痕跡、數月無人發現。
// 根本缺陷＝**沒有任何機制用支付商的資料獨立對帳已付款 vs 已履約**（我方帳本正是被測物，
// 拿它斷言「付了多少錢」是同源斷言——見 AGENTS.md 禁同源斷言）。本檔補上這條獨立對帳。
//
// 形態照抄 account-reconciliation.ts（跨層對帳），沿用同一套三條硬紀律：
//   1. **只讀**：本檔不得對我方帳本／額度有任何寫入（具名測試守門，測試只作變更探針，不作證明）。
//      補交付動作（fulfillMapayOrderManually）是**另一個具名匯出**，永不從對帳主入口被呼叫。
//   2. **歧義凍結**：定位不完的一律 verdict='unknown' 並如實列出；不猜、不自動補帳。
//      特別節：**人工補償碼（MANUAL-*、MPFIX993-0919 這類未用 `MP<單號>` 命名的碼）無法從
//      命名反推歸屬**——只當「疑似相關」候選列出，不當履約證據；這類單歸「需人工判定的未履約」，
//      manualReview=true，**不得自動補交付**（避免與人工已補的 1500 幣疊成雙份）。
//   3. **告警沿用既有通道**：console.error 的結構化行（與 [account-reconcile] 同一條），不新造通知機制。
//
// 判定口徑：對每個「支付商回報已付款」的 out_trade_no，檢查我方是否有任一履約證據——
//   (a) mapay_credit 存在且 status='applied'，或
//   (b) 存在兌換碼 `MP<單號後18位>` 且 quota 相符，或
//   (c) account_ledger 有 `redemption:<out_trade_no>` 的 recharge 行。
// 三者皆無 → verdict='paid_unfulfilled'（09-19 那筆就落在這個桶）。
//
// 取數口徑（2026-10-04 生產實證）：上游 `act=order` 是「按單號單查」**不是列表端點**（不帶
// 單號回 code:0；成功碼是 1）。故候選單號由我方已知單號推導（mapay_order_intake／mapay_credit／
// account_ledger 的 `redemption:<單號>`／兌換碼名 `MP<單號後18位>` 可反推者），再逐筆查支付商
// 真實狀態。「候選 0 或全部查無」＝看不到訂單，**不得**當成健康（見 health 路由）。

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

/** 默認滾動窗口：近 30 天（支付商 API 查詢越界沒有意義；真單是 09-19，仍在窗口內可驗）。 */
export const MAPAY_RECONCILE_WINDOW_DAYS_DEFAULT = 30;
/** cron 呼叫節流：默認 30 分鐘一次（支付商 API 不該被每分鐘打爆）。 */
export const MAPAY_RECONCILE_INTERVAL_MS_DEFAULT = 30 * 60_000;
/** 系統自動建的兌換碼命名（`mapayOrderRedemptionName` = MP + 單號後 18 位）。 */
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
  /** 認得出的套餐應發 quota；認不出為 null（此時兌換碼只看存在、不比對額度）。 */
  expectedQuota: number | null;
  planId: string | null;
  verdict: MapayOrderVerdict;
  evidence: {
    mapayCreditApplied: boolean;
    redemptionCode: boolean;
    ledgerRecharge: boolean;
  };
  /** 需人工判定（含人工補償碼痕跡 / 證據讀取失敗 / 額度不符的歧義）——不得自動補交付。 */
  manualReview: boolean;
  /** 疑似相關、但無法從命名歸屬的人工補償碼（只列出供人工判斷，不當履約證據）。 */
  manualCompensationCandidates: string[];
  reason: string;
}

export interface MapayOrderReconciliationReport {
  generatedAt: string;
  configured: boolean;
  window: { since: string; until: string };
  /** 本輪是否為 `?orders=` 顯式探針（只查指定單號，不從我方表推導候選）。 */
  explicitProbe: boolean;
  /** 支付商回報已付款的單數（本輪實際判定的集合）。 */
  checked: number;
  fulfilled: number;
  paidUnfulfilled: MapayOrderFinding[];
  unknown: MapayOrderFinding[];
  residue: {
    /** 本輪查詢的候選單號數（我方已知單號：intake／credit／ledger／兌換碼反推）。 */
    candidates: number;
    /** 支付商實際查到訂單實體的單數。 */
    found: number;
    paid: number;
    notPaid: number;
    /** 候選單號在支付商「查無此單」的數量。 */
    notFound: number;
    /** 逐筆查詢失敗的單號（通道／上游錯誤）——非空時**不得**回報健康。 */
    queryErrors: string[];
    /** **看不到任何訂單實體**（候選 0 或全部查無）＝「看不到」不是健康。 */
    upstreamEmpty: boolean;
    /** 讀不到的證據來源（card 未列 = 全部可讀）。 */
    evidenceUnreadable: string[];
    notes: string[];
  };
  lastFulfilledAt: string | null;
  alerts: string[];
  notes: string[];
}

// ─────────────────────────────────────────── 套餐解析（純函式）

export interface ResolvedOrderPlan {
  planId: string;
  coins: number;
  quota: number;
}

/**
 * 從訂單認出「買了什麼檔」。優先序（精度由高到低）：
 *   ① `param` 自簽還原 planId（已登入下單的單才有；最精確）
 *   ② `name` 內的金币數（`... 100金币`）
 *   ③ `money` 對檔位價格（容忍渠道手續費）
 * 都認不出 → null（對帳器不猜，兌換碼只按存在判定）。
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

// ─────────────────────────────────────────── 判定（純函式，唯一權威）

export interface ClassifyInput {
  order: MapayOrder;
  evidence: MapayOrderEvidence;
  expectedQuota: number | null;
  planId: string | null;
  manualCompensationCandidates: string[];
  /** 任一證據來源讀不到 ⇒ true：無法證明「未履約」時一律凍結 unknown，不誤判成 paid_unfulfilled。 */
  evidenceUnreadable: boolean;
}

/**
 * 單筆已付款訂單的判定。這是「已付款 vs 已履約」判別口徑的唯一權威——
 * 新增履約證據種類必須先改這裡與其測試。
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
        `已履約證據：` +
        [
          creditApplied ? "mapay_credit=applied" : null,
          redemptionHit ? `兌換碼 ${evidence.redemption?.name}` : null,
          ledgerHit ? "account_ledger recharge(redemption:<單號>)" : null,
        ]
          .filter(Boolean)
          .join("、"),
    };
  }

  // 兌換碼存在但 quota 不符（例：首充兜底只發 70 幣，或碼被重用）＝歧義，不當已履約也不當未履約。
  if (evidence.redemption && input.expectedQuota !== null && evidence.redemption.quota !== input.expectedQuota) {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason:
        `兌換碼 ${evidence.redemption.name} 存在但 quota=${evidence.redemption.quota} 與應發 ${input.expectedQuota} 不符——` +
        `歧義凍結，人工核對（不自動補交付，避免雙份）`,
    };
  }

  // 已占位但結果未定（pending/unknown）：上游調額不冪等，不得再開第二條發放通道。
  if (evidence.creditStatus === "pending" || evidence.creditStatus === "unknown") {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason: `mapay_credit 已占位（status=${evidence.creditStatus}）但入帳結果未定——人工核對，不得再發放`,
    };
  }

  if (input.evidenceUnreadable) {
    return {
      ...base,
      verdict: "unknown",
      evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
      manualReview: true,
      reason: "履約證據來源讀取失敗，無法證明已履約或未履約——歧義凍結，下輪重試或人工核對",
    };
  }

  const manualHit = input.manualCompensationCandidates.length > 0;
  return {
    ...base,
    verdict: "paid_unfulfilled",
    evidence: { mapayCreditApplied: false, redemptionCode: false, ledgerRecharge: false },
    manualReview: manualHit,
    reason: manualHit
      ? `支付商回報已付款，三條系統履約證據皆無；偵測到疑似人工補償碼（${input.manualCompensationCandidates.join("、")}）` +
        `——命名無法反推歸屬，歸「需人工判定的未履約」，**不得自動補交付**`
      : "支付商回報已付款，但 mapay_credit/兌換碼/account_ledger 三條履約證據皆無——未履約",
  };
}

/** 疑似人工補償碼：MMDD（付款日）或金額分數出現在碼名裡。只作候選，不當證據。 */
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

// ─────────────────────────────────────────── 證據讀取（只讀 SELECT / 只讀 GET）

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

// ─────────────────────────────────────────── 候選單號（我方已知單號；全部只讀 SELECT）

/** 單號字元集（與 tools/inspect-mapay-order.ts 同一保守判準）。 */
const OUT_TRADE_NO_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;

/**
 * 由系統兌換碼名 `MP<單號後18位>` 反推候選單號：只有後 18 位＝完整單號（單號長度 ≤18）
 * 才可反推；名裡超過 18 位＝已被截斷，丟棄不猜（查無此單自然會落在 notFound）。
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

/** 候選單號正規化：trim、去重、只留合法單號字元集。 */
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

// ─────────────────────────────────────────── 主入口（只讀）

export interface MapayReconcileDeps {
  sql?: GenerationSql;
  /**
   * 逐筆向支付商查單（按商戶單號）——對帳的權威取數來源。找不到回 null（查無此單），
   * 業務／通道錯誤應拋錯（呼叫端如實記進 queryErrors，不當健康）。
   */
  fetchOrder?: (outTradeNo: string) => Promise<MapayOrder | null>;
  listRedemptions?: () => Promise<GatewayRedemption[]>;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** 告警出口（默認 console.error，沿用既有通道）。 */
  alert?: (message: string) => void;
  /**
   * 顯式探針（只讀）：只查這些單號，**不**從我方表推導候選。給 orchestrator 驗證歷史單用。
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
 * 付款對帳主入口（只讀）。永不寫我方帳本／額度：只 GET 支付商與上游、只 SELECT 我方表，
 * 結果以報表與告警輸出。找不到的未履約單**不會**被自動補交付——補交付是另一個
 * 需人工顯式呼叫的 fulfillMapayOrderManually。
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
    return emptyReport("本實例沒有控制面資料庫連線（GENERATION_DATABASE_URL），付款對帳不可用。");
  }
  const sql = deps.sql ?? getGenerationSql();
  const env = deps.env ?? process.env;
  const alert = deps.alert ?? ((message: string) => console.error(`[mapay-order-reconcile] ${message}`));
  const evidenceUnreadable: string[] = [];

  // 兌換碼：既作履約證據，也作候選單號來源（`MP<後18位>` 可反推）。讀不到就只剩我方表候選。
  let redemptions: GatewayRedemption[] = [];
  try {
    redemptions = await (deps.listRedemptions ?? (() => listGatewayRedemptions({ pages: 10, pageSize: 100 })))();
  } catch (error) {
    evidenceUnreadable.push("redemptions");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] 上游兌換碼讀取失敗：${reason}`);
  }

  // 候選單號：顯式探針 → 只用指定單號；否則由我方已知單號推導（intake／credit／ledger／兌換碼反推）。
  const candidatePool: string[] = [];
  if (explicitOrders) {
    candidatePool.push(...explicitOrders);
    notes.push(`顯式探針：只查指定 ${explicitOrders.length} 筆單號（不從我方表推導候選）。`);
  } else {
    try {
      candidatePool.push(...(await readIntakeOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("mapay_order_intake");
      console.error(`[mapay-order-reconcile] mapay_order_intake 候選讀取失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      candidatePool.push(...(await readCreditOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("mapay_credit");
      console.error(`[mapay-order-reconcile] mapay_credit 候選讀取失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      candidatePool.push(...(await readLedgerRedemptionOrderNumbers(sql)));
    } catch (error) {
      evidenceUnreadable.push("account_ledger");
      console.error(`[mapay-order-reconcile] account_ledger 候選讀取失敗：${error instanceof Error ? error.message : String(error)}`);
    }
    candidatePool.push(...mapayCandidateOrderNumbersFromRedemptionNames(redemptions.map((item) => item.name ?? "")));
  }
  const candidates = normalizeMapayOrderCandidates(candidatePool);

  // 逐筆向支付商查真實狀態（上游 act=order 無法列舉，只能按我方已知單號單查）。
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
      console.error(`[mapay-order-reconcile] 單號 ${outTradeNo} 查詢失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const paidOrders = foundOrders.filter((order) => order.paid);
  const notPaid = foundOrders.length - paidOrders.length;
  const outTradeNos = paidOrders.map((order) => order.outTradeNo);

  // 「看不到訂單」≠健康：候選 0 或全部查無都要如實標示，不得當成「全部已履約」。
  const upstreamEmpty = foundOrders.length === 0;
  if (upstreamEmpty) {
    notes.push(
      candidates.length === 0
        ? "我方無任何已知候選單號可查——對帳無從證明健康。"
        : `候選 ${candidates.length} 筆單號在支付商全部查無訂單實體——「看不到訂單」不等於健康。`,
    );
  }
  if (notFound > 0 && !upstreamEmpty) notes.push(`${notFound} 筆候選單號在支付商查無此單。`);
  if (queryErrors.length > 0) {
    notes.push(`${queryErrors.length} 筆候選單號查詢失敗（通道／上游錯誤）——不得視為健康。`);
  }

  // 履約證據各自讀；讀不到如實記錄，並讓「證明不了」的單凍結 unknown。
  let creditMap = new Map<string, CreditEvidence>();
  let ledgerMap = new Map<string, LedgerRechargeEvidence>();

  try {
    creditMap = await readMapayCreditEvidence(sql, outTradeNos);
  } catch (error) {
    evidenceUnreadable.push("mapay_credit");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] mapay_credit 讀取失敗：${reason}`);
  }
  try {
    ledgerMap = await readLedgerRechargeEvidence(sql, outTradeNos);
  } catch (error) {
    evidenceUnreadable.push("account_ledger");
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[mapay-order-reconcile] account_ledger 讀取失敗：${reason}`);
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
  if (unknown.length > 0) notes.push(`${unknown.length} 筆已付款單未能判定（歧義凍結，人工核對；本輪不自動補交付）。`);
  if (paidUnfulfilled.length > 0) {
    notes.push(`${paidUnfulfilled.length} 筆已付款未履約——需人工處理；對帳器本身不補交付。`);
  }
  if (evidenceUnreadable.length > 0) {
    notes.push(`證據來源讀取失敗：${evidenceUnreadable.join("、")}——這些單的「未履約」判定不可信，已凍結為 unknown。`);
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

// ─────────────────────────────────────────── cron 節流入口

let lastMapayReconcileAt = 0;

/**
 * cron 用單次入口：自帶節流（默認 30 分鐘一次；MAPAY_RECONCILE_INTERVAL_MS 可調），
 * 避免每分鐘都打支付商 API。回 null＝本輪被節流或未配置。
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
    console.error("[mapay-order-reconcile] 本輪對帳異常（下一輪重試）", error);
    return null;
  }
}

// ─────────────────────────────────────────── 人工補交付（顯式；永不自動跑）

export interface ManualFulfillInput {
  outTradeNo: string;
  userId: number;
  /** 套餐 id（starter/popular/pro/first-charge/custom:<coins>）。 */
  planId: string;
  /** 操作人備註（寫進 mapay_credit.detail 供人工追溯）。 */
  note?: string;
}

export interface ManualFulfillResult {
  outcome: MapayCreditOutcome;
  planId: string;
  amountQuota: number;
}

/**
 * **需人工顯式呼叫**的補交付動作（不是對帳器預設行為）。走既有冪等入帳路徑
 * `runMapayCreditWithSql`（mapay_credit 佔位 + 上游調額 + account_ledger recharge，
 * 冪等鍵=out_trade_no），因此對同一張單重複呼叫只入帳一次。
 *
 * 為什麼不自動：人工補償碼（MANUAL-…／MPFIX…）無法從命名反推歸屬，自動補可能與人工
 * 已補的額度疊成雙份。operator 必須明確給 (outTradeNo, userId, planId)——不猜歸屬。
 */
export async function fulfillMapayOrderManually(
  input: ManualFulfillInput,
  deps: { sql?: GenerationSql } = {},
): Promise<ManualFulfillResult> {
  const plan = resolvePricingPlan(input.planId);
  if (!plan) throw new Error(`未知的套餐 id：${input.planId}`);
  if (!Number.isInteger(input.userId) || input.userId <= 0) throw new Error(`userId 必須是正整數（收到 ${input.userId}）`);
  if (!input.outTradeNo.trim()) throw new Error("outTradeNo 必填");
  const sql = deps.sql ?? getGenerationSql();
  const amountQuota = plan.coins * QUOTA_PER_COIN;
  const outcome = await runMapayCreditWithSql(sql, {
    orderId: input.outTradeNo.trim(),
    userId: input.userId,
    planId: plan.id,
    amountQuota,
    detail: `人工補交付${input.note ? `：${input.note}` : ""}`.slice(0, 500),
  });
  return { outcome, planId: plan.id, amountQuota };
}

// ─────────────────────────────────────────── 文字報表

export function formatMapayOrderReconciliationReport(report: MapayOrderReconciliationReport): string {
  const lines: string[] = [];
  lines.push(`# mPay 付款對帳報告（支付商已付款 vs 我方已履約） ${report.generatedAt}`);
  lines.push(
    `# 窗口 ${report.window.since} ~ ${report.window.until}｜已付款單 ${report.checked}｜` +
      `已履約 ${report.fulfilled}｜未履約 ${report.paidUnfulfilled.length}｜未定 ${report.unknown.length}`,
  );
  const render = (finding: MapayOrderFinding) => {
    const plan = finding.planId ?? "未知套餐";
    const worst = finding.expectedQuota !== null ? `${quotaToCoins(finding.expectedQuota)} 幣` : "額度未知";
    lines.push(
      `[${finding.verdict}] ${finding.outTradeNo} money=${finding.money ?? "?"} plan=${plan} 應發=${worst}` +
        `${finding.manualReview ? " ⚠需人工判定" : ""}`,
    );
    lines.push(`    ${finding.reason}`);
    for (const name of finding.manualCompensationCandidates) lines.push(`    ? 疑似人工補償碼：${name}`);
  };
  for (const finding of report.paidUnfulfilled) render(finding);
  for (const finding of report.unknown) render(finding);
  lines.push(`~ 最近一次成功履約：${report.lastFulfilledAt ?? "（窗口內無）"}`);
  for (const alert of report.alerts) lines.push(`! 告警：${alert}`);
  for (const note of report.notes) lines.push(`~ ${note}`);
  return lines.join("\n");
}