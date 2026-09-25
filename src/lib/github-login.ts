// PWA standalone 登录辅助：检测「存储与用户常用浏览器隔离」的运行环境 +
// 申请跨浏览器交接票据。纯前端模块，不依赖 React，可在任意组件/工具函数里调用。

/**
 * 该运行环境是否与使用者常用浏览器的存储隔离，导致 GitHub 登入态带不进来。
 *
 * 命中两类：
 *   - PWA standalone（display-mode: standalone / iOS navigator.standalone）：
 *     独立视窗的 storage 与系统浏览器隔离。
 *   - Electron 桌面殼：同样是独立 session，且視窗內沒有網址欄，在裡面輸入
 *     GitHub 憑證既無法複用瀏覽器既有登入態、使用者也無從確認自己站在哪個站上
 *     （2026-09-17 暴君實測回報）。
 *
 * 兩者的正確解法相同：走跨瀏覽器交接（PwaHandoffPanel + handoff ticket），
 * 授權在使用者真實瀏覽器完成，會話經一次性票據交回本環境。
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneMedia =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  // Electron 殼的 UA 一定帶 "Electron"；nodeIntegration 關閉時 window.process
  // 不可用，故以 UA 為準。
  const isElectronShell = navigator.userAgent.includes("Electron");
  return standaloneMedia || iosStandalone || isElectronShell;
}

export interface HandoffLogin {
  ticket: string;
  loginUrl: string;
}

/** 交接票据可选的登录提供方（服务端 handoff route 的同名白名单）。 */
export type HandoffProvider = "github" | "google";

interface PendingHandoff extends HandoffLogin {
  createdAt: number;
  provider: HandoffProvider;
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
    // 旧记录没有 provider 字段（Google 上线前写的），一律视作 github。
    const provider: HandoffProvider = parsed.provider === "google" ? "google" : "github";
    return { ticket: parsed.ticket, loginUrl: parsed.loginUrl, createdAt: parsed.createdAt, provider };
  } catch {
    return null;
  }
}

function writePendingHandoff(login: HandoffLogin, provider: HandoffProvider): void {
  try {
    const pending: PendingHandoff = { ...login, createdAt: Date.now(), provider };
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
 * 不重复创建新票——但只续接同一 provider 的票，避免点了 Google 却拿到上一张
 * GitHub 票（按钮显示与实际授权路由必须同构）。
 */
export async function createHandoffLogin(
  provider: HandoffProvider = "github",
): Promise<HandoffLogin | null> {
  const pending = readPendingHandoff();
  if (pending && pending.provider === provider) {
    return { ticket: pending.ticket, loginUrl: pending.loginUrl };
  }
  try {
    const res = await fetch(`/api/auth/handoff?action=create&provider=${provider}`, { method: "POST" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success?: boolean;
      ticket?: string;
      loginUrl?: string;
    };
    if (!data?.success || !data.ticket || !data.loginUrl) return null;
    const login = { ticket: data.ticket, loginUrl: data.loginUrl };
    writePendingHandoff(login, provider);
    return login;
  } catch {
    return null;
  }
}
