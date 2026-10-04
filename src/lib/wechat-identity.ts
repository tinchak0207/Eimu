import { createHmac } from "node:crypto";

/**
 * 由 peerId 稳定推导 new-api 帐号身份。
 * username = wx_<hash(peerId)>，同一个微信号永远对应同一个帐号（1:1），
 * 重复登入 = 找到既有帐号登入，不开新号。
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
