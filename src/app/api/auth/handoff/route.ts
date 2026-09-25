import { NextRequest, NextResponse } from "next/server";
import { claimHandoff, createHandoffTicket, pollHandoff } from "@/lib/pwa-handoff";

export const preferredRegion = "sfo1";

// PWA 跨浏览器登录交接：
//   POST ?action=create[&provider=github|google] → 签发 ticket，返回在常用浏览器
//        打开的 loginUrl（provider 白名单，缺省/未知值一律 github，默认行为零回归）；
//   GET  ?ticket=       → PWA 轮询投递状态；
//   POST ?action=claim  → 原子一次性消费，Set-Cookie 种登录态。
// Cookie flags 逐字对齐 /api/auth/github/callback（napi_token/napi_user，
// path "/", maxAge 30d, sameSite lax, secure true），保证两条链路种出的
// 会话完全同构。
export async function POST(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");
  if (action === "create") {
    // provider 白名单：只有显式 google 才走 Google，其余（缺省/垃圾值）回落 github。
    const provider = req.nextUrl.searchParams.get("provider") === "google" ? "google" : "github";
    try {
      const ticket = await createHandoffTicket();
      return NextResponse.json({
        success: true,
        ticket,
        loginUrl: `/api/auth/${provider}/start?handoff=${ticket}`,
      });
    } catch (error) {
      console.error("[auth/handoff:create]", error);
      return NextResponse.json(
        { success: false, message: "登录交接暂不可用，请稍后再试" },
        { status: 503 },
      );
    }
  }

  if (action === "claim") {
    const ticket = req.nextUrl.searchParams.get("ticket");
    if (!ticket) {
      return NextResponse.json({ success: false }, { status: 404 });
    }
    try {
      const claimed = await claimHandoff(ticket);
      if (!claimed) {
        return NextResponse.json({ success: false }, { status: 404 });
      }
      const userJson = JSON.stringify(claimed.user ?? {});
      const response = NextResponse.json({ success: true, user: claimed.user });
      response.cookies.set("napi_token", claimed.token, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        secure: true,
      });
      response.cookies.set("napi_user", userJson, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        secure: true,
      });
      return response;
    } catch (error) {
      console.error("[auth/handoff:claim]", error);
      return NextResponse.json(
        { success: false, message: "登录交接暂不可用，请稍后再试" },
        { status: 503 },
      );
    }
  }

  return NextResponse.json({ success: false, message: "未知操作" }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const ticket = req.nextUrl.searchParams.get("ticket");
  if (!ticket) {
    return NextResponse.json({ success: false }, { status: 404 });
  }
  try {
    const status = await pollHandoff(ticket);
    return NextResponse.json({ success: true, status });
  } catch (error) {
    console.error("[auth/handoff:poll]", error);
    return NextResponse.json(
      { success: false, message: "登录交接暂不可用，请稍后再试" },
      { status: 503 },
    );
  }
}
