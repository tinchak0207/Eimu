"use client";

// /history「项目维度」：选中某创作项目时，展示该项目标签下的**全部资产**（只读）。
//
// 数据加载不在这里（由 HistoryClient 走既有 project-assets-client 的 listProjectAssets 取得，
// 再 filterByProjectTag 过一遍）——本档只负责渲染，避免开出第二条真源。
//
// 卡片渲染**逐行复用** src/components/assets/ProjectAssetLibraryPanel.tsx 的卡片部分，
// 只动白名单：① 容器宽度/间距（适配 /history 的 max-w-[1440px] 版心）；② 标题文案；
// ③ 只读展示——不渲染「挂用/解除挂用」等写操作行（/history 是只读面，不持有挂用状态与回调）。
// 可见性徽章（VISIBILITY_KEY / VISIBILITY_CLASSES）与卡片内部交互语义原样照抄，不做二次发明。
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { text, type UiStringKey } from "@/lib/ui-strings";
import type { AssetLibraryItem, AssetVisibility } from "@/lib/asset-scope";

const VISIBILITY_KEY: Record<AssetVisibility, UiStringKey> = {
  owner: "assets.visibility.owner",
  "in-project": "assets.visibility.inProject",
  "in-team": "assets.visibility.inTeam",
  "shared-in": "assets.visibility.sharedIn",
};

const VISIBILITY_CLASSES: Record<AssetVisibility, string> = {
  owner: "bg-black/5 text-muted-foreground",
  "in-project": "bg-ios-blue/10 text-[#007AFF]",
  "in-team": "bg-ios-indigo/10 text-[#5856D6]",
  "shared-in": "bg-ios-green/10 text-[#248A3D]",
};

export interface ProjectAssetsOverviewProps {
  /** 已按项目标签过滤（filterByProjectTag）后的资产；null＝尚未取得（加载中或未选项目）。 */
  items: AssetLibraryItem[] | null;
  loading: boolean;
  error: string | null;
  className?: string;
}

export function ProjectAssetsOverview({ items, loading, error, className }: ProjectAssetsOverviewProps) {
  const count = items?.length ?? 0;

  return (
    <section
      className={cn("lg-card overflow-hidden rounded-ios-3xl", className)}
      aria-label={text("history.project.assetsTitle")}
    >
      <div className="border-b border-[rgba(0,0,0,0.06)] px-4 py-3 sm:px-5">
        <h2 className="text-ios-subhead font-semibold text-[rgba(0,0,0,0.85)]">
          {text("history.project.assetsTitle")}
        </h2>
        {/* 摘要：加载完成前不显示「共 0 件」，避免把未加载读成空。 */}
        {!loading && !error && (
          <p className="mt-0.5 text-ios-caption1 text-[rgba(0,0,0,0.58)]">
            {text("history.project.assetsSummary", { count })}
          </p>
        )}
      </div>

      {loading ? (
        <p className="flex items-center gap-1.5 px-4 py-3 text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:px-5">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {text("history.project.assetsLoading")}
        </p>
      ) : error ? (
        <p className="px-4 py-3 text-ios-caption1 text-[#FF3B30] sm:px-5">
          {text("history.project.assetsError", { error })}
        </p>
      ) : count === 0 ? (
        <p className="px-4 py-3 text-ios-caption1 text-[rgba(0,0,0,0.58)] sm:px-5">
          {text("assets.projectTag.empty")}
        </p>
      ) : (
        <div>
          {(items ?? []).map((item) => {
            const key = `${item.assetKind}:${item.assetId}`;
            return (
              <div key={key} className="border-b px-4 py-2.5 last:border-b-0 sm:px-5">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-ios-caption1 font-medium text-foreground">
                      <span className="truncate">{item.title}</span>
                      <span className="shrink-0 rounded-full bg-black/5 px-1.5 py-0.5 text-ios-caption2 text-muted-foreground">
                        {item.kindLabel}
                      </span>
                      <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-ios-caption2", VISIBILITY_CLASSES[item.visibility])}>
                        {text(VISIBILITY_KEY[item.visibility])}
                      </span>
                    </p>
                    {item.tags.length > 0 && (
                      <p className="mt-0.5 truncate text-ios-caption2 text-foreground/45">{item.tags.join(" · ")}</p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
