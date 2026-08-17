import { createHash } from "node:crypto";

/**
 * 微信公眾平台測試號（未認證也可用）被動回覆通道。
 * 用戶掃測試號二維碼關注 → 在微信對話中發送驗證碼 → 微信伺服器把
 * text 訊息 POST 到接口配置 URL（本模組的路由）→ 匹配登入碼 → 頁面輪詢完成。
 * FromUserName 即該用戶對測試號的唯一 openid（wxid），作為帳號身份。
 */

/** GET 驗證：signature = sha1(字典序拼接 token/timestamp/nonce)。 */
export function verifyWechatSignature(
  token: string,
  signature: string | null,
  timestamp: string | null,
  nonce: string | null,
): boolean {
  if (!signature || !timestamp || !nonce) return false;
  const sorted = [token, timestamp, nonce].sort().join("");
  const digest = createHash("sha1").update(sorted).digest("hex");
  return digest === signature;
}

/** 極簡 XML 取節點文本（微信明文訊息 XML 結構固定，無需引入 XML 依賴）。 */
export function xmlText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[)?([^\\]\\s][\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`));
  if (!m) return "";
  return m[1].replace(/\]\]>$/, "").replace(/\s+$/, "");
}

export interface WechatIncomingMessage {
  toUserName: string;
  fromUserName: string;
  msgType: string;
  content: string;
  msgId?: string;
  event?: string;
  eventKey?: string;
}

export function parseIncomingMessage(xml: string): WechatIncomingMessage {
  return {
    toUserName: xmlText(xml, "ToUserName"),
    fromUserName: xmlText(xml, "FromUserName"),
    msgType: xmlText(xml, "MsgType"),
    content: xmlText(xml, "Content"),
    msgId: xmlText(xml, "MsgId") || undefined,
    event: xmlText(xml, "Event") || undefined,
    eventKey: xmlText(xml, "EventKey") || undefined,
  };
}

/** 被動回覆 text 訊息 XML。 */
export function buildTextReply(
  toUserName: string,
  fromUserName: string,
  content: string,
): string {
  const createTime = Math.floor(Date.now() / 1000);
  return `<xml>
<ToUserName><![CDATA[${toUserName}]]></ToUserName>
<FromUserName><![CDATA[${fromUserName}]]></FromUserName>
<CreateTime>${createTime}</CreateTime>
<MsgType><![CDATA[text]]></MsgType>
<Content><![CDATA[${content}]]></Content>
</xml>`;
}

/** 接口配置 Token；統一取 env，全局共享。 */
export function getWechatOfficialToken(): string {
  return process.env.WECHAT_OFFICIAL_TOKEN?.trim() || "";
}

/** 測試號二維碼（後台『測試號二維碼』圖片 URL），未配置時前端隱藏。 */
export function getWechatOfficialQrUrl(): string | null {
  const base = process.env.WECHAT_OFFICIAL_QR_URL?.trim();
  if (!base) return null;
  // cache-busting：public 靜態圖被 CDN/瀏覽器長快取，換圖後舊碼會殘留，帶 v 強制取新
  return `${base}${base.includes("?") ? "&" : "?"}v=${Date.now()}`;
}