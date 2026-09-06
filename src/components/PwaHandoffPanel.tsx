"use client";

// PWA standalone GitHub 登录交接面板：在常用浏览器完成授权，本面板轮询
// 一次性 ticket，delivered 后 claim 领回会话（服务端 Set-Cookie 种登录态）。
// 仅 standalone PWA 内由登录入口触发，不影响普通浏览器登录链路。

import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { clearHandoffLogin } from "@/lib/github-login";

interface PwaHandoffPanelProps {
  loginUrl: string;
  onSuccess: () => void;
  onClose: () => void;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 10 * 60_000;

function extractTicket(loginUrl: string): string {
  const query = loginUrl.split("?", 2)[1] ?? "";
  return new URLSearchParams(query).get("handoff") ?? "";
}

export function PwaHandoffPanel({ loginUrl, onSuccess, onClose }: PwaHandoffPanelProps) {
  const { toast } = useToast();
  const [timedOut, setTimedOut] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const finishedRef = useRef(false);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onSuccess();
  }, [onSuccess]);

  useEffect(() => {
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

  const handleCopy = async () => {
    try {
      const full = loginUrl.startsWith("http") ? loginUrl : `${window.location.origin}${loginUrl}`;
      await navigator.clipboard.writeText(full);
      toast({ title: "已复制，去常用浏览器粘贴打开" });
    } catch {
      toast({ title: "复制失败，请重试" });
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-black/5 bg-white/95 p-5 shadow-2xl backdrop-blur-xl">
        <h2 className="text-[17px] font-semibold text-[rgba(0,0,0,0.85)]">登录</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-[rgba(0,0,0,0.6)]">
          复制链接到常用浏览器完成登录，回来后自动登录。
        </p>
        <button
          type="button"
          onClick={handleCopy}
          className="mt-3 text-[13px] font-medium text-ios-blue active:opacity-70"
        >
          复制链接
        </button>

        {timedOut ? (
          <p className="mt-4 text-[13px] font-medium text-ios-red">超时，请重试</p>
        ) : claiming ? (
          <p className="mt-4 text-[13px] text-[rgba(0,0,0,0.6)]">正在登录…</p>
        ) : null}

        <div className="mt-4 flex items-center gap-3">
          <a
            href={loginUrl}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-xl bg-[rgba(0,0,0,0.85)] px-4 py-2.5 text-center text-[14px] font-semibold text-white active:opacity-80"
          >
            去浏览器打开
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-black/[0.06] px-4 py-2.5 text-[14px] font-medium text-[rgba(0,0,0,0.72)] active:opacity-70"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
