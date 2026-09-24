"use client";

// CanvasEmbed —— 畫布嵌合（v5）：agent 對話右側結果面板的畫布渲染模式。
//
// v5（2026-08-16，ABCD 全波）在 v4（多選/框選/快捷鍵/右鍵/批次/編輯器）之上：
//   A1 port 拖線：節點左右圓點拖出虛線，鬆手在節點=成線（含環路阻止）、
//      鬆手在空白=就地建節點選單並自動連線（工作流像藤蔓生長）
//   A2 點選即面板：乾淨點擊節點直接吊出生成面板；生成中可「停止」
//   A4 空節點=生成落地位：空圖片節點 count=1 結果原地回填，不另建節點
//   A6 雙擊空白=建節點選單（桌面）；A8 拖圖入畫布/系統剪貼簿貼圖
//   A7 鄰接高亮：hover/選中 → 上下游連線與節點同時點亮
//   A5 連線可選可刪；A9 縮放控件+快捷鍵幫助；A12 失敗就地重試（參數不丟）
//   B1 視口裁剪（±280px 才渲染）；B2 節點清單+450ms 飛行聚焦；B3 縮略圖降採樣
//   C  agent 操作確認閘：canvas.ops 先彈卡（允许/拒绝/本次会话自动允许），
//      執行後結果回流 gateway；run_generation 由本層代跑
//   D  提示詞庫/雲端素材庫面板接線；編輯器角度重繪/AI 重繪回調接生成管線
//
// 2026-08-22 域拆分（docs/plans/2026-08-22-large-file-refactor.md Task 7）：
// 純函數/類型 → embed/embed-helpers.ts、交互域 → embed/use-canvas-interaction.ts、
// 生成編排 → embed/use-canvas-generation.ts、鍵盤/剪貼簿 → embed/use-canvas-shortcuts.ts、
// 右鍵選單 → embed/context-menu-items.ts、浮層+樣式 → embed/CanvasEmbedOverlays.tsx。
// 本檔保留組件殼 + 節點掛載（visibleNodes.map 的 CanvasNodeView）+ 頂欄。
//
// 認證立場：生成/超分走 Bearer + x-user-id（與 playground 同款 getStoredToken），
// 未登入誠實報錯，不假裝能生成。

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { X } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import type { CanvasGenerationReference } from "@/lib/canvas/semantic-nodes";
import { bezierPath } from "@/lib/canvas/layout";
import { InfiniteCanvas } from "./InfiniteCanvas";
import { CanvasConnections } from "./CanvasConnections";
import { CanvasNodeView } from "./CanvasNodeView";
import { CanvasMiniMap } from "./CanvasMiniMap";
import { CanvasContextMenu, type CanvasMenuItem } from "./CanvasContextMenu";
import { CanvasImageEditorDialog, type CanvasImageEditMode, type CanvasImageEditResult } from "./CanvasImageEditorDialog";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { CanvasShortcutsHelp } from "./CanvasShortcutsHelp";
import { CanvasNodeCreateMenu } from "./CanvasNodeCreateMenu";
import { CanvasLibraryPanel } from "./CanvasLibraryPanel";
import { ProjectAssetLibraryPanel } from "@/components/assets/ProjectAssetLibraryPanel";
// WS-審查（2026-09-24 能力建設）：資產／分鏡審查面板 + 純轉換（批准狀態一律經面板導出的純函式組裝，
// 不在宿主重寫第二份形狀）。外部開啟介面＝`openReviewPanel()` 派 CustomEvent，本檔掛監聽。
import {
  AssetReviewPanel,
  REVIEW_PANEL_OPEN_EVENT,
  applyReplaceReference,
  buildAssetRegeneratePayload,
  reviewSummary,
  type ReviewPanelKind,
  type ReviewPanelOpenDetail,
} from "@/components/assets/AssetReviewPanel";
import { ShotReviewPanel, reviewShotsFromNodes, shotApprovalFor } from "@/components/assets/ShotReviewPanel";
// 批准狀態（路 1 落地的真源）：寫入走 setApproval、分鏡側清洗走 shotApprovalFor（內部即 normalizeApprovalState）。
import { setApproval } from "@/lib/character-cards";
import type { ApprovalState } from "@/lib/character-cards";
import { DEFAULT_AGENT_SETTINGS, getAgentSettings } from "@/lib/agent-chat-client";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import type { CanvasNodeMetadata } from "@/lib/canvas/types";
import { LoraLibraryPanel, type SelectedLora } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import "@/components/canvas-workstation/panels/panels.css";
import { cn } from "@/lib/utils";
import { AGENT_AUTO_APPROVE_KEY, CULL_MARGIN_PX, ENTER_STAGGER_MS, buildAuthHeaders, fileToDataUrl, imageUrlOf } from "./embed/embed-helpers";
import { useCanvasInteraction } from "./embed/use-canvas-interaction";
import { useCanvasGeneration } from "./embed/use-canvas-generation";
import { useCanvasShortcuts } from "./embed/use-canvas-shortcuts";
import { buildCanvasEmbedMenuItems } from "./embed/context-menu-items";
import { CanvasEmbedOverlays } from "./embed/CanvasEmbedOverlays";
import { CHARACTER_CARD_KIND_LABEL } from "@/lib/character-cards";
import { shotEntityCardIdsFromMetadata } from "./CanvasNodePromptPanel";

export interface CanvasEmbedProps {
  /** useCanvasChat 的完整 return（chat 部分由宿主另外用，這裡只用畫布部分）。 */
  canvas: UseCanvasChatReturn;
  /** embed 高度；不傳則撐滿父容器。 */
  height?: string;
  /** 面板關閉（回到 ImageDisplay 模式）時觸發。 */
  onClose?: () => void;
  /** 全屏展開態：頂部薄條改顯示「收合」。 */
  expanded?: boolean;
  /** 展開/收合切換：compact 時顯示「展开」、全屏時顯示「收合」。 */
  onToggleExpand?: () => void;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    setReduced(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

export function CanvasEmbed({ canvas, height = "100%", onClose, expanded = false, onToggleExpand }: CanvasEmbedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const viewportSizeRef = useRef(viewportSize);
  viewportSizeRef.current = viewportSize;
  const didFitRef = useRef(false);
  const lastFitCountRef = useRef(0);
  const { fitView } = canvas;
  const reduceMotion = usePrefersReducedMotion();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [promptPanelNodeId, setPromptPanelNodeId] = useState<string | null>(null);
  // 面板行內 @ 引用的素材卡 id（與 panelRefIds 同級同生命週期；生成時收窄參考集）。
  const [panelEntityIds, setPanelEntityIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // LoRA 庫（2026-08-27 自專業工作站遷入）：同款滑入面板，選中結果注入生成鏈路。
  const [loraPanelOpen, setLoraPanelOpen] = useState(false);
  const [selectedLora, setSelectedLora] = useState<SelectedLora | null>(null);
  const [elementListOpen, setElementListOpen] = useState(false);
  // P2：角色/場景卡面板（左側彈出，與歷史畫布/節點清單同模式）。
  const [cardsOpen, setCardsOpen] = useState(false);
  // G2（2026-09-16）：作品/劇集面板（同款左側彈層；資料取自 hook 三欄出口 + nodes）。
  const [creationFlowOpen, setCreationFlowOpen] = useState(false);
  // REQ-B2 團隊資產空間：項目資產庫面板（右側滑入，同資源庫/角色卡同款彈層語彙）。
  const [projectAssetsOpen, setProjectAssetsOpen] = useState(false);
  // WS-審查（2026-09-24）：資產／分鏡審查面板（null＝關）。兩個面共用一顆畫布工具列入口。
  const [reviewPanel, setReviewPanel] = useState<ReviewPanelKind | null>(null);
  // 互動檔位（決策 1/2）：只有協作檔才是停點；全自動檔下審查面板可看可改、不阻塞流程。
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>(DEFAULT_AGENT_SETTINGS.interaction_mode);
  const [agentAutoApprove, setAgentAutoApprove] = useState(false);

  // ── 最新值 refs（組件殼域）
  const canvasStateRef = useRef(canvas);
  canvasStateRef.current = canvas;
  const promptPanelRef = useRef(promptPanelNodeId);
  promptPanelRef.current = promptPanelNodeId;

  // ── 派生索引
  const nodeById = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const n of canvas.nodes) map.set(n.id, n);
    return map;
  }, [canvas.nodes]);

  const childToParent = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of canvas.nodes) {
      for (const childId of n.batchChildren ?? []) map.set(childId, n.id);
    }
    return map;
  }, [canvas.nodes]);

  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen]);

  useEffect(() => {
    setAgentAutoApprove(window.localStorage.getItem(AGENT_AUTO_APPROVE_KEY) === "1");
  }, []);

  /** 檔位回讀（網關為準，失敗靜默落預設——與 getAgentSettings 自身契約一致，永不 reject）。 */
  useEffect(() => {
    let cancelled = false;
    void getAgentSettings().then((settings) => {
      if (!cancelled) setInteractionMode(settings.interaction_mode);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 外部開啟介面（決策 10 的第二個門，步驟條由另一路實作）：
   * 監聽 `REVIEW_PANEL_OPEN_EVENT`，把 `openReviewPanel({ panel })` 的請求翻成面板狀態。
   * 沒有宿主掛載時呼叫端拿不到任何回應——`openReviewPanel()` 已在該處聲明「回傳 true 只代表事件已派發」。
   */
  useEffect(() => {
    const handleOpen = (event: Event) => {
      const detail = (event as CustomEvent<ReviewPanelOpenDetail>).detail;
      setReviewPanel(detail?.panel === "shot" ? "shot" : "asset");
    };
    window.addEventListener(REVIEW_PANEL_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(REVIEW_PANEL_OPEN_EVENT, handleOpen);
  }, []);

  useEffect(() => {
    if (canvas.nodes.length === 0 || viewportSize.width === 0 || viewportSize.height === 0) return;
    if (!didFitRef.current) {
      didFitRef.current = true;
      const isFreshViewport = canvas.viewport.x === 0 && canvas.viewport.y === 0 && canvas.viewport.k === 1;
      if (isFreshViewport) fitView(viewportSize.width, viewportSize.height);
      return;
    }
    if (!expanded && canvas.nodes.length !== lastFitCountRef.current) {
      lastFitCountRef.current = canvas.nodes.length;
      const t = setTimeout(() => {
        fitView(viewportSize.width, viewportSize.height);
      }, 400);
      return () => clearTimeout(t);
    }
  }, [canvas.nodes.length, viewportSize.width, viewportSize.height, canvas.viewport, fitView, expanded]);

  const handleSizeChange = useCallback((size: { width: number; height: number }) => {
    setViewportSize((prev) => (prev.width === size.width && prev.height === size.height ? prev : size));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => handleSizeChange({ width: el.clientWidth, height: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleSizeChange]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) fitView(rect.width, rect.height);
    }, 80);
    return () => clearTimeout(t);
  }, [expanded, fitView]);

  // 批次收起 → 子節點隱藏；B1 視口裁剪 → 螢幕外 ±280px 不渲染。
  const visibleNodes = useMemo(() => {
    const vp = canvas.viewport;
    const cullEnabled = viewportSize.width > 0 && canvas.nodes.length > 24;
    const pad = CULL_MARGIN_PX / vp.k;
    const worldLeft = -vp.x / vp.k - pad;
    const worldTop = -vp.y / vp.k - pad;
    const worldRight = worldLeft + viewportSize.width / vp.k + pad * 2;
    const worldBottom = worldTop + viewportSize.height / vp.k + pad * 2;
    return canvas.nodes.filter((n) => {
      const parentId = childToParent.get(n.id);
      if (parentId && nodeById.get(parentId)?.batchExpanded === false) return false;
      if (!cullEnabled) return true;
      return (
        n.position.x + n.width >= worldLeft &&
        n.position.x <= worldRight &&
        n.position.y + n.height >= worldTop &&
        n.position.y <= worldBottom
      );
    });
  }, [canvas.nodes, canvas.viewport, viewportSize, childToParent, nodeById]);

  // ── 交互域（選取/框選/連線/埠拖拽/對齊/下載/建節點/右鍵選單定位；L227-237 交互 state 與鏡像 refs 由 hook 持有並回傳）
  const interaction = useCanvasInteraction({
    canvasStateRef,
    containerRef,
    visibleNodes,
    childToParent,
    setPromptPanelNodeId,
  });
  const {
    selectedIds,
    setSelectedIds,
    selectedConnectionId,
    setSelectedConnectionId,
    hoveredNodeId,
    setHoveredNodeId,
    menu,
    setMenu,
    connecting,
    setConnecting,
    portDrag,
    setPortDrag,
    createMenu,
    setCreateMenu,
    editor,
    setEditor,
    panelRefIds,
    setPanelRefIds,
    actionError,
    setActionError,
    showError,
    selectedIdsRef,
    connectingRef,
    portDragRef,
    menuRef,
    editorRef,
    selectedConnectionRef,
    createMenuRef,
    clipboardRef,
    modifiersRef,
    screenToWorld,
    screenInContainer,
    clearSelection,
    handleSelectNode,
    handleNodeClick,
    handleMarqueeSelect,
    handleNodeMove,
    handleDeleteNode,
    deleteSelected,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    alignSelection,
    distributeSelection,
    arrangeSelection,
    downloadNode,
    downloadBatch,
    createNodeAt,
    importImageFiles,
    startPortDrag,
    handleCreateFromMenu,
    handleCreateMenuUpload,
    openNodeMenu,
    openCanvasMenu,
    saveNodeAsCard,
  } = interaction;

  /** A7：鄰接集合（hover 優先，退回選中主節點）。 */
  const highlightNodeId = hoveredNodeId ?? canvas.selectedNodeId;

  // ── 生成編排域（A4 原地回填 / 批次子節點 / A12 重試 / 停止 / 高清放大 / agent 代跑）
  const {
    isGenerating,
    upscalingIds,
    callCanvasGenerate,
    generateIntoNode,
    handleGenerateFromNode,
    stopGeneration,
    retryNode,
    upscaleNode,
    runAgentGeneration,
  } = useCanvasGeneration({
    canvasStateRef,
    viewportSizeRef,
    showError,
    panelRefIds,
    setPromptPanelNodeId,
    setPanelRefIds,
    setPanelEntityIds,
    setSelectedIds,
    selectedLora,
  });

  // ── 鍵盤快捷鍵 + 系統剪貼簿（A8）
  useCanvasShortcuts({
    canvasStateRef,
    containerRef,
    viewportSizeRef,
    clipboardRef,
    editorRef,
    promptPanelRef,
    selectedIdsRef,
    selectedConnectionRef,
    connectingRef,
    portDragRef,
    menuRef,
    createMenuRef,
    setPortDrag,
    setConnecting,
    setCreateMenu,
    setMenu,
    setPromptPanelNodeId,
    setSelectedConnectionId,
    setSelectedIds,
    clearSelection,
    copySelection,
    pasteClipboard,
    duplicateSelection,
    deleteSelected,
    importImageFiles,
    createNodeAt,
  });

  const adjacentIds = useMemo(() => {
    const set = new Set<string>();
    if (!highlightNodeId) return set;
    for (const c of canvas.connections) {
      if (c.fromNodeId === highlightNodeId) set.add(c.toNodeId);
      if (c.toNodeId === highlightNodeId) set.add(c.fromNodeId);
    }
    return set;
  }, [canvas.connections, highlightNodeId]);

  // ── 舊 workflow 節點動作（站點代理 → 網關 /workflow/node/rerun|update；
  // 舊 /api/internal/workflow/* 路徑在站點從不存在，生產 404，已廢棄）
  const handleRerun = useCallback(async (nodeId: string) => {
    const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
    const workflowId = node?.metadata?.workflow_id;
    const sessionId = node?.metadata?.session_id;
    if (!workflowId || !sessionId) return;
    try {
      const response = await fetch(`/api/agent/sessions/${sessionId}/workflow-node-rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(buildAuthHeaders() ?? {}) },
        body: JSON.stringify({ session_id: sessionId, workflow_id: workflowId, node_id: nodeId, request_id: crypto.randomUUID() }),
      });
      if (!response.ok) showError(`重跑失败：${await response.text().then((t) => t.slice(0, 120))}`);
    } catch {
      showError("重跑请求失败");
    }
  }, [showError]);

  const handleEditWorkflowNode = useCallback(async (nodeId: string, patch: Record<string, unknown>) => {
    const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
    const workflowId = node?.metadata?.workflow_id;
    const sessionId = node?.metadata?.session_id;
    if (!workflowId || !sessionId) return;
    try {
      const response = await fetch(`/api/agent/sessions/${sessionId}/workflow-node-update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(buildAuthHeaders() ?? {}) },
        body: JSON.stringify({ session_id: sessionId, workflow_id: workflowId, node_id: nodeId, patch, request_id: crypto.randomUUID() }),
      });
      if (!response.ok) showError(`更新失败：${await response.text().then((t) => t.slice(0, 120))}`);
    } catch {
      showError("更新请求失败");
    }
  }, [showError]);

  // ── D：存入素材庫
  const saveNodeToAssets = useCallback(
    async (nodeId: string) => {
      const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const url = imageUrlOf(node);
      const isText = node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Prompt;
      const content = node.metadata?.content ?? node.metadata?.prompt ?? "";
      if (!url && !(isText && content.trim())) {
        showError("该节点没有可保存的内容");
        return;
      }
      try {
        const res = await fetch("/api/canvas/assets", {
          method: "PUT",
          headers: { "Content-Type": "application/json", ...(buildAuthHeaders() ?? {}) },
          body: JSON.stringify({
            id: `node-${nodeId}`,
            kind: url ? "image" : "text",
            title: node.title,
            ...(url ? { imageUrl: url } : { content }),
            tags: ["画布"],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }),
        });
        const body = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
        if (!res.ok || !body?.success) throw new Error(body?.error || (res.status === 401 ? "请先登录" : "保存失败"));
        showError("已存入素材库");
      } catch (error) {
        showError(error instanceof Error ? error.message : "保存失败");
      }
    },
    [showError],
  );

  const menuItems = useMemo(
    (): (CanvasMenuItem | "separator")[] =>
      buildCanvasEmbedMenuItems({
        menu,
        nodeById,
        childToParent,
        visibleNodes,
        upscalingIds,
        selectedIdsRef,
        canvasStateRef,
        clipboardRef,
        viewportSizeRef,
        alignSelection,
        distributeSelection,
        arrangeSelection,
        setSelectedConnectionId,
        setCreateMenu,
        pasteClipboard,
        setSelectedIds,
        setLibraryOpen,
        setHelpOpen,
        setPromptPanelNodeId,
        handleRerun,
        retryNode,
        setConnecting,
        copySelection,
        duplicateSelection,
        saveNodeAsCard,
        saveNodeToAssets,
        setEditor,
        upscaleNode,
        downloadNode,
        downloadBatch,
        handleDeleteNode,
        deleteSelected,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, nodeById, childToParent, visibleNodes, upscalingIds, saveNodeAsCard],
  );

  // ── 連線模式（工具列 Link2）游標跟隨
  const handleContainerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!connectingRef.current) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) setConnecting((prev) => (prev ? { ...prev, cursor: world } : prev));
  }, [screenToWorld, connectingRef]);

  const pendingPath = useMemo(() => {
    const active = portDrag?.cursor
      ? { sourceId: portDrag.sourceId, cursor: portDrag.cursor, side: portDrag.side }
      : connecting?.cursor
        ? { sourceId: connecting.sourceId, cursor: connecting.cursor, side: "right" as const }
        : null;
    if (!active) return null;
    const source = nodeById.get(active.sourceId);
    if (!source) return null;
    const cursorNode: CanvasNode = {
      id: "__cursor__",
      type: CanvasNodeType.Text,
      title: "",
      position: active.cursor,
      width: 0,
      height: 0,
    };
    return active.side === "left" ? bezierPath(cursorNode, source) : bezierPath(source, cursorNode);
  }, [portDrag, connecting, nodeById]);

  useEffect(() => {
    setPanelRefIds([]);
    setPanelEntityIds([]);
  }, [promptPanelNodeId]);

  const referenceCandidatesFor = useCallback(
    (nodeId: string) =>
      canvas.connections
        .filter((c) => c.toNodeId === nodeId)
        .map((c) => nodeById.get(c.fromNodeId))
        .filter((n): n is CanvasNode => !!n && !!imageUrlOf(n))
        .map((n) => ({ nodeId: n.id, title: n.title, previewUrl: imageUrlOf(n)! })),
    [canvas.connections, nodeById],
  );

  /**
   * @ 可引用的素材卡候選 = 項目鎖定且過作用域裁決的卡（activeCharacterCards）。
   * 語義是「全畫布可用」，不是「只連上游的卡」；音頻卡不做視覺引用故濾掉。
   * nodeId 參數只為與 referenceCandidatesFor 同形（呼叫端條件式寫法照抄）。
   */
  const entityCandidatesFor = useCallback(
    (nodeId: string) =>
      canvas.activeCharacterCards
        .filter((card) => card.kind !== "audio")
        .map((card) => ({
          cardId: card.id,
          name: card.name,
          kind: card.kind,
          kindLabel: CHARACTER_CARD_KIND_LABEL[card.kind],
          previewUrl: card.references[0]?.url ?? "",
        })),
    [canvas.activeCharacterCards],
  );

  /**
   * 本鏡節點 metadata 已指定的實體卡 id（character/scene/prop 三欄聯集去重）。
   * 供 prompt 面板「本镜参考素材」清單的 shot 來源；節點沒指定時為空陣列（既有行為不變）。
   * 推導本體在 CanvasNodePromptPanel.shotEntityCardIdsFromMetadata（純函式，可直測）。
   */
  const shotEntityCardIdsFor = useCallback(
    (nodeId: string): string[] => shotEntityCardIdsFromMetadata(nodeById.get(nodeId)?.metadata),
    [nodeById],
  );

  // ── WS-審查（2026-09-24）：資產／分鏡審查域的接線
  // 分鏡列＝畫布節點投影（純函式在面板檔內，可單測）；場景名由外層 Group 的 storyboardScene 解析。
  const reviewShots = useMemo(
    () =>
      reviewShotsFromNodes(canvas.nodes, {
        connections: canvas.connections,
        sceneNameOf: (nodeId) => {
          const parentId = childToParent.get(nodeId);
          return parentId ? nodeById.get(parentId)?.metadata?.storyboardScene?.sceneName : undefined;
        },
      }),
    [canvas.nodes, canvas.connections, childToParent, nodeById],
  );
  /** 入口徽章＝待批准＋已駁回的總數（僅顯示，不構成任何阻塞）。 */
  const reviewPendingCount = useMemo(() => {
    const cards = reviewSummary(canvas.characterCards);
    const shots = reviewSummary(reviewShots);
    return cards.pending + cards.rejected + shots.pending + shots.rejected;
  }, [canvas.characterCards, reviewShots]);

  /** 逐張重生成（決策 11：不過扣費確認卡，直接扣）。落地＝覆蓋該格原圖（決策 6）。 */
  const handleRegenerateAsset = useCallback(
    async (cardId: string, referenceIndex: number): Promise<{ url: string; costCoins?: number } | null> => {
      const state = canvasStateRef.current;
      const card = state.characterCards.find((c) => c.id === cardId);
      if (!card) return null;
      if (!card.prompt.trim()) {
        showError("这张资产没有描述，先补上描述再重新生成");
        return null;
      }
      const controller = new AbortController();
      try {
        // cards: [] ＝明確關閉卡注入：卡的片段與參考圖已在本 payload 內顯式給定，
        // 再注入一次會讓「要被換掉的那張圖」同時當參考（把錯誤傳染給新圖）。
        const images = await callCanvasGenerate(
          buildAssetRegeneratePayload(card, referenceIndex, DEFAULT_IMAGE_MODEL_ID),
          controller.signal,
          { cards: [], referenceScope: "all" },
        );
        const image = images[0];
        if (!image?.url) return null;
        const saved = await state.upsertCharacterCard(applyReplaceReference(card, referenceIndex, image.url));
        if (!saved) {
          // 圖生了但沒寫回卡片＝不算成功（不謊報；原圖未動，用戶可重試）
          showError("新图已生成但写回卡片失败，原图未改动");
          return null;
        }
        return { url: image.url, ...(typeof image.cost_coins === "number" ? { costCoins: image.cost_coins } : {}) };
      } catch (error) {
        showError(error instanceof Error ? error.message : "重新生成失败");
        return null;
      }
    },
    [callCanvasGenerate, canvasStateRef, showError],
  );

  /** 用戶上傳自有素材＝直接覆蓋原圖（決策 6）；壓縮走既有的 `fileToDataUrl` 輪子（原地不改既有函式）。 */
  const handleReplaceAsset = useCallback(
    async (cardId: string, referenceIndex: number, file: File): Promise<boolean> => {
      const state = canvasStateRef.current;
      const card = state.characterCards.find((c) => c.id === cardId);
      if (!card) return false;
      try {
        const { dataUrl } = await fileToDataUrl(file);
        const saved = await state.upsertCharacterCard(applyReplaceReference(card, referenceIndex, dataUrl));
        if (!saved) showError("上传成功但写回卡片失败，请重试");
        return saved;
      } catch (error) {
        showError(error instanceof Error ? error.message : "上传失败");
        return false;
      }
    },
    [canvasStateRef, showError],
  );

  /** 駁回（決策 4）：寫狀態與理由後停下——不重生成、不花錢。寫入走真源 `setApproval`。 */
  const handleRejectAsset = useCallback(
    async (cardId: string, reason: string) => {
      const state = canvasStateRef.current;
      const card = state.characterCards.find((c) => c.id === cardId);
      if (!card) return;
      const saved = await state.upsertCharacterCard(setApproval(card, "rejected", { reason }));
      if (!saved) showError("驳回状态没写回卡片，请重试");
    },
    [canvasStateRef, showError],
  );

  /** 整批一鍵批准（決策 3）：逐筆套同一動作；失敗逐筆如實報，不謊報整批成功。 */
  const handleApproveAllAssets = useCallback(
    async (cardIds: readonly string[]) => {
      const state = canvasStateRef.current;
      let failed = 0;
      for (const id of cardIds) {
        const card = state.characterCards.find((c) => c.id === id);
        if (!card) continue;
        if (!(await state.upsertCharacterCard(setApproval(card, "approved")))) failed += 1;
      }
      if (failed > 0) showError(`${failed} 张资产的批准没写回，请重试`);
    },
    [canvasStateRef, showError],
  );

  /**
   * 分鏡批准狀態寫入（路 1 的凍結欄位；清洗走 `shotApprovalFor` → 真源 `normalizeApprovalState`）。
   * **依賴聲明**：`CanvasNodeMetadata` 目前尚未白名單 `approval` 鍵（`layout.ts toNodeMetadata`
   * 會在外層丟掉未列鍵，雙白名單另一端是 `canvas-chat-types.compactMetadataForAgent`）——
   * 該鍵的持久化屬資料層（路 1），本片只負責寫進節點 metadata 並如實回報此依賴。
   */
  const patchShotApproval = useCallback(
    (nodeId: string, approval: ApprovalState) => {
      canvasStateRef.current.patchNodeMetadata(nodeId, { approval } as Partial<CanvasNodeMetadata>);
    },
    [canvasStateRef],
  );

  const handleRejectShot = useCallback(
    (shotId: string, reason: string) => {
      const approval = shotApprovalFor("rejected", reason);
      if (approval) patchShotApproval(shotId, approval);
    },
    [patchShotApproval],
  );

  const handleApproveAllShots = useCallback(
    (shotIds: readonly string[]) => {
      const approval = shotApprovalFor("approved");
      if (!approval) return;
      for (const shotId of shotIds) patchShotApproval(shotId, approval);
    },
    [patchShotApproval],
  );

  // ── A8：拖檔案入畫布
  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY) ?? { x: 40, y: 40 };
      void importImageFiles(files, world);
    },
    [screenToWorld, importImageFiles],
  );

  // ── 編輯器產物 → 子節點插回
  const handleEditorProduce = useCallback((results: CanvasImageEditResult[], _mode: CanvasImageEditMode) => {
    const ed = editorRef.current;
    const state = canvasStateRef.current;
    if (!ed) return;
    const source = state.nodes.find((n) => n.id === ed.nodeId);
    if (!source) return;
    const ts = Date.now().toString(36);
    const newNodes: CanvasNode[] = results.map((r, i) => {
      const width = 300;
      const heightRaw = r.width > 0 ? Math.round((width * r.height) / r.width) : 220;
      return {
        id: `${ed.nodeId}-ed-${ts}-${i}`,
        type: CanvasNodeType.Image,
        title: `${source.title} · ${r.label}`,
        position: {
          x: source.position.x + source.width + 60 + (i % 3) * (width + 24),
          y: source.position.y + Math.floor(i / 3) * 260,
        },
        width,
        height: Math.min(Math.max(heightRaw, 120), 460),
        moved: true,
        metadata: {
          content: r.dataUrl,
          status: "success",
          naturalWidth: r.width,
          naturalHeight: r.height,
          source_image: imageUrlOf(source) ?? undefined,
        },
      };
    });
    const newConns: CanvasConnection[] = newNodes.map((n) => ({
      id: `conn-${ed.nodeId}-${n.id}`,
      fromNodeId: ed.nodeId,
      toNodeId: n.id,
    }));
    state.addNodes(newNodes, newConns);
    setSelectedIds(new Set(newNodes.map((n) => n.id)));
    if (newNodes.length > 0) state.selectNode(newNodes[0].id);
  }, [editorRef, canvasStateRef, setSelectedIds]);

  /** D：角度 AI 重繪 / mask AI 重繪 → 生成 loading 子節點 → 原地回填。 */
  const generateChildFromSource = useCallback(
    (sourceId: string, title: string, params: { prompt: string; referenceUrls?: string[] }) => {
      const state = canvasStateRef.current;
      const source = state.nodes.find((n) => n.id === sourceId);
      const sourceUrl = imageUrlOf(source);
      if (!source || !sourceUrl) return;
      const id = `${sourceId}-ai-${Date.now().toString(36)}`;
      const child: CanvasNode = {
        id,
        type: CanvasNodeType.Image,
        title: `${source.title} · ${title}`,
        position: { x: source.position.x + source.width + 60, y: source.position.y },
        width: source.width,
        height: source.height,
        moved: true,
        metadata: { status: "loading", prompt: params.prompt, source_image: sourceUrl },
      };
      state.addNodes([child], [{ id: `conn-${sourceId}-${id}`, fromNodeId: sourceId, toNodeId: id }]);
      const references: CanvasGenerationReference[] = (params.referenceUrls ?? []).map((url) => ({
        url,
        role: "general",
        name: "reference",
      }));
      void generateIntoNode(id, { prompt: params.prompt, sourceImage: sourceUrl, references });
    },
    [generateIntoNode, canvasStateRef],
  );

  // ── Wave C：agent 操作確認閘
  const approveAgentOps = useCallback(() => {
    const { runGeneration } = canvasStateRef.current.applyAgentOps();
    runAgentGeneration(runGeneration);
  }, [runAgentGeneration, canvasStateRef]);

  const handleToggleAgentAutoApprove = useCallback((checked: boolean) => {
    setAgentAutoApprove(checked);
    window.localStorage.setItem(AGENT_AUTO_APPROVE_KEY, checked ? "1" : "0");
  }, []);

  // 自動允許開啟時：ops 一到即執行（信任已由用戶顯式授予並可隨時關閉）。
  useEffect(() => {
    if (!canvas.pendingAgentOps || !agentAutoApprove) return;
    approveAgentOps();
  }, [canvas.pendingAgentOps, agentAutoApprove, approveAgentOps]);

  const hasNodes = canvas.nodes.length > 0;
  const editorNode = editor ? nodeById.get(editor.nodeId) : undefined;
  const editorUrl = imageUrlOf(editorNode);
  const pendingOps = canvas.pendingAgentOps;

  return (
    <>
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
        >
          <CanvasConnections
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
              <CanvasNodeView
                key={node.id}
                node={node}
                scale={canvas.viewport.k}
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
                enterDelay={reduceMotion ? 0 : Math.min(index, 8) * ENTER_STAGGER_MS}
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
                onStartConnect={(nid) => setConnecting({ sourceId: nid, cursor: null })}
                onStartPortDrag={startPortDrag}
                onNodeContextMenu={openNodeMenu}
                onRename={canvas.renameNode}
                onUpdateText={(nid, text) => canvas.patchNodeMetadata(nid, { content: text })}
                onUpdateReferenceRole={(nid, role) => canvas.patchNodeMetadata(nid, { referenceRole: role })}
                onRetry={
                  node.metadata?.status === "error"
                    ? isWorkflowNode
                      ? node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Prompt
                        ? (id) => void handleRerun(id) // workflow 節點（含配音/視頻卡）走網關真重跑；text/config 網關本就拒跑不給按鈕
                        : undefined
                      : node.metadata?.prompt
                        ? retryNode // A12 圖片重試：僅當參數確實存過
                        : undefined // 沒參數就不渲染按鈕，不出「必定失敗」的死按鈕
                    : undefined
                }
              />
            );
          })}
        </InfiniteCanvas>

        {canvas.nodes.length > 1 && expanded && (
          <CanvasMiniMap
            nodes={canvas.nodes}
            viewport={canvas.viewport}
            viewportSize={viewportSize}
            onJumpTo={(world) => canvas.centerOn(world, viewportSize.width, viewportSize.height)}
            className="bottom-[calc(1rem+env(safe-area-inset-bottom,0px))] right-[calc(1rem+env(safe-area-inset-right,0px))]"
          />
        )}

        {/* A9：縮放控件（全屏態；minimap 上方） */}
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
            className="absolute right-[calc(1rem+env(safe-area-inset-right,0px))] top-1/2 z-10 -translate-y-1/2 max-md:hidden"
          />
        )}

        {/* 頂部薄條 */}
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
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
            >
              {expanded ? "收合" : "展开"}
            </button>
          )}
          <button
            type="button"
            onClick={() => canvas.newCanvasSession()}
            aria-label="新建画布"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
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
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            历史画布
          </button>
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            aria-label="提示词库与素材"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            资源库
          </button>
          {/* LoRA 庫（2026-08-27 自專業工作站遷入）：與资源库同層入口 */}
          <button
            type="button"
            onClick={() => setLoraPanelOpen(true)}
            aria-label="LoRA 模型库"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            LoRA{selectedLora ? " · 1" : ""}
          </button>
          {/* P2：角色/場景卡——badge 數字 = 當前鎖定生效的卡數 */}
          <button
            type="button"
            onClick={() => setCardsOpen((v) => !v)}
            aria-pressed={cardsOpen}
            aria-label="角色与场景卡"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            角色卡{canvas.activeCardIds.length > 0 ? ` · ${canvas.activeCardIds.length}` : ""}
          </button>
          {/* REQ-B2 團隊資產空間：項目資產庫（資產包 + 資產卡的作用域/掛用/顯式分享入口） */}
          <button
            type="button"
            onClick={() => setProjectAssetsOpen((v) => !v)}
            aria-pressed={projectAssetsOpen}
            aria-label="项目资产库"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            项目资产
          </button>
          {/* G2（2026-09-16）：作品/劇集——badge 數字 = 劇集數，當前步驟顯示在面板內 */}
          <button
            type="button"
            onClick={() => setCreationFlowOpen((v) => !v)}
            aria-pressed={creationFlowOpen}
            aria-label="作品与剧集"
            className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
          >
            作品{canvas.episodes.length > 0 ? ` · ${canvas.episodes.length} 集` : ""}
          </button>
          {expanded && (
            <button
              type="button"
              onClick={() => setElementListOpen((v) => !v)}
              aria-pressed={elementListOpen}
              aria-label="节点清单"
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white max-md:hidden"
            >
              节点清单
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭画布，回到图片结果"
              className="ce-embed-bar-btn lg-float pointer-events-auto cursor-pointer rounded-full font-medium text-ios-blue hover:bg-white active:bg-white"
            >
              关闭画布
            </button>
          )}
        </div>

        {/* 連線模式提示 */}
        {(connecting || portDrag) && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-ios-blue/90 px-3 py-1.5 text-[12.5px] font-medium text-white shadow-md">
            {portDrag ? "拖到目标节点成线 · 松手在空白处新建节点" : "点击目标节点完成连线 · Esc 取消"}
          </div>
        )}

        {/* 浮層（agent 確認閘 / 角色卡 / 歷史畫布 / 節點清單）+ .ce-embed-* 樣式塊（須無條件掛載，殼層頂欄樣式依賴它） */}
        <CanvasEmbedOverlays
          height={height}
          expanded={expanded}
          pendingOps={pendingOps}
          agentAutoApprove={agentAutoApprove}
          onToggleAgentAutoApprove={handleToggleAgentAutoApprove}
          onApproveAgentOps={approveAgentOps}
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

        {/* 操作錯誤/提示 */}
        {actionError && (
          <div
            role="alert"
            className="pointer-events-auto absolute bottom-4 left-1/2 z-30 flex max-w-[85%] -translate-x-1/2 items-center gap-2 rounded-full bg-black/90 px-4 py-2 text-[12.5px] font-medium text-white shadow-lg"
          >
            <span className="min-w-0 truncate">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="关闭提示" className="shrink-0 opacity-80 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* 右鍵選單 / 建節點選單 */}
        <CanvasContextMenu open={!!menu} position={menu?.position ?? { x: 0, y: 0 }} items={menuItems} onClose={() => setMenu(null)} />
        <CanvasNodeCreateMenu
          open={!!createMenu}
          position={createMenu?.position ?? { x: 0, y: 0 }}
          onClose={() => setCreateMenu(null)}
          onCreate={handleCreateFromMenu}
          onUploadFiles={handleCreateMenuUpload}
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

      {/* 快捷鍵幫助 / 資源庫 / 圖片編輯器（overflow 外層渲染） */}
      <CanvasShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      {/* REQ-B2：項目資產庫（專案 id 由 hook 的 getProjectId 直讀，未建號則面板顯示空態） */}
      {/* REQ-B2b：掛用＝copy-on-use——面板把副本 id 交回來，這裡鎖進項目 cardIds（生成注入讀的就是它） */}
      <ProjectAssetLibraryPanel
        open={projectAssetsOpen}
        onClose={() => setProjectAssetsOpen(false)}
        projectId={canvas.getProjectId()}
        isLoggedIn={Boolean(buildAuthHeaders())}
        onCopyChange={canvas.applyMountCopyChange}
      />
      {/* WS-審查（2026-09-24）：資產／分鏡審查面板（同一顆畫布入口 + 步驟條的外開介面；
          決策 2：全自動檔下這兩個面板可看可改、不阻塞流程——面板本身不擋任何生成路徑） */}
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
                // 填進當前節點面板：寫入節點 metadata 後重開面板（面板讀 initialPrompt）。
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
                // 配方模板（2026-08-27 自專業工作站遷入）：六槽裡的 prompt 填進當前
                // 節點面板（與 onUsePrompt 同一寫入路徑）；模型槽在 agent 模式由
                // agent 依參數回流處理，這裡不越權切模型。
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
        isLoggedIn={(() => {
          const headers = buildAuthHeaders();
          return Boolean(headers);
        })()}
      />
      {/* LoRA 庫（2026-08-27 自專業工作站遷入）：同款右側滑入面板，選中即注入生成 */}
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
    </>
  );
}
