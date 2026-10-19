"use client";

import { useCallback, useState } from "react";
import { Github } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useWechatScanLogin } from "@/hooks/use-wechat-scan-login";
import { useGithubLoginHandoff } from "@/hooks/use-github-login-handoff";
import { WechatScanQr } from "@/components/WechatScanQr";
import { PromoHandoffNotice } from "@/components/promo/PromoHandoffNotice";

/**
 * 宣传片结尾送出时，从送出钮上方长出来的登入小对话框（2026-09-27 项目负责人裁定）。
 *
 * 为什么不是全屏弹窗：全屏遮罩把刚播完的结尾画面盖掉＝把人的注意力从「这部片」
 * 挪到「一个登入墙」，还没登入就先把兴致打断（项目负责人原话：「不要遮盖……不然用户
 * 会丧失兴趣」）。所以改成：送出钮先转圈 0.2 秒（＝正在开跑的反馈），然后在钮的
 * 正上方长出这一小格，只遮住牠上面那一小块，画面其余部分（封面、输入框、那句话）
 * 都还在原地。
 *
 * 两条登入链路都是站上现成的（不重写）：
 * ①GitHub＝同窗口跳转 `/api/auth/github/start`；但在 standalone PWA / Electron
 *   桌面壳里登入态带不进来（2026-10-04），改走跨浏览器交接：取得 handoff 连结后
 *   原地换成 PromoHandoffNotice，授权在系统浏览器完成、这里轮询领回会话。跳走前
 *   那句话已写进 sessionStorage，回来落 / 自动补送。
 * ②微信＝小框原地换成扫码二维码（2026-09-30：取消验证码、扫到即登入；不再开
 *   `/wechat-login` 新分页——手机上新分页＝人切去微信扫完回来找不到原页、那句话
 *   也就没人补送）。轮询拿到 token → refresh → 补送。
 * 登入态一翻真，ImagePlayground 的补送 effect 就把那句话送进真会话（这里不重复做）。
 */

interface PromoLoginPopoverProps {
  /** 使用者放弃登入（关掉这格）：上层要清掉待送的那句话。 */
  onDismiss: () => void;
}

/** 微信官方白绿双对话框 + 眼睛圆点 + 尾巴（逐字取自 SplitLoginButton，勿改）。 */
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

export function PromoLoginPopover({ onDismiss }: PromoLoginPopoverProps) {
  const { refresh } = useAuth();
  /** 小框的两页：选登入方式／微信二维码（原地换页，不开新分页）。 */
  const [view, setView] = useState<"choose" | "wechat">("choose");

  /**
   * 登入态落地：刷新即可——待送的那句话由 ImagePlayground 的补送 effect 接手
   * （登入态一翻真就关浮层、开新会话、把那句话送进去）。
   */
  const finish = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const wechat = useWechatScanLogin({ enabled: view === "wechat", onDone: () => void finish() });

  const { handoffUrl, startLogin, closeHandoff } = useGithubLoginHandoff();

  // 稳定引用：交接面的轮询 effect 以 onSuccess 为依赖，若每次 re-render 都给新
  // 函式，effect 会被反覆重建、2 秒轮询永远等不到第一枪（宿主高频 re-render 时
  // 登入就永远续不上）。
  const handleHandoffDone = useCallback(() => {
    void finish();
  }, [finish]);

  return (
    <div
      role="dialog"
      aria-label="登录后开拍"
      onClick={(event) => event.stopPropagation()}
      className="lg-float relative w-[min(336px,calc(100vw-2rem))] rounded-ios-2xl p-4 shadow-[0_18px_44px_rgba(45,49,66,0.22)] animate-in fade-in slide-in-from-bottom-1 duration-150"
    >
      {/* 指向下方送出钮的小尖角：位置＝对话框水平中心，钮在画面正中间那条线上。 */}
      <div className="pointer-events-none absolute -bottom-[6px] left-1/2 h-3 w-3 -translate-x-1/2 rotate-45 rounded-[2px] bg-[inherit] shadow-[3px_3px_8px_rgba(45,49,66,0.10)]" />

      {handoffUrl ? (
        <PromoHandoffNotice
          loginUrl={handoffUrl}
          onSuccess={handleHandoffDone}
          onBack={closeHandoff}
        />
      ) : view === "wechat" ? (
        <>
          <p className="text-ios-subhead font-semibold text-foreground">微信扫码，扫到就开拍</p>
          <div className="mt-3">
            <WechatScanQr login={wechat} size={168} />
          </div>
          <p className="mt-2.5 text-center text-ios-caption1">
            <button
              type="button"
              onClick={() => setView("choose")}
              className="cursor-pointer font-medium text-muted-foreground lg-transition hover:text-foreground"
            >
              换其他方式登录
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="text-ios-subhead font-semibold text-foreground">登录后开拍</p>
          <p className="mt-1 text-ios-caption1 leading-relaxed text-muted-foreground">
            你刚说的那句已经存好了，登录完成就开一个新对话、直接送进产线。
          </p>

          <div className="mt-3 flex flex-col gap-2">
            <button
              type="button"
              onClick={() => void startLogin("github")}
              className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#1f2328] text-ios-footnote font-semibold text-white lg-transition hover:bg-[#16181c] active:scale-[0.99]"
            >
              <Github className="h-[17px] w-[17px]" aria-hidden="true" />
              使用 GitHub 登录
            </button>
            <button
              type="button"
              onClick={() => setView("wechat")}
              className="flex h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-full bg-[#07C160] text-ios-footnote font-semibold text-white lg-transition hover:bg-[#06AD56] active:scale-[0.99]"
            >
              <WechatLogo className="h-[18px] w-[18px]" />
              使用微信登录
            </button>
          </div>

          <p className="mt-2.5 text-center text-ios-caption1 text-muted-foreground">
            <button
              type="button"
              onClick={onDismiss}
              className="cursor-pointer font-medium text-muted-foreground lg-transition hover:text-foreground"
            >
              先不登录
            </button>
          </p>
        </>
      )}
    </div>
  );
}
