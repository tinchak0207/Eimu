// REQ-D3 訂閱 SKU：**發碼端**（訂閱兌換碼的產生）。
//
// 為什麼要有本檔：訂閱走兌換碼通道（預設，見 subscription-sku 的 SUBSCRIPTION_FULFILLMENT_CHANNEL），
// 而「這張碼是哪個 SKU」只能靠碼的 `name`（`SUB-<sku>@<ref>`）承載——沒有一個遵守這個
// 約定的發碼端，入帳端就永遠認不出訂閱碼。本檔就是那個唯一的生產者。
//
// 現場事實（為什麼標記放 name 不放 key，見 subscription-sku.ts 的長註釋）：
//   ・key：API 建碼路徑由 new-api 生成（不透明隨機串）；直寫庫路徑由我方生成，但仍是
//     隨機串 ⇒ 塞標記 = 改碼格式（對用戶可見、且兩條路徑不一致）。
//   ・name：**兩條建碼路徑都由我方寫入**（mPay 走 `MP<orderId>`；人工碼走 `eimu1500`），
//     且能由 `/api/redemption/` 只讀列出 ⇒ 標記的自然載體，無需映射表。
//
// 本檔與 `lib/mapay-redemption.ts` 同一族（同一個上游端點與同一個「先搜後建」冪等姿勢），
// 差別只在白名單欄位：`name` 由 `subscriptionCodeName(sku, orderId)` 產生。
// 未接線到任何結帳流程（哪個 SKU 對應哪個付費方案＝定價決策，需暴君定調）：本檔先把
// 「發碼能力」備好，入帳端已可認。

import type { GatewayRedemption } from "@/lib/gateway-admin";
import { subscriptionCodeName } from "@/lib/generation-core/subscription-sku";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

type GatewayResult<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

type RedemptionSearchData = {
  items?: GatewayRedemption[];
};

export type FulfilledSubscriptionRedemption = {
  key: string;
  created: boolean;
  /** 碼的 name（帶 SKU 標記，入帳端據此認出訂閱碼）。 */
  name: string;
};

export interface SubscriptionRedemptionPlan {
  /** SKU 識別（必須與 subscription-sku 的 SKU 註冊表或入帳端的兜底規則一致）。 */
  sku: string;
  /** 我方訂單/業務參照（寫進 name 的 @ 後段，只作審計與冪等搜尋）。 */
  orderId: string;
  /** 本期額度（quota 單位，1 幣 = QUOTA_PER_COIN）——由定價決定，本檔不發明。 */
  quota: number;
}

function gatewayBaseUrl(env: EnvLike): string {
  // [riskclose 2026-09-27] TLS gateway channel (bare-IP plaintext /api closed).
  return env.GATEWAY_BASE_URL ?? (env.NODE_ENV === "production" ? "https://store.tinchak0207.xyz/newapi" : "http://localhost:3001");
}

function bearer(value: string): string {
  const token = value.replace(/^Bearer\s+/i, "").trim();
  return `Bearer ${token}`;
}

function adminHeaders(env: EnvLike): Record<string, string> {
  const token =
    env.GATEWAY_ADMIN_ACCESS_TOKEN ??
    env.GATEWAY_ADMIN_TOKEN ??
    env.NEW_API_ADMIN_ACCESS_TOKEN ??
    "";
  const userId = env.GATEWAY_ADMIN_USER_ID ?? env.NEW_API_ADMIN_USER_ID ?? "";

  if (!token.trim() || !userId.trim()) {
    throw new Error("Missing New API admin redemption credentials.");
  }

  return {
    Authorization: bearer(token),
    "Content-Type": "application/json",
    "New-Api-User": userId.trim(),
  };
}

async function readGatewayResult<T>(response: Response): Promise<GatewayResult<T>> {
  const text = await response.text();
  if (!text) return { success: false, message: `Gateway returned ${response.status}` };

  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    return { success: false, message: text.slice(0, 300) };
  }
}

function exactRedemption(items: GatewayRedemption[] | undefined, name: string, quota: number) {
  return items?.find((item) => item.name === name && item.quota === quota && item.key);
}

/**
 * 產生（或找回）一張訂閱兌換碼。
 *
 * 幂等：先按 name 搜尋，已存在同名同額的碼 ⇒ 直接回既有碼（`created: false`）——
 * 重複履約不會產生第二張碼（多一張碼 = 多一次可兌換的錢）。
 */
export async function fulfillSubscriptionRedemption(
  input: { plan: SubscriptionRedemptionPlan },
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<FulfilledSubscriptionRedemption> {
  const name = subscriptionCodeName(input.plan.sku, input.plan.orderId);
  const quota = Math.round(input.plan.quota);
  const headers = adminHeaders(env);
  const baseUrl = gatewayBaseUrl(env);

  const search = await fetcher(`${baseUrl}/api/redemption/search?keyword=${encodeURIComponent(name)}`, {
    headers,
    cache: "no-store",
  });
  const searchResult = await readGatewayResult<RedemptionSearchData>(search);
  if (!search.ok || !searchResult.success) {
    throw new Error(searchResult.message ?? "Failed to search subscription redemption code.");
  }

  const existing = exactRedemption(searchResult.data?.items, name, quota);
  if (existing) return { key: existing.key, created: false, name };

  const create = await fetcher(`${baseUrl}/api/redemption/`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, count: 1, quota, expired_time: 0 }),
    cache: "no-store",
  });
  const createResult = await readGatewayResult<string[]>(create);
  const key = createResult.data?.[0];

  if (!create.ok || !createResult.success || !key) {
    throw new Error(createResult.message ?? "Failed to create subscription redemption code.");
  }

  return { key, created: true, name };
}
