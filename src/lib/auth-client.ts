import {
  type NewApiUser,
  clearStoredToken,
  getStoredToken,
  getStoredUser,
} from "./new-api-client";
import { parseWelcomeGiftModal, type WelcomeGiftModal } from "./welcome-gift-modal";

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: NewApiUser;
  token?: string;
  /**
   * 新人礼首登弹窗（/api/auth/me 的加法栏位）：非空＝服务端说「已发放、未展示」。
   * 单独回传而不是塞进 user——user 会被整包写进 localStorage，把「待展示」这种
   * 一次性状态种进本机快照，下次开页就会拿旧值弹窗（服务端才是权威）。
   */
  welcomeGift?: WelcomeGiftModal | null;
  /**
   * 暂时性失败（网路抖动 / 闸道 5xx / 冷启动）：登入态本身没被否定，
   * 呼叫方只该保留现状重试，绝不可 clearStoredToken——
   * 2026-09-05 事故：/api/auth/me 上游 503 曾被当成登出处理，
   * 一次闸道打嗝就把全站 localStorage+cookie 抹掉，AI 助理弹「尚未登录」。
   */
  transient?: boolean;
}

export async function fetchMe(token: string): Promise<AuthResult> {
  try {
    const cookieToken = typeof document !== "undefined"
      ? document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("napi_token="))?.slice("napi_token=".length)
      : undefined;
    const candidateTokens = cookieToken ? [decodeURIComponent(cookieToken), token] : [token];
    for (const candidate of [...new Set(candidateTokens)]) {
      // 每次候选重试都重新解析 user：getStoredUser 会自愈坏 cookie，
      // 让「旧残留导致缺 x-user-id」的 401 在重试时恢复。
      const storedUser = getStoredUser();
      const res = await fetch("/api/auth/me", {
        headers: {
          Authorization: `Bearer ${candidate}`,
          ...(storedUser?.id ? { "x-user-id": String(storedUser.id) } : {}),
        },
      });
      if (res.status === 401) continue;
      if (res.status >= 500) return { ok: false, error: "服务暂时不可用", transient: true };
      const data = await res.json() as { success: boolean; data?: NewApiUser; message?: string };
      if (!data.success || !data.data) return { ok: false, error: data.message || "无法获取用户信息" };
      // 弹窗栏位取出后不留进 user：user 会被整包写进 localStorage（见 AuthResult.welcomeGift 注）。
      const { welcomeGift, ...user } = data.data as NewApiUser & { welcomeGift?: unknown };
      return { ok: true, user, welcomeGift: parseWelcomeGiftModal(welcomeGift), token: candidate };
    }
    clearStoredToken();
    return { ok: false, error: "session_expired" };
  } catch {
    return { ok: false, error: "网络错误", transient: true };
  }
}

/**
 * 新人礼首登弹窗已展示的回执（POST /api/auth/me，op=welcome-gift-modal-seen）。
 *
 * 形状刻意与 fetchMe 一致（Bearer + x-user-id）：站上对 /api/auth/me 的两次呼叫
 * 必须带同一组身分标头，否则控制面认不出人、回执落不到 modal_seen_at 上。
 * 失败只回 false，**呼叫方不得挡住关窗**——回执没写上只会让下次登入再弹一次，
 * 比把人家的新人礼藏起来轻。
 */
export async function ackWelcomeGiftModalSeen(token: string): Promise<boolean> {
  try {
    const storedUser = getStoredUser();
    const res = await fetch("/api/auth/me", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...(storedUser?.id ? { "x-user-id": String(storedUser.id) } : {}),
      },
      body: JSON.stringify({ op: "welcome-gift-modal-seen" }),
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => null) as { success?: boolean } | null;
    return data?.success === true;
  } catch {
    return false;
  }
}

export function logout(): void {
  const token = getStoredToken();
  const user = getStoredUser();
  clearStoredToken();
  if (!token || typeof fetch === "undefined") return;
  void fetch("/api/auth/logout", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(user?.id ? { "x-user-id": String(user.id) } : {}),
    },
    keepalive: true,
  }).catch(() => undefined);
}
