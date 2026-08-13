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
}

export async function fetchMe(token: string): Promise<AuthResult> {
  try {
    const storedUser = getStoredUser();
    const res = await fetch("/api/auth/me", {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(storedUser?.id ? { "x-user-id": String(storedUser.id) } : {}),
      },
    });

    if (res.status === 401) {
      clearStoredToken();
      return { ok: false, error: "session_expired" };
    }

    const data = await res.json() as { success: boolean; data?: NewApiUser; message?: string };
    if (!data.success || !data.data) {
      return { ok: false, error: data.message || "无法获取用户信息" };
    }

    return { ok: true, user: data.data };
  } catch {
    return { ok: false, error: "网络错误" };
  }
}

export function logout(): void {
  clearStoredToken();
}
