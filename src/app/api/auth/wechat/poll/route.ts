import { NextRequest, NextResponse } from "next/server";
import { getWechatLoginState, expireWechatLogin } from "@/lib/wechat-login";

export const preferredRegion = "sfo1";

/**
 * 前端轮询登入结果。
 * state 需与 httpOnly cookie 一致（防第三方猜 state 窃取登入结果）。
 */
export async function GET(req: NextRequest) {
  const qState = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("wechat_oauth_state")?.value;
  if (!qState || !cookieState || qState !== cookieState) {
    return NextResponse.json({ success: false, message: "invalid_state" }, { status: 400 });
  }

  // state → 反查 code：cookie 只存 state，需从 blob 找对应。为避免全表扫，poll 需带 code。
  // 前端 start 已拿到 code，这里以 code + state 双重验证。
  const code = req.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.json({ success: false, message: "missing_code" }, { status: 400 });
  }

  const record = await getWechatLoginState(code);
  if (!record || record.state !== qState) {
    return NextResponse.json({ success: false, message: "unknown_code" }, { status: 404 });
  }

  if (record.expiresAt < Date.now()) {
    await expireWechatLogin(code);
    return NextResponse.json({ success: false, message: "expired" }, { status: 410 });
  }

  if (record.status === "pending") {
    return NextResponse.json({ success: false, status: "pending" });
  }

  if (record.status === "completed" && record.token && record.user) {
    // 兑换完成后销毁 cookie，防止同一 state 被重复消费。
    const res = NextResponse.json({
      success: true,
      status: "completed",
      token: record.token,
      user: record.user,
    });
    res.cookies.set("wechat_oauth_state", "", { path: "/", maxAge: 0 });
    return res;
  }

  return NextResponse.json({ success: false, status: "expired" }, { status: 410 });
}
