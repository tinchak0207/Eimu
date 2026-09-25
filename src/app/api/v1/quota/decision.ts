// /v1/quota 的餘額決策（自 route.ts 拆出的**行為等價搬遷**，非改判）：
// Next.js 對 route 檔的匯出做白名單型別檢查，值匯出 `decideQuota` 留在
// route.ts 會讓 `next build` 直接 Failed to compile（本機 tsc 照不到，
// 2026-09-23 遠端建置實錘）；故函式與型別住進這個普通模組，
// route.ts 只做 HTTP 包裝。演譯註解與決策語義逐字隨行，不動一字。
//
// GET /v1/quota —— agent gateway 餘額閘的生產讀法。
//
// gateway 的 workflow preflightBudget（R5-B）與 fetchBalance（錢包角標）都打
// 這條路：Bearer B端/agent key → biz_api_key.userId → **我方帳本**（account_ledger）
// → { balance_coins }。
//
// REQ-E1a（暴君 2026-09-23 裁定）：客戶可見餘額的權威歸我方帳本；new-api 的
// users.quota 降格為「上游供貨水位」。故不再直接讀 users.quota，而是：
//   ① 確保該身份有上線基線（ensureAccountOpening，以 new-api 當時餘額種入、幂等）
//   ② 讀我方帳本 → 可用餘額（REQ-D3：永久池 + 未過期訂閱池，讀取時 lazy 判定過期）
// 回應形狀（success / balance_coins / currency）與 503（quota_unavailable）文案
// 一字不改——契約不破。餘額可為負（真實狀態，不夾到 0）。
//
// REQ-D3 改了什麼：數字的口徑從「帳面淨額 Σ amount」變成「**可用**餘額」。
// 沒有訂閱帳本行時兩者逐位相同（回歸不變）；有訂閱時，已過期期的殘額不再計入可用
// （不依賴任何定時任務：過期是這次讀取當場算出來的）。
//
// 降級：本模組同時服務 Vercel 站點副本（該實例沒有控制面 DB 連線）。沒有帳本儲存層時
// 退回原本的 users.quota 讀法——C 端顯示不因本次權威搬遷而斷（生產路徑在控制面，
// 那裡有帳本，回答的是我方口徑）。

import { fetchGatewayUser, type GatewayAdminUser } from "@/lib/gateway-admin";
import {
  accountLedgerStoreEnabled,
  ensureAccountOpening,
  quotaResponseBody,
  readPoolBalances,
  type OpeningSeedResult,
} from "@/lib/generation-core/account-ledger";
import type { PoolBalances } from "@/lib/generation-core/subscription-sku";

/** 決策結果（HTTP 狀態 + 回應體 + 標頭）——路由只負責把它包成 NextResponse。 */
export interface QuotaDecision {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** 決策的注入點（測試用同一條決策路徑的真實行為斷言，不必起 Next 服務）。 */
export interface QuotaDecisionDeps {
  ledgerEnabled?: () => boolean;
  ensureOpening?: (billingUserId: number) => Promise<OpeningSeedResult>;
  readPools?: (billingUserId: number) => Promise<PoolBalances & { entries: unknown[] }>;
  fetchUser?: (billingUserId: number) => Promise<GatewayAdminUser | null>;
}

/** 餘額不可得的決策（契約碼與文案沿用，改的只是「什麼時候說這句話」）。 */
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
 * 餘額讀取的**完整決策**（單一權威，路由與測試共用）：
 *
 *   帳本已配置 → ①確保基線（回讀確認）②讀池口徑可用餘額
 *   基線不成立（E1-b D-2）→ **503，不得回 200 的 0**：空帳本 Σ=0 是「還沒有帳」，
 *   不是「餘額 0 幣」；把「讀不到」畫成 0 等於對客戶說謊。
 *   帳本未配置（C 端站點副本）→ 回落 users.quota（既有降級，行為不變）。
 *
 * 本函式只讀上游（fetchGatewayUser），永不寫上游：餘額查詢不得有任何外部副作用。
 */
export async function decideQuota(userId: number, deps: QuotaDecisionDeps = {}): Promise<QuotaDecision> {
  const ledgerEnabled = deps.ledgerEnabled ?? accountLedgerStoreEnabled;
  const ensureOpening = deps.ensureOpening ?? ((id: number) => ensureAccountOpening(id));
  const readPools = deps.readPools ?? ((id: number) => readPoolBalances(id));
  const fetchUser = deps.fetchUser ?? fetchGatewayUser;

  // ① 帳本口徑（權威）：基線不明（new-api 不可達／基線落不了地）時不畫假數字 → 503。
  if (ledgerEnabled()) {
    try {
      const opening = await ensureOpening(userId);
      if (opening.baselineQuota === null) return unavailableDecision();
      const balances = await readPools(userId);
      return okDecision(balances.availableQuota);
    } catch (error) {
      console.error(`[v1/quota] 帳本讀取失敗 user=${userId}`, error);
      return unavailableDecision();
    }
  }

  // ② 降級（C 端 Vercel 站點副本，無控制面 DB）：沿用既有 users.quota 讀法。
  let user: Awaited<ReturnType<typeof fetchGatewayUser>>;
  try {
    user = await fetchUser(userId);
  } catch {
    user = null;
  }
  if (!user) return unavailableDecision();

  return okDecision(user.quota);
}
