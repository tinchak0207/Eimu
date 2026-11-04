"use client";

import { ChevronDown, Github } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface SplitLoginButtonProps {
  onGoogle: () => void;
  onGithub: () => void;
  onWechat: () => void;
  githubBusy?: string | null;
}

/** 微信官方白绿双对话框 + 眼睛圆点 + 尾巴的精简 SVG（内嵌，无外部依赖） */
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
 * Google 官方四色「G」（蓝/绿/黄/红四段 path，viewBox 24）。
 * 蓝弧与按钮底色同色，直接叠蓝底会断线——故垫一层白底圆：G 缩到 65% 置中，
 * 缩放后最外角距圆心 11.03 < 圆半径 11.5，四段全落在白圆内。
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

// 与 Header 同一套扁平语言：不再摆三块品牌色，只留一颗淡彩渐变「登录」胶囊（取 Eimu 输入框描边同款蓝紫），
// 三种方式收进下拉（沿用顶栏其它菜单的 DropdownMenu），品牌色只出现在菜单图标里。
export function SplitLoginButton({ onGoogle, onGithub, onWechat, githubBusy }: SplitLoginButtonProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="登录"
          className="group inline-flex h-9 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[linear-gradient(135deg,#e9f2ff_0%,#f2eaff_100%)] pl-4 pr-3 text-ios-footnote font-semibold text-[rgba(0,0,0,0.78)] ring-1 ring-inset ring-[rgba(120,120,255,0.22)] transition-[box-shadow,transform,color] duration-200 hover:text-black hover:ring-[rgba(120,120,255,0.42)] active:scale-[0.97] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(120,120,255,0.55)] data-[state=open]:ring-[rgba(120,120,255,0.5)]">
          登录
          <ChevronDown
            className="h-3.5 w-3.5 text-[rgba(0,0,0,0.45)] transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={8} className="min-w-[11rem]">
        <DropdownMenuItem onSelect={onWechat} className="cursor-pointer gap-2.5">
          <span className="grid h-4 w-4 place-items-center rounded-full bg-[#07c160]">
            <WechatLogo className="h-2.5 w-2.5" />
          </span>
          微信登录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onGoogle} className="cursor-pointer gap-2.5">
          <GoogleLogo className="h-4 w-4 shrink-0" />
          Google 登录
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onGithub} className="cursor-pointer gap-2.5">
          <Github className="h-4 w-4 shrink-0 text-[#1f2328]" aria-hidden="true" />
          {githubBusy ? "连接中…" : "GitHub 登录"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
