"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { setStoredToken, type NewApiUser } from "@/lib/new-api-client";

/**
 * 微信「扫码即登入」（2026-09-30 暴君裁定：取消验证码，检测到扫码的用户直接登入）。
 *
 * 链路：/api/auth/wechat/start 签一个一次性 state，并向 VPS mp-qr-server 换一张
 * 带参数二维码（scene=state）→ 使用者用微信扫 → 公众号推 SCAN/subscribe 事件到
 * /api/auth/wechat/msg，EventKey 就是 state → 伺服器直接开号/登入并标记完成 →
 * 这里轮询 /api/auth/wechat/poll 拿到 token 落地。全程不需要使用者打任何字。
 *
 * 轮询：固定 1.5s，外加「回到这个分页」即时补一枪——手机上人是切去微信扫完才回来，
 * 背景分页的计时器会被浏览器节流，不补这一枪就要多等好几秒才看到登入成功。
 *
 * /wechat-login 独立页与宣传片结尾的登入小框共用这一个 hook（同一条链，不两份）。
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
  /** 微信带参数二维码图片 URL（mp.weixin.qq.com/cgi-bin/showqrcode）。 */
  qrUrl: string | null;
  error: string;
  /** 二维码剩余有效秒数。 */
  secondsLeft: number;
  /** 重新签一张码（过期／取码失败后）。 */
  retry: () => void;
}

export function useWechatScanLogin(options: {
  /** false 时不取码、不轮询（例如小框还没切到微信那一页）。 */
  enabled?: boolean;
  /** token 已写进本机（localStorage + cookie）之后呼叫。 */
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

  // 取码：每次 attempt 变化签一张新的。
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

  // 轮询登入结果。
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
          // state cookie 丢了（隐私模式/跨分页）或码不认得：这张码已经等不到结果。
          stopped = true;
          setError("登录会话已失效，点一下重新获取");
          setPhase("error");
        }
      } catch {
        // 网路抖动：下一轮再试。
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

  // 倒数：归零就当过期（伺服器同样 10 分钟 TTL）。
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
