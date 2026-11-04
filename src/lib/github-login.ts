// PWA standalone 登录辅助：检测「存储与用户常用浏览器隔离」的运行环境 +
// 申请跨浏览器交接票据。纯前端模块，不依赖 React，可在任意组件/工具函数里调用。

/**
 * 该运行环境是否与使用者常用浏览器的存储隔离，导致 GitHub 登入态带不进来。
 *
 * 命中两类：
 *   - PWA standalone（display-mode: standalone / iOS navigator.standalone）：
 *     独立视窗的 storage 与系统浏览器隔离。
 *   - Electron 桌面壳：同样是独立 session，且视窗内没有网址栏，在里面输入
 *     GitHub 凭证既无法复用浏览器既有登入态、使用者也无从确认自己站在哪个站上
 *     （2026-09-17 暴君实测回报）。
 *
 * 两者的正确解法相同：走跨浏览器交接（PwaHandoffPanel + handoff ticket），
 * 授权在使用者真实浏览器完成，会话经一次性票据交回本环境。
 */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  const standaloneMedia =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  return standaloneMedia || iosStandalone || isElectronShell();
}

/**
 * 当前是否为 Electron 桌面壳。壳与 PWA 分流用：两者都算 standalone（登入一律走
 * 跨浏览器交接），但壳的导航政策会把 /api/auth/* 转去系统浏览器，因此取得交接
 * 连结后可再主动跳一次，一次点击就开好授权页。
 *
 * Electron 壳的 UA 一定带 "Electron"；nodeIntegration 关闭时 window.process
 * 不可用，故以 UA 为准。
 */
export function isElectronShell(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
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
  /** PKCE 式 verifier：只留在本设备（localStorage + 内存），领取时随 claim 请求体提交。旧记录没有。 */
  verifier?: string;
}

// localStorage 不可用时的内存兜底（同一页面生命周期内仍能 claim）。
const memoryVerifiers = new Map<string, string>();

function randomVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 取该 ticket 对应的本地 verifier（claim 用）；旧式在途 ticket 没有 → null。 */
export function getHandoffVerifier(ticket: string): string | null {
  const mem = memoryVerifiers.get(ticket);
  if (mem) return mem;
  const pending = readPendingHandoff();
  return pending && pending.ticket === ticket && pending.verifier ? pending.verifier : null;
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
    const verifier = typeof parsed.verifier === "string" && parsed.verifier ? parsed.verifier : undefined;
    return { ticket: parsed.ticket, loginUrl: parsed.loginUrl, createdAt: parsed.createdAt, provider, verifier };
  } catch {
    return null;
  }
}

function writePendingHandoff(login: HandoffLogin, provider: HandoffProvider, verifier: string): void {
  memoryVerifiers.set(login.ticket, verifier);
  try {
    const pending: PendingHandoff = { ...login, createdAt: Date.now(), provider, verifier };
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    // localStorage 不可用（隐私模式等）：登录流程照旧，仅失去续接能力。
  }
}

/** 清除本地 pending 票据（claim 成功或登录完成后调用）。 */
export function clearHandoffLogin(): void {
  memoryVerifiers.clear();
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
    const verifier = randomVerifier();
    const challenge = await sha256Hex(verifier);
    const res = await fetch(`/api/auth/handoff?action=create&provider=${provider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ challenge }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      success?: boolean;
      ticket?: string;
      loginUrl?: string;
    };
    if (!data?.success || !data.ticket || !data.loginUrl) return null;
    const login = { ticket: data.ticket, loginUrl: data.loginUrl };
    writePendingHandoff(login, provider, verifier);
    return login;
  } catch {
    return null;
  }
}
