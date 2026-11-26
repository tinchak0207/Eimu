// mPay 订单参数（我方自签，把订单绑到下单的那个用户）。
//
// 新格式：`<planId>.<userId>.<outTradeNo>.<timestamp>.<HMAC 32 hex>`。
// 载荷含 out_trade_no 与 timestamp，签名不再截成 8 hex。
// 旧格式 `<planId>.<userId>.<HMAC 前 8 hex>` 仍接受，只为在途订单。
// 为什么要绑：旧格式 param 只有 planId，回调无从得知这笔钱属于谁——兑现只能靠用户
// 回跳 /pricing 自动兑换码。用户付完直接关掉分页（不回跳），钱已付、额度却没到帐。
// 绑上 userId 后 notify 可以**直接入帐**（见 mapay-credit.ts），不再依赖用户回跳；
// 未登入下单（无签名）一字不动地走原兑换码流程。
// 密钥复用两侧（Vercel／控面）都有的 GENERATION_BILLING_RELAY_SECRET，以域前缀分隔。

import { createHmac, timingSafeEqual } from "node:crypto";

/** 在途订单的旧签名长度（hex 位数）。新单不得再用。 */
const LEGACY_SIG_HEX = 8;

/** 新签名长度（hex 位数，至少 32）。 */
const SIG_HEX = 32;

/** 订单参数的签名前缀（改它等于让新旧两侧互不认，属破坏性变更）。 */
const SIGNATURE_DOMAIN = "mapay-order";

export function mapayOrderSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GENERATION_BILLING_RELAY_SECRET?.trim() || null;
}

function signLegacy(planId: string, userId: number, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_DOMAIN}.${planId}.${userId}`)
    .digest("hex")
    .slice(0, LEGACY_SIG_HEX);
}

function signCurrent(
  planId: string,
  userId: number,
  outTradeNo: string,
  timestamp: string,
  secret: string,
): string {
  return createHmac("sha256", secret)
    .update(`${SIGNATURE_DOMAIN}.${planId}.${userId}.${outTradeNo}.${timestamp}`)
    .digest("hex")
    .slice(0, SIG_HEX);
}

function safeEqualHex(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

export interface MapayOrderParamBinding {
  outTradeNo: string;
  timestamp: number | string;
}

/** 已登入下单时写进 mPay `param` 的值。给出交易号与时间戳时走新签名。 */
export function buildMapayOrderParam(
  planId: string,
  userId: number,
  secret: string,
  binding?: MapayOrderParamBinding,
): string {
  const outTradeNo = binding?.outTradeNo?.trim() ?? "";
  const timestamp = binding?.timestamp == null ? "" : String(binding.timestamp).trim();
  if (outTradeNo && timestamp) {
    return `${planId}.${userId}.${outTradeNo}.${timestamp}.${signCurrent(planId, userId, outTradeNo, timestamp, secret)}`;
  }
  return `${planId}.${userId}.${signLegacy(planId, userId, secret)}`;
}

export interface ParsedMapayOrderParam {
  planId: string;
  userId: number;
  outTradeNo?: string;
  timestamp?: string;
}

const CURRENT_PARAM =
  /^(.+)\.([0-9]{1,15})\.([^.]+)\.([0-9]{10,16})\.([0-9a-f]{32,64})$/;
const LEGACY_PARAM = /^(.+)\.([0-9]{1,15})\.([0-9a-f]{8})$/;

function parseIdentity(planId: string, userIdRaw: string): { planId: string; userId: number } | null {
  const userId = Number(userIdRaw);
  if (!planId || !Number.isSafeInteger(userId) || userId <= 0) return null;
  return { planId, userId };
}

/**
 * 验签并还原 (planId, userId)。
 * 同时接受旧 8 hex（在途订单）与新的至少 32 hex（载荷含 out_trade_no、timestamp）。
 * 任何不合法（未签名旧格式／畸形／签名错／篡改）一律 null。
 * 回 null ＝ 呼叫方完全走旧流程（兑换码）。
 */
export function parseMapayOrderParam(
  param: string | null | undefined,
  secret: string,
): ParsedMapayOrderParam | null {
  const raw = (param ?? "").trim();

  const current = CURRENT_PARAM.exec(raw);
  if (current) {
    const identity = parseIdentity(current[1], current[2]);
    if (!identity) return null;
    const outTradeNo = current[3];
    const timestamp = current[4];
    const actualSig = current[5].slice(0, SIG_HEX);
    const expected = signCurrent(identity.planId, identity.userId, outTradeNo, timestamp, secret);
    if (!safeEqualHex(expected, actualSig)) return null;
    return { ...identity, outTradeNo, timestamp };
  }

  const legacy = LEGACY_PARAM.exec(raw);
  if (!legacy) return null;
  const identity = parseIdentity(legacy[1], legacy[2]);
  if (!identity) return null;
  const expected = signLegacy(identity.planId, identity.userId, secret);
  return safeEqualHex(expected, legacy[3]) ? identity : null;
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
