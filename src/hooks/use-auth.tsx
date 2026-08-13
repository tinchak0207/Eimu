"use client";

import { useState, useEffect, useCallback, createContext, useContext } from "react";
import type { NewApiUser } from "@/lib/new-api-client";
import { getStoredToken, getStoredUser, clearStoredToken, setStoredToken, syncStoredAuthFromCookie } from "@/lib/new-api-client";
import { fetchMe, logout as doLogout } from "@/lib/auth-client";
import { shouldBypassAuthForLocalTest } from "@/lib/sub2api";

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
  const localTestMode = shouldBypassAuthForLocalTest(process.env);
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
      setStoredToken(t, result.user);
      setUser(result.user);
      setToken(t);
    } else {
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
        if (result.ok && result.user) { setStoredToken(storedToken, result.user); setUser(result.user); }
        else { clearStoredToken(); setUser(null); setToken(null); }
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
