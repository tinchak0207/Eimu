import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { MOCK_MODE, mockGetSelf } from "@/lib/mock";
import { getGatewayBaseUrl } from "@/lib/new-api-auth-server";
import { sanitizeUpstreamMessage } from "@/lib/proxy";
import { isSessionTokenRevoked, lookupUserIdByTokenViaRelay } from "@/lib/newapi-session-token";
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

// 对控面 GET /api/user/self 的硬超时。没有它，上游 hang 死时本路由会一路占满
// Vercel maxDuration（RTT 150-220ms/跳的裸 HTTP 串行链）。取 2.5s：正常单跳
// 加少量重试余量，超时即走 catch → 503「服务暂时不可用」，前端按 transient 处理。
const ME_UPSTREAM_TIMEOUT_MS = 2_500;

// 验证结果微快取（复制 image-billing authMicroCache 模式）：30 秒 TTL、上限 500
// 条、只快取成功结果。key 为凭证杂凑（SHA-256 hex），明文 token 永不进快取、
// 永不进日志。命中免去对控面的串行往返；资料只被 JSON 序列化、无调用方改写，
// 故直接持有引用，无需像计费快取那样浅拷贝防污染。
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

// 新人礼挂点（src/lib/welcome-gift-login.ts → 控面 welcome-gift）：验证通过后、写快取前，
// 首次命中即发，已发/不符合则 no-op。每个实例每个用户只问一次控面（结案状态永久记住；
// 未结案 5 分钟后再试），整段最多等 WELCOME_GIFT_BUDGET_MS，失败只记日志、绝不挡登入。
// 本次发放成功时把 quota 就地加上，钱包当场看到到帐；站内通知同时写入。
const WELCOME_GIFT_TIMEOUT_MS = 3_000;
const WELCOME_GIFT_BUDGET_MS = 4_000;
const WELCOME_GIFT_RETRY_MS = 5 * 60_000;
const WELCOME_GIFT_MEMO_MAX = 5_000;
const welcomeGiftNextCheckAt = new Map<number, number>();
// 新人礼首登弹窗的待展示状态（每实例每用户一份）。
// 为什么要单独记：上面的「结案即不再问控面」memo 会让后续请求拿不到 grant 结果，
// 但弹窗状态必须持续可读——用户可能先落在别的页面、刷新后才回首页，那时才该弹。
// 回执（POST）后立刻删掉，本实例不再拿旧状态回答。
const welcomeGiftModalMemo = new Map<number, WelcomeGiftModal | null>();

/** 由 grant 结果推导弹窗内容（币数/张数/文案皆来自 welcome-gift 的具名常量）。 */
function welcomeGiftModalOf(result: WelcomeGiftResult): WelcomeGiftModal {
  const copy = welcomeGiftModalCopy(result.coins, WELCOME_GIFT_IMAGE_COUNT);
  return { pending: true, coins: result.coins, images: WELCOME_GIFT_IMAGE_COUNT, ...copy };
}

/** 记住本轮拿到的弹窗状态；本轮没拿到答案（null）时保留上一轮的记忆。 */
function rememberWelcomeGiftModal(userId: number, result: WelcomeGiftResult | null): void {
  if (!result) return;
  if (welcomeGiftModalMemo.size >= WELCOME_GIFT_MEMO_MAX) welcomeGiftModalMemo.clear();
  welcomeGiftModalMemo.set(userId, result.modalPending ? welcomeGiftModalOf(result) : null);
}

/**
 * 把弹窗状态 additive 挂到 new-api 既有回应上（既有栏位一字不动，只多一个 welcomeGift）。
 * pending=false 也照挂：前端只认 pending===true，缺栏位与 false 同义，明写出来才好回报。
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
    // 结案＝不必再问：已发且通知已送达、或不符合资格。通知待送的下次再试。
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

// 首次触达归因补记（src/lib/user-attribution.ts → 控面 user-attribution）：
// OAuth 回调已带 email 落库，这里是**所有 provider 的兜底**（微信等没有 callback 的路径
// 也在登入后打 /api/auth/me，同样带著浏览器的 eimu_first_touch cookie）。控面是首触胜出的
// 幂等 upsert，重复送无副作用。没有 cookie（多数回访）＝零网路成本直接跳过。
// 每个实例每个用户成功一次即永久记住；失败 10 分钟后再试，整段最多等 FIRST_TOUCH_BUDGET_MS。
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

// 邀请绑定：同一套记忆（每实例每用户处理完一次即永久记住，失败 10 分钟后再试）。
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

/** 登入后的侧车事实：新人礼（额度）与首次触达归因并行；两者都永不 throw、都不挡登入。 */
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
  if (await isSessionTokenRevoked(token)) {
    return NextResponse.json({ success: false, message: "未授权" }, { status: 401 });
  }

  // ── Mock mode ──────────────────────────────────────────────────────────────
  if (MOCK_MODE) {
    const result = mockGetSelf(token);
    return NextResponse.json(result, { status: result.success ? 200 : 401 });
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  try {
    // 缓存 key 用整串凭证头（Bearer token + 可选 userId）的杂凑；日志只印前 8 码。
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
    // 反查链与首查是真相依（失败回退路径），保持串行不并行。
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
        {
          success: false,
          message: upstream.status === 401
            ? "session_expired"
            : sanitizeUpstreamMessage(data?.message) ?? "获取用户信息失败",
        },
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

/** 用凭证向上游问自己的 userId（与 GET 同一真源：new-api 对 Bearer 强制 New-Api-User 头）。 */
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
 * POST /api/auth/me —— 「我的会话态」回执（加法式：GET 的语义一行不动）。
 *
 * 目前只有一件事：新人礼首登弹窗已展示（控制面 welcome-gift op=modal_seen，写
 * welcome_gift_grant.modal_seen_at）。这是弹窗「只展示一次」的服务端权威——换设备、
 * 换浏览器再登入也不会重弹；前端 localStorage 只是本设备的辅助闸门。
 *
 * 身份取上游 /api/user/self（与 GET 同一真源），拿不到再走控面稳定令牌反查。
 * 永不 throw 到调用方：失败只回 {success:false}，前端已本地记「看过」，不影响登入。
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
    // 本实例立刻忘掉待展示状态（跨实例由服务端 modal_seen_at 保证不再弹）。
    welcomeGiftModalMemo.delete(userId);
    welcomeGiftNextCheckAt.delete(userId);
    return NextResponse.json({ success: true, updated });
  } catch (error) {
    console.error("[auth/me] welcome gift modal ack failed", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ success: false, message: "服务暂时不可用" }, { status: 503 });
  }
}
