"use client";

import { useState, useEffect, useCallback, createContext, useContext } from "react";
import type { NewApiUser } from "@/lib/new-api-client";
import { getStoredToken, getStoredUser, clearStoredToken, setStoredToken, syncStoredAuthFromCookie } from "@/lib/new-api-client";
import { fetchMe, logout as doLogout } from "@/lib/auth-client";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";

interface AuthState {
  user: NewApiUser | null;
  token: string | null;
  isLoading: boolean;
  isLoggedIn: boolean;
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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const localTestMode = LOCAL_TEST_MODE;
  const [user, setUser] = useState<NewApiUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(!localTestMode);

  useEffect(() => {
    if (!localTestMode) return;
    setUser(LOCAL_TEST_AUTH_USER);
    setToken("local-test-token");
    setIsLoading(false);
  }, [localTestMode]);

  const refresh = useCallback(async () => {
    if (localTestMode) return;
    const t = getStoredToken();
    if (!t) { setIsLoading(false); return; }

    const result = await fetchMe(t);
    if (result.ok && result.user) {
      const validToken = result.token ?? t;
      setStoredToken(validToken, result.user);
      setUser(result.user);
      setToken(validToken);
    } else if (!result.transient) {
      // 只有被明確否定（401/憑證壞）才登出；5xx/網路抖動保留登入態，
      // 否則閘道一次打嗝就把用戶踢下線（2026-09-05「偶爾跳未登录」根因）。
      clearStoredToken();
      setUser(null);
      setToken(null);
    }
    setIsLoading(false);
  }, [localTestMode]);

  const setAuth = useCallback((t: string, u: NewApiUser) => {
    if (localTestMode) return;
    setStoredToken(t, u);   // persist to localStorage
    setToken(t);
    setUser(u);
  }, [localTestMode]);

  const logout = useCallback(() => {
    if (localTestMode) return;
    doLogout();
    setUser(null);
    setToken(null);
  }, [localTestMode]);

  useEffect(() => {
    if (localTestMode) return;
    // 水合成功标记：启动自愈脚本据此判断「页面是否真的活了」。
    (window as unknown as { __eimuHydrated?: boolean }).__eimuHydrated = true;
    syncStoredAuthFromCookie();
    // Hydrate from localStorage on mount
    const storedUser = getStoredUser();
    const storedToken = getStoredToken();
    if (storedUser && storedToken) {
      setUser(storedUser);
      setToken(storedToken);
      setIsLoading(false);
      // Refresh in background to get latest quota
      fetchMe(storedToken).then((result) => {
        if (result.ok && result.user) {
          const validToken = result.token ?? storedToken;
          setStoredToken(validToken, result.user);
          setUser(result.user);
          setToken(validToken);
        }
        else if (!result.transient) { clearStoredToken(); setUser(null); setToken(null); }
        // transient：維持 optimistic 登入態，等下一次 refresh/操作再校驗。
      });
    } else {
      setIsLoading(false);
    }
  }, [localTestMode]);

  return (
    <AuthContext.Provider value={{
      user, token, isLoading,
      isLoggedIn: !!user && !!token,
      refresh, logout, setAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
