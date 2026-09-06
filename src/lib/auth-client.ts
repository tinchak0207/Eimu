import {
  type NewApiUser,
  clearStoredToken,
  getStoredUser,
} from "./new-api-client";

export interface AuthResult {
  ok: boolean;
  error?: string;
  user?: NewApiUser;
  token?: string;
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
      return { ok: true, user: data.data, token: candidate };
    }
    clearStoredToken();
    return { ok: false, error: "session_expired" };
  } catch {
    return { ok: false, error: "网络错误", transient: true };
  }
}

export function logout(): void {
  clearStoredToken();
}
