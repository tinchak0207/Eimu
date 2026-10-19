"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEimuShell } from "@/hooks/use-eimu-shell";
import { cn } from "@/lib/utils";
import { resolveDesktopDownload, type DesktopDownload } from "@/lib/desktop-releases";

/**
 * 桌面版下载钮（单一元件，两个变体）。
 *
 * 项目负责人原话「搞弹窗就有点蠢了，点击按钮直接识别浏览器环境然后下载就行了」——
 * 所以没有选单：单击即由 UA 判定平台并动作。
 * - `icon`：header 用（极简图标态、`hidden xl:flex`、aria/title「下载桌面版」）。
 * - `hero`：宣传片结尾那颗大的；文字随平台自动变（Linux/Windows 各自副档名）。
 *
 * 判定逻辑一律走 `resolveDesktopDownload`（`@/lib/desktop-releases`），此档不另写一份。
 * 平台判定放 useEffect：SSR 没有 navigator，先渲染中性文字，避免 hydration 不一致。
 *
 * 壳内一律不渲染（单一真源）：跑在 Eimu 桌面壳内（`window.eimuShell` 存在）时，使用者
 * 已在桌面 App 里，任何「下载桌面版」入口都是冗余；而 0.3.2+ 壳已内建 electron-updater
 * 背景静默更新（退出时自动安装），站内不该再有任何「叫使用者去下载」的 UI。
 * `useEimuShell()` 的值在 effect 后才有，故用 `checked` 闸门让「判定尚未完成」的
 * 首帧也回 null——浏览器端 mount 后照常渲染，壳内永远不渲染，避免第一帧闪现。
 */

export interface DesktopDownloadButtonProps {
  variant: "icon" | "hero";
  /** 给 header icon 态并入页内极简 chrome（FLAT_CHROME）用。 */
  className?: string;
}

/** 封面画布 1920×1080——与 `PromoIntroOverlay`／`promo-video/cover.html` 同一份真源。 */
const COVER_W = 1920;
const COVER_H = 1080;
const pct = (value: number, total: number): string => `${((value / total) * 100).toFixed(4)}%`;
const cqh = (px: number): string => `${((px / COVER_H) * 100).toFixed(4)}cqh`;

/**
 * hero 钮在封面画布上的矩形：左缘与 `.prompt`（left 294）／`.cap`（left 306）对齐。
 * `.prompt` 占 y 690–802、`.cap` 占 y 832–861，故 top 890 起、高 92 —— 两者皆不重叠。
 * 尺寸全走 cqh()／pct()，任何视窗与直式放大态都与封面等比。
 */
const HERO = { left: 294, top: 890, height: 92 } as const;

const MAC_UNAVAILABLE = {
  title: "macOS 版暂未提供",
  description: "请在浏览器直接访问 eimu.dev 使用网页版，桌面客户端目前只提供 Windows 与 Linux。",
};

/** 触发下载：临时 <a>。回应带 `content-disposition: attachment`，不会离开页面。 */
function triggerDownload(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function DesktopDownloadButton({ variant, className }: DesktopDownloadButtonProps) {
  const { toast } = useToast();
  const shell = useEimuShell();
  const [download, setDownload] = useState<DesktopDownload | null>(null);
  // `useEimuShell()` 在 effect 后才有值：用 checked 闸门让判定完成前也回 null，
  // 壳内首帧不闪现下载钮（浏览器端 mount 后照常渲染）。
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setDownload(resolveDesktopDownload(navigator.userAgent));
    setChecked(true);
  }, []);

  // 壳内不渲染任何 variant（单一真源）；判定尚未完成也不渲染，避免首帧闪现。
  if (!checked || shell) return null;

  const handleActivate = (event?: React.MouseEvent) => {
    // 结尾封面父层 onClick 会关登入小框；下载钮不是那个意思，挡掉冒泡。
    event?.stopPropagation();
    if (!download) return;
    if (download.ok) {
      triggerDownload(download.url);
      return;
    }
    if (download.reason === "mac-web-only") toast(MAC_UNAVAILABLE);
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={handleActivate}
        aria-label="下载桌面版"
        title="下载桌面版"
        className={cn(
          "hidden h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 xl:flex sm:h-9 sm:w-8",
          className,
        )}
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  // hero：unknown（Android／手机）不渲染——那台装置装不了桌面版，摆颗按不到结果的钮只是噪音。
  if (download && !download.ok && download.reason === "unknown") return null;

  // 平台判定前（SSR ＋ 首帧）与 mac 一律中性文字；iOS/Android 上不会出现上下字串不一致。
  const info = download?.ok ? download : null;
  const label = info ? `下载 ${info.label} 客户端` : "下载桌面客户端";
  const ext = info ? info.ext : null;

  return (
    <button
      type="button"
      onClick={handleActivate}
      aria-label="下载桌面客户端"
      className="absolute flex cursor-pointer items-center justify-center whitespace-nowrap bg-[#2d3142] text-white lg-transition hover:bg-[#272b39] active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(255,255,255,0.60)]"
      style={{
        left: pct(HERO.left, COVER_W),
        top: pct(HERO.top, COVER_H),
        height: cqh(HERO.height),
        borderRadius: cqh(9999),
        paddingLeft: cqh(40),
        paddingRight: cqh(40),
        gap: cqh(20),
        boxShadow: "0 12px 26px rgba(45,49,66,.28), inset 0 1.5px 0 rgba(255,255,255,.25)",
      }}
    >
      <Download aria-hidden="true" style={{ width: cqh(34), height: cqh(34) }} strokeWidth={2.4} />
      <span className="font-semibold tracking-[0.01em]" style={{ fontSize: cqh(30) }}>
        {label}
      </span>
      {ext && (
        <span className="font-medium tracking-[0.06em] opacity-60" style={{ fontSize: cqh(22) }}>
          .{ext}
        </span>
      )}
    </button>
  );
}
