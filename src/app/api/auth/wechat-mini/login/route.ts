import { NextRequest, NextResponse } from "next/server";
import { loginWechatPeer } from "@/lib/wechat-login";
import { grantMiniappWelcomeGiftViaRelay } from "@/lib/welcome-gift";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 微信服务器验证 code 后才取得账号身份；请求内 userId/source/amount 一律不参与发礼。 */
export async function POST(req: NextRequest) {
  const appid = process.env.WX_MINIPROGRAM_APPID?.trim();
  const secret = process.env.WX_MINIPROGRAM_SECRET?.trim();
  const passwordSeed = process.env.WECHAT_CALLBACK_SECRET?.trim();
  if (!appid || !secret || !passwordSeed) {
    return NextResponse.json({ success: false, message: "not_configured" }, { status: 503 });
  }
  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, message: "bad_json" }, { status: 400 });
  }
  const code = body && typeof body === "object" && typeof (body as { code?: unknown }).code === "string"
    ? (body as { code: string }).code.trim() : "";
  if (!code || code.length > 512) return NextResponse.json({ success: false, message: "invalid_code" }, { status: 400 });
  try {
    const query = new URLSearchParams({ appid, secret, js_code: code, grant_type: "authorization_code" });
    const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${query}`, {
      cache: "no-store", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return NextResponse.json({ success: false, message: "wechat_unavailable" }, { status: 502 });
    const session = await response.json() as { openid?: unknown; errcode?: unknown };
    if (typeof session.openid !== "string" || !session.openid || (typeof session.errcode === "number" && session.errcode !== 0)) {
      return NextResponse.json({ success: false, message: "wechat_login_failed", ...(typeof session.errcode === "number" ? { errcode: session.errcode } : {}) }, { status: 401 });
    }
    const result = await loginWechatPeer(session.openid, passwordSeed);
    const user = result.user as { id?: unknown; quota?: unknown; used_quota?: unknown };
    const userId = typeof user?.id === "number" ? user.id : Number.NaN;
    if (!result.ok || !Number.isInteger(userId) || userId <= 0) {
      return NextResponse.json({ success: false, message: "wechat_login_failed" }, { status: 502 });
    }
    const gift = await grantMiniappWelcomeGiftViaRelay(userId, { timeoutMs: 12_000 });
    // 没确认发礼前不交付 token：客户端不能先经 auth/me 抢占网页默认礼。
    // 重登仍用同一 verified openid/user_id，占位表控制一次发放；unknown 不盲重发。
    if (!gift || gift.status === "unavailable" || gift.status === "in_flight") {
      // 真实已有余额/消费记录的老账号不因赠礼依赖故障失去登录能力。
      // 首次建号或此前建号尚未领款的 0/0 账号仍等原 50 币占位，不先经 auth/me 抢领网页默认礼。
      const established = !result.isNewUser && (
        (typeof user.quota === "number" && user.quota > 0) ||
        (typeof user.used_quota === "number" && user.used_quota > 0)
      );
      if (established) return NextResponse.json({ success: true, isNewUser: false, token: result.token, user: result.user, welcomeGift: { status: gift?.status ?? "unavailable", pending: true } });
      return NextResponse.json({ success: false, message: "miniapp_gift_pending" }, { status: 503 });
    }
    const returnedUser = gift.status === "granted" && typeof user.quota === "number"
      ? { ...user, quota: user.quota + gift.amountQuota } : result.user;
    return NextResponse.json({ success: true, isNewUser: result.isNewUser, token: result.token, user: returnedUser, welcomeGift: { status: gift.status, coins: gift.coins } });
  } catch {
    // 微信请求 URL 含 AppSecret，绝不把 fetch 异常/URL/响应原文写日志。
    return NextResponse.json({ success: false, message: "wechat_login_unavailable" }, { status: 502 });
  }
}
