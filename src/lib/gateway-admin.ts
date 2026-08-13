// 上游 New API 的管理操作：查用户、建用户、调额度。
//
// 只在服务端使用。凭证（GATEWAY_ADMIN_ACCESS_TOKEN / GATEWAY_ADMIN_USER_ID）
// 在 Vercel 里被标记为 sensitive，`vercel env pull` 拿不回明文，
// 所以这些操作必须由持有凭证的运行时来执行，而不是本地脚本。
//
// 调用格式与 image-billing.ts 的 adjustImageQuota / fetchManagedImageUser 一致
// （同一个 /api/user/manage 端点、同一套参数），不另发明一套，
// 免得和生产扣费路径产生行为差异。

import { randomBytes } from "node:crypto";
import { getGatewayBaseUrl } from "./new-api-auth-server";
import { QUOTA_PER_COIN } from "./quota-constants";

export interface GatewayAdminUser {
  id: number;
  username: string;
  display_name?: string;
  quota: number;
  used_quota?: number;
  status?: number;
  group?: string;
}

interface GatewayResult<T> {
  success: boolean;
  message?: string;
  data?: T;
}

function bearer(token: string): string {
  return /^bearer /i.test(token) ? token : `Bearer ${token}`;
}

function adminHeaders(): Record<string, string> {
  const token = process.env.GATEWAY_ADMIN_ACCESS_TOKEN?.trim();
  const userId = process.env.GATEWAY_ADMIN_USER_ID?.trim();
  if (!token || !userId) {
    throw new Error("上游管理凭证未配置（GATEWAY_ADMIN_ACCESS_TOKEN / GATEWAY_ADMIN_USER_ID）。");
  }
  return {
    Authorization: bearer(token),
    "New-Api-User": userId,
    "Content-Type": "application/json",
  };
}

async function callGateway<T>(path: string, init?: RequestInit): Promise<GatewayResult<T>> {
  const response = await fetch(`${getGatewayBaseUrl()}${path}`, {
    ...init,
    headers: { ...adminHeaders(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });

  const text = await response.text();
  try {
    return JSON.parse(text) as GatewayResult<T>;
  } catch {
    // 上游偶尔在网关层返回 HTML 错误页；把片段带出来便于排查。
    throw new Error(`上游返回了非 JSON（HTTP ${response.status}）：${text.slice(0, 200)}`);
  }
}

/**
 * 按用户名精确查找。
 * New API 的 search 只做关键词匹配，所以这里在结果里再精确比对一次，
 * 避免 `biz-a` 命中 `biz-abc`。
 */
export async function findGatewayUserByUsername(username: string): Promise<GatewayAdminUser | null> {
  const result = await callGateway<GatewayAdminUser[] | { items?: GatewayAdminUser[] }>(
    `/api/user/search?keyword=${encodeURIComponent(username)}&p=1&page_size=100`,
  );
  if (!result.success) return null;

  const items = Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
  return items.find((user) => user.username === username) ?? null;
}

export async function fetchGatewayUser(userId: number): Promise<GatewayAdminUser | null> {
  const result = await callGateway<GatewayAdminUser>(`/api/user/${userId}`);
  return result.success && result.data?.id ? result.data : null;
}

/** 把某个用户的额度调整到目标张数。返回调整后的用户。 */
export async function setGatewayUserImageQuota(
  userId: number,
  currentQuota: number,
  targetImages: number,
): Promise<GatewayAdminUser> {
  const targetQuota = Math.round(targetImages * QUOTA_PER_COIN);
  const delta = targetQuota - currentQuota;

  if (delta !== 0) {
    const adjusted = await callGateway(`/api/user/manage`, {
      method: "POST",
      body: JSON.stringify({
        id: userId,
        action: "add_quota",
        mode: delta > 0 ? "add" : "subtract",
        value: Math.abs(delta),
      }),
    });
    if (!adjusted.success) {
      throw new Error(adjusted.message ?? "调整额度失败。");
    }
  }

  const confirmed = await fetchGatewayUser(userId);
  if (!confirmed) throw new Error("额度已调整，但无法复核最终结果，请手动检查上游。");
  return confirmed;
}

/**
 * 上游 New API 对用户字段的长度限制，来自 model/user.go：
 *   Username    `validate:"max=20"`
 *   Password    `validate:"min=8,max=20"`
 *   DisplayName `validate:"max=20"`
 * 超限时上游返回「输入不合法 Key: 'User.Password' Error:Field validation ... on the 'max' tag」。
 * 这几个常量必须跟着上游走，别凭感觉设。
 */
export const GATEWAY_USERNAME_MAX_LENGTH = 20;
export const GATEWAY_PASSWORD_MIN_LENGTH = 8;
export const GATEWAY_PASSWORD_MAX_LENGTH = 20;
export const GATEWAY_DISPLAY_NAME_MAX_LENGTH = 20;

/**
 * 生成一个符合上游长度限制的随机密码。
 *
 * 12 字节 base64url 恰好 16 个字符，落在 8–20 之间。
 * 之前用 16 字节（22 个字符）直接被上游打回来。
 */
function randomGatewayPassword(): string {
  const password = randomBytes(12).toString("base64url");
  if (password.length < GATEWAY_PASSWORD_MIN_LENGTH || password.length > GATEWAY_PASSWORD_MAX_LENGTH) {
    // 走到这里说明 base64url 的长度假设变了，早失败好过让上游报一个难懂的校验错。
    throw new Error(`生成的密码长度 ${password.length} 超出上游允许的 8–20。`);
  }
  return password;
}

export interface ProvisionResult {
  user: GatewayAdminUser;
  /** 本次是新建的，还是复用了已存在的账户。 */
  created: boolean;
}

/**
 * 开一个专用 B 端计费账户并设定初始额度。幂等：已存在就复用，只把额度调到目标值。
 *
 * 密码随机生成且不返回 —— 这个账户只由程序通过 B 端密钥调用，没人需要登录它。
 * 日后若真要登录，在上游后台重置密码即可。
 */
export async function provisionBizBillingAccount(
  username: string,
  initialImages: number,
): Promise<ProvisionResult> {
  if (username.length > GATEWAY_USERNAME_MAX_LENGTH) {
    throw new Error(`用户名最长 ${GATEWAY_USERNAME_MAX_LENGTH} 个字符（上游限制）。`);
  }

  const existing = await findGatewayUserByUsername(username);

  if (existing) {
    const user = await setGatewayUserImageQuota(existing.id, existing.quota, initialImages);
    return { user, created: false };
  }

  const created = await callGateway(`/api/user/`, {
    method: "POST",
    body: JSON.stringify({
      username,
      password: randomGatewayPassword(),
      // 上游 DisplayName 也是 max=20，这里 12 个字符，留足余量。
      display_name: "B端API计费账户",
    }),
  });

  if (!created.success) {
    throw new Error(created.message ?? "创建上游用户失败。");
  }

  const fresh = await findGatewayUserByUsername(username);
  if (!fresh) {
    throw new Error("上游报告创建成功，但随后查不到该用户，请手动检查。");
  }

  const user = await setGatewayUserImageQuota(fresh.id, fresh.quota, initialImages);
  return { user, created: true };
}
