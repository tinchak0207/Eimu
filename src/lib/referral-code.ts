// 邀请码（我方自签，不依赖 new-api aff_code）。
//
// 形状：`<userId 的 36 进位>-<HMAC 前 8 hex>`，如 `3f-1a2b3c4d`。
// 为什么自签：①OAuth 注册不经 new-api 的 aff 参数，上游 aff 绑定在我们的登入链路上
// 从来没生效过；②解码不需要任何查表（控面拿到码就能还原邀请人）；③签名防
// 伪造——乱填别人的 id 只会被拒，不会把奖励记到错的人头上。
// 密钥复用两侧（Vercel／控面）都有的 GENERATION_BILLING_RELAY_SECRET，以域前缀分隔。

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

/** 验签并还原邀请人 id；任何不合法（畸形／签名错）一律 null。 */
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
