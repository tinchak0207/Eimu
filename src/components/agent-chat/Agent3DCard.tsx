"use client";

// Agent 3D 成品卡：model3d.done 的聊天呈现。内联即可旋转（赏阅 Scene3dSurface，
// 与画布 scene_3d 卡、赏阅全屏同一个渲染器），点「放大」进全屏赏阅；GLB 可直接下载。
// 带贴图的 GLB 常有几十 MB（混元3D 实测 79MB）：先出占位，点一下才下载并挂实时视口，不在聊天里偷偷吃流量。

import { memo, useMemo, useState } from "react";
import { Box, Coins, Download } from "lucide-react";
import type { AgentModel3dItem } from "@/lib/agent/agent-chat-types";
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
  const [armed, setArmed] = useState(false);
  return (
    <figure className="agent-rise">
      <div className="relative">
        {armed ? (
          <Viewer asset={asset} density="inline" />
        ) : (
          <button
            type="button"
            onClick={() => setArmed(true)}
            className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-[#0b0f14] text-white/85 [touch-action:manipulation]"
            aria-label="加载 3D 预览"
          >
            <Box className="h-8 w-8" aria-hidden="true" />
            <span className="text-ios-subhead font-medium">点击查看 3D 模型</span>
            <span className="text-ios-caption1 text-white/50">可拖动旋转 · 文件较大，点开才加载</span>
          </button>
        )}
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
