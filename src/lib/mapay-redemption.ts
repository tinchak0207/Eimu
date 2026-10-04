import { QUOTA_PER_COIN } from "./quota-constants";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type EnvLike = Record<string, string | undefined>;

type GatewayResult<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

type RedemptionSearchData = {
  items?: NewApiRedemption[];
};

export type NewApiRedemption = {
  id: number;
  key: string;
  name: string;
  quota: number;
  status: number;
};

export type FulfilledRedemption = {
  key: string;
  created: boolean;
};

export type MapayRedemptionPlan = {
  id: string;
  name: string;
  price: number;
  coins: number;
};

function gatewayBaseUrl(env: EnvLike): string {
  // [riskclose 2026-09-27] TLS gateway channel (bare-IP plaintext /api closed).
  // [riskclose 2026-10-04] 生产环境**必须**显式配置 GATEWAY_BASE_URL：旧实现在 env 缺失时
  // 静默回退到硬编码默认值，2026-09-19 真实订单 IMGMU7UH9SFF9A21D 就是走到一条已死的
  // 默认 URL 被支付商推送 6 次全回 500（钱路定时炸弹）。钱路不得静默回退。
  const configured = env.GATEWAY_BASE_URL?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "Missing GATEWAY_BASE_URL：生产环境 mPay 兑换码履约必须显式配置网关地址，禁止回退到硬编码默认值。",
    );
  }
  return "http://localhost:3001";
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

export function mapayOrderRedemptionName(orderId: string): string {
  return `MP${orderId.slice(-18)}`;
}

export function mapayPlanQuota(plan: MapayRedemptionPlan): number {
  return plan.coins * QUOTA_PER_COIN;
}

function exactRedemption(items: NewApiRedemption[] | undefined, name: string, quota: number) {
  return items?.find((item) => item.name === name && item.quota === quota && item.key);
}

export async function fulfillMapayRedemption(
  input: { orderId: string; plan: MapayRedemptionPlan },
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<FulfilledRedemption> {
  const name = mapayOrderRedemptionName(input.orderId);
  const quota = mapayPlanQuota(input.plan);
  const headers = adminHeaders(env);
  const baseUrl = gatewayBaseUrl(env);

  const search = await fetcher(
    `${baseUrl}/api/redemption/search?keyword=${encodeURIComponent(name)}`,
    { headers, cache: "no-store" },
  );
  const searchResult = await readGatewayResult<RedemptionSearchData>(search);
  if (!search.ok || !searchResult.success) {
    throw new Error(searchResult.message ?? "Failed to search redemption code.");
  }

  const existing = exactRedemption(searchResult.data?.items, name, quota);
  if (existing) return { key: existing.key, created: false };

  const create = await fetcher(`${baseUrl}/api/redemption/`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name,
      count: 1,
      quota,
      expired_time: 0,
    }),
    cache: "no-store",
  });
  const createResult = await readGatewayResult<string[]>(create);
  const key = createResult.data?.[0];

  if (!create.ok || !createResult.success || !key) {
    throw new Error(createResult.message ?? "Failed to create redemption code.");
  }

  return { key, created: true };
}
