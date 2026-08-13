import { NextRequest, NextResponse } from "next/server";
import { getWechatLoginState, expireWechatLogin } from "@/lib/wechat-login";

export const preferredRegion = "sfo1";

/**
 * 前端輪詢登入結果。
 * state 需與 httpOnly cookie 一致（防第三方猜 state 竊取登入結果）。
 */
export async function GET(req: NextRequest) {
  const qState = req.nextUrl.searchParams.get("state");
  const cookieState = req.cookies.get("wechat_oauth_state")?.value;
  if (!qState || !cookieState || qState !== cookieState) {
    return NextResponse.json({ success: false, message: "invalid_state" }, { status: 400 });
  }

  // state → 反查 code：cookie 只存 state，需從 blob 找對應。為避免全表掃，poll 需帶 code。
  // 前端 start 已拿到 code，這裡以 code + state 雙重驗證。
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
    // 兌換完成後銷毀 cookie，防止同一 state 被重複消費。
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
