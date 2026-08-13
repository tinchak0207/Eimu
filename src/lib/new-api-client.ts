/**
 * new-api gateway client
 * All calls go through Next.js server-side proxy — never expose GATEWAY_KEY to browser.
 */
import type { GenerationWorkflowMetadata } from "./image-types";
import type { HistoryFacets, HistoryQuery, HistoryStats } from "./history-types";
import { QUOTA_PER_COIN } from "./quota-constants";

export interface NewApiUser {
  id: number;
  username: string;
  display_name: string;
  email: string;
  quota: number;       // remaining quota in new-api units
  used_quota: number;
}

export interface NewApiLoginResponse {
  success: boolean;
  message: string;
  data?: {
    token: string;
    user: NewApiUser;
  };
}

export interface NewApiImageRequest {
  prompt: string;
  model: string;
  n?: number;
  size?: string;
}

export interface NewApiImageResponse {
  created?: number;
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; code?: string };
}

// ─── Token storage (client-side only) ───────────────────────────────────────

const TOKEN_KEY = "napi_token";
const USER_KEY  = "napi_user";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string, user: NewApiUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

function getCookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const pair = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  return pair ? decodeURIComponent(pair.slice(prefix.length)) : null;
}

export function syncStoredAuthFromCookie(): boolean {
  if (typeof window === "undefined") return false;
  const token = getCookieValue(TOKEN_KEY);
  const rawUser = getCookieValue(USER_KEY);
  if (!token || !rawUser) return false;
  try {
    const user = JSON.parse(rawUser) as NewApiUser;
    setStoredToken(token, user);
    const url = new URL(window.location.href);
    if (url.searchParams.get("auth") === "github") {
      url.searchParams.delete("auth");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return true;
  } catch {
    return false;
  }
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  if (typeof document !== "undefined") {
    document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`;
    document.cookie = `${USER_KEY}=; path=/; max-age=0`;
  }
}

export function getStoredUser(): NewApiUser | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as NewApiUser; } catch { return null; }
}

// ─── Quota helpers ───────────────────────────────────────────────────────────

/**
 * Canonical definition lives in ./quota-constants (dependency-free so server
 * routes can import it without pulling in this module's browser-only helpers).
 * Re-exported here to keep existing `@/lib/new-api-client` import paths intact.
 */
export { QUOTA_PER_COIN };

export function quotaToCoins(quota: number): number {
  return Math.floor(quota / QUOTA_PER_COIN);
}

export function hasEnoughQuota(user: NewApiUser, coins = 1): boolean {
  return user.quota >= QUOTA_PER_COIN * coins;
}

// ─── Types for new-api responses ─────────────────────────────────────────────

export interface LogItem {
  id: number;
  created_at: number;       // unix timestamp (seconds)
  type: number;             // 2 = image generation
  model_name: string;
  quota: number;            // consumed quota units
  prompt_tokens?: number;
  completion_tokens?: number;
  channel_id?: number;
  token_name?: string;
  username?: string;
  content?: string;
}

export interface LogStat {
  quota: number;            // total consumed quota
  rpm: number;              // requests per minute
  tpm: number;              // tokens per minute
}

export interface QuotaDate {
  date: string;             // YYYY-MM-DD
  quota: number;
}

export interface CheckinStatus {
  can_checkin: boolean;
  quota?: number;           // quota awarded on last checkin
  quota_awarded?: number;
  checked_in_today?: boolean;
  last_checkin_time?: number;
}

export interface NewApiModel {
  id: string;
  object: string;
  owned_by?: string;
}

export interface StoredHistoryEntry {
  id: string;
  userId: number;
  prompt: string;
  generatedAt: number;
  results: Array<{
    provider: string;
    modelId: string;
    image?: string | null;
    imageUrl?: string | null;
    videoUrl?: string | null;
    mediaType?: "image" | "video";
    taskId?: string;
    resultId?: string;
  }>;
  workflow?: GenerationWorkflowMetadata;
  taskId?: string;
  generationId?: string;
  primaryResultId?: string;
  retryOfTaskId?: string;
  taskStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "refunded" | "unknown";
  errorCode?: string;
}

// ─── Client-side API helpers (all go through /api/* proxy) ───────────────────

function bearerHeader(token: string) {
  const user = getStoredUser();
  return {
    Authorization: `Bearer ${token}`,
    ...(user?.id ? { "x-user-id": String(user.id) } : {}),
  };
}

/** Fetch paginated usage logs */
export async function fetchUsageLogs(
  token: string,
  page = 1,
  pageSize = 20,
  modelName?: string,
): Promise<{ success: boolean; data?: LogItem[]; message?: string }> {
  const qs = new URLSearchParams({ p: String(page), page_size: String(pageSize) });
  if (modelName) qs.set("model_name", modelName);
  const res = await fetch(`/api/log/self?${qs}`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: LogItem[]; message?: string }>;
}

/** Fetch usage stats (total quota consumed) */
export async function fetchUsageStat(
  token: string,
): Promise<{ success: boolean; data?: LogStat; message?: string }> {
  const res = await fetch(`/api/log/self/stat`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: LogStat; message?: string }>;
}

/** Fetch daily quota trend */
export async function fetchQuotaDates(
  token: string,
): Promise<{ success: boolean; data?: QuotaDate[]; message?: string }> {
  const res = await fetch(`/api/data/self`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: QuotaDate[]; message?: string }>;
}

/** Get checkin status */
export async function fetchCheckinStatus(
  token: string,
): Promise<{ success: boolean; data?: CheckinStatus; message?: string }> {
  const res = await fetch(`/api/checkin`, { headers: bearerHeader(token), cache: "no-store" });
  return res.json() as Promise<{ success: boolean; data?: CheckinStatus; message?: string }>;
}

/** Do daily checkin */
export async function doCheckin(
  token: string,
): Promise<{ success: boolean; data?: { quota: number; quota_awarded?: number }; message?: string }> {
  const res = await fetch(`/api/checkin`, {
    method: "POST",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  return res.json() as Promise<{ success: boolean; data?: { quota: number; quota_awarded?: number }; message?: string }>;
}

/** Redeem a top-up code */
export async function redeemTopupCode(
  token: string,
  key: string,
): Promise<{ success: boolean; data?: { quota: number }; message?: string }> {
  type TopupResponse = { success: boolean; data?: number | { quota: number }; message?: string };
  const res = await fetch(`/api/topup`, {
    method: "POST",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ key }),
  });
  const payload = await res.json() as TopupResponse;
  return {
    ...payload,
    data: typeof payload.data === "number" ? { quota: payload.data } : payload.data,
  };
}

/** Fetch models available to this user */
export async function fetchUserModels(
  token: string,
): Promise<{ success: boolean; data?: NewApiModel[]; message?: string }> {
  const res = await fetch(`/api/user/models`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: NewApiModel[]; message?: string }>;
}

/** Fetch user's referral code */
export async function fetchAffCode(
  token: string,
): Promise<{ success: boolean; data?: string; message?: string }> {
  const res = await fetch(`/api/user/aff`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: string; message?: string }>;
}

/** GET /api/history 的响应体。 */
interface HistoryPageResponse {
  success: boolean;
  data?: { entries: StoredHistoryEntry[]; cursor: string | null; total: number };
  facets?: HistoryFacets;
  message?: string;
}

/** 把 HistoryQuery 转成查询串。空值一律省略，避免服务端把空字符串当成筛选条件。 */
function historyQueryParams(
  query: HistoryQuery = {},
  options: { cursor?: string | null; pageSize?: number; facets?: boolean } = {},
): URLSearchParams {
  const params = new URLSearchParams();
  if (query.keyword) params.set("keyword", query.keyword);
  if (query.modelId) params.set("modelId", query.modelId);
  if (query.imageSize) params.set("imageSize", query.imageSize);
  if (query.starredOnly) params.set("starred", "1");
  if (query.withImageOnly) params.set("withImage", "1");
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.until !== undefined) params.set("until", String(query.until));
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.pageSize) params.set("pageSize", String(options.pageSize));
  if (options.facets) params.set("facets", "1");
  return params;
}

/** 取一页历史记录。第一页可以顺带把分面一起要回来。 */
export async function fetchHistoryPage(
  token: string,
  query: HistoryQuery = {},
  options: { cursor?: string | null; pageSize?: number; facets?: boolean; signal?: AbortSignal } = {},
): Promise<HistoryPageResponse> {
  const params = historyQueryParams(query, options);
  const res = await fetch(`/api/history?${params}`, {
    headers: bearerHeader(token),
    cache: "no-store",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return res.json() as Promise<HistoryPageResponse>;
}

/**
 * 取最近的历史记录，返回扁平数组。
 *
 * 保留这个旧签名是因为 use-image-generation 只需要最近几条来填工作站的「最近任务」，
 * 不需要翻页。内部走的是同一个分页端点。
 */
export async function fetchStoredHistory(
  token: string,
  limit = 50,
): Promise<{ success: boolean; data?: StoredHistoryEntry[]; message?: string }> {
  const page = await fetchHistoryPage(token, {}, { pageSize: limit });
  return {
    success: page.success,
    ...(page.data ? { data: page.data.entries } : {}),
    ...(page.message ? { message: page.message } : {}),
  };
}

/** 本站保存的历史记录的汇总与分面。 */
export async function fetchHistoryStats(
  token: string,
): Promise<{ success: boolean; data?: HistoryStats; facets?: HistoryFacets; message?: string }> {
  const res = await fetch(`/api/history/stats`, { headers: bearerHeader(token), cache: "no-store" });
  return res.json() as Promise<{ success: boolean; data?: HistoryStats; facets?: HistoryFacets; message?: string }>;
}

/** 收藏 / 取消收藏一条记录。 */
export async function patchStoredHistoryEntry(
  token: string,
  id: string,
  patch: { starred: boolean },
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json() as Promise<{ success: boolean; message?: string }>;
}

/** 批量删除历史记录。 */
export async function deleteStoredHistoryEntries(
  token: string,
  ids: string[],
): Promise<{ success: boolean; removed?: number; message?: string }> {
  const res = await fetch(`/api/history`, {
    method: "DELETE",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return res.json() as Promise<{ success: boolean; removed?: number; message?: string }>;
}

/** 清空历史记录。 */
export async function clearStoredHistory(
  token: string,
): Promise<{ success: boolean; removed?: number; message?: string }> {
  const res = await fetch(`/api/history`, {
    method: "DELETE",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify({ all: true }),
  });
  return res.json() as Promise<{ success: boolean; removed?: number; message?: string }>;
}

/** Fetch user's API token list */
export async function fetchTokens(
  token: string,
): Promise<{ success: boolean; data?: unknown[]; message?: string }> {
  const res = await fetch(`/api/token`, { headers: bearerHeader(token) });
  return res.json() as Promise<{ success: boolean; data?: unknown[]; message?: string }>;
}

/** Delete a user API token */
export async function deleteToken(
  token: string,
  tokenId: number,
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`/api/token/${tokenId}`, {
    method: "DELETE",
    headers: bearerHeader(token),
  });
  return res.json() as Promise<{ success: boolean; message?: string }>;
}

/** Update user profile */
export async function updateSelf(
  token: string,
  patch: Partial<Pick<NewApiUser, "display_name" | "email">>,
): Promise<{ success: boolean; message?: string }> {
  const res = await fetch(`/api/user/self`, {
    method: "PUT",
    headers: { ...bearerHeader(token), "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.json() as Promise<{ success: boolean; message?: string }>;
}
