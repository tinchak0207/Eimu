"use client";

// Agent 導演台小卡：director.done 的聊天呈現（spec §5 片5）。
// 殼內不疊卡（agent-chat-liquid-glass-inset-surface）：iOS 內嵌面
// rounded-[18px] + bg-[rgba(120,120,128,0.06)]，無邊框無陰影，骨架照抄
// AgentToolCard/AgentImageCard 既有語彙。SVG 走 data:image/svg+xml;base64 img
//（src/lib/svg-data-url.ts），禁 dangerouslySetInnerHTML。
// 「全屏開啟」二期 C6 才開通：disabled + 「即将上线」标注，绝不伪造行为。

import { memo, type ComponentType } from "react";
import { Clapperboard, MonitorPlay, TriangleAlert, CircleCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentDirectorItem } from "@/lib/agent-chat-types";
import { svgToDataUrl } from "@/lib/svg-data-url";
import { DirectorMiniViewport } from "@/components/director-mini/DirectorMiniViewport";

export interface AgentDirectorCardProps {
  item: AgentDirectorItem;
}

interface HealthMeta {
  label: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  badge: string;
  tone: string;
}

const HEALTH_META: Record<"ok" | "issues", HealthMeta> = {
  ok: { label: "分镜健康", Icon: CircleCheck, badge: "lg-tint-green", tone: "text-[#248A3D]" },
  issues: { label: "待修正", Icon: TriangleAlert, badge: "lg-tint-gold", tone: "text-[rgba(120,90,20,0.9)]" },
};

/** 幀數 → 秒展示（24fps 對齊 gateway duration_frames 口徑）：48 → "2s"。 */
function formatDuration(frames: number): string {
  if (!Number.isFinite(frames) || frames <= 0) return "0s";
  const seconds = frames / 24;
  return `${Number.isInteger(seconds) ? seconds : Math.round(seconds * 10) / 10}s`;
}

function AgentDirectorCardComponent({ item }: AgentDirectorCardProps) {
  const health = HEALTH_META[item.health.ok ? "ok" : "issues"];
  const topView = svgToDataUrl(item.schematic?.top_view_svg);
  const cameraView = svgToDataUrl(item.schematic?.camera_view_svg);
  const shot = item.activeShot;
  const plan = item.plan;

  return (
    <div className="agent-rise flex flex-col gap-2.5 rounded-[18px] bg-[rgba(120,120,128,0.06)] px-3.5 py-3">
      {/* 头行：方案名 + 镜头数徽章 + 健康徽章 */}
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white text-muted-foreground">
          <Clapperboard className="h-4 w-4" aria-hidden="true" />
        </span>
        <p className="min-w-0 flex-1 truncate text-ios-subhead font-semibold text-foreground" title={plan?.name}>
          {plan ? plan.name : "导演台"}
        </p>
        <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2.5 py-1 text-ios-footnote font-semibold tabular-nums lg-tint-blue text-ios-blue">
          {item.counts?.shots ?? 0} 镜头
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-ios-footnote font-semibold tabular-nums",
            health.badge,
            health.tone,
          )}
        >
          <health.Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {item.health.ok ? health.label : `${health.label} · ${item.health.issues.length}`}
        </span>
      </div>

      {plan?.summary && (
        <p className="text-ios-caption1 leading-relaxed text-muted-foreground">{plan.summary}</p>
      )}

      {/* 健康问题列表（琥珀态）：先给前 3 条，全量在导演台看 */}
      {!item.health.ok && item.health.issues.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-[14px] bg-[rgba(120,90,20,0.07)] px-2.5 py-1.5">
          {item.health.issues.slice(0, 3).map((issue, i) => (
            <li key={`${issue.code}-${i}`} className="text-ios-caption1 leading-snug text-[rgba(120,90,20,0.9)]">
              {issue.message || issue.code}
            </li>
          ))}
          {item.health.issues.length > 3 && (
            <li className="text-ios-caption1 text-[rgba(120,90,20,0.65)]">
              其余 {item.health.issues.length - 3} 条在导演台中查看
            </li>
          )}
        </ul>
      )}

      {/* 3D 白模即時視口（片B）：WebGL 失敗才降級顯示 SVG 示意（topView/cameraView） */}
      <DirectorMiniViewport
        sessionId={item.directorSessionId}
        revision={item.revision}
        topViewSvg={topView}
        cameraViewSvg={cameraView}
        className="h-[180px]"
      />

      {/* 摘要行：active_shot 名 / 时长 / 运镜 / 景别（13px 正文档 = ios-footnote 0.8125rem） */}
      <p className="truncate text-[13px] leading-relaxed text-muted-foreground">
        {shot
          ? `镜头 ${shot.no} · ${shot.name} · ${formatDuration(shot.duration_frames)} · ${shot.camera_move || "未定运镜"}${shot.shot_scale ? ` · ${shot.shot_scale}` : ""}`
          : "暂无活跃镜头"}
      </p>

      {/* 底部操作行：全屏二期 C6 才开通，disabled + 标注；revision 小字留痕 */}
      <div className="flex items-center gap-2 pt-0.5">
        <button
          type="button"
          disabled
          title="全屏导演台即将上线"
          className={cn(
            "flex h-11 items-center gap-1.5 rounded-full px-3.5 text-ios-subhead font-medium transition-all duration-200",
            "lg-float text-muted-foreground",
            "disabled:cursor-not-allowed disabled:text-foreground/45",
            "[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
          )}
        >
          <MonitorPlay className="h-4 w-4" aria-hidden="true" />
          在新分页开启导演台 · 即将上线
        </button>
        <span className="ml-auto shrink-0 text-ios-caption2 tabular-nums text-foreground/40">
          rev {item.revision}
        </span>
      </div>
    </div>
  );
}

export const AgentDirectorCard = memo(AgentDirectorCardComponent);
