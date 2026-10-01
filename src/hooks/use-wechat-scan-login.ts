"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setStoredToken, type NewApiUser } from "@/lib/new-api-client";

/**
 * 微信「掃碼即登入」（2026-09-30 暴君裁定：取消驗證碼，檢測到掃碼的用戶直接登入）。
 *
 * 鏈路：/api/auth/wechat/start 簽一個一次性 state，並向 VPS mp-qr-server 換一張
 * 帶參數二維碼（scene=state）→ 使用者用微信掃 → 公眾號推 SCAN/subscribe 事件到
 * /api/auth/wechat/msg，EventKey 就是 state → 伺服器直接開號/登入並標記完成 →
 * 這裡輪詢 /api/auth/wechat/poll 拿到 token 落地。全程不需要使用者打任何字。
 *
 * 輪詢：固定 1.5s，外加「回到這個分頁」即時補一槍——手機上人是切去微信掃完才回來，
 * 背景分頁的計時器會被瀏覽器節流，不補這一槍就要多等好幾秒才看到登入成功。
 *
 * /wechat-login 獨立頁與宣傳片結尾的登入小框共用這一個 hook（同一條鏈，不兩份）。
 */

export type WechatScanPhase = "loading" | "waiting" | "done" | "error";

interface StartResponse {
  success: boolean;
  code?: string;
  state?: string;
  ttlSec?: number;
  mpQrImgUrl?: string | null;
  message?: string;
}

interface PollResponse {
  success: boolean;
  status?: "pending" | "completed" | "expired";
  token?: string;
  user?: NewApiUser;
  message?: string;
}

const POLL_MS = 1500;

export interface WechatScanLogin {
  phase: WechatScanPhase;
  /** 微信帶參數二維碼圖片 URL（mp.weixin.qq.com/cgi-bin/showqrcode）。 */
  qrUrl: string | null;
  error: string;
  /** 二維碼剩餘有效秒數。 */
  secondsLeft: number;
  /** 重新簽一張碼（過期／取碼失敗後）。 */
  retry: () => void;
}

export function useWechatScanLogin(options: {
  /** false 時不取碼、不輪詢（例如小框還沒切到微信那一頁）。 */
  enabled?: boolean;
  /** token 已寫進本機（localStorage + cookie）之後呼叫。 */
  onDone?: () => void;
} = {}): WechatScanLogin {
  const { enabled = true, onDone } = options;
  const [phase, setPhase] = useState<WechatScanPhase>("loading");
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [ticket, setTicket] = useState<{ code: string; state: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 取碼：每次 attempt 變化簽一張新的。
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setPhase("loading");
    setError("");
    setTicket(null);
    setQrUrl(null);
    (async () => {
      try {
        const res = await fetch("/api/auth/wechat/start", { cache: "no-store", credentials: "same-origin" });
        const data = (await res.json()) as StartResponse;
        if (cancelled) return;
        if (!res.ok || !data.success || !data.code || !data.state) {
          throw new Error(data.message || "获取二维码失败");
        }
        if (!data.mpQrImgUrl) throw new Error("微信二维码暂时取不到，请稍后重试");
        setTicket({ code: data.code, state: data.state });
        setQrUrl(data.mpQrImgUrl);
        setSecondsLeft(data.ttlSec ?? 600);
        setPhase("waiting");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "获取二维码失败");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, attempt]);

  // 輪詢登入結果。
  useEffect(() => {
    if (!enabled || phase !== "waiting" || !ticket) return;
    let stopped = false;
    let inFlight = false;
    const qs = `?code=${encodeURIComponent(ticket.code)}&state=${encodeURIComponent(ticket.state)}`;
    const check = async (): Promise<void> => {
      if (stopped || inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/auth/wechat/poll${qs}`, { cache: "no-store", credentials: "same-origin" });
        const data = (await res.json()) as PollResponse;
        if (stopped) return;
        if (data.success && data.status === "completed" && data.token && data.user) {
          stopped = true;
          setStoredToken(data.token, data.user);
          setPhase("done");
          onDoneRef.current?.();
        } else if (res.status === 410 || data.message === "expired" || data.status === "expired") {
          stopped = true;
          setError("二维码已过期，点一下重新获取");
          setPhase("error");
        } else if (res.status === 400 || res.status === 404) {
          // state cookie 丟了（隱私模式/跨分頁）或碼不認得：這張碼已經等不到結果。
          stopped = true;
          setError("登录会话已失效，点一下重新获取");
          setPhase("error");
        }
      } catch {
        // 網路抖動：下一輪再試。
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void check(), POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled, phase, ticket]);

  // 倒數：歸零就當過期（伺服器同樣 10 分鐘 TTL）。
  useEffect(() => {
    if (!enabled || phase !== "waiting") return;
    const timer = window.setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [enabled, phase]);
  useEffect(() => {
    if (phase !== "waiting" || secondsLeft > 0) return;
    setError("二维码已过期，点一下重新获取");
    setPhase("error");
  }, [phase, secondsLeft]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { phase, qrUrl, error, secondsLeft, retry };
}
