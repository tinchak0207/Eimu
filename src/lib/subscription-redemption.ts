// REQ-D3 订阅 SKU：**发码端**（订阅兑换码的产生）。
//
// 为什么要有本档：订阅走兑换码通道（预设，见 subscription-sku 的 SUBSCRIPTION_FULFILLMENT_CHANNEL），
// 而「这张码是哪个 SKU」只能靠码的 `name`（`SUB-<sku>@<ref>`）承载——没有一个遵守这个
// 约定的发码端，入帐端就永远认不出订阅码。本档就是那个唯一的生产者。
//
// 现场事实（为什么标记放 name 不放 key，见 subscription-sku.ts 的长注释）：
//   ・key：API 建码路径由 new-api 生成（不透明随机串）；直写库路径由我方生成，但仍是
//     随机串 ⇒ 塞标记 = 改码格式（对用户可见、且两条路径不一致）。
//   ・name：**两条建码路径都由我方写入**（mPay 走 `MP<orderId>`；人工码走 `eimu1500`），
//     且能由 `/api/redemption/` 只读列出 ⇒ 标记的自然载体，无需映射表。
//
// 本档与 `lib/mapay-redemption.ts` 同一族（同一个上游端点与同一个「先搜后建」幂等姿势），
// 差别只在白名单栏位：`name` 由 `subscriptionCodeName(sku, orderId)` 产生。
// 未接线到任何结帐流程（哪个 SKU 对应哪个付费方案＝定价决策，需暴君定调）：本档先把
// 「发码能力」备好，入帐端已可认。

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
  /** 码的 name（带 SKU 标记，入帐端据此认出订阅码）。 */
  name: string;
};

export interface SubscriptionRedemptionPlan {
  /** SKU 识别（必须与 subscription-sku 的 SKU 注册表或入帐端的兜底规则一致）。 */
  sku: string;
  /** 我方订单/业务参照（写进 name 的 @ 后段，只作审计与幂等搜寻）。 */
  orderId: string;
  /** 本期额度（quota 单位，1 币 = QUOTA_PER_COIN）——由定价决定，本档不发明。 */
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
 * 产生（或找回）一张订阅兑换码。
 *
 * 幂等：先按 name 搜寻，已存在同名同额的码 ⇒ 直接回既有码（`created: false`）——
 * 重复履约不会产生第二张码（多一张码 = 多一次可兑换的钱）。
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
