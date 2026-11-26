import { NextResponse } from "next/server";
import { loginWechatPeer } from "@/lib/accounts/wechat-login";
import { grantMiniappWelcomeGiftViaRelay } from "@/lib/billing/welcome-gift";

/**
 * 小程序登录收尾（微信 openid 登录与游客登录共用）：建号/登入 → 确认 50 币注册礼 → 交付 token。
 * 没确认发礼前不交付 token：客户端不能先经 auth/me 抢占网页默认礼。
 */
export async function completeMiniappLogin(peerId: string, passwordSeed: string): Promise<NextResponse> {
  const result = await loginWechatPeer(peerId, passwordSeed);
  const user = result.user as { id?: unknown; quota?: unknown; used_quota?: unknown };
  const userId = typeof user?.id === "number" ? user.id : Number.NaN;
  if (!result.ok || !Number.isInteger(userId) || userId <= 0) {
    return NextResponse.json({ success: false, message: "wechat_login_failed" }, { status: 502 });
  }
  const gift = await grantMiniappWelcomeGiftViaRelay(userId, { timeoutMs: 12_000 });
  // 重登仍用同一 verified 身份/user_id，占位表控制一次发放；unknown 不盲重发。
  if (!gift || gift.status === "unavailable" || gift.status === "in_flight") {
    // 真实已有余额/消费记录的老账号不因赠礼依赖故障失去登录能力。
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
}
