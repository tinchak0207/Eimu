"use client";

// 3D 场景卡主体（2026-09-06 Astra PRD P1-3，type: scene_3d）。
// 两条来源（Scene3dCardMetadata.source）：
//   · director（或缺省）＝三栏齐的导演交付：turntable 播放器 ＋ stills 网格 ＋ 资产下载；
//   · import（2026-09-27 本机导入刀）＝只带 glb_path：GLB 视口直接当主体，
//     **缺的栏位整块不渲染**（不出空播放器、不出空静帧网格、不出死观看钮）——减法。
// 轮子来源：node-view/NodeBody.tsx 的 Video 分支（turntable 视频播放器，逐行复制）
// + 同档图片 <img> 形状（stills 网格）+ CanvasNodeView batchExpanded「下载全部」
// 按钮形状（资产下载行）。白名单偏离仅四项：
//   ①数据源 = node.metadata.sceneCard（Scene3dCardMetadata）
//   ②文案简体（下载/静帧/场景资产）
//   ③交互锁定 = P1 只读+播放：无编辑/生成入口
//   ④主体加 stills 网格（3-6 张，slice(0,6) 上限）+ 资产下载连结（.blend/.glb）
// 播放器行为/生命周期 hooks 与视频分支零偏离（同款 <video controls> 原生形，
// 无自造状态机；渲染验收权在暴君，本组件不做自我 UI 检查）。

import { useState } from "react";
import { Download, Eye, Mountain, X } from "lucide-react";
import type { CanvasNode, Scene3dCardMetadata } from "@/lib/canvas/types";
import { Scene3dGltfViewport } from "./Scene3dGltfViewport";

/** stills 网格上限（契约 3-6 张；超量截断不渲染，防 agent 回传爆卡）。 */
const STILLS_MAX = 6;

/** NodeBody 图片分支同款代理兜底：上游 CDN 可能要登入/过期/CORS，代理 302 拉回。 */
function proxySrc(url: string): string {
  return `/api/canvas/image-proxy?url=${encodeURIComponent(url)}`;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http") || value.startsWith("/") || value.startsWith("data:");
}

export function Scene3dCardBody({ node }: { node: CanvasNode }) {
  const scene: Scene3dCardMetadata | undefined = node.metadata?.sceneCard;
  const stills = (scene?.stills_urls ?? []).filter((u): u is string => typeof u === "string" && isHttpUrl(u)).slice(0, STILLS_MAX);
  const summary = scene?.scene_summary?.trim() ?? "";
  // 导入卡（本机 GLB）：无 turntable/stills/blend，主体直接是 GLB 视口。
  const isImport = scene?.source === "import";
  const glbPlayable = typeof scene?.glb_path === "string" && scene.glb_path.trim() !== "";
  const hasAssets = Boolean(scene?.blend_path || glbPlayable);
  // 3D 预览（片P）：glb 真资产视口。内嵌面切换（壳内不叠卡），非浮层非新卡。
  const [previewOpen, setPreviewOpen] = useState(false);
  // 导入卡的主体＝视口本身（无需切换钮）；glb 不可用时主体整块不出现。
  const inlineViewport = Boolean(isImport && glbPlayable);

  if (!scene) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4">
        <Mountain className="h-7 w-7 text-foreground/45" aria-hidden="true" />
        <span className="text-ios-caption1 text-muted-foreground">3D 场景 · 等待 agent 填充</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* 主体：导入卡＝GLB 视口直接当主体；导演卡＝turntable 播放器（NodeBody Video 分支同款原生播放器） */}
      {inlineViewport ? (
        <div className="min-h-0 flex-1">
          <Scene3dGltfViewport glbPath={scene.glb_path} className="h-full w-full" />
        </div>
      ) : !isImport ? (
        <div className="min-h-0 flex-1">
          {previewOpen && glbPlayable ? (
            <Scene3dGltfViewport glbPath={scene.glb_path} className="h-full w-full" />
          ) : scene.turntable_url && isHttpUrl(scene.turntable_url) ? (
            <video src={scene.turntable_url} controls className="h-full w-full object-cover" data-canvas-interactive />
          ) : (
            <div className="flex h-full items-center justify-center bg-black/[0.04]">
              <span className="text-ios-caption1 text-muted-foreground">turntable 未同步 · 让 agent 重新生成</span>
            </div>
          )}
        </div>
      ) : null}
      {/* stills 缩图网格（复制 NodeBody 图片 <img> 形状；代理兜底同款）。空则整块不渲染。 */}
      {stills.length > 0 && (
        <div className="grid shrink-0 grid-cols-3 gap-1 px-2 pt-1.5">
          {stills.map((url, i) => (
            <div key={`${url}-${i}`} className="overflow-hidden rounded-[8px] bg-black/[0.04]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url.startsWith("http") ? proxySrc(url) : url}
                alt={`场景静帧 ${i + 1}`}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="h-[52px] w-full object-cover"
              />
            </div>
          ))}
        </div>
      )}
      {/* 场景摘要 + 资产下载（按钮形状 = CanvasNodeView「下载全部」同款） */}
      {(summary || hasAssets) && (
        <div className="shrink-0 space-y-1 px-3 py-1.5">
          {summary && <p className="truncate text-ios-caption1 text-muted-foreground">{summary}</p>}
          {hasAssets && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">
                {isImport ? "本机导入" : "场景资产"}
              </span>
              {/* 3D 预览入口（片P）：glb 在手才可点；导入卡主体已是视口，不出切换钮（禁死按钮） */}
              {!isImport && glbPlayable && (
                <button
                  type="button"
                  data-canvas-interactive
                  onClick={() => setPreviewOpen((open) => !open)}
                  aria-pressed={previewOpen}
                  className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue hover:bg-white"
                >
                  {previewOpen ? <X className="h-3 w-3" aria-hidden="true" /> : <Eye className="h-3 w-3" aria-hidden="true" />}
                  {previewOpen ? "关闭预览" : "3D 预览"}
                </button>
              )}
              {scene.blend_path && (
                <a
                  data-canvas-interactive
                  href={scene.blend_path}
                  download
                  className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue hover:bg-white"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  .blend
                </a>
              )}
              {glbPlayable && (
                <a
                  data-canvas-interactive
                  href={scene.glb_path}
                  download
                  className="inline-flex items-center gap-1 rounded-full bg-white/80 px-2 py-0.5 text-ios-caption2 font-medium text-ios-blue hover:bg-white"
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  .glb
                </a>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
