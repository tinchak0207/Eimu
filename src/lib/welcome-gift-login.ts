// 新人礼的登录路径编排（Vercel 侧）：请控制面发放 → 若通知待送，写一条站内通知 → 回执。
//
// 与 welcome-gift.ts 分档的原因：通知写入复用 notification-store（Vercel Blob），
// 控制面只需要 welcome-gift.ts 这一档，不必同步 notification-store 那一族文件。

import { createNotification } from "@/lib/notification-store";
import {
  ackWelcomeGiftNoticeViaRelay,
  grantWelcomeGiftViaRelay,
  welcomeGiftNotice,
  type WelcomeGiftResult,
} from "@/lib/welcome-gift";
import { QUOTA_PER_COIN } from "@/lib/quota-constants";

export interface WelcomeGiftLoginDeps {
  grant?: typeof grantWelcomeGiftViaRelay;
  ack?: typeof ackWelcomeGiftNoticeViaRelay;
  notify?: (userId: number, notice: { title: string; body: string }) => Promise<unknown>;
}

/**
 * 永不 throw。回传的 noticePending 已反映本次是否送达（送达且回执成功 → false）。
 */
export async function ensureWelcomeGiftOnLogin(
  userId: number,
  options: { timeoutMs?: number } = {},
  deps: WelcomeGiftLoginDeps = {},
): Promise<WelcomeGiftResult | null> {
  try {
    const result = await (deps.grant ?? grantWelcomeGiftViaRelay)(userId, { timeoutMs: options.timeoutMs });
    if (!result || !result.noticePending) return result;

    const notify = deps.notify ?? ((id: number, notice: { title: string; body: string }) => createNotification(id, notice));
    try {
      await notify(userId, welcomeGiftNotice(result.amountQuota / QUOTA_PER_COIN));
    } catch (error) {
      console.error(`[welcome-gift] 站内通知写入失败 user=${userId}：${error instanceof Error ? error.message : String(error)}`);
      return result;
    }
    const acked = await (deps.ack ?? ackWelcomeGiftNoticeViaRelay)(userId, { timeoutMs: options.timeoutMs });
    return { ...result, noticePending: !acked };
  } catch (error) {
    console.error(`[welcome-gift] login hook failed user=${userId}：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
