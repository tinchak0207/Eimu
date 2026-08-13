import { createHmac } from "node:crypto";

/**
 * 由 peerId 穩定推導 new-api 帳號身份。
 * username = wx_<hash(peerId)>，同一個微信號永遠對應同一個帳號（1:1），
 * 重複登入 = 找到既有帳號登入，不開新號。
 */

export function buildWechatUsername(peerId: string): string {
  const digest = createHmac("sha256", "wechat-identity")
    .update(`wx:${peerId}`)
    .digest("hex")
    .slice(0, 16);
  return `wx_${digest}`;
}

export function buildWechatPassword(peerId: string, secret: string) {
  const digest = createHmac("sha256", secret)
    .update(`wechat:${peerId}`)
    .digest("hex");
  return `Wx${digest.slice(0, 14)}`;
}

export function buildWechatEmail(peerId: string) {
  const digest = createHmac("sha256", "wechat-identity")
    .update(`wx:${peerId}`)
    .digest("hex")
    .slice(0, 12);
  return `wechat-${digest}@wx.tinchak0207.xyz`;
}
