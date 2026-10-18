import { NextRequest, NextResponse } from "next/server";
import {
  completeWechatLogin,
  getWechatLoginState,
  loginWechatPeer,
  verifyWechatCallbackSecret,
} from "@/lib/wechat-login";

export const preferredRegion = "sfo1";

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-wechat-callback-secret");
  if (!verifyWechatCallbackSecret(secret)) {
    return NextResponse.json({ success: false, message: "forbidden" }, { status: 403 });
  }

  let body: { code?: string; peerId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, message: "bad_json" }, { status: 400 });
  }
  const rawCode = (body.code ?? "").trim();
  const peerId = (body.peerId ?? "").trim();
  if (!rawCode || !peerId) {
    return NextResponse.json({ success: false, message: "missing_code_or_peer" }, { status: 400 });
  }

  const record = await getWechatLoginState(rawCode);
  if (!record) {
    return NextResponse.json({ success: false, message: "unknown_code" }, { status: 404 });
  }
  if (record.expiresAt < Date.now()) {
    return NextResponse.json({ success: false, message: "expired" }, { status: 410 });
  }
  if (record.status !== "pending") {
    return NextResponse.json({ success: false, message: "already_used" }, { status: 409 });
  }

  try {
    const passwordSeed = process.env.WECHAT_CALLBACK_SECRET?.trim() || "";
    if (!passwordSeed) {
      return NextResponse.json({ success: false, message: "not_configured" }, { status: 503 });
    }
    const result = await loginWechatPeer(peerId, passwordSeed);
    const ok = await completeWechatLogin(rawCode, peerId, result.token, result.user);
    if (!ok) {
      return NextResponse.json({ success: false, message: "already_used" }, { status: 409 });
    }
    return NextResponse.json({
      success: true,
      message: result.isNewUser ? "注册成功，已登录" : "绑定成功，已登录",
      isNewUser: result.isNewUser,
    });
  } catch (error) {
    console.error("[auth/wechat/callback]", error);
    return NextResponse.json(
      { success: false, message: error instanceof Error ? error.message : "unknown" },
      { status: 500 },
    );
  }
}
