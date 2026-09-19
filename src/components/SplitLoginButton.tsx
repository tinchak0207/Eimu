"use client";

import { useState } from "react";
import { Github } from "lucide-react";
import { cn } from "@/lib/utils";

interface SplitLoginButtonProps {
  onGoogle: () => void;
  onGithub: () => void;
  onWechat: () => void;
  githubBusy?: string | null;
}

/** 微信官方白綠雙對話框 + 眼睛圓點 + 尾巴的精簡 SVG（內嵌，無外部依賴） */
function WechatLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M9.5 3C5.91 3 3 5.58 3 8.75c0 1.76.88 3.33 2.26 4.38L4.75 15l2.3-1.05A7.28 7.28 0 0 0 9.5 14.5c.26 0 .52-.01.77-.04A5.12 5.12 0 0 1 10 12.5c0-2.9 2.69-5.25 6-5.25.2 0 .4.01.59.03C15.9 5.24 12.97 3 9.5 3Z"
        fill="white"
      />
      <circle cx="7.75" cy="8.5" r="0.85" fill="#07C160" />
      <circle cx="11.25" cy="8.5" r="0.85" fill="#07C160" />
      <path
        d="M16 8.5c-3.03 0-5.5 2.02-5.5 4.5s2.47 4.5 5.5 4.5c.6 0 1.17-.08 1.7-.23L20 18.5l-.9-1.98A4.22 4.22 0 0 0 21.5 13c0-2.48-2.47-4.5-5.5-4.5Z"
        fill="white"
      />
      <circle cx="14.5" cy="13" r="0.75" fill="#07C160" />
      <circle cx="17.5" cy="13" r="0.75" fill="#07C160" />
    </svg>
  );
}

/**
 * Google 官方四色「G」（藍/綠/黃/紅四段 path，viewBox 24）。
 * 藍弧與按鈕底色同色，直接疊藍底會斷線——故墊一層白底圓：G 縮到 65% 置中，
 * 縮放後最外角距圓心 11.03 < 圓半徑 11.5，四段全落在白圓內。
 */
function GoogleLogo({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="11.5" fill="#ffffff" />
      <g transform="translate(4.2 4.2) scale(0.65)">
        <path
          fill="#4285F4"
          d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
        />
        <path
          fill="#34A853"
          d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24Z"
        />
        <path
          fill="#FBBC05"
          d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09Z"
        />
        <path
          fill="#EA4335"
          d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09c.95-2.85 3.6-4.96 6.73-4.96Z"
        />
      </g>
    </svg>
  );
}

const DIAGONAL = 12;

// 三段斜切（Google → GitHub → 微信）：每段在「自己的框」內斜切，相鄰兩段的
// 公共邊必須是同一條斜線——段 N 的右邊界（底 100%-12px）與段 N+1 的左邊界
// （底 -12px）在容器座標裡逐點重合，否則交界處會露出一道透明楔形缺口。
export function SplitLoginButton({ onGoogle, onGithub, onWechat, githubBusy }: SplitLoginButtonProps) {
  const [hover, setHover] = useState<"google" | "github" | "wechat" | null>(null);

  return (
    <div
      className="relative isolate h-10 w-[196px] overflow-hidden rounded-full shadow-[0_4px_14px_rgba(0,0,0,0.16)] sm:w-[330px]"
      onMouseLeave={() => setHover(null)}
    >
      <button
        type="button"
        onClick={onGoogle}
        onMouseEnter={() => setHover("google")}
        aria-label="使用 Google 登录"
        className={cn(
          "absolute inset-y-0 left-0 z-0 flex w-[33.333%] items-center justify-center gap-1.5 text-[13px] font-semibold text-white",
          "transition-colors duration-200",
          "focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset",
          hover === "google" ? "bg-[#3367D6]" : "bg-[#4285F4]",
        )}
        style={{
          clipPath: `polygon(0 0, calc(100% + ${DIAGONAL}px) 0, calc(100% - ${DIAGONAL}px) 100%, 0 100%)`,
        }}
      >
        <GoogleLogo className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">Google</span>
      </button>

      <button
        type="button"
        onClick={onGithub}
        onMouseEnter={() => setHover("github")}
        aria-label="使用 GitHub 登录"
        className={cn(
          "absolute inset-y-0 left-[33.333%] z-10 flex w-[33.333%] items-center justify-center gap-1.5 text-[13px] font-semibold text-white",
          "transition-colors duration-200",
          "focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset",
          hover === "github" ? "bg-[#16181c]" : "bg-[#1f2328]",
        )}
        style={{
          clipPath: `polygon(${DIAGONAL}px 0, calc(100% + ${DIAGONAL}px) 0, calc(100% - ${DIAGONAL}px) 100%, -${DIAGONAL}px 100%)`,
        }}
      >
        <Github className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="hidden sm:inline">{githubBusy ? "连接中…" : "GitHub"}</span>
      </button>

      <button
        type="button"
        onClick={onWechat}
        onMouseEnter={() => setHover("wechat")}
        aria-label="使用微信登录"
        className={cn(
          "absolute inset-y-0 left-[66.667%] z-20 flex w-[33.333%] items-center justify-center gap-1.5 text-[13px] font-semibold text-white",
          "transition-colors duration-200",
          "focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset",
          hover === "wechat" ? "bg-[#06ad56]" : "bg-[#07c160]",
        )}
        style={{
          clipPath: `polygon(${DIAGONAL}px 0, 100% 0, 100% 100%, -${DIAGONAL}px 100%)`,
        }}
      >
        <WechatLogo className="h-4 w-4 shrink-0" />
        <span className="hidden sm:inline">微信</span>
      </button>
    </div>
  );
}
