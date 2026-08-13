// B 端 API 密钥。
//
// 面向 API 聚合平台转售生图能力：聚合平台只会发标准的
// `Authorization: Bearer sk-...`，不会带我们内部那个 `x-user-id` 头，
// 所以密钥本身必须能单独解析出计费主体。
//
// 计费账本仍然记在上游 New API —— 每个 B 端密钥绑定一个 New API 用户 id，
// 扣费复用 image-billing 的 reserveImageQuota / refundImageQuota。
// 不自建额度系统：那是钱的事，已有的实现经过生产验证，重造只会多一处出错的地方。
//
// 明文密钥只在签发的那一刻返回一次，存储里只留 sha256 —— Blob 泄露也换不回密钥。
//
// 本模块的纯逻辑部分不碰 Blob 与 process.env，可直接在 node --test 下测。

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** 密钥前缀。带 `biz` 便于在日志和聚合平台后台里一眼区分 C 端 token。 */
export const BIZ_KEY_PREFIX = "sk-biz-";

/** 随机部分的字节数。16 字节 = 32 个十六进制字符，足够抗暴力枚举。 */
const BIZ_KEY_RANDOM_BYTES = 16;

/** 界面上用于识别密钥的可见片段长度（前缀之后）。 */
const BIZ_KEY_VISIBLE_CHARS = 6;

export const BIZ_KEY_DEFAULT_RPM = 60;
export const BIZ_KEY_MAX_RPM = 600;
export const BIZ_KEY_MAX_LABEL_LENGTH = 60;

export interface BizApiKey {
  id: string;
  /** 客户名称，仅用于后台识别。 */
  label: string;
  /** sha256(明文密钥)，十六进制。存储里没有明文。 */
  keyHash: string;
  /** `sk-biz-7f3a9c…`，用于后台展示与日志，无法反推密钥。 */
  keyPreview: string;
  /** 绑定的 New API 用户 id，扣费落在这个账户上。 */
  userId: number;
  enabled: boolean;
  /** 每分钟请求上限。 */
  rpm: number;
  /** 允许调用的模型；空数组表示不限。 */
  allowedModels: string[];
  createdAt: number;
  lastUsedAt?: number;
  totalRequests: number;
  totalImages: number;
}

/** 后台列表用的公开视图。keyHash 绝不出网。 */
export type PublicBizApiKey = Omit<BizApiKey, "keyHash">;

export interface BizKeyDraft {
  label: string;
  userId: number;
  rpm: number;
  allowedModels: string[];
  enabled: boolean;
}

export type BizKeyDraftResult =
  | { ok: true; draft: BizKeyDraft }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────── 密钥生成与校验

export interface GeneratedBizKey {
  /** 明文密钥，只在签发时返回一次。 */
  key: string;
  keyHash: string;
  keyPreview: string;
}

export function hashBizApiKey(key: string): string {
  return createHash("sha256").update(key.trim(), "utf8").digest("hex");
}

/** `sk-biz-7f3a9c…`。前缀 + 前 6 位，其余省略。 */
export function previewBizApiKey(key: string): string {
  const body = key.startsWith(BIZ_KEY_PREFIX) ? key.slice(BIZ_KEY_PREFIX.length) : key;
  return `${BIZ_KEY_PREFIX}${body.slice(0, BIZ_KEY_VISIBLE_CHARS)}…`;
}

export function generateBizApiKey(): GeneratedBizKey {
  const key = `${BIZ_KEY_PREFIX}${randomBytes(BIZ_KEY_RANDOM_BYTES).toString("hex")}`;
  return { key, keyHash: hashBizApiKey(key), keyPreview: previewBizApiKey(key) };
}

/** 形状检查。挡掉明显不是本站密钥的输入，省掉一次哈希与查表。 */
export function looksLikeBizApiKey(value: string): boolean {
  return new RegExp(`^${BIZ_KEY_PREFIX}[0-9a-f]{${BIZ_KEY_RANDOM_BYTES * 2}}$`).test(value.trim());
}

/**
 * 从 Authorization 头里取出 Bearer 令牌。
 * 聚合平台的实现五花八门，大小写和多余空格都得容忍。
 */
export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  // 捕获组必须以非空白开头：写成 (.+?) 时 "Bearer   " 会惰性匹配出一个空格，
  // 于是空令牌被当成有效令牌传下去。
  const match = /^\s*bearer\s+(\S.*?)\s*$/i.exec(authorization);
  return match ? match[1] : null;
}

/**
 * 恒定时间比较两个哈希。
 *
 * 密钥查表是按哈希精确匹配的，本来不构成时序侧信道；
 * 但一旦有人把它改成遍历比较，普通的 === 就会漏时间。这里先把口子堵上。
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ─────────────────────────────────────────────────────────── 草稿校验

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验后台提交的新建/修改表单。 */
export function normalizeBizKeyDraft(input: unknown, supportedModels: string[]): BizKeyDraftResult {
  if (!isRecord(input)) return { ok: false, error: "请求体格式不正确。" };

  const label = typeof input.label === "string" ? input.label.trim().slice(0, BIZ_KEY_MAX_LABEL_LENGTH) : "";
  if (!label) return { ok: false, error: "请填写客户名称。" };

  const userId = Number(input.userId);
  // userId 0 是本地测试身份，不能作为计费主体。
  if (!Number.isInteger(userId) || userId <= 0) {
    return { ok: false, error: "请填写有效的计费用户 id。" };
  }

  const rawRpm = input.rpm === undefined || input.rpm === "" ? BIZ_KEY_DEFAULT_RPM : Number(input.rpm);
  if (!Number.isFinite(rawRpm) || rawRpm < 1 || rawRpm > BIZ_KEY_MAX_RPM) {
    return { ok: false, error: `每分钟请求上限需在 1 到 ${BIZ_KEY_MAX_RPM} 之间。` };
  }

  const allowed = Array.isArray(input.allowedModels)
    ? input.allowedModels.filter((model): model is string => typeof model === "string" && supportedModels.includes(model))
    : [];

  return {
    ok: true,
    draft: {
      label,
      userId,
      rpm: Math.floor(rawRpm),
      allowedModels: [...new Set(allowed)],
      enabled: input.enabled === undefined ? true : input.enabled === true,
    },
  };
}

export function toPublicBizApiKey(key: BizApiKey): PublicBizApiKey {
  // 显式列字段而不是解构剔除：日后给 BizApiKey 加敏感字段时，
  // 这里不会因为「忘了加进剔除列表」而把它悄悄发出去。
  return {
    id: key.id,
    label: key.label,
    keyPreview: key.keyPreview,
    userId: key.userId,
    enabled: key.enabled,
    rpm: key.rpm,
    allowedModels: key.allowedModels,
    createdAt: key.createdAt,
    ...(key.lastUsedAt !== undefined ? { lastUsedAt: key.lastUsedAt } : {}),
    totalRequests: key.totalRequests,
    totalImages: key.totalImages,
  };
}

/** 空的 allowedModels 表示不限模型。 */
export function isModelAllowedForKey(key: Pick<BizApiKey, "allowedModels">, modelId: string): boolean {
  return key.allowedModels.length === 0 || key.allowedModels.includes(modelId);
}

// ─────────────────────────────────────────────────────────── 限流

export interface RateWindow {
  /** 当前窗口内的请求时间戳，升序。 */
  hits: number[];
}

export interface RateLimitDecision {
  allowed: boolean;
  /** 当前窗口内已用次数（含本次，若允许）。 */
  used: number;
  limit: number;
  /** 被拒时建议的重试等待秒数。 */
  retryAfterSeconds: number;
  window: RateWindow;
}

const RATE_WINDOW_MS = 60_000;

/**
 * 滑动窗口限流，纯函数。
 *
 * 这是进程内的：Vercel 上多个 lambda 实例各算一份，所以实际放行量可能高于 rpm。
 * 它的用途是挡住失控的客户端和明显的滥用，不是精确配额 ——
 * 真正的花费上限由 New API 的余额兜底。接入文档里如实写明这一点。
 */
export function consumeRateLimit(window: RateWindow | undefined, now: number, limit: number): RateLimitDecision {
  const cutoff = now - RATE_WINDOW_MS;
  const hits = (window?.hits ?? []).filter((timestamp) => timestamp > cutoff);

  if (hits.length >= limit) {
    const oldest = hits[0];
    return {
      allowed: false,
      used: hits.length,
      limit,
      // 最早那次请求滑出窗口才有名额，向上取整避免客户端立刻重试又被拒。
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + RATE_WINDOW_MS - now) / 1000)),
      window: { hits },
    };
  }

  const next = [...hits, now];
  return { allowed: true, used: next.length, limit, retryAfterSeconds: 0, window: { hits: next } };
}
