import { createHash } from "node:crypto";

/**
 * 微信公众平台测试号（未认证也可用）被动回覆通道。
 * 用户扫测试号二维码关注 → 在微信对话中发送验证码 → 微信伺服器把
 * text 讯息 POST 到接口配置 URL（本模组的路由）→ 匹配登入码 → 页面轮询完成。
 * FromUserName 即该用户对测试号的唯一 openid（wxid），作为帐号身份。
 */

/** GET 验证：signature = sha1(字典序拼接 token/timestamp/nonce)。 */
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

/** 极简 XML 取节点文本（微信明文讯息 XML 结构固定，无需引入 XML 依赖）。 */
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

/** 被动回覆 text 讯息 XML。 */
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

/** 接口配置 Token；统一取 env，全局共享。 */
export function getWechatOfficialToken(): string {
  return process.env.WECHAT_OFFICIAL_TOKEN?.trim() || "";
}

/** 测试号二维码（后台『测试号二维码』图片 URL），未配置时前端隐藏。 */
export function getWechatOfficialQrUrl(): string | null {
  const base = process.env.WECHAT_OFFICIAL_QR_URL?.trim();
  if (!base) return null;
  // cache-busting：public 静态图被 CDN/浏览器长快取，换图后旧码会残留，带 v 强制取新
  return `${base}${base.includes("?") ? "&" : "?"}v=${Date.now()}`;
}