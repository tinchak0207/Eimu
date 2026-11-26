import { NextRequest, NextResponse } from "next/server";
import { completeMiniappLogin } from "@/lib/accounts/miniapp-login";

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
    return await completeMiniappLogin(session.openid, passwordSeed);
  } catch {
    // 微信请求 URL 含 AppSecret，绝不把 fetch 异常/URL/响应原文写日志。
    return NextResponse.json({ success: false, message: "wechat_login_unavailable" }, { status: 502 });
  }
}
