"use client";

import { memo } from "react";
import { AlertTriangle, Bot, ChevronLeft, ChevronRight, Clipboard, Download, FolderOpen, ImagePlus, Images, Layers3, Play, Undo2, X } from "lucide-react";
import { resultSrc } from "@/components/image-src";
import { cn } from "@/lib/utils";
import { formatPublicGenerationSummary } from "@/lib/public-generation-summary";
import type { ImageResult, ReferenceImage } from "@/lib/image-types";
import type { WorkstationCommandId } from "@/lib/workstation-commands";
import type { CanvasNotice, CanvasTool, GalleryMode, LeftPanelTab, SlotState, WorkspaceMode } from "../workstation-constants";
import { BRUSH_SIZES, CANVAS_TOOLS, SLOT_STATE_LABELS } from "../workstation-constants";

export interface CanvasStageProps {
  workspaceMode: WorkspaceMode;
  activeWorkspaceTitle: string;
  capabilityNotice: string | undefined;
  notice: CanvasNotice | null;
  setNotice: React.Dispatch<React.SetStateAction<CanvasNotice | null>>;
  activeCanvasTool: CanvasTool;
  setActiveCanvasTool: (tool: CanvasTool) => void;
  canvasZoom: "fit" | "actual";
  setCanvasZoom: (zoom: "fit" | "actual") => void;
  setCanvasNotice: (text: string, level?: "info" | "warn" | "error") => void;
  /** 成片墙（viewer 模式）。 */
  viewerGalleryMode: GalleryMode;
  setViewerGalleryMode: (mode: GalleryMode) => void;
  renderBoardsPanel: () => React.ReactNode;
  shots: Array<{ id: string }>;
  allResults: ImageResult[];
  resultKey: (image: ImageResult) => string;
  slotStateFor: (image: ImageResult) => SlotState;
  openResultOnCanvas: (image: ImageResult) => void;
  downloadResult: (image?: ImageResult) => void | Promise<void>;
  referenceImages: ReferenceImage[];
  executeCommand: (commandId: WorkstationCommandId) => void;
  setLeftPanelTab: (tab: LeftPanelTab) => void;
  /** 画布（canvas 模式）。 */
  visibleResult: ImageResult | undefined;
  setLightboxOpen: (open: boolean | boolean) => void;
  canvasViewportRef: React.RefObject<HTMLDivElement | null>;
  baseImageRef: React.RefObject<HTMLImageElement | null>;
  annotationCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  isPanning: boolean;
  startPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  movePan: (event: React.PointerEvent<HTMLDivElement>) => void;
  endPan: (event: React.PointerEvent<HTMLDivElement>) => void;
  panOffset: { x: number; y: number };
  zoomScale: number;
  zoomAtPointer: (factor: number) => void;
  resetZoom: () => void;
  handleAnnotationPointerDown: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  handleAnnotationPointerMove: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  handleAnnotationPointerUp: (event: React.PointerEvent<HTMLCanvasElement>) => void;
  isLoading: boolean;
  runningSlots: number;
  runTotal: number;
  runUnit: string;
  runSettled: number;
  runProgress: number;
  runEtaLabel: string | null;
  viewableResults: ImageResult[];
  visibleResultIndex: number;
  stepResult: (delta: number) => void;
  staleConfigFields: string[];
  dismissedStaleResultKey: string | null;
  setDismissedStaleResultKey: (key: string | null) => void;
  restoreVisibleResultConfig: () => void;
  sendResultToAssets: (image?: ImageResult) => void | Promise<void>;
  saveResultToBoard: (image: ImageResult) => void;
  copyProvenanceConfig: (image?: ImageResult) => void;
  activateWorkspace: (mode: WorkspaceMode) => void;
  /** 标注 dock。 */
  brushSize: number;
  setBrushSize: (size: number) => void;
  strokeCount: number;
  undoAnnotation: () => void;
  hasAnnotation: boolean;
  exportAnnotationToReference: () => void;
  clearAnnotation: () => void;
}

/**
 * 中栏画布（2026-08-22 从 InvokeInspiredWorkstation 拆出）。
 * 含 viewer 成片墙 / canvas 模式（fit + actual-size 缩放平移 + 标注层）/ 工具 dock。
 * 消费 useCanvasAnnotation 暴露的 refs 与 handlers（由入口透传）。
 */
export const CanvasStage = memo(function CanvasStage({
  workspaceMode,
  activeWorkspaceTitle,
  capabilityNotice,
  notice,
  setNotice,
  activeCanvasTool,
  setActiveCanvasTool,
  canvasZoom,
  setCanvasZoom,
  setCanvasNotice,
  viewerGalleryMode,
  setViewerGalleryMode,
  renderBoardsPanel,
  shots,
  allResults,
  resultKey,
  slotStateFor,
  openResultOnCanvas,
  downloadResult,
  referenceImages,
  executeCommand,
  setLeftPanelTab,
  visibleResult,
  setLightboxOpen,
  canvasViewportRef,
  baseImageRef,
  annotationCanvasRef,
  isPanning,
  startPan,
  movePan,
  endPan,
  panOffset,
  zoomScale,
  zoomAtPointer,
  resetZoom,
  handleAnnotationPointerDown,
  handleAnnotationPointerMove,
  handleAnnotationPointerUp,
  isLoading,
  runningSlots,
  runTotal,
  runUnit,
  runSettled,
  runProgress,
  runEtaLabel,
  viewableResults,
  visibleResultIndex,
  stepResult,
  staleConfigFields,
  dismissedStaleResultKey,
  setDismissedStaleResultKey,
  restoreVisibleResultConfig,
  sendResultToAssets,
  saveResultToBoard,
  copyProvenanceConfig,
  activateWorkspace,
  brushSize,
  setBrushSize,
  strokeCount,
  undoAnnotation,
  hasAnnotation,
  exportAnnotationToReference,
  clearAnnotation,
}: CanvasStageProps) {
  return (
    <main className="pro-canvas-stage pro-glass-panel" data-workspace-mode={workspaceMode}>
      <div className="pro-canvas-header">
        <div className="pro-panel-title">
          <Layers3 className="h-4 w-4" />
          {activeWorkspaceTitle}
        </div>
        {/*
          旧版是 {canvasNotice || capabilityNotice}：只要有任何一条普通通知在，
          「该模型不支持参考图」这类能力警告就被吃掉；且样式 white-space: nowrap
          会把长句截成「已调整版位：所选模型不支…」。现在两条各自渲染、可换行、
          error 级带关闭钮，且 error 用 role="alert" 让读屏器立刻播报。
        */}
        <div className="pro-canvas-notices">
          {capabilityNotice && (
            <em className="pro-canvas-notice" data-level="warn" role="status">
              {capabilityNotice}
            </em>
          )}
          {notice && (
            <em
              className="pro-canvas-notice"
              data-level={notice.level}
              role={notice.level === "error" ? "alert" : "status"}
            >
              {notice.text}
              {notice.level === "error" && (
                <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
                  <X className="h-3 w-3" />
                </button>
              )}
            </em>
          )}
        </div>
      </div>

      <div className="pro-canvas-preview" data-canvas-tool={activeCanvasTool} data-zoom={canvasZoom}>
        {workspaceMode === "viewer" ? (
          <div className="pro-viewer-grid">
            <div className="pro-gallery-toolbar">
              <button type="button" onClick={() => setViewerGalleryMode("images")} className={cn(viewerGalleryMode === "images" && "is-active")}>
                成片
              </button>
              <button type="button" onClick={() => setViewerGalleryMode("assets")} className={cn(viewerGalleryMode === "assets" && "is-active")}>
                参考图
              </button>
              <button type="button" onClick={() => setViewerGalleryMode("boards")} className={cn(viewerGalleryMode === "boards" && "is-active")}>
                <FolderOpen className="mr-1 inline h-3 w-3" />
                文件夹 {shots.length > 0 && shots.length}
              </button>
            </div>
            {viewerGalleryMode === "boards" ? renderBoardsPanel() : (
            <div className="pro-gallery-grid">
              {viewerGalleryMode === "images" && allResults.map((image, index) => {
                const ready = Boolean(image.image || image.imageUrl || image.videoUrl);
                return (
                /*
                 * 卡片外面多包一层：下载钮不能写在 <button> 里面（嵌套 button 是无效
                 * HTML，浏览器会把内层拆出去，点击行为随引擎而变），旧版把下载藏在
                 * 全屏灯箱里也是同一个原因 —— 现在它是卡片的兄弟节点，绝对定位盖在角上。
                 */
                <div key={resultKey(image) || index} className="pro-gallery-item">
                <button
                  type="button"
                  onClick={() => openResultOnCanvas(image)}
                  disabled={!ready}
                  title={ready ? "打开这张成片" : "等待生成"}
                  className={cn("pro-gallery-card", resultKey(image) === resultKey(visibleResult ?? image) && ready && "is-selected")}
                >
                  {ready ? (
                    image.mediaType === "video" && image.videoUrl ? (
                      <video src={image.videoUrl} muted playsInline className="h-full w-full object-cover" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resultSrc(image)} alt="生成结果" />
                    )
                  ) : (
                    <div className="pro-gallery-empty">等待生成</div>
                  )}
                  {/*
                    旧版是 SLOT_STATE_LABELS[slotItems[index]?.state]：allResults 按
                    images→tasks 顺序拼接，slotItems 按 tasks 倒序排列，两个数组用同一个
                    下标取值 —— 于是第 3 张成片可能显示第 3 个任务（完全无关）的状态。
                    现在按 id 查，查不到就说明它只存在于本地数组，直接按有无媒体判断。
                  */}
                  <span>{ready ? "已完成" : SLOT_STATE_LABELS[slotStateFor(image)]}</span>
                </button>
                {ready && image.mediaType !== "video" && (
                  <button
                    type="button"
                    className="pro-gallery-download"
                    onClick={() => void downloadResult(image)}
                    aria-label="下载这张成片"
                    title="下载这张成片"
                  >
                    <Download className="h-3 w-3" />
                  </button>
                )}
                </div>
                );
              })}
              {viewerGalleryMode === "assets" && referenceImages.map((image) => (
                <div key={image.id} className="pro-gallery-card">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={image.previewUrl} alt={image.name} />
                  <span>{image.name}</span>
                </div>
              ))}
            </div>
            )}
            {((viewerGalleryMode === "images" && allResults.length === 0) || (viewerGalleryMode === "assets" && referenceImages.length === 0)) && (
              <div className="pro-canvas-empty">
                <Images className="h-8 w-8 text-foreground/45" />
                <span>{viewerGalleryMode === "images" ? "还没有成片" : "还没有参考图"}</span>
                {/*
                  空态的下一步是「去写提示词」，不是「回到画布」——
                  旧版这个按钮把用户送回一个同样空白的画布，等于原地打转。
                */}
                {viewerGalleryMode === "images" ? (
                  <button type="button" onClick={() => executeCommand("focus_prompt")} className="pro-empty-cta">
                    去写画面描述
                  </button>
                ) : (
                  <button type="button" onClick={() => setLeftPanelTab("assets")} className="pro-empty-cta">
                    去添加参考图
                  </button>
                )}
              </div>
            )}
          </div>
        ) : (
          <>
            {visibleResult ? (
              visibleResult.mediaType === "video" && visibleResult.videoUrl ? (
                <video
                  src={visibleResult.videoUrl}
                  controls
                  playsInline
                  onClick={() => setLightboxOpen(true)}
                  className="pro-canvas-media h-full w-full cursor-zoom-in object-contain"
                />
              ) : canvasZoom === "actual" ? (
                <div
                  ref={canvasViewportRef}
                  className="pro-canvas-actual"
                  data-panning={isPanning ? "true" : undefined}
                  onPointerDown={startPan}
                  onPointerMove={movePan}
                  onPointerUp={endPan}
                  onPointerCancel={endPan}
                  onDoubleClick={resetZoom}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={resultSrc(visibleResult)}
                    alt="生成结果"
                    draggable={false}
                    style={{
                      transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
                      transformOrigin: "center center",
                    }}
                  />
                </div>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  ref={baseImageRef}
                  src={resultSrc(visibleResult)}
                  alt="生成结果"
                  onClick={() => setLightboxOpen(true)}
                  className="pro-canvas-media h-full w-full cursor-zoom-in object-contain"
                />
              )
            ) : isLoading || runningSlots > 0 ? (
              /*
                生成中的画布不再是一句「在左侧描述画面，然后生成」——
                那句话在已经点了生成之后是错的，用户看着它会以为自己没点上。
                现在是骨架屏 + 真实进度 + 预计剩余时间。
              */
              <div className="pro-canvas-skeleton" role="status" aria-live="polite">
                <div className="pro-canvas-skeleton-frame" aria-hidden="true" />
                <div className="pro-canvas-skeleton-copy">
                  <strong>正在生成 {runTotal} {runUnit}</strong>
                  <div
                    className="pro-run-progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={runTotal}
                    aria-valuenow={runSettled}
                    aria-label="生成进度"
                  >
                    <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
                  </div>
                  <span>
                    {runSettled} / {runTotal} 已落地
                    {runEtaLabel ? ` · 预计还需 ${runEtaLabel}` : ""}
                  </span>
                </div>
              </div>
            ) : (
              <div className="pro-canvas-empty">
                <Bot className="h-8 w-8 text-foreground/45" />
                <span>在左侧描述画面，然后生成。</span>
                <button type="button" onClick={() => executeCommand("focus_prompt")} className="pro-empty-cta">
                  去写画面描述
                </button>
              </div>
            )}
            {canvasZoom === "fit" && (
              <canvas
                ref={annotationCanvasRef}
                className="pro-annotate-layer"
                data-active={activeCanvasTool !== "select"}
                onPointerDown={handleAnnotationPointerDown}
                onPointerMove={handleAnnotationPointerMove}
                onPointerUp={handleAnnotationPointerUp}
                onPointerCancel={handleAnnotationPointerUp}
                aria-label="画布标注层"
              />
            )}
            {visibleResult && (
              <div className="pro-zoom-toggle" aria-label="画布缩放">
                <button type="button" onClick={() => setCanvasZoom("fit")} className={cn(canvasZoom === "fit" && "is-active")}>
                  适应
                </button>
                <button type="button" onClick={() => setCanvasZoom("actual")} className={cn(canvasZoom === "actual" && "is-active")}>
                  原图大小
                </button>
                {/* 原图模式下把当前倍率写出来：不然滚了半天不知道自己在几倍，也找不到回 100% 的路 */}
                {canvasZoom === "actual" && (
                  <>
                    <button type="button" onClick={() => zoomAtPointer(1 / 1.25)} aria-label="缩小" title="缩小">
                      −
                    </button>
                    <button type="button" onClick={resetZoom} title="回到 100%（双击画布同效）">
                      {Math.round(zoomScale * 100)}%
                    </button>
                    <button type="button" onClick={() => zoomAtPointer(1.25)} aria-label="放大" title="放大">
                      ＋
                    </button>
                  </>
                )}
              </div>
            )}
            {viewableResults.length > 1 && (
              <div className="pro-canvas-pager" role="group" aria-label="切换成片">
                <button type="button" onClick={() => stepResult(-1)} aria-label="上一张（←）" title="上一张（←）">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span aria-live="polite">{visibleResultIndex + 1} / {viewableResults.length}</span>
                <button type="button" onClick={() => stepResult(1)} aria-label="下一张（→）" title="下一张（→）">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            )}
            {/*
              漂移提示不放进 pro-canvas-meta —— 那条信息条默认半透明、鼠标移上去才显形，
              而「你看到的图不是当前设置的结果」正是必须主动撞进视线的一句话。
            */}
            {visibleResult && staleConfigFields.length > 0 && dismissedStaleResultKey !== resultKey(visibleResult) && (
              <div className="pro-canvas-stale" role="status">
                <AlertTriangle className="h-3 w-3" />
                <span>这张图不是当前设置的结果（{staleConfigFields.join("、")}）</span>
                <button type="button" onClick={restoreVisibleResultConfig} title="把编辑器改回产出这张图时的设置">
                  改回这张图的设置
                </button>
                <button
                  type="button"
                  onClick={() => setDismissedStaleResultKey(resultKey(visibleResult))}
                  aria-label="忽略此提示"
                  title="忽略"
                  className="pro-canvas-stale-dismiss"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}
            {visibleResult && (
              <div className="pro-canvas-meta">
                <span>{formatPublicGenerationSummary(visibleResult)}</span>
                {/*
                  下载原本只存在于全屏灯箱里 —— 要拿到文件必须先点开大图再找按钮。
                  成片最常做的一件事不该藏在二级界面。
                */}
                <button type="button" onClick={() => void downloadResult(visibleResult)} title="下载这张成片" aria-label="下载">
                  <Download className="h-3 w-3" />
                </button>
                {!(visibleResult.mediaType === "video") && (
                  <>
                    <button type="button" onClick={() => sendResultToAssets(visibleResult)}>
                      设为参考
                    </button>
                    <button type="button" onClick={() => saveResultToBoard(visibleResult)} title="保存到文件夹">
                      存入文件夹
                    </button>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/*
        成片缩略条。
        旧版画布一次只看得到一张，想看这批里的其他张必须切到「成片墙」——
        而那是一次硬切换：画布、标注、缩放全部离开视线，看完还要再切回来。
        缩略条把「这批有哪些」压在画布下沿，切换成本降到一次点击。
      */}
      {workspaceMode === "canvas" && viewableResults.length > 1 && (
        <div className="pro-film-strip" role="listbox" aria-label="这批成片">
          {viewableResults.map((image, index) => (
            <button
              key={resultKey(image) || index}
              type="button"
              role="option"
              aria-selected={index === visibleResultIndex}
              className={cn(index === visibleResultIndex && "is-active")}
              onClick={() => openResultOnCanvas(image)}
              title={`第 ${index + 1} 张`}
            >
              {image.mediaType === "video" ? (
                <span className="pro-film-strip-video">
                  <Play className="h-3 w-3" />
                </span>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={resultSrc(image)} alt={`第 ${index + 1} 张成片`} draggable={false} />
              )}
              <em>{index + 1}</em>
            </button>
          ))}
        </div>
      )}

      <div className="pro-canvas-dock" id="pro-tour-canvas-tools">
        <div className="pro-tool-strip" role="group" aria-label="画布工具">
          {CANVAS_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              onClick={() => {
                setActiveCanvasTool(tool.id);
                if (workspaceMode !== "canvas") activateWorkspace("canvas");
                if (canvasZoom !== "fit") setCanvasZoom("fit");
                setCanvasNotice(tool.id === "select" ? "" : tool.hint);
              }}
              className={cn(activeCanvasTool === tool.id && "is-active")}
              title={tool.hint}
            >
              {tool.label}
            </button>
          ))}
        </div>
        {/*
          笔粗选择。旧版画笔固定 6px、橡皮固定 26px：圈一只眼睛太粗，
          涂掉一整片背景又太细，只能靠反复描。
        */}
        {activeCanvasTool !== "select" && (
          <div className="pro-brush-strip" role="group" aria-label="笔刷粗细">
            {BRUSH_SIZES.map((size) => (
              <button
                key={size.value}
                type="button"
                aria-pressed={brushSize === size.value}
                title={`${size.label}（${size.value}px）`}
                onClick={() => setBrushSize(size.value)}
                className={cn(brushSize === size.value && "is-active")}
              >
                <span style={{ width: size.dot, height: size.dot }} aria-hidden="true" />
                {size.label}
              </button>
            ))}
          </div>
        )}
        <div className="pro-dock-actions">
          {strokeCount > 0 && (
            <button type="button" onClick={undoAnnotation} title="撤销最后一笔（Ctrl/⌘+Z）">
              <Undo2 className="h-3 w-3" />
              撤销
            </button>
          )}
          {hasAnnotation && (
            <>
              <button type="button" onClick={exportAnnotationToReference} title="把标注设为参考图">
                <ImagePlus className="h-3 w-3" />
                设为参考
              </button>
              <button type="button" onClick={clearAnnotation} title="清空画布上的标注">
                清空标注
              </button>
            </>
          )}
          <button type="button" onClick={() => copyProvenanceConfig(visibleResult)} title="复制当前配置，可稍后导入。">
            <Clipboard className="h-3 w-3" />
            复制配置
          </button>
          {visibleResult && !(visibleResult.mediaType === "video") && (
            <button type="button" onClick={() => sendResultToAssets(visibleResult)} title="把当前成片设为参考图">
              设为参考
            </button>
          )}
        </div>
      </div>
    </main>
  );
});
