// mPay 订单参数（我方自签，把订单绑到下单的那个用户）。
//
// 形状：`<planId>.<userId>.<HMAC 前 8 hex>`，如 `popular.253.1a2b3c4d`。
// 为什么要绑：旧格式 param 只有 planId，回调无从得知这笔钱属于谁——兑现只能靠用户
// 回跳 /pricing 自动兑换码。用户付完直接关掉分页（不回跳），钱已付、额度却没到帐。
// 绑上 userId 后 notify 可以**直接入帐**（见 mapay-credit.ts），不再依赖用户回跳；
// 旧格式（未登入下单）一字不动地走原兑换码流程。
// 密钥复用两侧（Vercel／控面）都有的 GENERATION_BILLING_RELAY_SECRET，以域前缀分隔。

import { createHmac, timingSafeEqual } from "node:crypto";

/** 签名长度（hex 位数）。 */
const SIG_HEX = 8;

/** 订单参数的签名前缀（改它等于让新旧两侧互不认，属破坏性变更）。 */
const SIGNATURE_DOMAIN = "mapay-order";

export function mapayOrderSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GENERATION_BILLING_RELAY_SECRET?.trim() || null;
}

function sign(planId: string, userId: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_DOMAIN}.${planId}.${userId}`)
    .digest("hex")
    .slice(0, SIG_HEX);
}

/** 已登入下单时写进 mPay `param` 的三段值。 */
export function buildMapayOrderParam(planId: string, userId: number, secret: string): string {
  return `${planId}.${userId}.${sign(planId, userId, secret)}`;
}

export interface ParsedMapayOrderParam {
  planId: string;
  userId: number;
}

/**
 * 验签并还原 (planId, userId)；任何不合法（旧格式／畸形／签名错／篡改 userId）一律 null。
 * 回 null ＝ 呼叫方完全走旧流程（兑换码）。
 */
export function parseMapayOrderParam(
  param: string | null | undefined,
  secret: string,
): ParsedMapayOrderParam | null {
  // planId 不含 "."（静态档 starter/popular/pro、自定义档 custom:<coins>），从最后两段切。
  const match = /^(.+)\.([0-9]{1,15})\.([0-9a-f]{8})$/.exec((param ?? "").trim());
  if (!match) return null;

  const planId = match[1];
  const userId = Number(match[2]);
  if (!planId || !Number.isSafeInteger(userId) || userId <= 0) return null;

  const expected = Buffer.from(sign(planId, userId, secret));
  const actual = Buffer.from(match[3]);
  return expected.length === actual.length && timingSafeEqual(expected, actual)
    ? { planId, userId }
    : null;
}

/**
 * 回调／回跳侧的统一入口：`param` → 绑定资讯。
 * **未绑一律 null**（旧格式、验签失败、篡改、密钥未配置）＝呼叫方完全走旧兑换码流程。
 */
export function resolveMapayOrderBinding(
  param: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ParsedMapayOrderParam | null {
  const secret = mapayOrderSecret(env);
  return secret ? parseMapayOrderParam(param, secret) : null;
}