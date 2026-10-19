"use client";

// 跨浏览器交接的「轮询 → 认领」状态机（2026-09-05 全闭环，2026-10-04 自
// PwaHandoffPanel 逐行抽出为共用 hook）：standalone PWA / Electron 壳在使用者
// 真实浏览器完成授权后，这里以 2s 轮询一次性 ticket，服务端回 delivered 便
// POST claim 领回会话（服务端 Set-Cookie 种登入态），只 finish 一次。

import { useCallback, useEffect, useRef, useState } from "react";
import { clearHandoffLogin } from "@/lib/github-login";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60_000;

function extractTicket(loginUrl: string): string {
  const query = loginUrl.split("?", 2)[1] ?? "";
  return new URLSearchParams(query).get("handoff") ?? "";
}

/**
 * @param loginUrl 交接授权连结（含 handoff ticket）；null 时不轮询、不计逾时。
 * @param onSuccess claim 成功后呼叫一次（呼叫方刷新登入态）。
 */
export function usePwaHandoffClaim(
  loginUrl: string | null,
  onSuccess: () => void,
): { timedOut: boolean; claiming: boolean } {
  const [timedOut, setTimedOut] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const finishedRef = useRef(false);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onSuccess();
  }, [onSuccess]);

  useEffect(() => {
    if (loginUrl === null) return;
    const ticket = extractTicket(loginUrl);
    if (!ticket) {
      setTimedOut(true);
      return;
    }
    const startedAt = Date.now();
    let stopped = false;
    let inFlight = false;

    const poll = window.setInterval(async () => {
      if (stopped || inFlight) return;
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        window.clearInterval(poll);
        setTimedOut(true);
        return;
      }
      inFlight = true;
      try {
        const res = await fetch(`/api/auth/handoff?ticket=${encodeURIComponent(ticket)}`);
        const data = (await res.json()) as { success?: boolean; status?: string };
        if (stopped) return;
        if (data?.success && data.status === "delivered") {
          setClaiming(true);
          const claimRes = await fetch(
            `/api/auth/handoff?action=claim&ticket=${encodeURIComponent(ticket)}`,
            { method: "POST" },
          );
          const claimData = (await claimRes.json()) as { success?: boolean };
          if (!stopped && claimData?.success) {
            window.clearInterval(poll);
            stopped = true;
            // 站点登录态第一优先读 localStorage：claim 只种了 cookie，
            // 这里把 cookie 同步进 localStorage，同步失败也照常 finish
            //（onSuccess 的 refresh 会走通）。动态 import 避免模块环。
            try {
              const { syncStoredAuthFromCookie } = await import("@/lib/new-api-client");
              syncStoredAuthFromCookie();
            } catch {
              // 同步失败不阻断 finish。
            }
            clearHandoffLogin();
            finish();
          } else if (!stopped) {
            setClaiming(false);
          }
        }
      } catch {
        // 网络抖动：下一轮继续。
      } finally {
        inFlight = false;
      }
    }, POLL_INTERVAL_MS);

    return () => {
      stopped = true;
      window.clearInterval(poll);
    };
  }, [loginUrl, finish]);

  return loginUrl === null ? { timedOut: false, claiming: false } : { timedOut, claiming };
}
