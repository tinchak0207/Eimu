// PWA standalone 登录辅助：检测 standalone 模式 + 申请跨浏览器交接票据。
// 纯前端模块，不依赖 React，可在任意组件/工具函数里调用。

export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneMedia =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standaloneMedia || iosStandalone;
}

export interface HandoffLogin {
  ticket: string;
  loginUrl: string;
}

interface PendingHandoff extends HandoffLogin {
  createdAt: number;
}

// 本地 pending 票据键：PWA 切去浏览器授权期间可能被系统杀掉重启，
// 回来后 React state 全丢，靠这里续接旧票让面板立刻看到 delivered。
const PENDING_KEY = "pwa_handoff_pending";
// 服务端 ticket 10 分钟过期，本地留 2 分钟余量。
const PENDING_MAX_AGE_MS = 8 * 60_000;

function readPendingHandoff(): PendingHandoff | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingHandoff> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.ticket || !parsed.loginUrl || typeof parsed.createdAt !== "number") return null;
    if (Date.now() - parsed.createdAt >= PENDING_MAX_AGE_MS) return null;
    return { ticket: parsed.ticket, loginUrl: parsed.loginUrl, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function writePendingHandoff(login: HandoffLogin): void {
  try {
    const pending: PendingHandoff = { ...login, createdAt: Date.now() };
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // localStorage 不可用（隐私模式等）：登录流程照旧，仅失去续接能力。
  }
}

/** 清除本地 pending 票据（claim 成功或登录完成后调用）。 */
export function clearHandoffLogin(): void {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    // 同上，静默失败不阻断登录流程。
  }
}

/**
 * 向后端申请一次性交接票据；网络/服务端失败返回 null（调用方退回原流程）。
 * 若本地仍有未过期的 pending 票据，直接续接旧票（面板轮询会立刻看到 delivered），
 * 不重复创建新票。
 */
export async function createHandoffLogin(): Promise<HandoffLogin | null> {
  const pending = readPendingHandoff();
  if (pending) {
    return { ticket: pending.ticket, loginUrl: pending.loginUrl };
  }
  try {
    const res = await fetch("/api/auth/handoff?action=create", { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success?: boolean;
      ticket?: string;
      loginUrl?: string;
    };
    if (!data?.success || !data.ticket || !data.loginUrl) return null;
    const login = { ticket: data.ticket, loginUrl: data.loginUrl };
    writePendingHandoff(login);
    return login;
  } catch {
    return null;
  }
}
