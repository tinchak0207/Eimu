"use client";

// Agent 3D 成品卡：model3d.done 的聊天呈现。内联即可旋转（赏阅 Scene3dSurface，
// 与画布 scene_3d 卡、赏阅全屏同一个渲染器），点「放大」进全屏赏阅；GLB 可直接下载。

import { memo, useMemo } from "react";
import { Coins, Download } from "lucide-react";
import type { AgentModel3dItem } from "@/lib/agent-chat-types";
import { viewAssetFromModel3dItem } from "@/lib/viewer/from-items";
import { Viewer } from "@/components/viewer/Viewer";

export interface Agent3DCardProps {
  item: AgentModel3dItem;
}

function formatCoins(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function Agent3DCardComponent({ item }: Agent3DCardProps) {
  const asset = useMemo(() => viewAssetFromModel3dItem(item), [item]);
  return (
    <figure className="agent-rise">
      <div className="relative">
        <Viewer asset={asset} density="inline" className="h-[min(420px,52dvh)]" />
        <span className="pointer-events-none absolute left-2.5 top-2.5 z-10 rounded-full bg-black/55 px-2 py-0.5 text-ios-caption1 font-medium text-white/90 backdrop-blur-md">
          3D 模型
        </span>
      </div>
      <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 pb-3 pt-2.5 text-ios-footnote text-muted-foreground">
        {item.title && <span className="text-foreground">{item.title}</span>}
        {item.costCoins !== undefined && item.costCoins > 0 && (
          <span className="flex items-center gap-1">
            <Coins className="h-3.5 w-3.5" aria-hidden="true" />
            消耗 {formatCoins(item.costCoins)} 金币
          </span>
        )}
        <a
          href={item.url}
          download
          target="_blank"
          rel="noreferrer"
          className="flex min-h-11 items-center gap-1 [touch-action:manipulation]"
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          下载 GLB
        </a>
      </figcaption>
    </figure>
  );
}

export const Agent3DCard = memo(Agent3DCardComponent);
