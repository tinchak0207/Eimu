// 首次觸達（first-touch）歸因的**純函式層**：cookie 編解碼、來源推導、provider email 挑選。
//
// 為什麼獨立成一檔：本檔沒有任何 node 內建模組（crypto/postgres）依賴，所以能被
// "use client" 元件（AttributionCapture）與服務端（OAuth callback、統計投影）共用同一把尺。
// 服務端寫庫／簽名中繼在 `user-attribution.ts`（那一檔才 import node:crypto 與 postgres）。
//
// 口徑（唯一真源，測試釘住）：
//   ① 首觸不覆蓋：cookie 已有合法值 → 不重寫（首次觸達時間戳與 90 天窗口固定）。
//   ② 分組鍵 signup_source：utm_source → referrer host → 'direct'，一律小寫。
//   ③ email 只存已驗證的（GitHub /user/emails 的 verified、Google 的 email_verified）。

/** 首次觸達 cookie 名。 */
export const FIRST_TOUCH_COOKIE = "eimu_first_touch";

/** 首次觸達 cookie 有效期（天）。 */
export const FIRST_TOUCH_MAX_AGE_DAYS = 90;

/** cookie 值的結構版本；解不出版本號＝視為不合法（寧可重寫一次，不讀半截 JSON）。 */
export const FIRST_TOUCH_COOKIE_VERSION = 1;

/** 邀請碼在落地 URL 上的參數名（分享頁、定價頁邀請連結同一個）。 */
export const INVITE_PARAM = "invite";

/** 邀請碼 cookie：與首觸 cookie 分開——首觸不覆蓋，但訪客可能先自然來過、之後才點好友連結。首個邀請勝出。 */
export const INVITE_COOKIE = "eimu_invite";

/** 邀請碼形狀（`<id36>-<8hex>`）；只擋畸形，驗簽在服務端（referral-code.ts）。 */
export function looksLikeInviteCode(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[0-9a-z]{1,10}-[0-9a-f]{8}$/.test(value);
}

/** 沒有歸因事實的用戶（存量用戶、cookie 被清掉的人）在統計投影裡的分組哨兵值。 */
export const UNATTRIBUTED_SOURCE = "__unknown__";

/** 單一 token（utm 值 / campaign / 路徑）的長度上限，防 cookie 被塞爆。 */
export const MAX_TOUCH_TOKEN_LENGTH = 120;

export interface FirstTouchInput {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  /** 來源主機名（不含協議／路徑），本站自身不算來源。 */
  referrerHost?: string | null;
  /** 落地路徑（含 search），如 `/` 或 `/pricing?ref=x`。 */
  landingPath?: string | null;
  /** 首次觸達時刻（ISO）。 */
  capturedAt?: string | null;
}

/** 落庫形狀（cookie 事實 + 推導出的分組鍵）。 */
export interface FirstTouchRecord extends FirstTouchInput {
  signupSource: string;
}

export interface GitHubEmailEntry {
  email?: string | null;
  primary?: boolean | null;
  verified?: boolean | null;
}

/** 去控制字元、去頭尾空白、截長；空＝null。 */
export function normalizeTouchToken(value: unknown, maxLength: number = MAX_TOUCH_TOKEN_LENGTH): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

/**
 * 從 document.referrer 取來源主機名。本站自己（selfHost）不算來源——站內跳轉不是歸因。
 * 解析失敗（空字串、非絕對 URL）回 null。
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
 * 分組鍵：utm_source → referrer host → 'direct'（小寫）。
 * 'direct' 是一句真話：首觸當下確實沒有帶任何來源參數／來源主機。
 */
export function deriveSignupSource(input: FirstTouchInput): string {
  const utmSource = normalizeTouchToken(input.utmSource)?.toLowerCase();
  if (utmSource) return utmSource;
  const host = normalizeTouchToken(input.referrerHost)?.toLowerCase();
  if (host) return host;
  return "direct";
}

/** 把事實攤平成可落庫的形狀（保留原文，另附推導出的分組鍵）。 */
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

/** cookie 值：緊湊 JSON（鍵短，省 cookie 額度）→ encodeURIComponent（RFC 6265 安全）。 */
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
 * 解 cookie。只有版本號對得上才算合法（`null`＝沒值／壞值／舊格式 → 呼叫方重寫一次）。
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
 * 首觸不覆蓋：既有 cookie 合法 → 回 null（呼叫方**不寫**，時間戳與 90 天窗口固定不動）；
 * 否則回新值。回 null 是「不必寫」的顯式信號，不是錯誤。
 */
export function resolveFirstTouchCookieValue(
  existingRaw: string | null | undefined,
  input: FirstTouchInput,
): string | null {
  if (decodeFirstTouchCookieValue(existingRaw)) return null;
  return encodeFirstTouchCookieValue(input);
}

/** 從 `window.location.search` 抽 utm 三兄弟（缺＝null，不做猜測）。 */
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

/** 像樣的 email（含單一 @、兩側非空、無空白）；不通過一律不落庫。 */
export function isPlausibleEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 254) return false;
  if (/\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  return at > 0 && at === trimmed.lastIndexOf("@") && at < trimmed.length - 1;
}

/**
 * GitHub 已驗證 email 的挑選：**只認 verified=true**（未驗證的可能是別人的信箱）。
 * 優先 primary，其次清單序第一個。挑不到回 null（絕不回退到合成 email）。
 */
export function selectVerifiedGitHubEmail(entries: readonly GitHubEmailEntry[] | null | undefined): string | null {
  if (!Array.isArray(entries)) return null;
  const verified = entries.filter((entry) => entry?.verified === true && isPlausibleEmail(entry.email));
  if (verified.length === 0) return null;
  const primary = verified.find((entry) => entry.primary === true);
  return (primary ?? verified[0]).email!.trim().toLowerCase();
}

/**
 * Google 已驗證 email：`email_verified === true` 才認（OpenID Connect userinfo 的回報）。
 * 挑不到回 null。
 */
export function selectVerifiedGoogleEmail(
  profile: { email?: string | null; email_verified?: boolean | null } | null | undefined,
): string | null {
  if (!profile || profile.email_verified !== true) return null;
  if (!isPlausibleEmail(profile.email)) return null;
  return profile.email.trim().toLowerCase();
}
