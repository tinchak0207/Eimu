// 首次触达（first-touch）归因的**纯函式层**：cookie 编解码、来源推导、provider email 挑选。
//
// 为什么独立成一档：本档没有任何 node 内建模组（crypto/postgres）依赖，所以能被
// "use client" 元件（AttributionCapture）与服务端（OAuth callback、统计投影）共用同一把尺。
// 服务端写库／签名中继在 `user-attribution.ts`（那一档才 import node:crypto 与 postgres）。
//
// 口径（唯一真源，测试钉住）：
//   ① 首触不覆盖：cookie 已有合法值 → 不重写（首次触达时间戳与 90 天窗口固定）。
//   ② 分组键 signup_source：utm_source → referrer host → 'direct'，一律小写。
//   ③ email 只存已验证的（GitHub /user/emails 的 verified、Google 的 email_verified）。

/** 首次触达 cookie 名。 */
export const FIRST_TOUCH_COOKIE = "eimu_first_touch";

/** 首次触达 cookie 有效期（天）。 */
export const FIRST_TOUCH_MAX_AGE_DAYS = 90;

/** cookie 值的结构版本；解不出版本号＝视为不合法（宁可重写一次，不读半截 JSON）。 */
export const FIRST_TOUCH_COOKIE_VERSION = 1;

/** 邀请码在落地 URL 上的参数名（分享页、定价页邀请连结同一个）。 */
export const INVITE_PARAM = "invite";

/** 邀请码 cookie：与首触 cookie 分开——首触不覆盖，但访客可能先自然来过、之后才点好友连结。首个邀请胜出。 */
export const INVITE_COOKIE = "eimu_invite";

/** 邀请码形状（`<id36>-<8hex>`）；只挡畸形，验签在服务端（referral-code.ts）。 */
export function looksLikeInviteCode(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-z]{1,10}-[0-9a-f]{8}$/.test(value);
}

/** 没有归因事实的用户（存量用户、cookie 被清掉的人）在统计投影里的分组哨兵值。 */
export const UNATTRIBUTED_SOURCE = "__unknown__";

/** 单一 token（utm 值 / campaign / 路径）的长度上限，防 cookie 被塞爆。 */
export const MAX_TOUCH_TOKEN_LENGTH = 120;

export interface FirstTouchInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** 来源主机名（不含协议／路径），本站自身不算来源。 */
  referrerHost?: string | null;
  /** 落地路径（含 search），如 `/` 或 `/pricing?ref=x`。 */
  landingPath?: string | null;
  /** 首次触达时刻（ISO）。 */
  capturedAt?: string | null;
}

/** 落库形状（cookie 事实 + 推导出的分组键）。 */
export interface FirstTouchRecord extends FirstTouchInput {
  signupSource: string;
}

export interface GitHubEmailEntry {
  email?: string | null;
  primary?: boolean | null;
  verified?: boolean | null;
}

/** 去控制字元、去头尾空白、截长；空＝null。 */
export function normalizeTouchToken(value: unknown, maxLength: number = MAX_TOUCH_TOKEN_LENGTH): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/**
 * 从 document.referrer 取来源主机名。本站自己（selfHost）不算来源——站内跳转不是归因。
 * 解析失败（空字串、非绝对 URL）回 null。
 */
export function referrerHostFrom(referrer: unknown, selfHost?: string | null): string | null {
  if (typeof referrer !== "string" || !referrer.trim()) return null;
  let host = "";
  try {
    host = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host) return null;
  const self = normalizeTouchToken(selfHost)?.toLowerCase();
  if (self && host === self) return null;
  return host.slice(0, MAX_TOUCH_TOKEN_LENGTH);
}

/**
 * 分组键：utm_source → referrer host → 'direct'（小写）。
 * 'direct' 是一句真话：首触当下确实没有带任何来源参数／来源主机。
 */
export function deriveSignupSource(input: FirstTouchInput): string {
  const utmSource = normalizeTouchToken(input.utmSource)?.toLowerCase();
  if (utmSource) return utmSource;
  const host = normalizeTouchToken(input.referrerHost)?.toLowerCase();
  if (host) return host;
  return "direct";
}

/** 把事实摊平成可落库的形状（保留原文，另附推导出的分组键）。 */
export function toFirstTouchRecord(input: FirstTouchInput): FirstTouchRecord {
  return {
    utmSource: normalizeTouchToken(input.utmSource),
    utmMedium: normalizeTouchToken(input.utmMedium),
    utmCampaign: normalizeTouchToken(input.utmCampaign),
    referrerHost: normalizeTouchToken(input.referrerHost)?.toLowerCase() ?? null,
    landingPath: normalizeTouchToken(input.landingPath, 300),
    capturedAt: normalizeTouchToken(input.capturedAt) ?? new Date().toISOString(),
    signupSource: deriveSignupSource(input),
  };
}

/** cookie 值：紧凑 JSON（键短，省 cookie 额度）→ encodeURIComponent（RFC 6265 安全）。 */
export function encodeFirstTouchCookieValue(input: FirstTouchInput): string {
  const record = toFirstTouchRecord(input);
  const payload = {
    v: FIRST_TOUCH_COOKIE_VERSION,
    u: record.utmSource,
    m: record.utmMedium,
    c: record.utmCampaign,
    r: record.referrerHost,
    p: record.landingPath,
    t: record.capturedAt,
  };
  return encodeURIComponent(JSON.stringify(payload));
}

/**
 * 解 cookie。只有版本号对得上才算合法（`null`＝没值／坏值／旧格式 → 呼叫方重写一次）。
 */
export function decodeFirstTouchCookieValue(raw: unknown): FirstTouchInput | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const payload = parsed as Record<string, unknown>;
  if (payload.v !== FIRST_TOUCH_COOKIE_VERSION) return null;
  return {
    utmSource: normalizeTouchToken(payload.u),
    utmMedium: normalizeTouchToken(payload.m),
    utmCampaign: normalizeTouchToken(payload.c),
    referrerHost: normalizeTouchToken(payload.r),
    landingPath: normalizeTouchToken(payload.p, 300),
    capturedAt: normalizeTouchToken(payload.t),
  };
}

/**
 * 首触不覆盖：既有 cookie 合法 → 回 null（呼叫方**不写**，时间戳与 90 天窗口固定不动）；
 * 否则回新值。回 null 是「不必写」的显式信号，不是错误。
 */
export function resolveFirstTouchCookieValue(
  existingRaw: string | null | undefined,
  input: FirstTouchInput,
): string | null {
  if (decodeFirstTouchCookieValue(existingRaw)) return null;
  return encodeFirstTouchCookieValue(input);
}

/** 从 `window.location.search` 抽 utm 三兄弟（缺＝null，不做猜测）。 */
export function firstTouchFromLocation(input: {
  search: string;
  referrer?: string | null;
  selfHost?: string | null;
  pathname?: string | null;
  capturedAt?: string;
}): FirstTouchInput {
  const params = new URLSearchParams(input.search ?? "");
  return {
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    referrerHost: referrerHostFrom(input.referrer ?? "", input.selfHost),
    landingPath: normalizeTouchToken(input.pathname ?? null, 300),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
  };
}

/** 像样的 email（含单一 @、两侧非空、无空白）；不通过一律不落库。 */
export function isPlausibleEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  return at > 0 && at === trimmed.lastIndexOf("@") && at < trimmed.length - 1;
}

/**
 * GitHub 已验证 email 的挑选：**只认 verified=true**（未验证的可能是别人的信箱）。
 * 优先 primary，其次清单序第一个。挑不到回 null（绝不回退到合成 email）。
 */
export function selectVerifiedGitHubEmail(entries: readonly GitHubEmailEntry[] | null | undefined): string | null {
  if (!Array.isArray(entries)) return null;
  const verified = entries.filter((entry) => entry?.verified === true && isPlausibleEmail(entry.email));
  if (verified.length === 0) return null;
  const primary = verified.find((entry) => entry.primary === true);
  return (primary ?? verified[0]).email!.trim().toLowerCase();
}

/**
 * Google 已验证 email：`email_verified === true` 才认（OpenID Connect userinfo 的回报）。
 * 挑不到回 null。
 */
export function selectVerifiedGoogleEmail(
  profile: { email?: string | null; email_verified?: boolean | null } | null | undefined,
): string | null {
  if (!profile || profile.email_verified !== true) return null;
  if (!isPlausibleEmail(profile.email)) return null;
  return profile.email.trim().toLowerCase();
}
