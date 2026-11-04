"use client";

// 赏阅（内嵌用）：同一个 Surface、两种 density。
//   inline：聊天卡片/历史/画布里的成品组件。最小 chrome，右上角「放大」进全屏。
//   full  ：独立页（/view）整页铺满，带顶栏、动作栏与评审面板——与全屏弹层是同一个舞台（ViewerStage）。
// 全屏弹层打开期间，inline 的 Surface active=false（暂停并释放大资源），避免两份同时出声。

import { useCallback, useRef, type ReactNode } from "react";
import { Expand } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Locator, ViewAsset, ViewerActions, ViewerController } from "@/lib/viewer/types";
import { useAnnotations } from "./ReviewSheet";
import { SurfaceSlot, ViewerStage, useViewer } from "./ViewerHost";

export interface ViewerProps {
  asset: ViewAsset;
  /** 默认 inline。 */
  density?: "inline" | "full";
  actions?: ViewerActions;
  /** inline 放大按钮的处理；缺省＝调 useViewer().open(asset, { actions })。 */
  onOpenFull?(): void;
  /** 外部强制暂停（例如卡片滚出视口）；默认 true。 */
  active?: boolean;
  className?: string;
  /** full 密度：一进来跳到的位置（分享链接 t=）。 */
  initialLocator?: Locator;
  /** full 密度：顶栏最左的自定义内容（如回首页链接）。 */
  leading?: ReactNode;
}

export function Viewer({
  asset,
  density = "inline",
  actions,
  onOpenFull,
  active = true,
  className,
  initialLocator,
  leading,
}: ViewerProps) {
  if (density === "full") {
    return (
      <div className={cn("h-full w-full", className)}>
        <ViewerStage mode="page" set={[asset]} actions={actions} initialLocator={initialLocator} leading={leading} />
      </div>
    );
  }
  return (
    <InlineViewer asset={asset} actions={actions} onOpenFull={onOpenFull} active={active} className={className} />
  );
}

function InlineViewer({
  asset,
  actions,
  onOpenFull,
  active,
  className,
}: Pick<ViewerProps, "asset" | "actions" | "onOpenFull" | "className"> & { active: boolean }) {
  const viewer = useViewer();
  const review = useAnnotations(asset.id);
  const controllerRef = useRef<ViewerController | null>(null);

  const openFull = useCallback(
    (withReview: boolean) => {
      if (onOpenFull) onOpenFull();
      else viewer.open(asset, { actions, review: withReview });
    },
    [onOpenFull, viewer, asset, actions],
  );
  const canOpen = !!onOpenFull || viewer.available;

  return (
    <div
      className={cn("relative w-full overflow-hidden rounded-2xl bg-[#0d0f14] text-white", className)}
      data-viewer-kind={asset.kind}
    >
      <SurfaceSlot
        asset={asset}
        density="inline"
        annotations={review.annotations}
        controllerRef={controllerRef}
        // inline 里没有评审面板的位置：标记请求接力到全屏并直接展开面板。
        onRequestMark={() => openFull(true)}
        active={active && !viewer.isOpen}
        onOpenChild={(child) => {
          if (onOpenFull) return onOpenFull();
          const kids = asset.children;
          const at = kids ? kids.findIndex((c) => c === child || c.id === child.id) : -1;
          viewer.open(kids && at >= 0 ? kids : [child], { index: Math.max(0, at), actions });
        }}
      />
      {canOpen && (
        <button
          type="button"
          onClick={() => openFull(false)}
          aria-label="放大"
          title="放大"
          className="absolute right-2 top-2 z-10 flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur hover:bg-black/65 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]"
        >
          <Expand className="h-5 w-5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
