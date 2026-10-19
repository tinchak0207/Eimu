"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Loader2, LogIn } from "lucide-react";

export function AdminLogin() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const result = await response.json() as { success?: boolean; message?: string };
      if (!response.ok) throw new Error(result.message || "登录失败。");
      router.refresh();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "登录失败。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f4f5f7] px-4 py-16">
      <form onSubmit={submit} className="w-full max-w-[380px] rounded-lg border border-black/10 bg-white p-6 shadow-[0_18px_60px_rgba(31,35,48,0.10)]">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#20242c] text-white">
            <KeyRound className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-[#20242c]">管理员登录</h1>
            <p className="text-xs text-black/45">eimu.dev</p>
          </div>
        </div>
        <label className="mb-4 block text-sm font-medium text-[#30343b]">
          账号
          <input
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className="mt-2 w-full rounded-md border border-black/10 bg-[#f4f5f7] px-3 py-2.5 outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/15"
          />
        </label>
        <label className="mb-5 block text-sm font-medium text-[#30343b]">
          密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-2 w-full rounded-md border border-black/10 bg-[#f4f5f7] px-3 py-2.5 outline-none focus:border-[#2878d0] focus:ring-2 focus:ring-[#2878d0]/15"
          />
        </label>
        {error && <p role="alert" className="mb-4 rounded-md bg-[#fff0ef] px-3 py-2 text-sm text-[#b42318]">{error}</p>}
        <button
          type="submit"
          disabled={loading || !username || !password}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-[#20242c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#303640] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          登录
        </button>
      </form>
    </main>
  );
}
