"use client";

// 宣传片结尾登入小框里的交接面（2026-10-04）：Electron 桌面壳 / standalone PWA
// 里点「使用 GitHub 登录」后，在同一个 popover 内原地显示这一格——授权在系统
// 浏览器完成，这里轮询一次性 ticket 自动续接。刻意不是全屏遮罩（沿用 popover
// 语汇，只占小框那一格，结尾画面其余部分仍在原地）。

import { isElectronShell } from "@/lib/github-login";
import { useToast } from "@/hooks/use-toast";
import { usePwaHandoffClaim } from "@/hooks/use-pwa-handoff-claim";

interface PromoHandoffNoticeProps {
  /** 交接授权连结（含 handoff ticket）。 */
  loginUrl: string;
  /** claim 成功后呼叫一次（呼叫方刷新登入态 → 补送那句话）。 */
  onSuccess: () => void;
  /** 退回登入方式选择页。 */
  onBack: () => void;
}

export function PromoHandoffNotice({ loginUrl, onSuccess, onBack }: PromoHandoffNoticeProps) {
  const { toast } = useToast();
  const { timedOut, claiming } = usePwaHandoffClaim(loginUrl, onSuccess);
  // 壳的导航政策会替我们把授权页开去系统浏览器；standalone PWA 不会，文案不能说谎。
  const shellOpenedBrowser = isElectronShell();

  const handleCopy = async () => {
    try {
      const full = loginUrl.startsWith("http") ? loginUrl : `${window.location.origin}${loginUrl}`;
      await navigator.clipboard.writeText(full);
      toast({ title: "已复制，去浏览器粘贴打开" });
    } catch {
      toast({ title: "复制失败，请重试" });
    }
  };

  return (
    <div className="flex flex-col">
      <p className="text-ios-subhead font-semibold text-foreground">在浏览器完成登录</p>
      <p className="mt-1 text-ios-caption1 leading-relaxed text-muted-foreground">
        {shellOpenedBrowser
          ? "已在新窗口打开 GitHub 授权页。登录完成后这里会自动继续，你那句话直接送进产线。"
          : "点下面的按钮去浏览器完成授权，完成后这里会自动继续；你那句话直接送进产线。"}
      </p>

      {timedOut ? (
        <p className="mt-2.5 text-ios-caption1 font-medium text-ios-red">超时，请重试</p>
      ) : claiming ? (
        <p className="mt-2.5 text-ios-caption1 text-muted-foreground">正在登录…</p>
      ) : null}

      <div className="mt-3 flex flex-col gap-2">
        <a
          href={loginUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-10 w-full items-center justify-center gap-2 rounded-full bg-[#1f2328] text-ios-footnote font-semibold text-white lg-transition hover:bg-[#16181c] active:scale-[0.99]"
        >
          去浏览器打开
        </a>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex h-10 w-full cursor-pointer items-center justify-center rounded-full bg-black/[0.06] text-ios-footnote font-medium text-foreground lg-transition hover:bg-black/[0.1] active:scale-[0.99]"
        >
          复制链接
        </button>
      </div>

      <p className="mt-2.5 text-center text-ios-caption1 text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer font-medium text-muted-foreground lg-transition hover:text-foreground"
        >
          换其他方式登录
        </button>
      </p>
    </div>
  );
}
