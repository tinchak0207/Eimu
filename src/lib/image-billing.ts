import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { QUOTA_PER_COIN } from "@/lib/new-api-client";
import { EnvLike, shouldBypassAuthForLocalTest } from "@/lib/sub2api";

export const IMAGE_GENERATION_QUOTA = QUOTA_PER_COIN;

type FetchLike = typeof fetch;

type GatewayResult<T> = {
  success: boolean;
  message?: string;
  data?: T;
};

export type ImageBillingUser = {
  id: number;
  username: string;
  quota: number;
  used_quota: number;
};

export type ImageAuthResult =
  | { ok: true; user: ImageBillingUser; bypassBilling: boolean }
  | { ok: false; status: number; message: string };

/**
 * A response that reached New API and was explicitly rejected. Transport
 * failures are deliberately left as ordinary errors so the durable ledger can
 * freeze them for reconciliation instead of replaying a possible debit.
 */
export class ImageBillingGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfter?: string | null,
  ) {
    super(message);
    this.name = "ImageBillingGatewayError";
  }
}

/** A verification error after a successful debit that was successfully reversed. */
export class ImageBillingRevertedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageBillingRevertedError";
  }
}

// token → 认证结果的模块级微缓存：30 秒 TTL、上限 500 条，命中则免去对网关的 GET /api/user/self。
// 只缓存成功结果；存取均做浅拷贝，避免调用方修改 quota 污染缓存。
const AUTH_CACHE_TTL_MS = 30_000;
const AUTH_CACHE_MAX_ENTRIES = 500;
const authMicroCache = new Map<string, { expiresAt: number; user: ImageBillingUser }>();

// 网关计费调用的硬超时。没有它，退款请求在网关 hang 死时会一路耗到 Vercel 的
// maxDuration 硬杀点——函数被杀则退款丢失、路由事件也一并蒸发，恰好是最需要
// 留下记录的那种 run。取 15s：reserveImageQuota 最坏是 扣款+复核+回滚 三连调用
// （45s），仍落在生成路由预留的 60s 结算余量内。
const GATEWAY_BILLING_TIMEOUT_MS = 15_000;

async function readGatewayResult<T>(response: Response): Promise<GatewayResult<T>> {
  const text = await response.text();
  if (!text) return { success: false, message: `Gateway returned ${response.status}` };

  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    return { success: false, message: text.slice(0, 300) };
  }
}

function bearer(value: string): string {
  const token = value.replace(/^Bearer\s+/i, "").trim();
  return `Bearer ${token}`;
}

function adminBillingConfig(env: EnvLike) {
  const token =
    env.GATEWAY_ADMIN_ACCESS_TOKEN ??
    env.GATEWAY_ADMIN_TOKEN ??
    env.NEW_API_ADMIN_ACCESS_TOKEN ??
    "";
  const userId = env.GATEWAY_ADMIN_USER_ID ?? env.NEW_API_ADMIN_USER_ID ?? "";

  if (!token.trim() || !userId.trim()) {
    throw new Error("Missing New API admin billing credentials.");
  }

  return { token: bearer(token), userId: userId.trim() };
}

export async function authenticateImageUser(
  headers: Headers,
  requiredQuota = IMAGE_GENERATION_QUOTA,
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<ImageAuthResult> {
  if (shouldBypassAuthForLocalTest(env)) {
    return {
      ok: true,
      bypassBilling: true,
      user: { id: 0, username: "local-test", quota: Number.MAX_SAFE_INTEGER, used_quota: 0 },
    };
  }

  const auth = headers.get("authorization") ?? "";
  const userId = headers.get("x-user-id") ?? headers.get("New-Api-User") ?? "";

  if (!auth || !userId) {
    return { ok: false, status: 401, message: "请先登录再生成图片。" };
  }

  const cacheKey = `${auth}|${userId}`;
  const cached = authMicroCache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now() && cached.user.quota >= requiredQuota) {
      return { ok: true, user: { ...cached.user }, bypassBilling: false };
    }
    authMicroCache.delete(cacheKey);
  }

  const response = await fetcher(`${getGatewayBaseUrl()}/api/user/self`, {
    headers: {
      Authorization: auth,
      "New-Api-User": userId,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(GATEWAY_BILLING_TIMEOUT_MS),
  });
  const result = await readGatewayResult<ImageBillingUser>(response);

  if (!response.ok || !result.success || !result.data?.id) {
    return { ok: false, status: 401, message: result.message ?? "登录已过期，请重新登录。" };
  }

  if (result.data.quota < requiredQuota) {
    return { ok: false, status: 402, message: "余额不足，请先充值。" };
  }

  if (authMicroCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = authMicroCache.keys().next().value;
    if (oldestKey !== undefined) authMicroCache.delete(oldestKey);
  }
  authMicroCache.set(cacheKey, {
    expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    user: { ...result.data },
  });

  return { ok: true, user: result.data, bypassBilling: false };
}

async function adjustImageQuota(
  userId: number,
  mode: "add" | "subtract",
  quotaToAdjust: number,
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
) {
  const admin = adminBillingConfig(env);
  const response = await fetcher(`${getGatewayBaseUrl()}/api/user/manage`, {
    method: "POST",
    headers: {
      Authorization: admin.token,
      "Content-Type": "application/json",
      "New-Api-User": admin.userId,
    },
    body: JSON.stringify({
      id: userId,
      action: "add_quota",
      mode,
      value: quotaToAdjust,
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(GATEWAY_BILLING_TIMEOUT_MS),
  });
  const result = await readGatewayResult<unknown>(response);

  if (!response.ok || !result.success) {
    throw new ImageBillingGatewayError(
      result.message ?? `New API quota ${mode} failed.`,
      response.status,
      response.headers.get("retry-after"),
    );
  }
}

/**
 * 超时对账日志：AbortSignal.timeout 触发时网关可能「已提交但迟到」——subtract 超时
 * 会让用户被扣款却收到 402（无补偿路径），add 超时会引导管理员人工补退（可能双退）。
 * 网关的 add_quota 没有幂等键，无法自动对账，所以至少留下带 userId/金额的告警，
 * 让人工核对有据可查。
 */
function warnBillingTimeout(action: string, userId: number, quota: number, error: unknown): void {
  if (error instanceof Error && error.name === "TimeoutError") {
    console.error(`[billing-reconcile] ${action} timed out after ${GATEWAY_BILLING_TIMEOUT_MS}ms; gateway may have applied it anyway. userId=${userId} quota=${quota} — verify balance manually.`);
  }
}

async function fetchManagedImageUser(
  userId: number,
  env: EnvLike = process.env,
  fetcher: FetchLike = fetch,
): Promise<ImageBillingUser> {
  const admin = adminBillingConfig(env);
  const response = await fetcher(`${getGatewayBaseUrl()}/api/user/${userId}`, {
    headers: {
      Authorization: admin.token,
      "New-Api-User": admin.userId,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(GATEWAY_BILLING_TIMEOUT_MS),
  });
  const result = await readGatewayResult<ImageBillingUser>(response);

  if (!response.ok || !result.success || !result.data?.id) {
    throw new ImageBillingGatewayError(
      result.message ?? "Failed to verify reserved image quota.",
      response.status,
      response.headers.get("retry-after"),
    );
  }

  return result.data;
}

export async function reserveImageQuota(
  userId: number,
  quotaToReserve: number,
  knownQuota?: number,
  env?: EnvLike,
  fetcher?: FetchLike,
) {
  try {
    await adjustImageQuota(userId, "subtract", quotaToReserve, env, fetcher);
  } catch (error) {
    warnBillingTimeout("reserve(subtract)", userId, quotaToReserve, error);
    throw error;
  }

  // 已知余额充足（≥ 2 次生成额度）时跳过复核，省一次网关请求；低余额才复核，防止扣穿。
  if (knownQuota !== undefined && knownQuota >= 2 * quotaToReserve) {
    return;
  }

  try {
    const user = await fetchManagedImageUser(userId, env, fetcher);
    if (user.quota < 0) {
      throw new Error("余额不足，请先充值。");
    }
  } catch (error) {
    try {
      await adjustImageQuota(userId, "add", quotaToReserve, env, fetcher);
    } catch (rollbackError) {
      // The debit may have happened and its compensating credit is uncertain.
      // Let the durable ledger freeze this instead of replaying it.
      throw rollbackError;
    }
    throw new ImageBillingRevertedError(
      `Reservation verification failed and was reversed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function refundImageQuota(userId: number, quotaToRefund: number, env?: EnvLike, fetcher?: FetchLike) {
  try {
    await adjustImageQuota(userId, "add", quotaToRefund, env, fetcher);
  } catch (error) {
    warnBillingTimeout("refund(add)", userId, quotaToRefund, error);
    throw error;
  }
}
