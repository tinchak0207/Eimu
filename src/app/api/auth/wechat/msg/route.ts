import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  verifyWechatSignature,
  parseIncomingMessage,
  getWechatOfficialToken,
} from "@/lib/wechat-official";
import {
  getWechatLoginStateByState,
  completeWechatLogin,
  loginWechatPeer,
  WechatLoginState,
} from "@/lib/wechat-login";
import { buildWechatUsername } from "@/lib/wechat-identity";

export const preferredRegion = "sfo1";

/**
 * 测试号/订阅号接口配置 URL：https://eimu.dev/api/auth/wechat/msg
 * GET：微信伺服器验证（回 echostr）。
 * POST：被动回覆在部分场景不被微信接受（体感「不说话/暂时无法提供服务」），
 * 此处一律回 200 空；兑换结果与所有提示改走**客服消息接口**主动推送
 * （VPS mp-qr-server /send-text，测试号权限 50 万/日），100% 显示。
 */
export async function GET(req: NextRequest) {
  const token = getWechatOfficialToken();
  const sp = req.nextUrl.searchParams;
  const ok = verifyWechatSignature(
    token,
    sp.get("signature"),
    sp.get("timestamp"),
    sp.get("nonce"),
  );
  if (!ok) {
    return new NextResponse("invalid signature", { status: 403 });
  }
  return new NextResponse(sp.get("echostr") || "", {
    headers: { "Content-Type": "text/plain" },
  });
}

/** VPS 客服消息推送（best-effort，失败不阻塞兑换）。 */
async function pushCustomText(openid: string, content: string): Promise<void> {
  const base = process.env.WECHAT_MP_QR_SERVER?.trim();
  if (!base) return;
  try {
    await fetch(`${base}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openid, content }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    console.warn("[wechat/msg] 客服消息失败:", err instanceof Error ? err.message : err);
  }
}

/** 异步兑换：开号/登入 → 标记完成 → 客服消息推送结果。 */
async function redeemAsync(openid: string, record: WechatLoginState): Promise<void> {
  const seed = process.env.WECHAT_CALLBACK_SECRET?.trim() || "";
  if (!seed) {
    console.error("[wechat/msg] WECHAT_CALLBACK_SECRET 未配置，拒绝兑换");
    await pushCustomText(openid, "登录失败，请刷新网页重新扫码后再试。");
    return;
  }
  try {
    const result = await loginWechatPeer(openid, seed);
    const completed = await completeWechatLogin(record.code, openid, result.token, result.user);
    console.log(
      `[wechat/msg] 兑换${completed ? "成功" : "失败(非 pending)"} openid=${buildWechatUsername(openid)} code=${record.code}`,
    );
    if (completed) {
      await pushCustomText(openid, "登录成功，可以返回浏览器了。");
    }
  } catch (err) {
    console.error("[wechat/msg] 兑换异常:", err);
    await pushCustomText(openid, "登录失败，请刷新网页重新扫码后再试。");
  }
}

export async function POST(req: NextRequest) {
  const token = getWechatOfficialToken();
  if (!token) {
    console.warn("[wechat/msg] WECHAT_OFFICIAL_TOKEN 未配置，拒绝请求");
    return new NextResponse("not configured", { status: 503 });
  }
  const sp = req.nextUrl.searchParams;
  const signatureOk = verifyWechatSignature(token, sp.get("signature"), sp.get("timestamp"), sp.get("nonce"));
  if (!signatureOk) {
    return new NextResponse("invalid signature", { status: 403 });
  }
  if (!process.env.WECHAT_CALLBACK_SECRET?.trim()) {
    return new NextResponse("not configured", { status: 503 });
  }

  const xml = await req.text();
  const msg = parseIncomingMessage(xml);
  if (!msg.fromUserName) {
    return new NextResponse("", { status: 200 });
  }

  let record: WechatLoginState | null = null;

  // 扫码事件：新关注 subscribe（临时码带 qrscene_ 前缀）/ 老用户 SCAN
  if (msg.msgType === "event" && (msg.event === "subscribe" || msg.event === "SCAN")) {
    const raw = msg.eventKey || "";
    const scene = raw.startsWith("qrscene_") ? raw.slice("qrscene_".length) : raw;
    if (scene) {
      record = await getWechatLoginStateByState(scene);
    }
    if (!record) {
      void pushCustomText(msg.fromUserName, "欢迎关注 Eimu。要登录网站，请用微信扫描网页上的登录二维码。");
      return new NextResponse("", { status: 200 });
    }
    if (record.status !== "pending" || record.expiresAt < Date.now()) {
      void pushCustomText(msg.fromUserName, "登录会话已过期，请刷新网页重新获取二维码。");
      return new NextResponse("", { status: 200 });
    }
    console.log(`[wechat/msg] 扫码事件 ${msg.event} scene=${scene}`);
    waitUntil(redeemAsync(msg.fromUserName, record));
    void pushCustomText(msg.fromUserName, "正在登录，请稍候，登录成功后页面会自动跳转。");
    return new NextResponse("", { status: 200 });
  }

  // text 讯息：验证码通道已取消（2026-09-30 暴君裁定：扫到即登入，少一个阻塞）。
  // 有人照旧习惯发字过来，就告诉他正确做法，不再兑换任何码。
  if (msg.msgType === "text") {
    void pushCustomText(msg.fromUserName, "现在无需验证码：直接用微信扫网页上的二维码即可登录。");
    return new NextResponse("", { status: 200 });
  }

  // 其他类型（语音/图片等）不回覆
  return new NextResponse("", { status: 200 });
}