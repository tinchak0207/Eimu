"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { DirectorMiniViewport } from "@/components/director-mini/DirectorMiniViewport";
import { authHeaders } from "@/lib/canvas/client";

const POLL_MS = 3000;

/** 轮询导演场景 revision：agent 在聊天里改场景，这一页跟着刷新。 */
function useDirectorRevision(sessionId: string): { revision: number; status: "loading" | "ok" | "auth" | "error" } {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<"loading" | "ok" | "auth" | "error">("loading");
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const headers = authHeaders();
      if (!headers) {
        if (!stopped) setStatus("auth");
        return;
      }
      try {
        const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/director/state`, { cache: "no-store", headers });
        if (!resp.ok) throw new Error(String(resp.status));
        const json = (await resp.json()) as { revision?: number; project?: { revision?: number } };
        const rev = json.revision ?? json.project?.revision;
        if (!stopped) {
          setStatus("ok");
          if (typeof rev === "number") setRevision((prev) => (prev === rev ? prev : rev));
        }
      } catch {
        if (!stopped) setStatus((s) => (s === "ok" ? "ok" : "error"));
      }
      if (!stopped) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);
  return { revision, status };
}

export function DirectorStageClient({ sessionId }: { sessionId: string }) {
  const { revision, status } = useDirectorRevision(sessionId);
  return (
    <main className="flex h-[100dvh] w-full flex-col bg-[#0b0f14] text-white">
      <header className="flex min-h-[52px] items-center gap-3 border-b border-white/10 px-3">
        <Link
          href="/"
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-white/80 hover:bg-white/10"
          aria-label="返回"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Link>
        <h1 className="text-[16px] font-semibold">导演台</h1>
        <span className="ml-auto text-[13px] tabular-nums text-white/50">
          {status === "auth" ? "请先登录" : status === "error" ? "场景读取失败，重试中" : `rev ${revision}`}
        </span>
      </header>
      <div className="relative min-h-0 flex-1">
        {status === "auth" ? (
          <div className="flex h-full items-center justify-center text-[14px] text-white/60">请先登录后打开导演台</div>
        ) : (
          <DirectorMiniViewport sessionId={sessionId} revision={revision} className="h-full w-full !rounded-none" />
        )}
      </div>
    </main>
  );
}
