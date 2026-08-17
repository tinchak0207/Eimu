import { NextResponse } from "next/server";
import { createWechatLoginState, WECHAT_LOGIN_TTL_SEC } from "@/lib/wechat-login";
import { getWechatOfficialQrUrl } from "@/lib/wechat-official";

export const preferredRegion = "sfo1";

// VPS 上的帶參數二維碼服務（access_token 不過 Vercel；正式號白名單只需 VPS IP）
const MP_QR_SERVER =
  process.env.WECHAT_MP_QR_SERVER?.trim() || "http://43.172.85.76:8781";

async function fetchMpQrImgUrl(scene: string): Promise<string | null> {
  try {
    const res = await fetch(`${MP_QR_SERVER}/new-qr?scene=${encodeURIComponent(scene)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { success?: boolean; imgUrl?: string };
    return data.success && data.imgUrl ? data.imgUrl : null;
  } catch (err) {
    console.warn("[wechat/start] mp-qr 服務不可用，降級固定 QR:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET() {
  const state = await createWechatLoginState();

  // 掃碼即登入二維碼（scene=state，掃碼事件經 EventKey 反查）；失敗降級固定 QR + 發碼
  const mpQrImgUrl = await fetchMpQrImgUrl(state.state);

  const response = NextResponse.json({
    success: true,
    code: state.code,
    state: state.state,
    ttlSec: WECHAT_LOGIN_TTL_SEC,
    mpQrImgUrl,
    // 測試號主通道：公眾號二維碼（後台複製的圖片 URL），未配置時前端隱藏。
    officialQrUrl: getWechatOfficialQrUrl(),
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