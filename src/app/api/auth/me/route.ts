import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { MOCK_MODE, mockGetSelf } from "@/lib/mock";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";
import { ensureWelcomeGiftOnLogin } from "@/lib/welcome-gift-login";
import {
  WELCOME_GIFT_IMAGE_COUNT,
  ackWelcomeGiftModalSeenViaRelay,
  welcomeGiftModalCopy,
  type WelcomeGiftResult,
} from "@/lib/welcome-gift";
import type { WelcomeGiftModal } from "@/lib/welcome-gift-modal";
import { FIRST_TOUCH_COOKIE, INVITE_COOKIE } from "@/lib/first-touch-attribution";
import { recordFirstTouchCookieViaRelay, recordInviteViaRelay } from "@/lib/user-attribution";

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

// 新人礼掛點（src/lib/welcome-gift-login.ts → 控面 welcome-gift）：驗證通過後、寫快取前，
// 首次命中即發，已發/不符合則 no-op。每個實例每個用戶只問一次控面（結案狀態永久記住；
// 未結案 5 分鐘後再試），整段最多等 WELCOME_GIFT_BUDGET_MS，失敗只記日誌、絕不擋登入。
// 本次發放成功時把 quota 就地加上，錢包當場看到到帳；站內通知同時寫入。
const WELCOME_GIFT_TIMEOUT_MS = 3_000;
const WELCOME_GIFT_BUDGET_MS = 4_000;
const WELCOME_GIFT_RETRY_MS = 5 * 60_000;
const WELCOME_GIFT_MEMO_MAX = 5_000;
const welcomeGiftNextCheckAt = new Map<number, number>();
// 新人禮首登彈窗的待展示狀態（每實例每用戶一份）。
// 為什麼要單獨記：上面的「結案即不再問控面」memo 會讓後續請求拿不到 grant 結果，
// 但彈窗狀態必須持續可讀——用戶可能先落在別的頁面、刷新後才回首頁，那時才該彈。
// 回執（POST）後立刻刪掉，本實例不再拿舊狀態回答。
const welcomeGiftModalMemo = new Map<number, WelcomeGiftModal | null>();

/** 由 grant 結果推導彈窗內容（幣數/張數/文案皆來自 welcome-gift 的具名常量）。 */
function welcomeGiftModalOf(result: WelcomeGiftResult): WelcomeGiftModal {
  const copy = welcomeGiftModalCopy(result.coins, WELCOME_GIFT_IMAGE_COUNT);
  return { pending: true, coins: result.coins, images: WELCOME_GIFT_IMAGE_COUNT, ...copy };
}

/** 記住本輪拿到的彈窗狀態；本輪沒拿到答案（null）時保留上一輪的記憶。 */
function rememberWelcomeGiftModal(userId: number, result: WelcomeGiftResult | null): void {
  if (!result) return;
  if (welcomeGiftModalMemo.size >= WELCOME_GIFT_MEMO_MAX) welcomeGiftModalMemo.clear();
  welcomeGiftModalMemo.set(userId, result.modalPending ? welcomeGiftModalOf(result) : null);
}

/**
 * 把彈窗狀態 additive 掛到 new-api 既有回應上（既有欄位一字不動，只多一個 welcomeGift）。
 * pending=false 也照掛：前端只認 pending===true，缺欄位與 false 同義，明寫出來才好回報。
 */
function attachWelcomeGiftModal(user: { id?: unknown }, userId: number): void {
  (user as { welcomeGift?: WelcomeGiftModal }).welcomeGift =
    welcomeGiftModalMemo.get(userId) ?? { pending: false };
}

async function applyWelcomeGift(payload: unknown): Promise<void> {
  try {
    const user = (payload as { data?: { id?: unknown; quota?: unknown } } | null)?.data;
    const userId = Number(user?.id);
    if (!user || !Number.isInteger(userId) || userId <= 0) return;
    const nextCheckAt = welcomeGiftNextCheckAt.get(userId);
    if (nextCheckAt !== undefined && nextCheckAt > Date.now()) {
      attachWelcomeGiftModal(user, userId);
      return;
    }

    let budgetTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      ensureWelcomeGiftOnLogin(userId, { timeoutMs: WELCOME_GIFT_TIMEOUT_MS }),
      new Promise<null>((resolve) => {
        budgetTimer = setTimeout(() => resolve(null), WELCOME_GIFT_BUDGET_MS);
      }),
    ]).finally(() => clearTimeout(budgetTimer));
    // 結案＝不必再問：已發且通知已送達、或不符合資格。通知待送的下次再試。
    const settled = result?.status === "ineligible" ||
      ((result?.status === "granted" || result?.status === "already_granted") && !result.noticePending);
    if (welcomeGiftNextCheckAt.size >= WELCOME_GIFT_MEMO_MAX) welcomeGiftNextCheckAt.clear();
    welcomeGiftNextCheckAt.set(userId, settled ? Number.POSITIVE_INFINITY : Date.now() + WELCOME_GIFT_RETRY_MS);
    rememberWelcomeGiftModal(userId, result);
    attachWelcomeGiftModal(user, userId);

    if (result?.status === "granted" && typeof user.quota === "number") {
      user.quota += result.amountQuota;
    }
  } catch (error) {
    console.error("[auth/me] welcome gift skipped", error instanceof Error ? error.message : String(error));
  }
}

// 首次觸達歸因補記（src/lib/user-attribution.ts → 控面 user-attribution）：
// OAuth 回調已帶 email 落庫，這裡是**所有 provider 的兜底**（微信等沒有 callback 的路徑
// 也在登入後打 /api/auth/me，同樣帶著瀏覽器的 eimu_first_touch cookie）。控面是首觸勝出的
// 冪等 upsert，重複送無副作用。沒有 cookie（多數回訪）＝零網路成本直接跳過。
// 每個實例每個用戶成功一次即永久記住；失敗 10 分鐘後再試，整段最多等 FIRST_TOUCH_BUDGET_MS。
const FIRST_TOUCH_BUDGET_MS = 1_500;
const FIRST_TOUCH_RETRY_MS = 10 * 60_000;
const FIRST_TOUCH_MEMO_MAX = 5_000;
const firstTouchNextAttemptAt = new Map<number, number>();

async function applyFirstTouchAttribution(userId: number, rawCookie: string | null | undefined): Promise<void> {
  if (!rawCookie) return;
  const nextAttemptAt = firstTouchNextAttemptAt.get(userId);
  if (nextAttemptAt !== undefined && nextAttemptAt > Date.now()) return;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const recorded = await Promise.race([
      recordFirstTouchCookieViaRelay(userId, rawCookie, { timeoutMs: FIRST_TOUCH_BUDGET_MS }),
      new Promise<boolean>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), FIRST_TOUCH_BUDGET_MS);
      }),
    ]);
    if (firstTouchNextAttemptAt.size >= FIRST_TOUCH_MEMO_MAX) firstTouchNextAttemptAt.clear();
    firstTouchNextAttemptAt.set(userId, recorded ? Number.POSITIVE_INFINITY : Date.now() + FIRST_TOUCH_RETRY_MS);
  } catch (error) {
    console.error("[auth/me] first touch attribution skipped", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(budgetTimer);
  }
}

// 邀請綁定：同一套記憶（每實例每用戶處理完一次即永久記住，失敗 10 分鐘後再試）。
const inviteNextAttemptAt = new Map<number, number>();

async function applyInviteBinding(userId: number, rawCookie: string | null | undefined): Promise<void> {
  if (!rawCookie) return;
  const nextAttemptAt = inviteNextAttemptAt.get(userId);
  if (nextAttemptAt !== undefined && nextAttemptAt > Date.now()) return;
  let budgetTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = await Promise.race([
      recordInviteViaRelay(userId, rawCookie, { timeoutMs: FIRST_TOUCH_BUDGET_MS }),
      new Promise<boolean>((resolve) => {
        budgetTimer = setTimeout(() => resolve(false), FIRST_TOUCH_BUDGET_MS);
      }),
    ]);
    if (inviteNextAttemptAt.size >= FIRST_TOUCH_MEMO_MAX) inviteNextAttemptAt.clear();
    inviteNextAttemptAt.set(userId, done ? Number.POSITIVE_INFINITY : Date.now() + FIRST_TOUCH_RETRY_MS);
  } catch (error) {
    console.error("[auth/me] invite binding skipped", error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(budgetTimer);
  }
}

/** 登入後的側車事實：新人禮（額度）與首次觸達歸因並行；兩者都永不 throw、都不擋登入。 */
async function applyLoginSideFacts(payload: unknown, req: NextRequest): Promise<void> {
  const userId = Number((payload as { data?: { id?: unknown } } | null)?.data?.id);
  const attribution = Number.isInteger(userId) && userId > 0
    ? applyFirstTouchAttribution(userId, req.cookies.get(FIRST_TOUCH_COOKIE)?.value)
    : Promise.resolve();
  const invite = Number.isInteger(userId) && userId > 0
    ? applyInviteBinding(userId, req.cookies.get(INVITE_COOKIE)?.value)
    : Promise.resolve();
  await Promise.all([applyWelcomeGift(payload), attribution, invite]);
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
            await applyLoginSideFacts(retryData, req);
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
    await applyLoginSideFacts(data, req);
    cacheVerifiedMe(cacheKey, data);
    return NextResponse.json(data);
  } catch (err) {
    console.error("[auth/me]", err);
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}

/** 用憑證向上游問自己的 userId（與 GET 同一真源：new-api 對 Bearer 強制 New-Api-User 頭）。 */
async function upstreamUserId(token: string, userIdHeader: string | null): Promise<number | null> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (userIdHeader) headers["New-Api-User"] = userIdHeader;
  const upstream = await fetch(`${getGatewayBaseUrl()}/api/user/self`, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(ME_UPSTREAM_TIMEOUT_MS),
  });
  const data = await upstream.json().catch(() => null) as { success?: boolean; data?: { id?: unknown } } | null;
  const id = Number(upstream.ok && data?.success ? data.data?.id : Number.NaN);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * POST /api/auth/me —— 「我的會話態」回執（加法式：GET 的語義一行不動）。
 *
 * 目前只有一件事：新人禮首登彈窗已展示（控制面 welcome-gift op=modal_seen，寫
 * welcome_gift_grant.modal_seen_at）。這是彈窗「只展示一次」的服務端權威——換設備、
 * 換瀏覽器再登入也不會重彈；前端 localStorage 只是本設備的輔助閘門。
 *
 * 身份取上游 /api/user/self（與 GET 同一真源），拿不到再走控面穩定令牌反查。
 * 永不 throw 到調用方：失敗只回 {success:false}，前端已本地記「看過」，不影響登入。
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ success: false, message: "未授权" }, { status: 401 });
  }
  if (MOCK_MODE) return NextResponse.json({ success: true, updated: false });

  const token = authHeader.slice(7);
  const body = await req.json().catch(() => null) as { op?: unknown } | null;
  if (body?.op !== "welcome-gift-modal-seen") {
    return NextResponse.json({ success: false, message: "未知操作" }, { status: 400 });
  }

  try {
    const userIdHeader = req.headers.get("x-user-id");
    const userId = (await upstreamUserId(token, userIdHeader).catch(() => null))
      ?? (await lookupUserIdByTokenViaRelay(token).catch(() => null));
    if (!userId) {
      return NextResponse.json({ success: false, message: "无法确认用户身份" }, { status: 401 });
    }
    const updated = await ackWelcomeGiftModalSeenViaRelay(userId);
    // 本實例立刻忘掉待展示狀態（跨實例由服務端 modal_seen_at 保證不再彈）。
    welcomeGiftModalMemo.delete(userId);
    welcomeGiftNextCheckAt.delete(userId);
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    console.error("[auth/me] welcome gift modal ack failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}
