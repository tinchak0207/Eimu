"use client";

import { useState, useEffect, useCallback, useRef, createContext, useContext } from "react";
import type { NewApiUser } from "@/lib/new-api-client";
import { getStoredToken, getStoredUser, clearStoredToken, setStoredToken, syncStoredAuthFromCookie } from "@/lib/new-api-client";
import { fetchMe, logout as doLogout } from "@/lib/auth-client";
import type { WelcomeGiftModal } from "@/lib/welcome-gift-modal";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { bindCreativeProjectsAuth } from "@/hooks/use-creative-projects";

interface AuthState {
  user: NewApiUser | null;
  token: string | null;
  isLoading: boolean;
  isLoggedIn: boolean;
  /**
   * 新人礼首登弹窗：非空＝服务端（/api/auth/me 的加法栏位）说「已发放、未展示」。
   * 只由**本轮新拉的 /api/auth/me** 写入，不从 localStorage 快照复活——这样
   * 「只弹一次」的权威在服务端（modal_seen_at），本机快照脏了也不会旧弹。
   */
  welcomeGift: WelcomeGiftModal | null;
  /** 弹窗已处理（展示过／按下任一按钮）：本机清掉，等服务端回执把状态一并改掉。 */
  clearWelcomeGift: () => void;
  refresh: () => Promise<void>;
  logout: () => void;
  setAuth: (token: string, user: NewApiUser) => void;
}

const AuthContext = createContext<AuthState | null>(null);

const LOCAL_TEST_AUTH_USER: NewApiUser = {
  id: 0,
  username: "local-test",
  display_name: "Local Test",
  email: "local@test",
  quota: 999_999_999,
  used_quota: 0,
};

export default function AuthProvider({ children }: { children: React.ReactNode }) {
  const localTestMode = LOCAL_TEST_MODE;
  const [user, setUser] = useState<NewApiUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!localTestMode);
  const [welcomeGift, setWelcomeGift] = useState<WelcomeGiftModal | null>(null);
  const clearWelcomeGift = useCallback(() => setWelcomeGift(null), []);
  const authEpochRef = useRef(0);

  useEffect(() => {
    // 生产构建下条件被 SWC 对 process.env.NODE_ENV 的常量折叠＋DCE 整块剔除，
    // 「local-test-token」字面量因而不进产物（红队 2026-10-05 要求）；
    // 本机 dev（NODE_ENV=development）行为不变。
    if (process.env.NODE_ENV !== "production" && localTestMode) {
      setUser(LOCAL_TEST_AUTH_USER);
      setToken("local-test-token");
      setIsLoading(false);
    }
  }, [localTestMode]);

  const refresh = useCallback(async () => {
    if (localTestMode) return;
    const t = getStoredToken();
    const epoch = ++authEpochRef.current;
    if (!t) { setUser(null); setToken(null); setWelcomeGift(null); setIsLoading(false); return; }

    const result = await fetchMe(t);
    if (epoch !== authEpochRef.current || getStoredToken() !== t) return;
    if (result.ok && result.user) {
      const validToken = result.token ?? t;
      setStoredToken(validToken, result.user);
      setUser(result.user);
      setToken(validToken);
      // 只在服务端说「待展示」时上膛；已经上膛的不因后续 refresh 的 no-pending 而缩回去
      // （弹窗开著时被背景 refresh 收掉＝话说到一半自己消失）。
      if (result.welcomeGift) setWelcomeGift(result.welcomeGift);
    } else if (!result.transient) {
      // 只有被明确否定（401/凭证坏）才登出；5xx/网路抖动保留登入态，
      // 否则闸道一次打嗝就把用户踢下线（2026-09-05「偶尔跳未登录」根因）。
      clearStoredToken();
      setUser(null);
      setToken(null);
      setWelcomeGift(null);
    }
    setIsLoading(false);
  }, [localTestMode]);

  const setAuth = useCallback((t: string, u: NewApiUser) => {
    if (localTestMode) return;
    authEpochRef.current += 1;
    setStoredToken(t, u);   // persist to localStorage
    setToken(t);
    setUser(u);
    setWelcomeGift(null);
    setIsLoading(false);
  }, [localTestMode]);

  const logout = useCallback(() => {
    if (localTestMode) return;
    authEpochRef.current += 1;
    doLogout();
    setUser(null);
    setToken(null);
    setWelcomeGift(null);
  }, [localTestMode]);

  useEffect(() => {
    if (isLoading) return;
    bindCreativeProjectsAuth(user ? String(user.id) : null, token);
  }, [isLoading, token, user]);

  useEffect(() => {
    // 水合成功标记：启动自愈脚本据此判断「页面是否真的活了」。
    // 必须在 localTestMode 早退之前写（2026-10-01）：原本本地测试模式永远不写，每次进页 6 秒后被自愈脚本强制刷新。
    (window as unknown as { __eimuHydrated?: boolean }).__eimuHydrated = true;
    if (localTestMode) return;
    syncStoredAuthFromCookie();
    // Hydrate from localStorage on mount
    const storedUser = getStoredUser();
    const storedToken = getStoredToken();
    const epoch = ++authEpochRef.current;
    if (storedUser && storedToken) {
      setUser(storedUser);
      setToken(storedToken);
      setIsLoading(false);
      // Refresh in background to get latest quota
      fetchMe(storedToken).then((result) => {
        if (epoch !== authEpochRef.current || getStoredToken() !== storedToken) return;
        if (result.ok && result.user) {
          const validToken = result.token ?? storedToken;
          setStoredToken(validToken, result.user);
          setUser(result.user);
          setToken(validToken);
          if (result.welcomeGift) setWelcomeGift(result.welcomeGift);
        }
        else if (!result.transient) { clearStoredToken(); setUser(null); setToken(null); setWelcomeGift(null); }
        // transient：维持 optimistic 登入态，等下一次 refresh/操作再校验。
      });
    } else {
      setIsLoading(false);
    }
    // 其他标签页登录/退出时，以该标签页当前凭证重取身份，作废本页旧请求。
    const onStorage = (event: StorageEvent): void => {
      if (event.key !== "napi_token" && event.key !== "napi_user" && event.key !== null) return;
      authEpochRef.current += 1;
      const nextToken = getStoredToken();
      const nextUser = getStoredUser();
      setToken(nextToken);
      setUser(nextToken ? nextUser : null);
      setWelcomeGift(null);
      void refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      authEpochRef.current += 1;
      window.removeEventListener("storage", onStorage);
    };
  }, [localTestMode, refresh]);

  return (
    <AuthContext.Provider value={{
      user, token, isLoading,
      isLoggedIn: !!user && !!token,
      welcomeGift, clearWelcomeGift,
      refresh, logout, setAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在登录上下文中使用");
  return ctx;
}
