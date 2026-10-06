import { NextRequest, NextResponse } from "next/server";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { sanitizeUpstreamValue } from "@/lib/proxy";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export const preferredRegion = "sfo1";

const CHECKIN_DISABLED_MESSAGE = "签到功能未启用";
// 每日签到随机奖励 1～3 枚额度币，以 QUOTA_PER_COIN 表达以免与网关单位脱钩。
const CHECKIN_REWARD_MIN_QUOTA = 1 * QUOTA_PER_COIN;
const CHECKIN_REWARD_MAX_QUOTA = 3 * QUOTA_PER_COIN;
const ENABLE_CHECKIN_COOLDOWN_MS = 10 * 60 * 1000;
// 控面外呼硬超时：签到链路串行打 /api/user/checkin 与 /api/option/，任何一跳
// hang 死都会占满函数时限；控面正常应答远低于 5s，超时即快速失败。
const CHECKIN_UPSTREAM_TIMEOUT_MS = 5_000;

// 自动开启签到失败后的冷却时间戳：10 分钟内不再重试，避免每次签到查询都对网关连发注定失败的请求。
let enableCheckinLastFailedAt = 0;

type JsonRecord = Record<string, unknown>;

type UpstreamCheckinResult = {
  success?: boolean;
  message?: string;
  data?: JsonRecord;
};

function authHeaders(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  const userId = req.headers.get("x-user-id") ?? "";
  if (!auth) return null;

  const headers: Record<string, string> = { Authorization: auth };
  if (userId) headers["New-Api-User"] = userId;
  return headers;
}

function todayString() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function readJson(response: Response): Promise<UpstreamCheckinResult> {
  try {
    return (await response.json()) as UpstreamCheckinResult;
  } catch {
    return { success: false, message: "服务暂时不可用" };
  }
}

function isCheckinDisabled(data: UpstreamCheckinResult) {
  return data.success === false && data.message?.includes(CHECKIN_DISABLED_MESSAGE);
}

function normalizeCheckin(data: UpstreamCheckinResult, method: "GET" | "POST") {
  if (!data.success || !data.data) return data;

  if (method === "POST") {
    const quotaAwarded = Number(data.data.quota_awarded ?? data.data.quota ?? 0);
    return {
      ...data,
      data: {
        ...data.data,
        quota: quotaAwarded,
        quota_awarded: quotaAwarded,
        can_checkin: false,
        checked_in_today: true,
      },
    };
  }

  const stats = data.data.stats as JsonRecord | undefined;
  const checkedInToday = stats?.checked_in_today === true;
  const records = Array.isArray(stats?.records) ? stats.records : [];
  const todayRecord = records.find((record) => {
    if (!record || typeof record !== "object") return false;
    return (record as JsonRecord).checkin_date === todayString();
  }) as JsonRecord | undefined;
  const quotaAwarded = Number(todayRecord?.quota_awarded ?? 0);

  return {
    ...data,
    data: {
      ...data.data,
      quota: quotaAwarded,
      quota_awarded: quotaAwarded,
      can_checkin: !checkedInToday,
      checked_in_today: checkedInToday,
    },
  };
}

async function enableCheckin(req: NextRequest) {
  const headers = authHeaders(req);
  if (!headers) return false;

  const updates = [
    { key: "checkin_setting.enabled", value: "true" },
    { key: "checkin_setting.min_quota", value: String(CHECKIN_REWARD_MIN_QUOTA) },
    { key: "checkin_setting.max_quota", value: String(CHECKIN_REWARD_MAX_QUOTA) },
  ];

  for (const update of updates) {
    const response = await fetch(`${getGatewayBaseUrl()}/api/option/`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(update),
      cache: "no-store",
      signal: AbortSignal.timeout(CHECKIN_UPSTREAM_TIMEOUT_MS),
    });
    const data = await readJson(response);
    if (!response.ok || data.success !== true) return false;
  }

  return true;
}

async function callNativeCheckin(req: NextRequest, method: "GET" | "POST", body?: string) {
  const headers = authHeaders(req);
  if (!headers) {
    return NextResponse.json({ success: false, message: "未登录" }, { status: 401 });
  }

  const qs = req.nextUrl.searchParams.toString();
  const response = await fetch(`${getGatewayBaseUrl()}/api/user/checkin${qs ? `?${qs}` : ""}`, {
    method,
    headers: method === "POST" ? { ...headers, "Content-Type": "application/json" } : headers,
    body: method === "POST" ? body || "{}" : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(CHECKIN_UPSTREAM_TIMEOUT_MS),
  });
  const data = await readJson(response);
  // 上游失败时 data.message 可能是内部 SQL／栏位名（红队 2026-10-05 实测
  // `Scan error: column used_quota does not exist`）；出站前统一脱敏，错误负载连键名一起洗。
  const safe = sanitizeUpstreamValue(normalizeCheckin(data, method), {
    cleanKeys: !response.ok,
  }) as UpstreamCheckinResult;
  return NextResponse.json(safe, { status: response.status });
}

async function handleCheckin(req: NextRequest, method: "GET" | "POST") {
  const body = method === "POST" ? await req.text() : undefined;
  const first = await callNativeCheckin(req, method, body);
  const firstData = (await first.clone().json()) as UpstreamCheckinResult;
  if (!isCheckinDisabled(firstData)) return first;

  if (Date.now() - enableCheckinLastFailedAt < ENABLE_CHECKIN_COOLDOWN_MS) return first;

  const enabled = await enableCheckin(req);
  if (!enabled) {
    enableCheckinLastFailedAt = Date.now();
    return first;
  }

  const retry = await callNativeCheckin(req, method, body);
  return retry;
}

export async function GET(req: NextRequest) {
  return handleCheckin(req, "GET");
}

export async function POST(req: NextRequest) {
  return handleCheckin(req, "POST");
}
