import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  verifyWechatSignature,
  parseIncomingMessage,
  getWechatOfficialToken,
} from "@/lib/wechat-official";
import {
  getWechatLoginState,
  getWechatLoginStateByState,
  completeWechatLogin,
  loginWechatPeer,
  WechatLoginState,
} from "@/lib/wechat-login";
import { buildWechatUsername } from "@/lib/wechat-identity";

export const preferredRegion = "sfo1";

/**
 * 測試號/訂閱號接口配置 URL：https://eimu.dev/api/auth/wechat/msg
 * GET：微信伺服器驗證（回 echostr）。
 * POST：被動回覆在部分場景不被微信接受（體感「不說話/暫時無法提供服務」），
 * 此處一律回 200 空；兌換結果與所有提示改走**客服消息接口**主動推送
 * （VPS mp-qr-server /send-text，測試號權限 50 萬/日），100% 顯示。
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

/** VPS 客服消息推送（best-effort，失敗不阻塞兌換）。 */
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
    console.warn("[wechat/msg] 客服消息失敗:", err instanceof Error ? err.message : err);
  }
}

/** 異步兌換：開號/登入 → 標記完成 → 客服消息推送結果。 */
async function redeemAsync(openid: string, record: WechatLoginState): Promise<void> {
  const seed = process.env.WECHAT_CALLBACK_SECRET?.trim() || "wechat-official";
  try {
    const result = await loginWechatPeer(openid, seed);
    const completed = await completeWechatLogin(record.code, openid, result.token, result.user);
    console.log(
      `[wechat/msg] 兌換${completed ? "成功" : "失敗(非 pending)"} openid=${buildWechatUsername(openid)} code=${record.code}`,
    );
    if (completed) {
      await pushCustomText(openid, "登录成功，可以返回浏览器了。");
    }
  } catch (err) {
    console.error("[wechat/msg] 兌換異常:", err);
    await pushCustomText(openid, "登录失败，请刷新网页重新扫码后再试。");
  }
}

export async function POST(req: NextRequest) {
  const token = getWechatOfficialToken();
  if (!token) {
    console.warn("[wechat/msg] WECHAT_OFFICIAL_TOKEN 未配置，拒絕請求");
    return new NextResponse("not configured", { status: 503 });
  }

  const xml = await req.text();
  const msg = parseIncomingMessage(xml);
  if (!msg.fromUserName) {
    return new NextResponse("", { status: 200 });
  }

  let record: WechatLoginState | null = null;

  // 掃碼事件：新關注 subscribe（臨時碼帶 qrscene_ 前綴）/ 老用戶 SCAN
  if (msg.msgType === "event" && (msg.event === "subscribe" || msg.event === "SCAN")) {
    const raw = msg.eventKey || "";
    const scene = raw.startsWith("qrscene_") ? raw.slice("qrscene_".length) : raw;
    if (scene) {
      record = await getWechatLoginStateByState(scene);
    }
    if (!record) {
      void pushCustomText(msg.fromUserName, "欢迎使用微信授权服务，向我发送网站上的四字验证码即可快速登录。");
      return new NextResponse("", { status: 200 });
    }
    if (record.status !== "pending" || record.expiresAt < Date.now()) {
      void pushCustomText(msg.fromUserName, "登录会话已过期，请刷新网页重新获取二维码。");
      return new NextResponse("", { status: 200 });
    }
    console.log(`[wechat/msg] 掃碼事件 ${msg.event} scene=${scene}`);
    waitUntil(redeemAsync(msg.fromUserName, record));
    void pushCustomText(msg.fromUserName, "正在登录，请稍候，登录成功后页面会自动跳转。");
    return new NextResponse("", { status: 200 });
  }

  // text 訊息：驗證碼兌換（兜底通道）
  if (msg.msgType === "text" && msg.content) {
    const clean = msg.content.replace(/[\s，。、：:；;.,!?！？/\\|"'-]/g, "");
    if (clean) {
      const loginPrefix = clean.startsWith("/login") || clean.startsWith("login");
      const code = loginPrefix ? clean.replace(/^\/?login/i, "").trim() : clean;
      record = await getWechatLoginState(code);
    }
    if (!record) {
      void pushCustomText(msg.fromUserName, "验证码无效，请刷新页面重新获取后再发送。");
      return new NextResponse("", { status: 200 });
    }
    if (record.status !== "pending" || record.expiresAt < Date.now()) {
      void pushCustomText(msg.fromUserName, "验证码已过期或已被使用，请刷新页面重新获取。");
      return new NextResponse("", { status: 200 });
    }
    waitUntil(redeemAsync(msg.fromUserName, record));
    void pushCustomText(msg.fromUserName, "正在登录，请稍候，登录成功后页面会自动跳转。");
    return new NextResponse("", { status: 200 });
  }

  // 其他類型（語音/圖片等）不回覆
  return new NextResponse("", { status: 200 });
}