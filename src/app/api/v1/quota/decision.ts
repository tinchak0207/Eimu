// /v1/quota 的余额决策（自 route.ts 拆出的**行为等价搬迁**，非改判）：
// Next.js 对 route 档的汇出做白名单型别检查，值汇出 `decideQuota` 留在
// route.ts 会让 `next build` 直接 Failed to compile（本机 tsc 照不到，
// 2026-09-23 远端建置实锤）；故函式与型别住进这个普通模组，
// route.ts 只做 HTTP 包装。演译注解与决策语义逐字随行，不动一字。
//
// GET /v1/quota —— agent gateway 余额闸的生产读法。
//
// gateway 的 workflow preflightBudget（R5-B）与 fetchBalance（钱包角标）都打
// 这条路：Bearer B端/agent key → biz_api_key.userId → **我方帐本**（account_ledger）
// → { balance_coins }。
//
// REQ-E1a（项目负责人 2026-09-23 裁定）：客户可见余额的权威归我方帐本；new-api 的
// users.quota 降格为「上游供货水位」。故不再直接读 users.quota，而是：
//   ① 确保该身份有上线基线（ensureAccountOpening，以 new-api 当时余额种入、幂等）
//   ② 读我方帐本 → 可用余额（REQ-D3：永久池 + 未过期订阅池，读取时 lazy 判定过期）
// 回应形状（success / balance_coins / currency）与 503（quota_unavailable）文案
// 一字不改——契约不破。余额可为负（真实状态，不夹到 0）。
//
// REQ-D3 改了什么：数字的口径从「帐面净额 Σ amount」变成「**可用**余额」。
// 没有订阅帐本行时两者逐位相同（回归不变）；有订阅时，已过期期的残额不再计入可用
// （不依赖任何定时任务：过期是这次读取当场算出来的）。
//
// 降级：本模组同时服务 Vercel 站点副本（该实例没有控制面 DB 连线）。没有帐本储存层时
// 退回原本的 users.quota 读法——C 端显示不因本次权威搬迁而断（生产路径在控制面，
// 那里有帐本，回答的是我方口径）。

import { fetchGatewayUser, type GatewayAdminUser } from "@/lib/gateway-admin";
import {
  accountLedgerStoreEnabled,
  ensureAccountOpening,
  quotaResponseBody,
  readPoolBalances,
  type OpeningSeedResult,
} from "@/lib/generation-core/account-ledger";
import type { PoolBalances } from "@/lib/generation-core/subscription-sku";

/** 决策结果（HTTP 状态 + 回应体 + 标头）——路由只负责把它包成 NextResponse。 */
export interface QuotaDecision {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** 决策的注入点（测试用同一条决策路径的真实行为断言，不必起 Next 服务）。 */
export interface QuotaDecisionDeps {
  ledgerEnabled?: () => boolean;
  ensureOpening?: (billingUserId: number) => Promise<OpeningSeedResult>;
  readPools?: (billingUserId: number) => Promise<PoolBalances & { entries: unknown[] }>;
  fetchUser?: (billingUserId: number) => Promise<GatewayAdminUser | null>;
}

/** 余额不可得的决策（契约码与文案沿用，改的只是「什么时候说这句话」）。 */
function unavailableDecision(): QuotaDecision {
  return {
    status: 503,
    body: { success: false, error: { message: "余额查询暂不可用，请稍后重试。", code: "quota_unavailable" } },
    headers: {},
  };
}

function okDecision(quota: number): QuotaDecision {
  return { status: 200, body: quotaResponseBody(quota), headers: { "Cache-Control": "no-store" } };
}

/**
 * 余额读取的**完整决策**（单一权威，路由与测试共用）：
 *
 *   帐本已配置 → ①确保基线（回读确认）②读池口径可用余额
 *   基线不成立（E1-b D-2）→ **503，不得回 200 的 0**：空帐本 Σ=0 是「还没有帐」，
 *   不是「余额 0 币」；把「读不到」画成 0 等于对客户说谎。
 *   帐本未配置（C 端站点副本）→ 回落 users.quota（既有降级，行为不变）。
 *
 * 本函式只读上游（fetchGatewayUser），永不写上游：余额查询不得有任何外部副作用。
 */
export async function decideQuota(userId: number, deps: QuotaDecisionDeps = {}): Promise<QuotaDecision> {
  const ledgerEnabled = deps.ledgerEnabled ?? accountLedgerStoreEnabled;
  const ensureOpening = deps.ensureOpening ?? ((id: number) => ensureAccountOpening(id));
  const readPools = deps.readPools ?? ((id: number) => readPoolBalances(id));
  const fetchUser = deps.fetchUser ?? fetchGatewayUser;

  // ① 帐本口径（权威）：基线不明（new-api 不可达／基线落不了地）时不画假数字 → 503。
  if (ledgerEnabled()) {
    try {
      const opening = await ensureOpening(userId);
      if (opening.baselineQuota === null) return unavailableDecision();
      const balances = await readPools(userId);
      return okDecision(balances.availableQuota);
    } catch (error) {
      console.error(`[v1/quota] 帐本读取失败 user=${userId}`, error);
      return unavailableDecision();
    }
  }

  // ② 降级（C 端 Vercel 站点副本，无控制面 DB）：沿用既有 users.quota 读法。
  let user: Awaited<ReturnType<typeof fetchGatewayUser>>;
  try {
    user = await fetchUser(userId);
  } catch {
    user = null;
  }
  if (!user) return unavailableDecision();

  return okDecision(user.quota);
}
