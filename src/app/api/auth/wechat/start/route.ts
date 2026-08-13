import { NextResponse } from "next/server";
import { createWechatLoginState, WECHAT_LOGIN_TTL_SEC } from "@/lib/wechat-login";

export const preferredRegion = "sfo1";

export async function GET() {
  const state = await createWechatLoginState();

  const response = NextResponse.json({
    success: true,
    code: state.code,
    state: state.state,
    ttlSec: WECHAT_LOGIN_TTL_SEC,
    // bot 加好友入口：由 WECHAT_BOT_QR_URL 提供，未配置時前端隱藏掃碼。
    botQrUrl: process.env.WECHAT_BOT_QR_URL?.trim() || null,
  });

  response.cookies.set("wechat_oauth_state", state.state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: WECHAT_LOGIN_TTL_SEC,
  });
  return response;
}
