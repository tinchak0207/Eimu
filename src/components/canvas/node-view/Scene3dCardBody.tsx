"use client";

// 3D 場景卡主體（2026-09-06 Astra PRD P1-3，type: scene_3d）。
// 兩條來源（Scene3dCardMetadata.source）：
//   · director（或缺省）＝三欄齊的導演交付：turntable 播放器 ＋ stills 網格 ＋ 資產下載；
//   · import（2026-09-27 本機導入刀）＝只帶 glb_path：GLB 視口直接當主體，
//     **缺的欄位整塊不渲染**（不出空播放器、不出空靜帧網格、不出死觀看鈕）——減法。
// 輪子來源：node-view/NodeBody.tsx 的 Video 分支（turntable 視頻播放器，逐行複製）
// + 同檔圖片 <img> 形狀（stills 網格）+ CanvasNodeView batchExpanded「下载全部」
// 按鈕形狀（資產下載行）。白名單偏離僅四項：
//   ①數據源 = node.metadata.sceneCard（Scene3dCardMetadata）
//   ②文案簡體（下载/静帧/场景资产）
//   ③交互鎖定 = P1 只讀+播放：無編輯/生成入口
//   ④主體加 stills 網格（3-6 張，slice(0,6) 上限）+ 資產下載連結（.blend/.glb）
// 播放器行為/生命週期 hooks 與視頻分支零偏離（同款 <video controls> 原生形，
// 無自造狀態機；渲染驗收權在暴君，本組件不做自我 UI 檢查）。

import { useState } from "react";
import { Download, Eye, Mountain, X } from "lucide-react";
import type { CanvasNode, Scene3dCardMetadata } from "@/lib/canvas/types";
import { Scene3dGltfViewport } from "./Scene3dGltfViewport";

/** stills 網格上限（契約 3-6 張；超量截斷不渲染，防 agent 回傳爆卡）。 */
const STILLS_MAX = 6;

/** NodeBody 圖片分支同款代理兜底：上游 CDN 可能要登入/過期/CORS，代理 302 拉回。 */
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
  // 導入卡（本機 GLB）：無 turntable/stills/blend，主體直接是 GLB 視口。
  const isImport = scene?.source === "import";
  const glbPlayable = Boolean(scene?.glb_path && isHttpUrl(scene.glb_path));
  const hasAssets = Boolean(scene?.blend_path || glbPlayable);
  // 3D 預覽（片P）：glb 真資產視口。內嵌面切換（殼內不疊卡），非浮層非新卡。
  const [previewOpen, setPreviewOpen] = useState(false);
  // 導入卡的主體＝視口本身（無需切換鈕）；glb 不可用時主體整塊不出現。
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
      {/* 主體：導入卡＝GLB 視口直接當主體；導演卡＝turntable 播放器（NodeBody Video 分支同款原生播放器） */}
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
      {/* stills 縮圖網格（複製 NodeBody 圖片 <img> 形狀；代理兜底同款）。空則整塊不渲染。 */}
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
      {/* 場景摘要 + 資產下載（按鈕形狀 = CanvasNodeView「下载全部」同款） */}
      {(summary || hasAssets) && (
        <div className="shrink-0 space-y-1 px-3 py-1.5">
          {summary && <p className="truncate text-ios-caption1 text-muted-foreground">{summary}</p>}
          {hasAssets && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] font-medium uppercase leading-none tracking-[0.18em] text-muted-foreground/70">
                {isImport ? "本机导入" : "场景资产"}
              </span>
              {/* 3D 預覽入口（片P）：glb 在手才可點；導入卡主體已是視口，不出切換鈕（禁死按鈕） */}
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
