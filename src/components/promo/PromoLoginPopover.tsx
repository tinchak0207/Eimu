"use client";

import { useCallback, useState } from "react";
import { Github } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useWechatScanLogin } from "@/hooks/use-wechat-scan-login";
import { useGithubLoginHandoff } from "@/hooks/use-github-login-handoff";
import { WechatScanQr } from "@/components/WechatScanQr";
import { PromoHandoffNotice } from "@/components/promo/PromoHandoffNotice";

/**
 * 宣傳片結尾送出時，從送出鈕上方長出來的登入小對話框（2026-09-27 暴君裁定）。
 *
 * 為什麼不是全屏彈窗：全屏遮罩把剛播完的結尾畫面蓋掉＝把人的注意力從「這部片」
 * 挪到「一個登入牆」，還沒登入就先把興致打斷（暴君原話：「不要遮盖……不然用户
 * 会丧失兴趣」）。所以改成：送出鈕先轉圈 0.2 秒（＝正在開跑的反饋），然後在鈕的
 * 正上方長出這一小格，只遮住牠上面那一小塊，畫面其餘部分（封面、輸入框、那句話）
 * 都還在原地。
 *
 * 兩條登入鏈路都是站上現成的（不重寫）：
 * ①GitHub＝同窗口跳轉 `/api/auth/github/start`；但在 standalone PWA / Electron
 *   桌面殼裡登入態帶不進來（2026-10-04），改走跨瀏覽器交接：取得 handoff 連結後
 *   原地換成 PromoHandoffNotice，授權在系統瀏覽器完成、這裡輪詢領回會話。跳走前
 *   那句話已寫進 sessionStorage，回來落 / 自動補送。
 * ②微信＝小框原地換成掃碼二維碼（2026-09-30：取消驗證碼、掃到即登入；不再開
 *   `/wechat-login` 新分頁——手機上新分頁＝人切去微信掃完回來找不到原頁、那句話
 *   也就沒人補送）。輪詢拿到 token → refresh → 補送。
 * 登入態一翻真，ImagePlayground 的補送 effect 就把那句話送進真會話（這裡不重複做）。
 */

interface PromoLoginPopoverProps {
  /** 使用者放棄登入（關掉這格）：上層要清掉待送的那句話。 */
  onDismiss: () => void;
}

/** 微信官方白綠雙對話框 + 眼睛圓點 + 尾巴（逐字取自 SplitLoginButton，勿改）。 */
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
  /** 小框的兩頁：選登入方式／微信二維碼（原地換頁，不開新分頁）。 */
  const [view, setView] = useState<"choose" | "wechat">("choose");

  /**
   * 登入態落地：刷新即可——待送的那句話由 ImagePlayground 的補送 effect 接手
   * （登入態一翻真就關浮層、開新會話、把那句話送進去）。
   */
  const finish = useCallback(async () => {
    await refresh();
  }, [refresh]);

  const wechat = useWechatScanLogin({ enabled: view === "wechat", onDone: () => void finish() });

  const { handoffUrl, startLogin, closeHandoff } = useGithubLoginHandoff();

  // 穩定引用：交接面的輪詢 effect 以 onSuccess 為依賴，若每次 re-render 都給新
  // 函式，effect 會被反覆重建、2 秒輪詢永遠等不到第一槍（宿主高頻 re-render 時
  // 登入就永遠續不上）。
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
      {/* 指向下方送出鈕的小尖角：位置＝對話框水平中心，鈕在畫面正中間那條線上。 */}
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
