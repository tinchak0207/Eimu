"use client";

import { type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { X } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasNode } from "@/lib/canvas/types";
import type { CanvasLod, CanvasStageId, CanvasStageSummary } from "@/lib/canvas/lod";
import type { InspectInput } from "../node-view/node-inspect";
import type { CanvasMenuItem } from "../CanvasContextMenu";
import type { CanvasImageEditMode, CanvasImageEditResult } from "../CanvasImageEditorDialog";
import type { ReviewPanelKind } from "@/components/assets/AssetReviewPanel";
import { reviewShotsFromNodes } from "@/components/assets/ShotReviewPanel";
import type { CharacterCard } from "@/lib/character-cards";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import { type SelectedLora } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import "@/components/canvas-workstation/panels/panels.css";
import { cn } from "@/lib/utils";
import { ENTER_STAGGER_MS, imageUrlOf } from "./embed-helpers";
import { useCanvasInteraction } from "./use-canvas-interaction";
import { useCanvasGeneration } from "./use-canvas-generation";
import { CanvasErrorBoundary } from "../CanvasErrorBoundary";
import { InfiniteCanvas } from "../InfiniteCanvas";
import { CanvasConnections } from "../CanvasConnections";
import { CanvasNodeViewMemo } from "../CanvasNodeView";
import { CanvasMiniMap } from "../CanvasMiniMap";
import { CanvasContextMenu } from "../CanvasContextMenu";
import { CanvasImageEditorDialog } from "../CanvasImageEditorDialog";
import { CanvasZoomControls } from "../CanvasZoomControls";
import { CanvasShortcutsHelp } from "../CanvasShortcutsHelp";
import { CanvasNodeCreateMenu } from "../CanvasNodeCreateMenu";
import { CanvasLibraryPanel } from "../CanvasLibraryPanel";
import { ProjectAssetLibraryPanel } from "@/components/assets/ProjectAssetLibraryPanel";
import { AssetReviewPanel } from "@/components/assets/AssetReviewPanel";
import { ShotReviewPanel } from "@/components/assets/ShotReviewPanel";
import { LoraLibraryPanel } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import { CanvasStageOverview } from "../CanvasStageOverview";
import { CanvasBoardOverview } from "../CanvasBoardOverview";
import { CanvasEngineeringPanel } from "../CanvasEngineeringPanel";
import { CanvasEmbedOverlays } from "./CanvasEmbedOverlays";

interface CanvasEmbedViewProps {
  height: string;
  expanded: boolean;
  onClose?: () => void;
  onToggleExpand?: () => void;
  canvas: UseCanvasChatReturn;
  interaction: ReturnType<typeof useCanvasInteraction>;
  generation: Pick<ReturnType<typeof useCanvasGeneration>, "isGenerating" | "upscalingIds" | "extractingFramesIds" | "handleGenerateFromNode" | "stopGeneration" | "retryNode" | "upscaleNode" | "extractFramesFromNode">;
  containerRef: MutableRefObject<HTMLDivElement | null>;
  viewportSize: { width: number; height: number };
  viewportSizeRef: MutableRefObject<{ width: number; height: number }>;
  canvasStateRef: MutableRefObject<UseCanvasChatReturn>;
  reduceMotion: boolean;
  lod: CanvasLod;
  allowEngineering: boolean;
  blend: { gather: number; xray: number; board: number };
  stageSummaries: CanvasStageSummary[];
  gatherOffsetMap: Map<string, { x: number; y: number; stage: CanvasStageId }>;
  boardNodeIds: Set<string>;
  boardInputMap: Map<string, InspectInput[]>;
  visibleNodes: CanvasNode[];
  nodeById: Map<string, CanvasNode>;
  childToParent: Map<string, string>;
  nodeScale: number;
  nodesRemountedRef: MutableRefObject<boolean>;
  adjacentIds: Set<string>;
  highlightNodeId: string | null;
  pendingPath: string | null;
  gatherRaw: number;
  gatherEased: number;
  gatherLook: { move: number; scale: number; opacity: number; blur: number };
  xray: number;
  focusStage: CanvasStageId | null;
  engineeringNodeId: string | null;
  setEngineeringNodeId: Dispatch<SetStateAction<string | null>>;
  promptPanelNodeId: string | null;
  setPromptPanelNodeId: Dispatch<SetStateAction<string | null>>;
  panelEntityIds: string[];
  setPanelEntityIds: Dispatch<SetStateAction<string[]>>;
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  minimapOpen: boolean;
  setMinimapOpen: Dispatch<SetStateAction<boolean>>;
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  libraryOpen: boolean;
  setLibraryOpen: Dispatch<SetStateAction<boolean>>;
  loraPanelOpen: boolean;
  setLoraPanelOpen: Dispatch<SetStateAction<boolean>>;
  selectedLora: SelectedLora | null;
  setSelectedLora: Dispatch<SetStateAction<SelectedLora | null>>;
  cardsOpen: boolean;
  setCardsOpen: Dispatch<SetStateAction<boolean>>;
  creationFlowOpen: boolean;
  setCreationFlowOpen: Dispatch<SetStateAction<boolean>>;
  projectAssetsOpen: boolean;
  setProjectAssetsOpen: Dispatch<SetStateAction<boolean>>;
  elementListOpen: boolean;
  setElementListOpen: Dispatch<SetStateAction<boolean>>;
  isLoggedIn: boolean;
  libraryLoggedIn: boolean;
  reviewPanel: ReviewPanelKind | null;
  setReviewPanel: Dispatch<SetStateAction<ReviewPanelKind | null>>;
  reviewShots: ReturnType<typeof reviewShotsFromNodes>;
  reviewPendingCount: number;
  interactionMode: AgentInteractionMode;
  menuItems: (CanvasMenuItem | "separator")[];
  handleContainerPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  handleDrop: (e: React.DragEvent<HTMLDivElement>) => void;
  handleSelectStage: (stage: CanvasStageSummary) => void;
  handleReviewStage: (stage: CanvasStageSummary) => void;
  handleSelectLod: (level: CanvasLod) => void;
  openEngineering: (nodeId: string) => void;
  referenceCandidatesFor: (nodeId: string) => { nodeId: string; title: string; previewUrl: string }[];
  entityCandidatesFor: (nodeId: string) => { cardId: string; name: string; kind: CharacterCard["kind"]; kindLabel: string; previewUrl: string }[];
  shotEntityCardIdsFor: (nodeId: string) => string[];
  handleRerun: (nodeId: string) => Promise<void>;
  handleEditWorkflowNode: (nodeId: string, patch: Record<string, unknown>) => Promise<void>;
  handleRegenerateAsset: (cardId: string, referenceIndex: number) => Promise<{ url: string; costCoins?: number } | null>;
  handleReplaceAsset: (cardId: string, referenceIndex: number, file: File) => Promise<boolean>;
  handleRejectAsset: (cardId: string, reason: string) => Promise<void>;
  handleApproveAllAssets: (cardIds: readonly string[]) => Promise<void>;
  handleRejectShot: (shotId: string, reason: string) => void;
  handleApproveAllShots: (shotIds: readonly string[]) => void;
  handleEditorProduce: (results: CanvasImageEditResult[], _mode: CanvasImageEditMode) => void;
  generateChildFromSource: (sourceId: string, title: string, params: { prompt: string; referenceUrls?: string[] }) => void;
}

export function CanvasEmbedView({ P }: { P: CanvasEmbedViewProps }) {
  const {
    height, expanded, onClose, onToggleExpand, canvas, interaction, generation, containerRef, viewportSize,
    viewportSizeRef, canvasStateRef, reduceMotion, lod, allowEngineering, blend, stageSummaries, gatherOffsetMap,
    boardNodeIds, boardInputMap, visibleNodes, nodeById, childToParent, nodeScale, nodesRemountedRef, adjacentIds, highlightNodeId,
    pendingPath, gatherRaw, gatherEased, gatherLook, xray, focusStage, engineeringNodeId, setEngineeringNodeId, promptPanelNodeId,
    setPromptPanelNodeId, panelEntityIds, setPanelEntityIds, historyOpen, setHistoryOpen, minimapOpen, setMinimapOpen,
    helpOpen, setHelpOpen, libraryOpen, setLibraryOpen, loraPanelOpen, setLoraPanelOpen, selectedLora, setSelectedLora,
    cardsOpen, setCardsOpen, creationFlowOpen, setCreationFlowOpen, projectAssetsOpen, setProjectAssetsOpen,
    elementListOpen, setElementListOpen, isLoggedIn, libraryLoggedIn, reviewPanel, setReviewPanel, reviewShots,
    reviewPendingCount, interactionMode, menuItems, handleContainerPointerMove, handleDrop, handleSelectStage,
    handleReviewStage, handleSelectLod, openEngineering, referenceCandidatesFor, entityCandidatesFor,
    shotEntityCardIdsFor, handleRerun, handleEditWorkflowNode, handleRegenerateAsset, handleReplaceAsset,
    handleRejectAsset, handleApproveAllAssets, handleRejectShot, handleApproveAllShots, handleEditorProduce,
    generateChildFromSource,
  } = P;
  const {
    selectedIds, setSelectedIds, selectedConnectionId, setSelectedConnectionId, setHoveredNodeId, menu, setMenu,
    connecting, setConnecting, portDrag, createMenu, setCreateMenu, editor, setEditor, panelRefIds, setPanelRefIds,
    actionError, setActionError, showError, connectingRef, modifiersRef, screenToWorld, screenInContainer,
    clearSelection, handleSelectNode, handleNodeClick, handleMarqueeSelect, handleNodeMove, handleDeleteNode,
    downloadNode, downloadBatch, createNodeAt, startPortDrag, handleCreateFromMenu, handleCreateMenuUpload,
    handleImportScene3d, openNodeMenu, openCanvasMenu,
  } = P.interaction;
  const {
    isGenerating, upscalingIds, extractingFramesIds, handleGenerateFromNode, stopGeneration, retryNode,
    upscaleNode, extractFramesFromNode,
  } = P.generation;

  const hasNodes = canvas.nodes.length > 0;
  // 透析卡的即时萤幕矩形（client 座标）：面板 FLIP 起讫点与光束起点，飞行途中每帧跟著走。
  const engineeringNode = engineeringNodeId ? nodeById.get(engineeringNodeId) ?? null : null;
  const containerBox = engineeringNode ? containerRef.current?.getBoundingClientRect() : undefined;
  const engineeringAnchor =
    engineeringNode && containerBox
      ? {
          left: containerBox.left + canvas.viewport.x + engineeringNode.position.x * canvas.viewport.k,
          top: containerBox.top + canvas.viewport.y + engineeringNode.position.y * canvas.viewport.k,
          width: engineeringNode.width * canvas.viewport.k,
          height: engineeringNode.height * canvas.viewport.k,
        }
      : null;
  const editorNode = editor ? nodeById.get(editor.nodeId) : undefined;
  const editorUrl = imageUrlOf(editorNode);
  const pendingOps = canvas.pendingAgentOps;

  return (
    <CanvasErrorBoundary>
      <div
        ref={containerRef}
        className={cn("ce-embed-root relative w-full overflow-hidden", !expanded && "ce-compact")}
        onPointerDownCapture={(e) => {
          modifiersRef.current = { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey };
        }}
        onPointerMove={handleContainerPointerMove}
        onDragOver={(e) => {
          if (e.dataTransfer?.types?.includes("Files")) e.preventDefault();
        }}
        onDrop={handleDrop}
      >
        <InfiniteCanvas
          viewport={canvas.viewport}
          backgroundMode={canvas.backgroundMode}
          onViewportChange={canvas.setViewport}
          className={expanded ? "touch-none" : "touch-pan-y"}
          onBackgroundPointerDown={() => {
            if (connectingRef.current) setConnecting(null);
            setMenu(null);
            setCreateMenu(null);
            setPromptPanelNodeId(null);
            clearSelection();
          }}
          onMarqueeSelect={handleMarqueeSelect}
          onCanvasContextMenu={openCanvasMenu}
          onCanvasDoubleClick={(screen, world) => setCreateMenu({ position: screen, world })}
          contentStyle={
            {
              "--lod-g": String(gatherLook.move),
              "--lod-node-scale": String(gatherLook.scale),
              "--lod-node-opacity": String(gatherLook.opacity),
              "--lod-blur": `${gatherLook.blur}px`,
              "--lod-xray": String(xray),
            } as React.CSSProperties
          }
          contentData={{
            "data-lod-gathering": gatherEased > 0 ? "" : undefined,
            "data-lod-blur": gatherLook.blur > 0 && canvas.nodes.length <= 150 ? "" : undefined,
            "data-lod-inert": gatherEased > 0.35 ? "" : undefined,
            "data-focus-stage": focusStage !== null ? String(focusStage) : undefined,
            "data-eng-focus": engineeringNodeId ? "" : undefined,
            // 拆机：卡面（背板）开始掀；过半后卡面不再吃指针，点击落到板上。
            "data-lod-xray": xray > 0 ? "" : undefined,
            "data-lod-xray-open": xray > 0.6 ? "" : undefined,
          }}
        >
          {/* LOD 1 鸟瞰层：完全收束（gather=1）才卸载节点与连线；收束途中它们正往阶段质心飞。 */}
          {gatherRaw < 1 && (
          <>
          <CanvasConnections
            interactive={gatherEased === 0}
            nodes={canvas.nodes}
            connections={canvas.connections}
            activeNodeId={highlightNodeId}
            selectedConnectionId={selectedConnectionId}
            onSelectConnection={(id) => {
              setSelectedConnectionId(id);
              setSelectedIds(new Set());
              canvasStateRef.current.selectNode(null);
            }}
            onConnectionContextMenu={(id, clientX, clientY) => {
              setSelectedConnectionId(id);
              setMenu({ position: screenInContainer(clientX, clientY), world: screenToWorld(clientX, clientY) ?? { x: 0, y: 0 }, targetNodeId: null, targetConnectionId: id });
            }}
            pendingPath={pendingPath}
          />
          {visibleNodes.map((node: CanvasNode, index: number) => {
            const url = imageUrlOf(node);
            const parentId = childToParent.get(node.id);
            const isWorkflowNode = !!(node.metadata?.workflow_id && node.metadata?.session_id);
            const primaryChild = node.batchPrimaryImageId ? nodeById.get(node.batchPrimaryImageId) : undefined;
            return (
              <CanvasNodeViewMemo
                key={node.id}
                node={node}
                scale={nodeScale}
                selected={selectedIds.has(node.id) || canvas.selectedNodeId === node.id}
                adjacent={adjacentIds.has(node.id)}
                onSelect={handleSelectNode}
                onNodeClick={handleNodeClick}
                onHoverChange={(nid, hovered) => setHoveredNodeId((prev) => (hovered ? nid : prev === nid ? null : prev))}
                onInteractionStart={canvas.commitInteraction}
                onMove={handleNodeMove}
                onResize={canvas.resizeNode}
                onDelete={handleDeleteNode}
                onRerun={isWorkflowNode ? (id) => void handleRerun(id) : undefined}
                onEdit={isWorkflowNode ? (id, patch) => void handleEditWorkflowNode(id, patch) : undefined}
                enterDelay={reduceMotion || nodesRemountedRef.current ? 0 : Math.min(index, 8) * ENTER_STAGGER_MS}
                onEditPrompt={(nodeId) => setPromptPanelNodeId(nodeId)}
                promptPanelOpen={promptPanelNodeId === node.id}
                onClosePromptPanel={() => setPromptPanelNodeId(null)}
                onGenerateFromNode={(nodeId, prompt, options) =>
                  void handleGenerateFromNode(nodeId, prompt, { ...options, entityCardIds: panelEntityIds })
                }
                isGenerating={isGenerating}
                onStopGenerate={stopGeneration}
                onOpenPromptLibrary={() => setLibraryOpen(true)}
                referenceCandidates={promptPanelNodeId === node.id ? referenceCandidatesFor(node.id) : undefined}
                selectedReferenceIds={promptPanelNodeId === node.id ? panelRefIds : undefined}
                onToggleReference={(refId) =>
                  setPanelRefIds((prev) => (prev.includes(refId) ? prev.filter((id) => id !== refId) : [...prev, refId]))
                }
                entityCandidates={promptPanelNodeId === node.id ? entityCandidatesFor(node.id) : undefined}
                shotEntityCardIds={promptPanelNodeId === node.id ? shotEntityCardIdsFor(node.id) : undefined}
                selectedEntityIds={promptPanelNodeId === node.id ? panelEntityIds : undefined}
                onToggleEntity={(cardId) =>
                  setPanelEntityIds((prev) => (prev.includes(cardId) ? prev.filter((id) => id !== cardId) : [...prev, cardId]))
                }
                batchExpanded={node.batchExpanded}
                batchChildCount={node.batchChildren?.length}
                onToggleBatch={(nid) => canvas.toggleBatchExpanded(nid)}
                batchPrimaryImageUrl={imageUrlOf(primaryChild) ?? undefined}
                onDownloadAll={(node.batchChildren?.length ?? 0) > 0 ? (nid) => void downloadBatch(nid) : undefined}
                onSetPrimary={parentId ? (nid) => canvas.setBatchPrimary(parentId, nid) : undefined}
                onDownload={url ? (nid) => void downloadNode(nid) : undefined}
                onEditImage={url ? (nid) => setEditor({ nodeId: nid, mode: "crop" }) : undefined}
                onUpscale={url?.startsWith("http") ? (nid) => void upscaleNode(nid) : undefined}
                upscaling={upscalingIds.has(node.id)}
                // 影片取帧（2026-09-28）：仅 https 影片节点给按钮（本地/空内容不给「必定失败」的死按钮）。
                onExtractVideoFrames={
                  node.type === CanvasNodeType.Video && node.metadata?.content?.startsWith("https://")
                    ? (nid, action, atSec) => void extractFramesFromNode(nid, action, atSec)
                    : undefined
                }
                extractingVideoFrames={extractingFramesIds.has(node.id)}
                onStartConnect={(nid) => setConnecting({ sourceId: nid, cursor: null })}
                onStartPortDrag={startPortDrag}
                onNodeContextMenu={openNodeMenu}
                onRename={canvas.renameNode}
                onUpdateText={(nid, text) => canvas.patchNodeMetadata(nid, { content: text })}
                onUpdateReferenceRole={(nid, role) => canvas.patchNodeMetadata(nid, { referenceRole: role })}
                onPatchMetadata={(nid, patch) => canvas.patchNodeMetadata(nid, patch)}
                onRetry={
                  node.metadata?.status === "error"
                    ? isWorkflowNode
                      ? node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Prompt
                        ? (id) => void handleRerun(id) // workflow 节点（含配音/视频卡）走网关真重跑；text/config 网关本就拒跑不给按钮
                        : undefined
                      : node.metadata?.prompt
                        ? retryNode // A12 图片重试：仅当参数确实存过
                        : undefined // 没参数就不渲染按钮，不出「必定失败」的死按钮
                    : undefined
                }
                lod={lod}
                onOpenEngineering={openEngineering}
                gatherOffset={gatherOffsetMap.get(node.id)}
                stageId={gatherOffsetMap.get(node.id)?.stage ?? null}
                xrayVisible={boardNodeIds.has(node.id)}
                boardInputs={boardInputMap.get(node.id)}
                engineeringFocused={engineeringNodeId === node.id}
              />
            );
          })}
          </>
          )}
        </InfiniteCanvas>

        {/* 语义缩放上层：LOD1-3 阶段层 / LOD0 画布层。同一时刻只挂一层（避免两层叠影）；
            显隐由既有 lod 状态机驱动（lod = nextLod(k)，k 是唯一真源），不新增第二套状态机。 */}
        {hasNodes && lod >= 1 && (
          <CanvasStageOverview
            stages={stageSummaries}
            gather={gatherRaw}
            viewport={canvas.viewport}
            size={viewportSize}
            interactive={lod === 1}
            wide={allowEngineering}
            reduceMotion={reduceMotion}
            projectTitle={canvas.projectTitle}
            onSelectStage={handleSelectStage}
            onReviewStage={handleReviewStage}
          />
        )}

        {lod === 0 && (
          <CanvasBoardOverview
            boards={canvas.canvasList ?? []}
            board={blend.board}
            activeNodes={canvas.nodes}
            activeCanvasId={canvas.activeCanvasId ?? null}
            size={viewportSize}
            interactive={lod === 0}
            wide={allowEngineering}
            reduceMotion={reduceMotion}
            onSwitchCanvas={canvas.switchCanvas}
          />
        )}

        {/* 右下角小框：常驻（收起＝画布名胶囊／展开＝小地图＋画布名下拉切换）。 */}
        <CanvasMiniMap
          nodes={canvas.nodes}
          viewport={canvas.viewport}
          viewportSize={viewportSize}
          onJumpTo={(world) => canvas.centerOn(world, viewportSize.width, viewportSize.height)}
          canvases={canvas.canvasList ?? []}
          activeCanvasId={canvas.activeCanvasId ?? null}
          onSwitchCanvas={canvas.switchCanvas}
          open={minimapOpen}
          onOpenChange={setMinimapOpen}
          className="bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))]"
        />

        {/* A9：缩放控件（全屏态；minimap 上方） */}
        {expanded && (
          <CanvasZoomControls
            scale={canvas.viewport.k}
            onZoomTo={(k) => {
              const size = viewportSizeRef.current;
              canvas.setViewport((prev) => {
                const cx = size.width / 2;
                const cy = size.height / 2;
                const wx = (cx - prev.x) / prev.k;
                const wy = (cy - prev.y) / prev.k;
                return { x: cx - wx * k, y: cy - wy * k, k };
              });
            }}
            onFit={() => {
              const size = viewportSizeRef.current;
              if (size.width > 0) canvas.fitView(size.width, size.height);
            }}
            onHelp={() => setHelpOpen(true)}
            minimapOpen={minimapOpen}
            onToggleMinimap={canvas.nodes.length > 1 ? () => setMinimapOpen((v) => !v) : undefined}
            reviewActive={reviewPanel !== null}
            reviewPendingCount={reviewPendingCount}
            onToggleReview={() => setReviewPanel((prev) => (prev === "asset" ? null : "asset"))}
            lod={lod}
            allowEngineering={allowEngineering}
            onSelectLod={handleSelectLod}
            className="absolute right-[calc(1rem+env(safe-area-inset-right,0px))] top-1/2 z-10 -translate-y-1/2 max-md:hidden"
          />
        )}

        {/* 顶部薄条 */}
        <div
          className="ce-embed-topbar pointer-events-none absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2"
          style={{
            left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
            top: "calc(0.75rem + env(safe-area-inset-top, 0px))",
          }}
        >
          <span className="ce-embed-title-pill lg-float rounded-full px-2.5 py-1 text-ios-caption1 font-medium text-muted-foreground max-md:hidden">
            画布
          </span>
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-pressed={expanded}
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
            >
              {expanded ? "收合" : "展开"}
            </button>
          )}
          <button
            type="button"
            onClick={() => canvas.newCanvasSession()}
            aria-label="新建画布"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            新建画布
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              if (next) void canvas.refreshSavedProjects();
            }}
            aria-expanded={historyOpen}
            aria-haspopup="listbox"
            aria-label="历史画布"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            历史画布
          </button>
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            aria-label="提示词库与素材"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            资源库
          </button>
          {/* LoRA 库（2026-08-27 自专业工作站迁入）：与资源库同层入口 */}
          <button
            type="button"
            onClick={() => setLoraPanelOpen(true)}
            aria-label="LoRA 模型库"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            LoRA{selectedLora ? " · 1" : ""}
          </button>
          {/* P2：角色/场景卡——badge 数字 = 当前锁定生效的卡数 */}
          <button
            type="button"
            onClick={() => setCardsOpen((v) => !v)}
            aria-pressed={cardsOpen}
            aria-label="角色与场景卡"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            角色卡{canvas.activeCardIds.length > 0 ? ` · ${canvas.activeCardIds.length}` : ""}
          </button>
          {/* REQ-B2 团队资产空间：项目资产库（资产包 + 资产卡的作用域/挂用/显式分享入口） */}
          <button
            type="button"
            onClick={() => setProjectAssetsOpen((v) => !v)}
            aria-pressed={projectAssetsOpen}
            aria-label="项目资产库"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            项目资产
          </button>
          {/* G2（2026-09-16）：作品/剧集——badge 数字 = 剧集数，当前步骤显示在面板内 */}
          <button
            type="button"
            onClick={() => setCreationFlowOpen((v) => !v)}
            aria-pressed={creationFlowOpen}
            aria-label="作品与剧集"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
          >
            作品{canvas.episodes.length > 0 ? ` · ${canvas.episodes.length} 集` : ""}
          </button>
          {expanded && (
            <button
              type="button"
              onClick={() => setElementListOpen((v) => !v)}
              aria-pressed={elementListOpen}
              aria-label="节点清单"
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue max-md:hidden"
            >
              节点清单
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭画布，回到图片结果"
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-foreground/70 hover:bg-white hover:text-foreground active:bg-white aria-pressed:bg-ios-blue/10 aria-pressed:text-ios-blue aria-expanded:bg-ios-blue/10 aria-expanded:text-ios-blue"
            >
              关闭画布
            </button>
          )}
        </div>

        {/* 连线模式提示 */}
        {(connecting || portDrag) && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-ios-blue/90 px-3 py-1.5 text-ios-caption1 font-medium text-white shadow-md">
            {portDrag ? "拖到目标节点成线 · 松手在空白处新建节点" : "点击目标节点完成连线 · Esc 取消"}
          </div>
        )}

        {/* 浮层（agent 状态提示 / 角色卡 / 历史画布 / 节点清单）+ .ce-embed-* 样式块（须无条件挂载，壳层顶栏样式依赖它） */}
        <CanvasEmbedOverlays
          height={height}
          expanded={expanded}
          pendingOps={pendingOps}
          cardsOpen={cardsOpen}
          creationFlowOpen={creationFlowOpen}
          onCloseCreationFlow={() => setCreationFlowOpen(false)}
          historyOpen={historyOpen}
          onCloseHistory={() => setHistoryOpen(false)}
          elementListOpen={elementListOpen}
          reviewPanel={reviewPanel}
          reviewPendingCount={reviewPendingCount}
          onToggleReview={(panel) => setReviewPanel((prev) => (prev === panel ? null : panel))}
          canvas={canvas}
          viewportSizeRef={viewportSizeRef}
          setSelectedIds={setSelectedIds}
        />

        {/* 操作错误/提示 */}
        {actionError && (
          <div
            role="alert"
            className="pointer-events-auto absolute bottom-4 left-1/2 z-30 flex max-w-[85%] -translate-x-1/2 items-center gap-2 rounded-full bg-black/90 px-4 py-2 text-ios-caption1 font-medium text-white shadow-lg"
          >
            <span className="min-w-0 truncate">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="关闭提示" className="shrink-0 opacity-80 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* 右键选单 / 建节点选单 */}
        <CanvasContextMenu open={!!menu} position={menu?.position ?? { x: 0, y: 0 }} items={menuItems} onClose={() => setMenu(null)} />
        <CanvasNodeCreateMenu
          open={!!createMenu}
          position={createMenu?.position ?? { x: 0, y: 0 }}
          onClose={() => setCreateMenu(null)}
          onCreate={handleCreateFromMenu}
          onUploadFiles={handleCreateMenuUpload}
          onImportScene3d={handleImportScene3d}
          title={createMenu?.connectFrom ? "连接到新节点" : "新建节点"}
        />

        {!hasNodes && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="ce-embed-empty lg-float rounded-ios-2xl px-4 py-2 text-muted-foreground">
              双击空白新建节点，或拖入图片开始 · agent 生成会自动落到这里
            </p>
          </div>
        )}
      </div>

      {/* 快捷键帮助 / 资源库 / 图片编辑器（overflow 外层渲染） */}
      <CanvasShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* REQ-B2：项目资产库（专案 id 由 hook 的 getProjectId 直读，未建号则面板显示空态） */}
      {/* 2026-10-09：面板只剩「打项目标签／只看本项目标签」——打标签后靠 onTagsChange 重读卡库，
          让打了本项目标签的资产当场进生成注入（旧挂用交互已删，不再锁副本进 cardIds）。 */}
      <ProjectAssetLibraryPanel
        open={projectAssetsOpen}
        onClose={() => setProjectAssetsOpen(false)}
        projectId={canvas.getProjectId()}
        isLoggedIn={isLoggedIn}
        onTagsChange={canvas.refreshCharacterCards}
      />
      {/* WS-审查（2026-09-24）：资产／分镜审查面板（同一颗画布入口 + 步骤条的外开介面；
          决策 2：全自动档下这两个面板可看可改、不阻塞流程——面板本身不挡任何生成路径） */}
      <AssetReviewPanel
        open={reviewPanel === "asset"}
        onClose={() => setReviewPanel(null)}
        cards={canvas.characterCards}
        activeCardIds={canvas.activeCardIds}
        interactionMode={interactionMode}
        modelId={DEFAULT_IMAGE_MODEL_ID}
        onRegenerate={handleRegenerateAsset}
        onReplace={handleReplaceAsset}
        onReject={handleRejectAsset}
        onApproveAll={handleApproveAllAssets}
        onSwitchToShots={() => setReviewPanel("shot")}
      />
      {/* 语义缩放 LOD 3：工程透析面板（节点被删 → nodeById 取不到即不渲染） */}
      {engineeringNode && (
        <CanvasEngineeringPanel
          key={engineeringNode.id}
          node={engineeringNode}
          anchor={engineeringAnchor}
          reduceMotion={reduceMotion}
          onClose={() => setEngineeringNodeId(null)}
        />
      )}
      <ShotReviewPanel
        open={reviewPanel === "shot"}
        onClose={() => setReviewPanel(null)}
        shots={reviewShots}
        interactionMode={interactionMode}
        onReject={handleRejectShot}
        onApproveAll={handleApproveAllShots}
        onSwitchToAssets={() => setReviewPanel("asset")}
      />
      <CanvasLibraryPanel
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        onInsertText={(text, title) => {
          const vp = canvasStateRef.current.viewport;
          const center = {
            x: (viewportSizeRef.current.width / 2 - vp.x) / vp.k,
            y: (viewportSizeRef.current.height / 2 - vp.y) / vp.k,
          };
          createNodeAt("text", center, { content: text, title: title || "提示词" });
        }}
        onInsertImage={(url, title) => {
          const vp = canvasStateRef.current.viewport;
          const center = {
            x: (viewportSizeRef.current.width / 2 - vp.x) / vp.k,
            y: (viewportSizeRef.current.height / 2 - vp.y) / vp.k,
          };
          createNodeAt("image", center, { content: url, title: title || "素材" });
        }}
        onUsePrompt={
          promptPanelNodeId
            ? (prompt) => {
                // 填进当前节点面板：写入节点 metadata 后重开面板（面板读 initialPrompt）。
                const nid = promptPanelNodeId;
                canvasStateRef.current.patchNodeMetadata(nid, { prompt }, { history: false });
                setPromptPanelNodeId(null);
                window.setTimeout(() => setPromptPanelNodeId(nid), 0);
                setLibraryOpen(false);
              }
            : undefined
        }
        onApplyRecipeTemplate={
          promptPanelNodeId
            ? (config, label) => {
                // 配方模板（2026-08-27 自专业工作站迁入）：六槽里的 prompt 填进当前
                // 节点面板（与 onUsePrompt 同一写入路径）；模型槽在 agent 模式由
                // agent 依参数回流处理，这里不越权切模型。
                const nid = promptPanelNodeId;
                if (typeof config.prompt === "string" && config.prompt.trim()) {
                  canvasStateRef.current.patchNodeMetadata(nid, { prompt: config.prompt }, { history: false });
                }
                setPromptPanelNodeId(null);
                window.setTimeout(() => setPromptPanelNodeId(nid), 0);
                setLibraryOpen(false);
                showError(`已套用配方「${label}」`);
              }
            : undefined
        }
        isLoggedIn={libraryLoggedIn}
      />
      {/* LoRA 库（2026-08-27 自专业工作站迁入）：同款右侧滑入面板，选中即注入生成 */}
      {loraPanelOpen && (
        <div
          data-canvas-interactive
          role="dialog"
          aria-label="LoRA 模型库"
          className="fixed bottom-0 right-0 top-0 z-[90] flex w-[min(400px,94vw)] flex-col lg-sheet overflow-y-auto"
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-white/80 px-4 py-3 backdrop-blur">
            <h2 className="text-sm font-semibold text-foreground">LoRA 模型库</h2>
            <button
              type="button"
              onClick={() => setLoraPanelOpen(false)}
              title="关闭"
              className="flex h-7 w-7 items-center justify-center rounded-md text-foreground/45 hover:bg-black/5"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 p-4">
            <LoraLibraryPanel value={selectedLora} onChange={setSelectedLora} />
          </div>
        </div>
      )}
      {editor && editorUrl && editorNode && (
        <CanvasImageEditorDialog
          open
          imageUrl={editorUrl}
          nodeTitle={editorNode.title}
          initialMode={editor.mode}
          onClose={() => setEditor(null)}
          onProduce={handleEditorProduce}
          onRequestAngleGenerate={(params) => {
            const nid = editor.nodeId;
            setEditor(null);
            generateChildFromSource(nid, "角度重绘", { prompt: params.anglePrompt });
          }}
          onRequestInpaint={(params) => {
            const nid = editor.nodeId;
            setEditor(null);
            generateChildFromSource(nid, "AI 重绘", {
              prompt: `${params.instruction}（仅修改蒙版标记的区域，其余部分保持原样）`,
              referenceUrls: [params.maskDataUrl],
            });
          }}
        />
      )}
    </CanvasErrorBoundary>
  );
}
