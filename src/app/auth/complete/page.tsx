"use client";

import { useEffect, useState } from "react";

type Phase = "verifying" | "ok" | "fail";

export default function AuthCompletePage() {
  // PWA handoff：常用浏览器完成授权后回调带 ?handoff=1 落在这里。
  // 会话已经由 callback 种进本浏览器 cookie，这里只提示用户返回 App，
  // 不自动跳首页（跳走会把提示冲掉）。
  const [handoff, setHandoff] = useState(false);
  // 非 handoff（PC 同窗口流程）：跳回主页前先验证登录态——验证不过就
  // 原地把原因写出来，不让用户「回到首页还是未登录」却查无对证。
  const [phase, setPhase] = useState<Phase>("verifying");
  const [diagnostic, setDiagnostic] = useState("");

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("handoff") === "1") {
      setHandoff(true);
      return;
    }
    const target = window.location.origin;
    if (window.opener) {
      // 登入发生在 popup 内：通知开启它的主页（已带 napi cookie），然后自己关闭。
      try {
        window.opener.postMessage({ type: "github-auth-complete" }, target);
      } catch {
        // opener 已不可达，忽略——主页会在下一次导航时自然拿到登入态。
      }
      window.close();
      return;
    }
    // 整页跳转的登入：先验证会话真的可用，再回首页。
    (async () => {
      try {
        // 服务端种的 cookie 是 encodeURIComponent 编码值（token 含 +/=），
        // 必须先 decode 再当 Bearer——拿编码值去校验必然 401→反查 miss→502。
        const token = decodeURIComponent(
          document.cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("napi_token="))
            ?.slice(11) ?? "",
        );
        if (!token) {
          setPhase("fail");
          setDiagnostic("回调没有种上登录 cookie（浏览器拒绝了 Set-Cookie）");
          return;
        }
        const res = await fetch("/api/auth/me", { headers: { Authorization: `Bearer ${token}` } });
        const body = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: { display_name?: string; username?: string } } | null;
        if (res.ok && body?.success && body.data) {
          // cookie 同步进 localStorage（主页挂载首请求即用同一会话），再回首页。
          localStorage.setItem("napi_token", token);
          localStorage.setItem("napi_user", JSON.stringify(body.data));
          setPhase("ok");
          window.setTimeout(() => window.location.replace("/"), 400);
          return;
        }
        setPhase("fail");
        setDiagnostic(`登录校验失败：HTTP ${res.status}，${body?.message ?? "无错误信息"}，token 指纹 ${token.slice(0, 8)}…`);
      } catch (e) {
        setPhase("fail");
        setDiagnostic(`校验请求异常：${String(e)}`);
      }
    })();
  }, []);

  if (handoff) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-[15px] leading-relaxed text-[rgba(0,0,0,0.75)]">
          已交接给 App，可返回 App 查看登录状态
        </p>
      </div>
    );
  }
  if (phase === "verifying") {
    return (
      <div className="flex min-h-dvh items-center justify-center px-4">
        <p className="text-[15px] leading-relaxed text-[rgba(0,0,0,0.6)]">正在确认登录…</p>
      </div>
    );
  }
  if (phase === "fail") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 px-4">
        <p className="text-[15px] font-semibold text-[rgba(0,0,0,0.85)]">登录没有完成</p>
        <p className="max-w-md text-[13px] leading-relaxed text-ios-red">{diagnostic}</p>
        <button
          type="button"
          onClick={() => { window.location.href = "/api/auth/github/start"; }}
          className="mt-1 rounded-xl bg-[rgba(0,0,0,0.85)] px-4 py-2.5 text-ios-footnote font-semibold text-white active:opacity-80"
        >
          重试登录
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <p className="text-[15px] leading-relaxed text-[rgba(0,0,0,0.75)]">登录成功，正在进入…</p>
    </div>
  );
}
