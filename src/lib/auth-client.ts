import {
  type NewApiUser,
  clearStoredToken,
  getStoredUser,
} from "./new-api-client";
import { parseWelcomeGiftModal, type WelcomeGiftModal } from "./welcome-gift-modal";

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: NewApiUser;
  token?: string;
  /**
   * 新人禮首登彈窗（/api/auth/me 的加法欄位）：非空＝服務端說「已發放、未展示」。
   * 單獨回傳而不是塞進 user——user 會被整包寫進 localStorage，把「待展示」這種
   * 一次性狀態種進本機快照，下次開頁就會拿舊值彈窗（服務端才是權威）。
   */
  welcomeGift?: WelcomeGiftModal | null;
  /**
   * 暫時性失敗（網路抖動 / 閘道 5xx / 冷啟動）：登入態本身沒被否定，
   * 呼叫方只該保留現狀重試，絕不可 clearStoredToken——
   * 2026-09-05 事故：/api/auth/me 上游 503 曾被當成登出處理，
   * 一次閘道打嗝就把全站 localStorage+cookie 抹掉，AI 助理彈「尚未登录」。
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
      // 每次候選重試都重新解析 user：getStoredUser 會自愈壞 cookie，
      // 讓「舊殘留導致缺 x-user-id」的 401 在重試時恢復。
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
      // 彈窗欄位取出後不留進 user：user 會被整包寫進 localStorage（見 AuthResult.welcomeGift 註）。
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
 * 新人禮首登彈窗已展示的回執（POST /api/auth/me，op=welcome-gift-modal-seen）。
 *
 * 形狀刻意與 fetchMe 一致（Bearer + x-user-id）：站上對 /api/auth/me 的兩次呼叫
 * 必須帶同一組身分標頭，否則控制面認不出人、回執落不到 modal_seen_at 上。
 * 失敗只回 false，**呼叫方不得擋住關窗**——回執沒寫上只會讓下次登入再彈一次，
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
  clearStoredToken();
}
