"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { resolveDesktopDownload, type DesktopDownload } from "@/lib/desktop-releases";

/**
 * 桌面版下載鈕（單一元件，兩個變體）。
 *
 * 暴君原話「搞弹窗就有点蠢了，点击按钮直接识别浏览器环境然后下载就行了」——
 * 所以沒有選單：單擊即由 UA 判定平台並動作。
 * - `icon`：header 用（極簡圖標態、`hidden xl:flex`、aria/title「下载桌面版」）。
 * - `hero`：宣傳片結尾那顆大的；文字隨平台自動變（Linux/Windows 各自副檔名）。
 *
 * 判定邏輯一律走 `resolveDesktopDownload`（`@/lib/desktop-releases`），此檔不另寫一份。
 * 平台判定放 useEffect：SSR 沒有 navigator，先渲染中性文字，避免 hydration 不一致。
 */

export interface DesktopDownloadButtonProps {
  variant: "icon" | "hero";
  /** 給 header icon 態併入頁內極簡 chrome（FLAT_CHROME）用。 */
  className?: string;
}

/** 封面畫布 1920×1080——與 `PromoIntroOverlay`／`promo-video/cover.html` 同一份真源。 */
const COVER_W = 1920;
const COVER_H = 1080;
const pct = (value: number, total: number): string => `${((value / total) * 100).toFixed(4)}%`;
const cqh = (px: number): string => `${((px / COVER_H) * 100).toFixed(4)}cqh`;

/**
 * hero 鈕在封面畫布上的矩形：左緣與 `.prompt`（left 294）／`.cap`（left 306）對齊。
 * `.prompt` 佔 y 690–802、`.cap` 佔 y 832–861，故 top 890 起、高 92 —— 兩者皆不重疊。
 * 尺寸全走 cqh()／pct()，任何視窗與直式放大態都與封面等比。
 */
const HERO = { left: 294, top: 890, height: 92 } as const;

const MAC_UNAVAILABLE = {
  title: "macOS 版暂未提供",
  description: "请在浏览器直接访问 eimu.dev 使用网页版，桌面客户端目前只提供 Windows 与 Linux。",
};

/** 觸發下載：臨時 <a>。回應帶 `content-disposition: attachment`，不會離開頁面。 */
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
  const [download, setDownload] = useState<DesktopDownload | null>(null);

  useEffect(() => {
    setDownload(resolveDesktopDownload(navigator.userAgent));
  }, []);

  const handleActivate = (event?: React.MouseEvent) => {
    // 結尾封面父層 onClick 會關登入小框；下載鈕不是那個意思，擋掉冒泡。
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
          "hidden h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:text-[rgba(0,0,0,0.78)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)] xl:flex sm:h-9 sm:w-9",
          className,
        )}
      >
        <Download className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  }

  // hero：unknown（Android／手機）不渲染——那台裝置裝不了桌面版，擺顆按不到結果的鈕只是噪音。
  if (download && !download.ok && download.reason === "unknown") return null;

  // 平台判定前（SSR ＋ 首幀）與 mac 一律中性文字；iOS/Android 上不會出現上下字串不一致。
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
