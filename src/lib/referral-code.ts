// 邀請碼（我方自簽，不依賴 new-api aff_code）。
//
// 形狀：`<userId 的 36 進位>-<HMAC 前 8 hex>`，如 `3f-1a2b3c4d`。
// 為什麼自簽：①OAuth 註冊不經 new-api 的 aff 參數，上游 aff 綁定在我們的登入鏈路上
// 從來沒生效過；②解碼不需要任何查表（控面拿到碼就能還原邀請人）；③簽名防
// 偽造——亂填別人的 id 只會被拒，不會把獎勵記到錯的人頭上。
// 密鑰復用兩側（Vercel／控面）都有的 GENERATION_BILLING_RELAY_SECRET，以域前綴分隔。

import { createHmac, timingSafeEqual } from "node:crypto";
import { INVITE_PARAM } from "@/lib/first-touch-attribution";

export { INVITE_PARAM };

const SIG_HEX = 8;

export function referralSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GENERATION_BILLING_RELAY_SECRET?.trim() || null;
}

function sign(userId: number, secret: string): string {
  return createHmac("sha256", secret).update(`referral-invite.${userId}`).digest("hex").slice(0, SIG_HEX);
}

export function inviteCodeFor(userId: number, secret: string): string {
  return `${userId.toString(36)}-${sign(userId, secret)}`;
}

/** 驗簽並還原邀請人 id；任何不合法（畸形／簽名錯）一律 null。 */
export function parseInviteCode(code: string | null | undefined, secret: string): number | null {
  const match = /^([0-9a-z]{1,10})-([0-9a-f]{8})$/.exec((code ?? "").trim().toLowerCase());
  if (!match) return null;
  const userId = parseInt(match[1], 36);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  const expected = Buffer.from(sign(userId, secret));
  const actual = Buffer.from(match[2]);
  return expected.length === actual.length && timingSafeEqual(expected, actual) ? userId : null;
}

export function buildInviteUrl(siteUrl: string, code: string): string {
  return `${siteUrl.replace(/\/+$/, "")}/?${INVITE_PARAM}=${encodeURIComponent(code)}`;
}
