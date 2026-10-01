"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, RotateCw } from "lucide-react";
import type { WechatScanLogin } from "@/hooks/use-wechat-scan-login";

/**
 * 微信掃碼即登入的二維碼面（/wechat-login 頁與宣傳片結尾登入小框共用）。
 * 不再有驗證碼：掃到就登入（2026-09-30 暴君裁定）。
 *
 * 提示語按「人手上是什麼」分三種——同一支手機沒法用微信掃自己螢幕上的碼：
 * - 微信內建瀏覽器：長按二維碼 → 識別圖中二維碼（微信原生支援）；
 * - 其他手機瀏覽器：長按存圖 → 微信扫一扫 → 右上角相冊選它；
 * - 電腦：手機微信掃一掃。
 */

type Device = "wechat" | "mobile" | "desktop";

function detectDevice(): Device {
  if (typeof window === "undefined") return "desktop";
  if (/micromessenger/i.test(navigator.userAgent)) return "wechat";
  if (window.matchMedia("(pointer: coarse)").matches) return "mobile";
  return "desktop";
}

const HINTS: Record<Device, string> = {
  wechat: "长按二维码，选「识别图中二维码」即登录",
  mobile: "长按二维码保存到相册，打开微信「扫一扫」→ 右上角相册选它，扫到即登录",
  desktop: "打开手机微信「扫一扫」，扫到即登录",
};

export function WechatScanQr({ login, size = 200 }: { login: WechatScanLogin; size?: number }) {
  const [device, setDevice] = useState<Device>("desktop");
  useEffect(() => setDevice(detectDevice()), []);
  const { phase, qrUrl, error, secondsLeft, retry } = login;
  const mins = Math.floor(secondsLeft / 60);
  const secs = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="flex flex-col items-center text-center">
      <div
        className="relative grid place-items-center overflow-hidden rounded-ios-lg border border-black/[0.06] bg-white"
        style={{ width: size, height: size }}
      >
        {phase === "waiting" && qrUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- 微信 showqrcode 外鏈圖，長按要能存圖/識別
          <img src={qrUrl} alt="微信扫码登录二维码" width={size} height={size} className="h-full w-full" />
        ) : phase === "done" ? (
          <div className="flex flex-col items-center gap-2 text-[#07C160]">
            <Check className="h-10 w-10" strokeWidth={2.4} aria-hidden="true" />
            <span className="text-[14px] font-semibold text-foreground">登录成功</span>
          </div>
        ) : phase === "error" ? (
          <button
            type="button"
            onClick={retry}
            className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 px-4 text-[13px] text-muted-foreground lg-transition hover:text-foreground"
          >
            <RotateCw className="h-6 w-6" aria-hidden="true" />
            <span>{error || "获取二维码失败，点一下重试"}</span>
          </button>
        ) : (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        )}
      </div>
      <p className="mt-2.5 text-[13px] leading-relaxed text-foreground/75">
        {phase === "done" ? "正在进入…" : HINTS[device]}
      </p>
      {phase === "waiting" && (
        <p className="mt-1 text-[12px] tabular-nums text-muted-foreground">
          {mins}:{secs} 后过期
        </p>
      )}
    </div>
  );
}
