"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Viewer } from "@/components/viewer/Viewer";
import { ViewerProvider } from "@/components/viewer/ViewerHost";
import type { Locator, ViewAsset, ViewerActions } from "@/lib/viewer/types";

// 分享页客户端壳：整页铺满的赏阅（full density，不是弹层）。盖住全站导览——这里只有成品本身。
// 下载：跨域资源没有 CORS 时 fetch 会失败，如实返回 false（按钮显示「失败」），
// 绝不退化成 window.open 开链接（见 agent 媒体卡契约）。

function extensionOf(url: string, fallback: string): string {
  try {
    const ext = new URL(url).pathname.split(".").pop() ?? "";
    return /^[a-z0-9]{2,5}$/i.test(ext) ? ext.toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

async function downloadAsset(asset: ViewAsset): Promise<boolean> {
  if (!asset.url) return false;
  try {
    // cache-buster + no-store：避免命中 <img>/<video> no-cors 缓存副本导致 CORS 误判。
    const sep = asset.url.includes("?") ? "&" : "?";
    const res = await fetch(`${asset.url}${sep}_dl=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return false;
    const blob = await res.blob();
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${asset.title?.trim() || "eimu"}.${extensionOf(asset.url, "bin")}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return true;
  } catch {
    return false;
  }
}

const ACTIONS: ViewerActions = { onDownload: downloadAsset };

export function ViewClient({ asset, startSec }: { asset: ViewAsset; startSec: number }) {
  const initialLocator = useMemo<Locator | undefined>(
    () => (startSec > 0 && (asset.kind === "audio" || asset.kind === "video") ? { t: "time", a: startSec } : undefined),
    [asset.kind, startSec],
  );
  return (
    <ViewerProvider>
      <div className="fixed inset-0 z-[100] min-h-[100dvh] bg-[#0d0f14]">
        <Viewer
          asset={asset}
          density="full"
          actions={ACTIONS}
          initialLocator={initialLocator}
          className="h-full"
          leading={
            <Link
              href="/"
              aria-label="回到 Eimu 首页"
              className="flex h-11 shrink-0 items-center rounded-full px-3 text-[15px] font-bold tracking-tight text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            >
              Eimu
            </Link>
          }
        />
      </div>
    </ViewerProvider>
  );
}
