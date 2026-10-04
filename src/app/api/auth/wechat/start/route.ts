import { NextResponse } from "next/server";
import { createWechatLoginState, WECHAT_LOGIN_TTL_SEC } from "@/lib/wechat-login";
import { getWechatOfficialQrUrl } from "@/lib/wechat-official";

export const preferredRegion = "sfo1";

// VPS 上的带参数二维码服务（access_token 不过 Vercel；正式号白名单只需 VPS IP）
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
    console.warn("[wechat/start] mp-qr 服务不可用，降级固定 QR:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function GET() {
  const state = await createWechatLoginState();

  // 扫码即登入二维码（scene=state，扫码事件经 EventKey 反查）；失败降级固定 QR + 发码
  const mpQrImgUrl = await fetchMpQrImgUrl(state.state);

  const response = NextResponse.json({
    success: true,
    code: state.code,
    state: state.state,
    ttlSec: WECHAT_LOGIN_TTL_SEC,
    mpQrImgUrl,
    // 测试号主通道：公众号二维码（后台复制的图片 URL），未配置时前端隐藏。
    officialQrUrl: getWechatOfficialQrUrl(),
    // bot 加好友入口：由 WECHAT_BOT_QR_URL 提供，未配置时前端隐藏扫码。
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