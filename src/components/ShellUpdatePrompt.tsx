"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEimuShell } from "@/hooks/use-eimu-shell";

/**
 * 桌面壳「更新已就绪」提示（壳内唯一入口）。
 *
 * 为什么需要它：0.3.2+ 的壳内建 electron-updater，会在背景下载新版并暂停待套用，
 * 但 Linux AppImage 不吃 `autoInstallOnAppQuit`（那是 Windows/NSIS 路径）——下载完成后
 * 若没人通知主进程，新版永远躺在暂存目录里不被套用。壳下载完成时向页面发
 * `eimu-shell:update-ready`；本元件订阅它、以产品语言告知、并提供「一键重启并更新」
 * 呼叫 `window.eimuShell.applyUpdate()`（主进程 updater.js applyUpdate → quitAndInstall）。
 *
 * 只在壳内渲染（单一真源 `useEimuShell`）：普通浏览器没有 `window.eimuShell` ⇒ 回 null；
 * 旧壳（0.1.0～0.3.1）虽有 `window.eimuShell` 但没有 `onUpdateReady`／`applyUpdate`
 * ⇒ 逐次判 `typeof` 存在，缺席就完全不订阅、不渲染、不报错。
 */

export interface ShellUpdatePromptProps {
  className?: string;
}

export function ShellUpdatePrompt({ className }: ShellUpdatePromptProps) {
  const shell = useEimuShell();
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    // 旧壳没有 onUpdateReady：不订阅（避免 TypeError），提示永不出现。
    if (!shell || typeof shell.onUpdateReady !== "function") return;
    const unsubscribe = shell.onUpdateReady((info) => {
      const v =
        info && typeof info.version === "string" && info.version.trim()
          ? info.version.trim()
          : null;
      setVersion(v);
      setReady(true);
    });
    return () => {
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [shell]);

  // 非壳、旧壳（无 applyUpdate）、或尚无更新就绪 ⇒ 不渲染任何入口。
  if (!shell || !ready || typeof shell.applyUpdate !== "function") return null;

  const label = version ? `新版本 ${version} 已就绪` : "新版本已就绪";

  return (
    <button
      type="button"
      onClick={() => shell.applyUpdate?.()}
      aria-label="重启并更新"
      title="重启并更新"
      className={cn(
        "app-region-no-drag flex h-11 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-ios-footnote font-semibold text-[#2d3142] lg-transition focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 sm:h-9 sm:px-2.5",
        // Liquid Glass float：与 header 其它极简图标钮同一材料层，但保留玻璃底以强调这是一个「待处理」的状态。
        "border border-[rgba(255,255,255,0.72)] bg-[rgba(255,255,255,0.56)] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_6px_rgba(0,0,0,0.06)] backdrop-blur-md hover:bg-[rgba(255,255,255,0.82)] active:scale-95",
        className,
      )}
    >
      <RefreshCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {/* 窄壳（<sm）只留「新版本已就绪」，隐藏版本号，避免挤压右簇的视窗钮。 */}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">新版本已就绪</span>
      <span aria-hidden="true" className="opacity-40">
        ·
      </span>
      <span className="text-[#007AFF]">重启更新</span>
    </button>
  );
}