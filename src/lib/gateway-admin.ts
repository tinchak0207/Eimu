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
  /** 上游角色：1=普通用户，10=管理员，100=root（model/user.go RoleCommonUser 等）。 */
  role?: number;
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

/**
 * 把已有上游账号的密码改成当前推导值。
 * 只送 id 和 password。新 API 的 Update 用 Updates，空字段不会把邮箱和额度抹掉。
 * 失败只返回 false，不把密码写进日志。
 */
export async function resetGatewayUserPassword(userId: number, password: string): Promise<boolean> {
  if (!Number.isInteger(userId) || userId <= 0 || password.length < 8) return false;
  try {
    const result = await callGateway(`/api/user/`, {
      method: "PUT",
      body: JSON.stringify({ id: userId, password }),
    });
    return result.success === true;
  } catch (error) {
    console.error(
      `[gateway-admin] reset password failed user=${userId}: ${error instanceof Error ? error.message : "error"}`,
    );
    return false;
  }
}

/**
 * 上游兑换码记录（REQ-E1a 充值入账的唯一上游依据）。
 *
 * 只读：`GET /api/redemption/?p=&page_size=`（AdminAuth 路由，与 mapay-redemption.ts
 * 用的 `/api/redemption/search` 同一族）。充值在我方没有可观测的写入点——mPay 回调只
 * **生成**兑换码，真正的入账是用户在 new-api 端兑换（`POST /api/user/topup`），
 * 所以“已使用”这件事只能从上游记录读回来（`status=2` + `used_user_id` + `redeemed_time`）。
 *
 * 分页（2026-09-27 修）：上游 **p 从 1 起算**，`p=0` 与 `p=1` 返回同一页。旧实现从
 * `p=0` 起、默认只翻 1 页 ⇒ 生产上 415 张码只看到最新 100 张、且同一页被数两次
 * （日志 scanned=200 而库里 415 张），最旧的 315 张永远不扫。现在按 upstream `total`
 * 翻到尽、按 id 去重、`maxPages` 只作为防御上限。
 *
 * 返回形状两种都收（`data.items` 或裸数组）——与 findGatewayUserByUsername 同一防御
 * 姿势：上游不同版本分页信封不一致时，不要静默变成“没有兑换码”（那会把充值吞掉）。
 */
export interface GatewayRedemption {
  id: number;
  key: string;
  name?: string;
  quota: number;
  status?: number;
  used_user_id?: number;
  redeemed_time?: number;
  created_time?: number;
}

export async function listGatewayRedemptions(
  input: { pages?: number; pageSize?: number; keyword?: string } = {},
): Promise<GatewayRedemption[]> {
  const maxPages = Math.max(1, Math.min(input.pages ?? 20, 50));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 100));
  const byId = new Map<number, GatewayRedemption>();
  for (let page = 1; page <= maxPages; page += 1) {
    const path = input.keyword
      ? `/api/redemption/search?keyword=${encodeURIComponent(input.keyword)}&p=${page}&page_size=${pageSize}`
      : `/api/redemption/?p=${page}&page_size=${pageSize}`;
    const result = await callGateway<GatewayRedemption[] | { items?: GatewayRedemption[]; total?: number }>(path);
    if (!result.success) throw new Error(result.message ?? "读取上游兑换码失败。");
    const pageItems = Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
    const total = Array.isArray(result.data) ? undefined : result.data?.total;
    let added = 0;
    for (const item of pageItems) {
      if (!item || !Number.isFinite(Number(item.id))) continue;
      if (!byId.has(item.id)) {
        byId.set(item.id, item);
        added += 1;
      }
    }
    // 本页不足一页 / 已达 total / 本页没有新 id ⇒ 到底了（上游分页语义变动也不死循环）。
    if (pageItems.length < pageSize || added === 0) break;
    if (typeof total === "number" && byId.size >= total) break;
  }
  return [...byId.values()];
}

/**
 * 全量列出上游用户（只读：`GET /api/user/?p=&page_size=`，AdminAuth）。
 *
 * 实测（2026-09-27）：p 从 1 起算，p=0 与 p=1 返回同一页；信封为
 * `{ page, page_size, total, items }`。这里按 id 去重并在「本页不足一页 / 已达 total /
 * 本页没有新 id」时停，免得上游分页语义变动时死循环或重复计数。
 */
export async function listGatewayUsers(input: { pageSize?: number; maxPages?: number } = {}): Promise<GatewayAdminUser[]> {
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 100));
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 200, 1000));
  const byId = new Map<number, GatewayAdminUser>();
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await callGateway<GatewayAdminUser[] | { items?: GatewayAdminUser[]; total?: number }>(
      `/api/user/?p=${page}&page_size=${pageSize}`,
    );
    if (!result.success) throw new Error(result.message ?? "读取上游用户列表失败。");
    const items = Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
    const total = Array.isArray(result.data) ? undefined : result.data?.total;
    let added = 0;
    for (const user of items) {
      if (user?.id && !byId.has(user.id)) {
        byId.set(user.id, user);
        added += 1;
      }
    }
    if (items.length < pageSize || added === 0) break;
    if (typeof total === "number" && byId.size >= total) break;
  }
  return [...byId.values()];
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
 * 按原始 quota 单位精确调整用户额度（记帐投影用，不做张数取整）。
 * deltaQuota 负数=扣减。上游 /api/user/manage 的 value 以 1 quota 为单位。
 */
export async function adjustGatewayUserQuotaExact(userId: number, deltaQuota: number): Promise<void> {
  if (!Number.isFinite(deltaQuota) || deltaQuota === 0) return;
  const adjusted = await callGateway(`/api/user/manage`, {
    method: "POST",
    body: JSON.stringify({
      id: userId,
      action: "add_quota",
      mode: deltaQuota > 0 ? "add" : "subtract",
      value: Math.abs(Math.round(deltaQuota)),
    }),
  });
  if (!adjusted.success) {
    throw new Error(adjusted.message ?? "精确额度调整失败。");
  }
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
 * 确保某个 OAuth 上游账号存在：已存在就复用，不存在则由管理员 API 建号。
 *
 * 站点三条 OAuth 建号路径（github / google / wechat）原本打上游公开注册端点
 * `/api/user/register`；关闭自助注册（`RegisterEnabled=false`）后该端点会回
 * 「New user registration has been disabled by administrator」，故改走管理员
 * `POST /api/user/`（与 provisionBizBillingAccount 同一形状）。
 *
 * 密码由调用方按各自的确定性公式推导（见 github-auth / google-auth /
 * wechat-identity），这里只负责把账号建出来；已存在的账号绝不能重复建，
 * 故先查后建，撞到「已存在」也按复用处理（并发/竞态下的兜底）。
 *
 * 不传 display_name：实测上游管理员建号在 display_name 为空时会回落成
 * username，与旧 register 路径落库结果（github_32261631 等账号
 * display_name == username）逐字一致，email 同样落空、quota=0、group=default。
 */
export async function ensureGatewayUserForOAuth(
  input: { username: string; password: string },
): Promise<{ created: boolean }> {
  const { username, password } = input;
  if (username.length > GATEWAY_USERNAME_MAX_LENGTH) {
    throw new Error(`用户名最长 ${GATEWAY_USERNAME_MAX_LENGTH} 个字符（上游限制）。`);
  }

  const existing = await findGatewayUserByUsername(username);
  if (existing) return { created: false };

  const created = await callGateway(`/api/user/`, {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });

  if (created.success) return { created: true };
  // 竞态：查的时候没有、建的瞬间被别的请求建走了，上游回「已存在」，按复用处理。
  if (/exists|already|已存在|被使用|占用/i.test(created.message ?? "")) return { created: false };
  throw new Error(created.message ?? "创建上游用户失败。");
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

/**
 * 上游注册记录（只读）：激活漏斗的「注册」一步的唯一依据。
 *
 * `GET /api/user/?p=&page_size=` 按 id 倒序分页、`p` 从 1 起（生产实测 p=0 与 p=1
 * 回同一页，故从 1 起算并按 id 去重）；`created_at` 为 unix 秒（new-api users.created_at）。
 * 倒序分页里整页最早的注册早于 since 即可停——更旧的页不可能再有窗口内的注册。
 * 软删除用户上游不返回（与 sqlite `deleted_at IS NULL` 同口径）。
 */
export interface GatewayRegisteredUser {
  id: number;
  created_at: number;
}

export async function listGatewayUsersRegisteredSince(
  sinceUnixSeconds: number,
  input: { maxPages?: number; pageSize?: number } = {},
): Promise<{ users: GatewayRegisteredUser[]; truncated: boolean }> {
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 20, 50));
  const pageSize = Math.max(1, Math.min(input.pageSize ?? 100, 100));
  const byId = new Map<number, GatewayRegisteredUser>();
  for (let page = 1; page <= maxPages; page += 1) {
    const result = await callGateway<GatewayRegisteredUser[] | { items?: GatewayRegisteredUser[] }>(
      `/api/user/?p=${page}&page_size=${pageSize}`,
    );
    if (!result.success) throw new Error(result.message ?? "读取上游用户列表失败。");
    const pageItems = Array.isArray(result.data) ? result.data : (result.data?.items ?? []);
    let oldest = Number.POSITIVE_INFINITY;
    for (const item of pageItems) {
      const id = Number(item.id);
      const createdAt = Number(item.created_at);
      if (!Number.isFinite(id) || !Number.isFinite(createdAt)) continue;
      oldest = Math.min(oldest, createdAt);
      if (createdAt >= sinceUnixSeconds) byId.set(id, { id, created_at: createdAt });
    }
    if (pageItems.length < pageSize || oldest < sinceUnixSeconds) {
      return { users: [...byId.values()].sort((a, b) => a.id - b.id), truncated: false };
    }
  }
  // 翻满页上限仍未越过 since：注册数只是下界，必须如实标记。
  return { users: [...byId.values()].sort((a, b) => a.id - b.id), truncated: true };
}
