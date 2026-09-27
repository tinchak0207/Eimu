import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { MOCK_MODE, mockGetSelf } from "@/lib/mock";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";
import { ensureWelcomeGiftForUser } from "@/lib/welcome-gift";

export const preferredRegion = "sfo1";

// 對控面 GET /api/user/self 的硬超時。沒有它，上游 hang 死時本路由會一路佔滿
// Vercel maxDuration（RTT 150-220ms/跳的裸 HTTP 串行鏈）。取 2.5s：正常單跳
// 加少量重試餘量，超時即走 catch → 503「服務暫時不可用」，前端按 transient 處理。
const ME_UPSTREAM_TIMEOUT_MS = 2_500;

// 驗證結果微快取（複製 image-billing authMicroCache 模式）：30 秒 TTL、上限 500
// 條、只快取成功結果。key 為憑證雜湊（SHA-256 hex），明文 token 永不進快取、
// 永不進日誌。命中免去對控面的串行往返；資料只被 JSON 序列化、無調用方改寫，
// 故直接持有引用，無需像計費快取那樣淺拷貝防污染。
const ME_CACHE_TTL_MS = 30_000;
const ME_CACHE_MAX_ENTRIES = 500;
const meMicroCache = new Map<string, { expiresAt: number; data: unknown }>();

function cacheVerifiedMe(key: string, data: unknown) {
  if (meMicroCache.size >= ME_CACHE_MAX_ENTRIES) {
    const oldestKey = meMicroCache.keys().next().value;
    if (oldestKey !== undefined) meMicroCache.delete(oldestKey);
  }
  meMicroCache.set(key, { expiresAt: Date.now() + ME_CACHE_TTL_MS, data });
}

// 新人礼掛點（src/lib/welcome-gift.ts）：驗證通過後、寫快取前，首次命中即發，已發/不符合則
// no-op。每個實例每個用戶只問一次控面（結案狀態永久記住；未結案 5 分鐘後再試），
// 失敗只記日誌、絕不擋登入。本次發放成功時把 quota 就地加上，錢包當場看到到帳。
const WELCOME_GIFT_TIMEOUT_MS = 3_000;
const WELCOME_GIFT_RETRY_MS = 5 * 60_000;
const WELCOME_GIFT_MEMO_MAX = 5_000;
const welcomeGiftNextCheckAt = new Map<number, number>();

async function applyWelcomeGift(payload: unknown): Promise<void> {
  try {
    const user = (payload as { data?: { id?: unknown; quota?: unknown } } | null)?.data;
    const userId = Number(user?.id);
    if (!user || !Number.isInteger(userId) || userId <= 0) return;
    const nextCheckAt = welcomeGiftNextCheckAt.get(userId);
    if (nextCheckAt !== undefined && nextCheckAt > Date.now()) return;

    const result = await ensureWelcomeGiftForUser(userId, { timeoutMs: WELCOME_GIFT_TIMEOUT_MS });
    const settled = result?.status === "granted" || result?.status === "already_granted" || result?.status === "ineligible";
    if (welcomeGiftNextCheckAt.size >= WELCOME_GIFT_MEMO_MAX) welcomeGiftNextCheckAt.clear();
    welcomeGiftNextCheckAt.set(userId, settled ? Number.POSITIVE_INFINITY : Date.now() + WELCOME_GIFT_RETRY_MS);

    if (result?.status === "granted" && typeof user.quota === "number") {
      user.quota += result.amountQuota;
    }
  } catch (error) {
    console.error("[auth/me] welcome gift skipped", error instanceof Error ? error.message : String(error));
  }
}

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const userIdHeader = req.headers.get("x-user-id");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, message: "未授权" }, { status: 401 });
  }
  const token = authHeader.slice(7);

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (MOCK_MODE) {
    const result = mockGetSelf(token);
    return NextResponse.json(result, { status: result.success ? 200 : 401 });
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  try {
    // 緩存 key 用整串憑證頭（Bearer token + 可選 userId）的雜湊；日誌只印前 8 碼。
    const cacheKey = createHash("sha256")
      .update(`${authHeader}|${userIdHeader ?? ""}`)
      .digest("hex");
    const cached = meMicroCache.get(cacheKey);
    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return NextResponse.json(cached.data);
      }
      meMicroCache.delete(cacheKey);
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (userIdHeader) headers["New-Api-User"] = userIdHeader;
    const upstream = await fetch(`${getGatewayBaseUrl()}/api/user/self`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(ME_UPSTREAM_TIMEOUT_MS),
    });
    const data = await upstream.json().catch(() => null) as
      | { success?: boolean; message?: string; data?: unknown }
      | null;

    // new-api 对 Bearer 模式强制 New-Api-User 头；前端 user 存储可能是坏残留
    // （缺失或旧 id）。token 的唯一可信 userId 在控面稳定令牌表——反查重试。
    // 反查鏈與首查是真相依（失敗回退路徑），保持串行不並行。
    if (!upstream.ok || !data?.success) {
      const lookedUp = await lookupUserIdByTokenViaRelay(token);
      if (lookedUp) {
        const retry = await fetch(`${getGatewayBaseUrl()}/api/user/self`, {
          headers: { Authorization: `Bearer ${token}`, "New-Api-User": String(lookedUp) },
          cache: "no-store",
          signal: AbortSignal.timeout(ME_UPSTREAM_TIMEOUT_MS),
        });
        if (retry.ok) {
          const retryData = await retry.json().catch(() => null);
          if (retryData?.success) {
            await applyWelcomeGift(retryData);
            cacheVerifiedMe(cacheKey, retryData);
            return NextResponse.json(retryData);
          }
        }
      }
    }

    if (!upstream.ok || !data?.success) {
      console.error("[auth/me] upstream rejected", {
        status: upstream.status,
        message: data?.message ?? null,
        credentialHashPrefix: cacheKey.slice(0, 8),
        hasUserIdHeader: Boolean(userIdHeader),
      });
      return NextResponse.json(
        { success: false, message: upstream.status === 401 ? "session_expired" : data?.message ?? "获取用户信息失败" },
        { status: upstream.status === 401 ? 401 : 502 },
      );
    }
    await applyWelcomeGift(data);
    cacheVerifiedMe(cacheKey, data);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[auth/me]", err);
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}
