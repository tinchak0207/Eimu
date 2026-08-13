"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { setStoredToken } from "@/lib/new-api-client";
import type { NewApiUser } from "@/lib/new-api-client";

interface StartResponse {
  success: boolean;
  code?: string;
  state?: string;
ttlSec?: number;
  message?: string;
}

interface PollResponse {
  success: boolean;
  status?: "pending" | "completed";
token?: string;
  user?: NewApiUser;
  message?: string;
}

export default function WechatLoginPage() {
  const [code, setCode] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [phase, setPhase] = useState<"loading" | "waiting" | "done" | "error">("loading");
  const [error, setError] = useState("");
  const [countdown, setCountdown] = useState(600);

  // QR 動態刷新：worker 每 120s 換新 QR，這裡每 60s 重新載入一次 QR 圖，
  // 確保掃碼時永遠是有效的新碼（iLink QR 有效期短）。
  const [qrTs, setQrTs] = useState(() => Date.now());
  const [copyOk, setCopyOk] = useState(false);

  const init = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await fetch("/api/auth/wechat/start", { cache: "no-store" });
      const data = (await res.json()) as StartResponse;
      if (!res.ok || !data.success || !data.code || !data.state) {
        throw new Error(data.message || "获取登录码失败");
      }
      setCode(data.code);
      setState(data.state);
      setCountdown(data.ttlSec ?? 600);
      setPhase("waiting");
    } catch (e) {
      setError(e instanceof Error ? e.message : "获取登录码失败");
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void init();
  }, [init]);

  const notifyDone = useCallback(() => {
    const target = window.location.origin;
    if (window.opener) {
      try {
        window.opener.postMessage({ type: "wechat-auth-complete" }, target);
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      if (window.opener) window.close();
    }, 600);
  }, []);
  useEffect(() => {
    if (phase !== "waiting" || !code || !state) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) return;
      try {
        const qs = "?code=" + encodeURIComponent(code) + "&state=" + encodeURIComponent(state);
        const res = await fetch("/api/auth/wechat/poll" + qs, { cache: "no-store" });
        const data = (await res.json()) as PollResponse;
if (data.success && data.status === "completed" && data.token && data.user) {
          cancelled = true;
          window.clearInterval(timer);
          setStoredToken(data.token, data.user);
          setPhase("done");
          notifyDone();
        } else if (res.status === 410 || data.message === "expired") {
          cancelled = true;
          window.clearInterval(timer);
          setError("登录码已过期，请刷新重新获取。");
          setPhase("error");
        }
      } catch {
        // 网络抖动，下轮重试
      }
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, code, state, notifyDone]);

  useEffect(() => {
    if (phase !== "waiting" || countdown <= 0) return;
    const t = window.setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [phase, countdown]);

  // QR 每 30 秒刷新（worker 120s 換新碼，這裡更頻確保掃到新鮮 QR）
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = window.setInterval(() => setQrTs(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [phase]);

  const mins = Math.floor(countdown / 60);
  const secs = String(countdown % 60).padStart(2, "0");
  const padded = String(secs);
  const displayCode = code ? code.split(/(.{2})/).filter(Boolean).join("  ") : "";

  return (
    <main style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f5f5f7", fontFamily: "-apple-system, PingFang SC, Microsoft YaHei, sans-serif" }}>
      <div style={{ width: 380, maxWidth: "92vw", background: "#fff", borderRadius: 20, padding: 28, boxShadow: "0 12px 40px rgba(0,0,0,0.08)", textAlign: "center" }}>
        <span style={{ background: "#07C160", width: 52, height: 52, margin: "0 auto 12px", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 16 }}>
          <MessageCircle size={26} color="#fff" />
        </span>
        <h1 style={{ fontSize: 18, fontWeight: 600, margin: "0 0 4px" }}>微信登录</h1>
        <p style={{ fontSize: 13, color: "#888", margin: "0 0 20px" }}>把下方登录码发给微信机器人</p>

        {phase === "loading" && <p style={{ fontSize: 14, color: "#888" }}>正在获取登录码…</p>}

{phase === "waiting" && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: 4, color: "#111", padding: "14px 16px", border: "2px dashed #07C160", borderRadius: 16, background: "#f2fbf5" }}>
                {displayCode}
              </div>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(code || "");
                    setCopyOk(true);
                    setTimeout(() => setCopyOk(false), 1500);
                  } catch {
                    const ta = document.createElement("textarea");
                    ta.value = code || "";
                    document.body.appendChild(ta);
                    ta.select();
                    try { document.execCommand("copy"); setCopyOk(true); setTimeout(() => setCopyOk(false), 1500); } catch {}
                    document.body.removeChild(ta);
                  }
                }}
                style={{ padding: "10px 14px", borderRadius: 12, background: copyOk ? "#07C160" : "#eef1f4", color: copyOk ? "#fff" : "#333", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {copyOk ? "已复制 ✓" : "复制"}
              </button>
            </div>
            <p style={{ fontSize: 13, color: "#666", lineHeight: 1.9, margin: "0 0 14px", textAlign: "left" }}>
              <span style={{ fontWeight: 600 }}>1.</span> 手机：<b>长按二维码</b> → 微信「识别图中二维码」<br />
              <span style={{ fontWeight: 600 }}>2.</span> 微信里向机器人<b>粘贴</b>刚复制的验证码，发送即可
            </p>
            <img
              src={"/api/auth/wechat/qr?size=240&t=" + qrTs}
              alt="长按识别二维码"
              width={240}
              height={240}
              style={{ borderRadius: 12, border: "1px solid #eee", margin: "4px auto 8px", display: "block", maxWidth: "100%" }}
            />
            <p style={{ fontSize: 12, color: "#aaa", margin: "6px 0 0" }}>电脑/另一台手机可扫二维码 · {mins}:{padded} 后过期</p>
          </>
        )}

        {phase === "done" && (
          <div style={{ padding: 20 }}>
            <span style={{ fontSize: 40 }}>✔</span>
            <p style={{ fontSize: 15, fontWeight: 600, margin: "8px 0 0" }}>登录成功</p>
            <p style={{ fontSize: 13, color: "#888", margin: "6px 0 0" }}>正在返回…</p>
          </div>
        )}

        {phase === "error" && (
          <div style={{ padding: 16 }}>
            <p style={{ fontSize: 14, color: "#d33" }}>{error || "登录失败"}</p>
            <button onClick={() => { setCode(null); setState(null); setPhase("loading"); window.location.reload(); }} style={{ marginTop: 12, padding: "8px 18px", borderRadius: 10, background: "#007AFF", color: "#fff", border: "none", cursor: "pointer", fontSize: 14 }}>刷新</button>
          </div>
        )}
      </div>
    </main>
  );
}
