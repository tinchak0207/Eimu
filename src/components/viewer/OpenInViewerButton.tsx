"use client";

// 「放大赏阅」小钮：画布节点 / 鸟瞰缩图等「有成品但没有现成放大入口」的地方一步进入赏阅。
// 不改变宿主原有手势：data-canvas-interactive + 阻断 pointerdown/click 冒泡，拖拽与选中不受影响。
// Provider 缺席时不渲染（诚实原则：不长出必定无反应的按钮）。

import { Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { stableAssetId } from "@/lib/viewer/from-items";
import type { ViewAsset } from "@/lib/viewer/types";
import { useViewer } from "./ViewerHost";

interface OpenInViewerButtonProps {
  /** 单件或集合；集合时 index 指向起始成员。 */
  asset: ViewAsset | readonly ViewAsset[];
  index?: number;
  label?: string;
  className?: string;
}

export function OpenInViewerButton({ asset, index = 0, label = "放大赏阅", className }: OpenInViewerButtonProps) {
  const viewer = useViewer();
  if (!viewer.available) return null;
  return (
    <button
      type="button"
      data-canvas-interactive
      aria-label={label}
      title={label}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        viewer.open(asset, { index });
      }}
      className={cn(
        // 视觉 28px；命中区用透明伪元素扩到 44px（伪元素属于按钮本身，点到即触发，且不额外占位、不遮挡邻近节点的布局）。
        "relative flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/70",
        "after:absolute after:left-1/2 after:top-1/2 after:h-11 after:w-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-['']",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-white/70 [touch-action:manipulation]",
        className,
      )}
    >
      <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** 鸟瞰缩图（只有 url + image/video）→ 赏阅成员。 */
export function viewAssetsFromPreviews(previews: readonly { url: string; kind: "image" | "video" }[]): ViewAsset[] {
  return previews.map((p) => ({ id: stableAssetId(p.url), kind: p.kind, url: p.url }));
}
