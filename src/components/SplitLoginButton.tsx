"use client";

import { useState } from "react";
import { Github } from "lucide-react";
import { cn } from "@/lib/utils";

interface SplitLoginButtonProps {
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

const DIAGONAL = 12;

export function SplitLoginButton({ onGithub, onWechat, githubBusy }: SplitLoginButtonProps) {
  const [hover, setHover] = useState<"github" | "wechat" | null>(null);

  return (
    <div
      className="relative isolate h-10 w-[228px] overflow-hidden rounded-full shadow-[0_4px_14px_rgba(0,0,0,0.16)]"
      onMouseLeave={() => setHover(null)}
    >
      <button
        type="button"
        onClick={onGithub}
        onMouseEnter={() => setHover("github")}
        aria-label="使用 GitHub 登录"
        className={cn(
          "absolute inset-0 z-0 flex items-center justify-start gap-1.5 pl-3.5 pr-[46%] text-[13px] font-semibold text-white",
          "transition-colors duration-200",
          "focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset",
          hover === "github" ? "bg-[#16181c]" : "bg-[#1f2328]",
        )}
        style={{
          clipPath: `polygon(0 0, calc(50% + ${DIAGONAL}px) 0, calc(50% - ${DIAGONAL}px) 100%, 0 100%)`,
        }}
      >
        <Github className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{githubBusy ? "连接中…" : "GitHub"}</span>
      </button>

      <button
        type="button"
        onClick={onWechat}
        onMouseEnter={() => setHover("wechat")}
        aria-label="使用微信登录"
        className={cn(
          "absolute inset-0 z-10 flex items-center justify-end gap-1.5 pl-[46%] pr-3.5 text-[13px] font-semibold text-white",
          "transition-colors duration-200",
          "focus-visible:z-20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-inset",
          hover === "wechat" ? "bg-[#06ad56]" : "bg-[#07c160]",
        )}
        style={{
          clipPath: `polygon(calc(50% + ${DIAGONAL}px) 0, 100% 0, 100% 100%, calc(50% - ${DIAGONAL}px) 100%)`,
        }}
      >
        <WechatLogo className="h-4 w-4 shrink-0" />
        <span className="truncate">微信</span>
      </button>
    </div>
  );
}
