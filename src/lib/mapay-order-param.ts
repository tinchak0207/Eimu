// mPay 訂單參數（我方自簽，把訂單綁到下單的那個用戶）。
//
// 形狀：`<planId>.<userId>.<HMAC 前 8 hex>`，如 `popular.253.1a2b3c4d`。
// 為什麼要綁：舊格式 param 只有 planId，回調無從得知這筆錢屬於誰——兌現只能靠用戶
// 回跳 /pricing 自動兌換碼。用戶付完直接關掉分頁（不回跳），錢已付、額度卻沒到帳。
// 綁上 userId 後 notify 可以**直接入帳**（見 mapay-credit.ts），不再依賴用戶回跳；
// 舊格式（未登入下單）一字不動地走原兌換碼流程。
// 密鑰復用兩側（Vercel／控面）都有的 GENERATION_BILLING_RELAY_SECRET，以域前綴分隔。

import { createHmac, timingSafeEqual } from "node:crypto";

/** 簽名長度（hex 位數）。 */
const SIG_HEX = 8;

/** 訂單參數的簽名前綴（改它等於讓新舊兩側互不認，屬破壞性變更）。 */
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

/** 已登入下單時寫進 mPay `param` 的三段值。 */
export function buildMapayOrderParam(planId: string, userId: number, secret: string): string {
  return `${planId}.${userId}.${sign(planId, userId, secret)}`;
}

export interface ParsedMapayOrderParam {
  planId: string;
  userId: number;
}

/**
 * 驗簽並還原 (planId, userId)；任何不合法（舊格式／畸形／簽名錯／篡改 userId）一律 null。
 * 回 null ＝ 呼叫方完全走舊流程（兌換碼）。
 */
export function parseMapayOrderParam(
  param: string | null | undefined,
  secret: string,
): ParsedMapayOrderParam | null {
  // planId 不含 "."（靜態檔 starter/popular/pro、自定義檔 custom:<coins>），從最後兩段切。
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
 * 回調／回跳側的統一入口：`param` → 綁定資訊。
 * **未綁一律 null**（舊格式、驗簽失敗、篡改、密鑰未配置）＝呼叫方完全走舊兌換碼流程。
 */
export function resolveMapayOrderBinding(
  param: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ParsedMapayOrderParam | null {
  const secret = mapayOrderSecret(env);
  return secret ? parseMapayOrderParam(param, secret) : null;
}