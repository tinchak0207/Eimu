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
// 認證立場：生成/超分走 Bearer + x-user-id（與 playground 同款 getStoredToken），
// 未登入誠實報錯，不假裝能生成。

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasConnection, type CanvasNode, type CanvasPosition } from "@/lib/canvas/types";
import {
  composeGenerationPrompt,
  mergeGenerationReferences,
  resolveGenerationInputs,
  type CanvasGenerationReference,
} from "@/lib/canvas/semantic-nodes";
import { toReferenceImageRole } from "@/lib/image-types";
import type { ReferenceImageRole } from "@/lib/image-types";
import { applyCharacterCardsToPayload } from "@/lib/character-cards";
import type { CardAwareGeneratePayload, CharacterCard, CharacterCardKind } from "@/lib/character-cards";
import { bezierPath } from "@/lib/canvas/layout";
import { createBatchChildNode } from "@/lib/canvas/batch-utils";
import {
  alignNodes,
  arrangeGrid,
  cloneForPaste,
  distributeNodes,
  nodesInRect,
  type AlignMode,
  type WorldRect,
} from "@/lib/canvas/interaction";
import { getStoredToken, getStoredUser } from "@/lib/new-api-client";
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
import { cn } from "@/lib/utils";

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

/** 同一批節點進場的間隔（ms）。 */
const ENTER_STAGGER_MS = 110;
/** B1 視口裁剪的螢幕外緩衝（px）。 */
const CULL_MARGIN_PX = 280;
/** 拖圖/多檔導入的階梯錯位（px）。 */
const IMPORT_STAGGER = 40;
/** agent 自動允許的 localStorage key（會話級信任開關）。 */
const AGENT_AUTO_APPROVE_KEY = "canvas-agent-auto-approve";

function toDvh(height: string): string {
  return height.replace(/vh/g, "dvh");
}

function formatRelative(updatedAt: string): string {
  const ts = Date.parse(updatedAt);
  if (!Number.isFinite(ts)) return "";
  const diff = Date.now() - ts;
  if (diff < 0) return "刚刚";
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return new Date(ts).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
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

/** 節點的可下載/可編輯圖片 URL（僅 http(s)/data:）；image 與 reference 節點。 */
function imageUrlOf(node: CanvasNode | undefined): string | null {
  const content = node?.metadata?.content;
  if (!content) return null;
  if (node?.type !== CanvasNodeType.Image && node?.type !== CanvasNodeType.Reference) return null;
  return content.startsWith("http") || content.startsWith("data:") ? content : null;
}

function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || "image";
}

async function fetchImageBlob(url: string): Promise<Blob> {
  if (url.startsWith("data:")) {
    return (await fetch(url)).blob();
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`获取失败（${res.status}）`);
    return await res.blob();
  } catch {
    const res = await fetch(`/api/canvas/image-proxy?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error(`图片获取失败（${res.status}）`);
    return res.blob();
  }
}

function triggerDownload(blob: Blob, filename: string) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
}

function buildAuthHeaders(): Record<string, string> | null {
  const token = getStoredToken();
  const user = getStoredUser();
  if (!token || !user?.id) return null;
  return { Authorization: `Bearer ${token}`, "x-user-id": String(user.id) };
}

/** 本地圖片檔 → 壓縮 dataURL（browser-image-compression，1600px/1.5MB 上限）。 */
async function fileToDataUrl(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const { default: imageCompression } = await import("browser-image-compression");
  const compressed = await imageCompression(file, { maxWidthOrHeight: 1600, maxSizeMB: 1.5, useWebWorker: true });
  const dataUrl = await imageCompression.getDataUrlFromFile(compressed);
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = dataUrl;
  });
  return { dataUrl, ...size };
}

/** 環路檢查：from→to 加入後是否成環（to 沿出邊可達 from）。 */
function wouldCreateCycle(connections: CanvasConnection[], fromId: string, toId: string): boolean {
  const out = new Map<string, string[]>();
  for (const c of connections) out.set(c.fromNodeId, [...(out.get(c.fromNodeId) ?? []), c.toNodeId]);
  const queue = [toId];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === fromId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of out.get(cur) ?? []) queue.push(next);
  }
  return false;
}

interface MenuState {
  position: { x: number; y: number };
  world: { x: number; y: number };
  targetNodeId: string | null;
  targetConnectionId?: string | null;
}

interface EditorState {
  nodeId: string;
  mode: CanvasImageEditMode;
}

interface PortDragState {
  sourceId: string;
  side: "left" | "right";
  cursor: CanvasPosition | null;
}

interface CreateMenuState {
  position: { x: number; y: number };
  world: CanvasPosition;
  /** 連線拖放到空白時：建完自動與該節點連線。 */
  connectFrom?: { nodeId: string; side: "left" | "right" };
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
  const [isGenerating, setIsGenerating] = useState(false);
  // ── 交互狀態
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [connecting, setConnecting] = useState<{ sourceId: string; cursor: CanvasPosition | null } | null>(null);
  const [portDrag, setPortDrag] = useState<PortDragState | null>(null);
  const [createMenu, setCreateMenu] = useState<CreateMenuState | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [panelRefIds, setPanelRefIds] = useState<string[]>([]);
  const [upscalingIds, setUpscalingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [elementListOpen, setElementListOpen] = useState(false);
  // P2：角色/場景卡面板（左側彈出，與歷史畫布/節點清單同模式）。
  const [cardsOpen, setCardsOpen] = useState(false);
  const [agentAutoApprove, setAgentAutoApprove] = useState(false);
  const clipboardRef = useRef<{ nodes: CanvasNode[]; connections: CanvasConnection[] } | null>(null);
  const pasteCountRef = useRef(0);
  const modifiersRef = useRef({ ctrl: false, shift: false });
  const abortRef = useRef<AbortController | null>(null);

  // ── 最新值 refs
  const canvasStateRef = useRef(canvas);
  canvasStateRef.current = canvas;
  const selectedIdsRef = useRef(selectedIds);
  selectedIdsRef.current = selectedIds;
  const connectingRef = useRef(connecting);
  connectingRef.current = connecting;
  const portDragRef = useRef(portDrag);
  portDragRef.current = portDrag;
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const promptPanelRef = useRef(promptPanelNodeId);
  promptPanelRef.current = promptPanelNodeId;
  const selectedConnectionRef = useRef(selectedConnectionId);
  selectedConnectionRef.current = selectedConnectionId;
  const createMenuRef = useRef(createMenu);
  createMenuRef.current = createMenu;

  const showError = useCallback((message: string) => {
    setActionError(message);
    window.setTimeout(() => setActionError((prev) => (prev === message ? null : prev)), 6000);
  }, []);

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

  /** A7：鄰接集合（hover 優先，退回選中主節點）。 */
  const highlightNodeId = hoveredNodeId ?? canvas.selectedNodeId;
  const adjacentIds = useMemo(() => {
    const set = new Set<string>();
    if (!highlightNodeId) return set;
    for (const c of canvas.connections) {
      if (c.fromNodeId === highlightNodeId) set.add(c.toNodeId);
      if (c.toNodeId === highlightNodeId) set.add(c.fromNodeId);
    }
    return set;
  }, [canvas.connections, highlightNodeId]);

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

  // ── 座標工具
  const screenToWorld = useCallback((clientX: number, clientY: number): CanvasPosition | null => {
    const el = containerRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const vp = canvasStateRef.current.viewport;
    return { x: (clientX - rect.left - vp.x) / vp.k, y: (clientY - rect.top - vp.y) / vp.k };
  }, []);

  const screenInContainer = useCallback((clientX: number, clientY: number): { x: number; y: number } => {
    const el = containerRef.current;
    const rect = el?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  // ── 選取
  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectedConnectionId(null);
    canvasStateRef.current.selectNode(null);
  }, []);

  /** 手動建線（環路阻止 + 去重提示）。 */
  const tryConnect = useCallback(
    (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const state = canvasStateRef.current;
      if (wouldCreateCycle(state.connections, fromId, toId)) {
        showError("会形成循环连接，已阻止");
        return;
      }
      state.addConnection(fromId, toId);
    },
    [showError],
  );

  const handleSelectNode = useCallback((nodeId: string) => {
    const conn = connectingRef.current;
    if (conn) {
      if (conn.sourceId !== nodeId) {
        const state = canvasStateRef.current;
        if (wouldCreateCycle(state.connections, conn.sourceId, nodeId)) {
          setActionError("会形成循环连接，已阻止");
        } else {
          state.addConnection(conn.sourceId, nodeId);
        }
      }
      setConnecting(null);
      return;
    }
    setSelectedConnectionId(null);
    const { ctrl, shift } = modifiersRef.current;
    setSelectedIds((prev) => {
      if (ctrl) {
        const next = new Set(prev);
        if (next.has(nodeId)) next.delete(nodeId);
        else next.add(nodeId);
        return next;
      }
      if (shift) {
        const next = new Set(prev);
        next.add(nodeId);
        return next;
      }
      return new Set([nodeId]);
    });
    canvasStateRef.current.selectNode(nodeId);
  }, []);

  /** A2：乾淨點擊 → 開節點面板（修飾鍵/連線模式/Group/Prompt 除外——
   *  prompt 節點是備忘卡不是生成落地位，雙擊正文直編即可，不開生成面板）。 */
  const handleNodeClick = useCallback((nodeId: string) => {
    if (modifiersRef.current.ctrl || modifiersRef.current.shift) return;
    if (connectingRef.current || portDragRef.current) return;
    const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
    if (
      !node ||
      node.type === CanvasNodeType.Group ||
      node.type === CanvasNodeType.Video ||
      node.type === CanvasNodeType.Audio ||
      node.type === CanvasNodeType.Prompt
    ) return;
    setPromptPanelNodeId(nodeId);
  }, []);

  const handleMarqueeSelect = useCallback(
    (rect: WorldRect, additive: boolean) => {
      const ids = nodesInRect(visibleNodes, rect);
      setSelectedIds((prev) => {
        const next = additive ? new Set(prev) : new Set<string>();
        for (const id of ids) next.add(id);
        return next;
      });
      if (ids.length > 0) canvasStateRef.current.selectNode(ids[ids.length - 1]);
    },
    [visibleNodes],
  );

  const handleNodeMove = useCallback((nodeId: string, position: CanvasPosition) => {
    const state = canvasStateRef.current;
    const sel = selectedIdsRef.current;
    const dragged = state.nodes.find((n) => n.id === nodeId);
    if (!dragged) return;
    if (sel.has(nodeId) && sel.size > 1) {
      const dx = position.x - dragged.position.x;
      const dy = position.y - dragged.position.y;
      const moves = state.nodes
        .filter((n) => sel.has(n.id))
        .map((n) => ({
          nodeId: n.id,
          position: n.id === nodeId ? position : { x: n.position.x + dx, y: n.position.y + dy },
        }));
      state.moveNodes(moves);
    } else {
      state.moveNode(nodeId, position);
    }
  }, []);

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const parentId = childToParent.get(nodeId);
      if (parentId) canvasStateRef.current.deleteBatchChild(parentId, nodeId);
      else canvasStateRef.current.removeNode(nodeId);
      setSelectedIds((prev) => {
        if (!prev.has(nodeId)) return prev;
        const next = new Set(prev);
        next.delete(nodeId);
        return next;
      });
    },
    [childToParent],
  );

  const deleteSelected = useCallback(() => {
    const ids = [...selectedIdsRef.current];
    if (ids.length === 0) return;
    canvasStateRef.current.deleteNodes(ids);
    setSelectedIds(new Set());
  }, []);

  // ── 複製 / 貼上 / 複本
  const copySelection = useCallback(() => {
    const state = canvasStateRef.current;
    const sel = selectedIdsRef.current;
    if (sel.size === 0) return;
    clipboardRef.current = {
      nodes: state.nodes.filter((n) => sel.has(n.id)),
      connections: state.connections,
    };
    pasteCountRef.current = 0;
  }, []);

  const pasteClipboard = useCallback((at?: CanvasPosition) => {
    const clip = clipboardRef.current;
    const state = canvasStateRef.current;
    if (!clip || clip.nodes.length === 0) return;
    pasteCountRef.current += 1;
    const existingIds = new Set<string>([...state.nodes.map((n) => n.id), ...state.connections.map((c) => c.id)]);
    const offset = at ? { x: 0, y: 0 } : { x: 32 * pasteCountRef.current, y: 32 * pasteCountRef.current };
    const clone = cloneForPaste(clip.nodes, clip.connections, clip.nodes.map((n) => n.id), existingIds, offset);
    if (at && clone.nodes.length > 0) {
      const minX = Math.min(...clone.nodes.map((n) => n.position.x));
      const minY = Math.min(...clone.nodes.map((n) => n.position.y));
      for (const n of clone.nodes) {
        n.position = { x: n.position.x - minX + at.x, y: n.position.y - minY + at.y };
      }
    }
    state.addNodes(clone.nodes, clone.connections);
    setSelectedIds(new Set(clone.nodes.map((n) => n.id)));
    if (clone.nodes.length > 0) state.selectNode(clone.nodes[0].id);
  }, []);

  const duplicateSelection = useCallback(() => {
    copySelection();
    pasteClipboard();
  }, [copySelection, pasteClipboard]);

  // ── 對齊 / 均分 / 整理
  const applyMoves = useCallback((moves: { nodeId: string; position: CanvasPosition }[]) => {
    if (moves.length === 0) return;
    const state = canvasStateRef.current;
    state.commitInteraction();
    state.moveNodes(moves);
  }, []);

  const alignSelection = useCallback(
    (mode: AlignMode) => applyMoves(alignNodes(canvasStateRef.current.nodes, [...selectedIdsRef.current], mode)),
    [applyMoves],
  );
  const distributeSelection = useCallback(
    (axis: "h" | "v") => applyMoves(distributeNodes(canvasStateRef.current.nodes, [...selectedIdsRef.current], axis)),
    [applyMoves],
  );
  const arrangeSelection = useCallback(
    () => applyMoves(arrangeGrid(canvasStateRef.current.nodes, [...selectedIdsRef.current])),
    [applyMoves],
  );

  // ── 下載
  const downloadNode = useCallback(
    async (nodeId: string) => {
      const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      const url = imageUrlOf(node);
      if (!node || !url) return;
      try {
        triggerDownload(await fetchImageBlob(url), `${safeFilename(node.title)}.png`);
      } catch (error) {
        showError(error instanceof Error ? error.message : "下载失败");
      }
    },
    [showError],
  );

  const downloadBatch = useCallback(
    async (parentId: string) => {
      const state = canvasStateRef.current;
      const parent = state.nodes.find((n) => n.id === parentId);
      if (!parent) return;
      const children = (parent.batchChildren ?? [])
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n && !!imageUrlOf(n));
      if (children.length === 0) {
        showError("批次里没有可下载的图片");
        return;
      }
      try {
        const { default: JSZip } = await import("jszip");
        const zip = new JSZip();
        for (const child of children) {
          const blob = await fetchImageBlob(imageUrlOf(child)!);
          zip.file(`${safeFilename(child.title)}.png`, blob);
        }
        triggerDownload(await zip.generateAsync({ type: "blob" }), `${safeFilename(parent.title)}-批次.zip`);
      } catch (error) {
        showError(error instanceof Error ? error.message : "打包下载失败");
      }
    },
    [showError],
  );

  // ── 生成核心（A4 原地回填 / 批次子節點 / A12 重試 / 停止）
  // P2 掛接點：鎖定的角色/場景卡在這裡注入——手動面板、agent run_generation、
  // 編輯器派生全部經過 callCanvasGenerate，一處掛接保證項目級鎖定對所有
  // 畫布生成生效（片段前綴 + 參考圖 + 負面詞；無卡時 payload 原樣通過）。
  const callCanvasGenerate = useCallback(
    async (payload: Record<string, unknown>, signal: AbortSignal) => {
      const headers = buildAuthHeaders();
      if (!headers) throw new Error("请先登录再生成图片");
      const lockedCards = canvasStateRef.current.activeCharacterCards ?? [];
      const finalPayload: Record<string, unknown> = lockedCards.length
        ? applyCharacterCardsToPayload(payload as CardAwareGeneratePayload, lockedCards as CharacterCard[])
        : payload;
      const res = await fetch(`/api/canvas/generate`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(finalPayload),
        signal,
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; images?: { url: string; cost_coins: number | null; natural_width: number | null; natural_height: number | null }[]; error?: string }
        | null;
      if (!res.ok || !data?.ok || !data.images?.length) {
        throw new Error(data?.error || `生成失败（${res.status}）`);
      }
      return data.images;
    },
    [],
  );

  /**
   * 原地生成：結果回填該節點本體（A4 / A12 重試 / agent run_generation 共用）。
   * 語義接線（2026-08-22）：連入的 prompt 節點文本自動作為 prompt 前綴、
   * 連入的 reference 節點自動帶圖+角色進生成請求——手動 UI 與 agent 同一條路。
   */
  const generateIntoNode = useCallback(
    async (nodeId: string, params: { prompt: string; model?: string; size?: string; sourceImage?: string | null; references?: CanvasGenerationReference[] }) => {
      const state = canvasStateRef.current;
      const controller = new AbortController();
      abortRef.current = controller;
      setIsGenerating(true);
      const semantic = resolveGenerationInputs(state.nodes, state.connections, nodeId);
      const finalPrompt = composeGenerationPrompt(semantic.promptParts, params.prompt);
      const references = mergeGenerationReferences(params.references ?? [], semantic.references);
      state.patchNodeMetadata(nodeId, {
        status: "loading",
        prompt: finalPrompt,
        ...(params.model ? { model: params.model } : {}),
        ...(params.size ? { size: params.size } : {}),
        errorDetails: undefined,
      });
      try {
        const images = await callCanvasGenerate(
          {
            prompt: finalPrompt,
            model: params.model,
            size: params.size,
            count: 1,
            source_image: params.sourceImage ?? null,
            reference_images: references.map(({ url, role, name }) => ({ url, role, name })),
          },
          controller.signal,
        );
        const img = images[0];
        state.patchNodeMetadata(
          nodeId,
          {
            content: img.url,
            status: "success",
            ...(typeof img.cost_coins === "number" ? { cost_coins: img.cost_coins } : {}),
            ...(img.natural_width ? { naturalWidth: img.natural_width } : {}),
            ...(img.natural_height ? { naturalHeight: img.natural_height } : {}),
          },
          { history: false },
        );
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        state.patchNodeMetadata(
          nodeId,
          { status: "error", errorDetails: aborted ? "已停止" : error instanceof Error ? error.message : "生成失败" },
          { history: false },
        );
        if (!aborted) showError(error instanceof Error ? error.message : "生成失败");
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [callCanvasGenerate, showError],
  );

  /** 面板生成：空圖片節點 count=1 原地回填；其餘批次子節點插回。 */
  const handleGenerateFromNode = useCallback(
    async (nodeId: string, prompt: string, options: { model?: string; size?: string; quality?: string; count?: number }) => {
      const state = canvasStateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      // @引用（顯式選取）+ 連入 reference 節點（自動帶入）→ 帶角色的參考圖清單。
      const panelRefs: CanvasGenerationReference[] = panelRefIds
        .map((id) => state.nodes.find((n) => n.id === id))
        .filter((n): n is CanvasNode => !!n && !!imageUrlOf(n))
        .map((n) => ({
          nodeId: n.id,
          url: imageUrlOf(n)!,
          role: n.type === CanvasNodeType.Reference ? toReferenceImageRole(n.metadata?.referenceRole) : "general",
          name: n.title || "参考图",
        }));
      const semantic = resolveGenerationInputs(state.nodes, state.connections, nodeId);
      const references = mergeGenerationReferences(panelRefs, semantic.references);
      const finalPrompt = composeGenerationPrompt(semantic.promptParts, prompt);
      const refNodeIds = references.map((r) => r.nodeId).filter((id): id is string => !!id);
      const count = Math.min(Math.max(1, options.count ?? 1), 4);
      const sourceUrl = imageUrlOf(node);

      // A4：空圖片節點 + 單張 → 原地變身，不另建節點。
      if (node.type === CanvasNodeType.Image && !sourceUrl && count === 1) {
        setPromptPanelNodeId(null);
        await generateIntoNode(nodeId, { prompt, model: options.model, size: options.size, references });
        setPanelRefIds([]);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setIsGenerating(true);
      try {
        const images = await callCanvasGenerate(
          {
            prompt: finalPrompt,
            model: options.model,
            size: options.size,
            quality: options.quality,
            count,
            source_image: sourceUrl,
            reference_images: references.map(({ url, role, name }) => ({ url, role, name })),
          },
          controller.signal,
        );
        const existing = node.batchChildren?.length ?? 0;
        const ts = Date.now().toString(36);
        images.forEach((img, i) => {
          const child = createBatchChildNode(node, img.url, existing + i, existing + images.length, {
            id: `${nodeId}-b-${ts}-${i}`,
            metadata: {
              prompt: finalPrompt,
              model: options.model,
              size: options.size,
              ...(typeof img.cost_coins === "number" ? { cost_coins: img.cost_coins } : {}),
              ...(img.natural_width ? { naturalWidth: img.natural_width } : {}),
              ...(img.natural_height ? { naturalHeight: img.natural_height } : {}),
              ...(refNodeIds.length > 0 ? { referenceNodeIds: [...refNodeIds] } : {}),
            },
          });
          state.addBatchChild(nodeId, child);
          state.addConnection(nodeId, child.id);
        });
        setPromptPanelNodeId(null);
        setPanelRefIds([]);
        const size = viewportSizeRef.current;
        if (size.width > 0) state.fitView(size.width, size.height);
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        if (!aborted) showError(error instanceof Error ? error.message : "生成失败，请稍后再试");
      } finally {
        setIsGenerating(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [panelRefIds, generateIntoNode, callCanvasGenerate, showError],
  );

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** A12：失敗重試——沿用節點 metadata 保存的參數，結果回填原節點。 */
  const retryNode = useCallback(
    (nodeId: string) => {
      const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      const prompt = node?.metadata?.prompt;
      if (!node || !prompt) {
        showError("该节点没有保存生成参数，无法重试");
        return;
      }
      const references: CanvasGenerationReference[] = (node.metadata?.referenceNodeIds ?? [])
        .map((id): CanvasGenerationReference | null => {
          const refNode = canvasStateRef.current.nodes.find((n) => n.id === id);
          const url = imageUrlOf(refNode);
          if (!refNode || !url) return null;
          const role: ReferenceImageRole =
            refNode.type === CanvasNodeType.Reference ? toReferenceImageRole(refNode.metadata?.referenceRole) : "general";
          return { nodeId: refNode.id, url, role, name: refNode.title || "参考图" };
        })
        .filter((r): r is CanvasGenerationReference => r !== null);
      void generateIntoNode(nodeId, {
        prompt,
        model: node.metadata?.model,
        size: node.metadata?.size,
        sourceImage: node.metadata?.source_image ?? null,
        references,
      });
    },
    [generateIntoNode, showError],
  );

  // ── 高清放大
  const upscaleNode = useCallback(
    async (nodeId: string) => {
      const state = canvasStateRef.current;
      const node = state.nodes.find((n) => n.id === nodeId);
      const url = imageUrlOf(node);
      if (!node || !url) return;
      if (!url.startsWith("http")) {
        showError("本地编辑结果暂不支持高清放大（需要先生成为在线图片）");
        return;
      }
      const headers = buildAuthHeaders();
      if (!headers) {
        showError("请先登录再使用高清放大");
        return;
      }
      setUpscalingIds((prev) => new Set(prev).add(nodeId));
      try {
        const size =
          node.metadata?.naturalWidth && node.metadata?.naturalHeight
            ? `${node.metadata.naturalWidth}x${node.metadata.naturalHeight}`
            : undefined;
        const res = await fetch("/api/pixai/upscale", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ image: url, factor: 2, ...(size ? { size } : {}) }),
        });
        const body = (await res.json().catch(() => null)) as
          | { data?: Array<{ url?: string }>; url?: string; images?: Array<{ url?: string }>; message?: string }
          | null;
        if (!res.ok) throw new Error(body?.message || `放大失败（${res.status}）`);
        const resultUrl =
          (Array.isArray(body?.data) ? body.data[0]?.url : undefined) ||
          body?.url ||
          (Array.isArray(body?.images) ? body.images[0]?.url : undefined);
        if (!resultUrl) throw new Error("放大失败：未返回图片");
        const child: CanvasNode = {
          id: `${nodeId}-up-${Date.now().toString(36)}`,
          type: CanvasNodeType.Image,
          title: `${node.title} · 高清`,
          position: { x: node.position.x + node.width + 60, y: node.position.y },
          width: node.width,
          height: node.height,
          moved: true,
          metadata: { content: resultUrl, status: "success", source_image: url, prompt: node.metadata?.prompt },
        };
        state.addNodes([child], [{ id: `conn-${nodeId}-${child.id}`, fromNodeId: nodeId, toNodeId: child.id }]);
        setSelectedIds(new Set([child.id]));
        state.selectNode(child.id);
      } catch (error) {
        showError(error instanceof Error ? error.message : "放大失败");
      } finally {
        setUpscalingIds((prev) => {
          const next = new Set(prev);
          next.delete(nodeId);
          return next;
        });
      }
    },
    [showError],
  );

  // ── 建節點（雙擊/連線拖放/庫插入/導入共用）
  const createNodeAt = useCallback(
    (
      type: "text" | "image" | "prompt" | "reference",
      world: CanvasPosition,
      extras?: { content?: string; title?: string; width?: number; height?: number; referenceRole?: ReferenceImageRole },
    ) => {
      const state = canvasStateRef.current;
      const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const nodeType =
        type === "text"
          ? CanvasNodeType.Text
          : type === "prompt"
            ? CanvasNodeType.Prompt
            : type === "reference"
              ? CanvasNodeType.Reference
              : CanvasNodeType.Image;
      const defaultTitle = type === "text" ? "文本" : type === "prompt" ? "提示词" : type === "reference" ? "参考图" : "图片";
      const role = extras?.referenceRole;
      const node: CanvasNode = {
        id,
        type: nodeType,
        title: extras?.title ?? defaultTitle,
        position: world,
        width: extras?.width ?? (type === "reference" ? 300 : 340),
        height: extras?.height ?? (type === "prompt" ? 200 : 240),
        moved: true,
        metadata:
          type === "text" || type === "prompt"
            ? { content: extras?.content ?? "", status: "idle" }
            : extras?.content
              ? { content: extras.content, status: "success", ...(role ? { referenceRole: role } : {}) }
              : { status: "idle", ...(role ? { referenceRole: role } : {}) },
      };
      state.addNodes([node]);
      setSelectedIds(new Set([id]));
      state.selectNode(id);
      return id;
    },
    [],
  );

  /** 本地圖片檔 → 畫布節點（壓縮後 dataURL；多檔階梯錯位）。
   *  kind="reference" → 建成帶角色的 reference 節點（默認 general，節點上可切換）。 */
  const importImageFiles = useCallback(
    async (files: File[], world: CanvasPosition, kind: "image" | "reference" = "image") => {
      let index = 0;
      for (const file of files.slice(0, 8)) {
        if (!file.type.startsWith("image/")) continue;
        try {
          const { dataUrl, width, height } = await fileToDataUrl(file);
          const nodeW = kind === "reference" ? 300 : 340;
          const nodeH = width > 0 ? Math.min(Math.max(Math.round((nodeW * height) / width), 120), 460) : 240;
          const id = createNodeAt(kind, { x: world.x + index * IMPORT_STAGGER, y: world.y + index * IMPORT_STAGGER }, {
            content: dataUrl,
            title: safeFilename(file.name.replace(/\.[^.]+$/, "")) || (kind === "reference" ? "参考图" : "图片"),
            width: nodeW,
            height: nodeH,
            ...(kind === "reference" ? { referenceRole: "general" as ReferenceImageRole } : {}),
          });
          canvasStateRef.current.patchNodeMetadata(id, { naturalWidth: width, naturalHeight: height, bytes: file.size, mimeType: file.type }, { history: false });
          index += 1;
        } catch {
          showError(`「${file.name}」导入失败`);
        }
      }
    },
    [createNodeAt, showError],
  );

  // ── A1：port 拖線（window 級 move/up，capture 保證不被節點吃掉）
  const startPortDrag = useCallback((nodeId: string, side: "left" | "right", clientX: number, clientY: number) => {
    setMenu(null);
    setConnecting(null);
    setPortDrag({ sourceId: nodeId, side, cursor: screenToWorld(clientX, clientY) });
  }, [screenToWorld]);

  useEffect(() => {
    if (!portDrag) return;
    const onMove = (e: PointerEvent) => {
      setPortDrag((prev) => (prev ? { ...prev, cursor: screenToWorld(e.clientX, e.clientY) } : prev));
    };
    const onUp = (e: PointerEvent) => {
      const drag = portDragRef.current;
      setPortDrag(null);
      if (!drag) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const nodeEl = el?.closest<HTMLElement>("[data-canvas-node]");
      const targetId = nodeEl?.getAttribute("data-canvas-node");
      if (targetId && targetId !== drag.sourceId) {
        // 右 port = 出邊（source→target）、左 port = 入邊（target→source）
        if (drag.side === "right") tryConnect(drag.sourceId, targetId);
        else tryConnect(targetId, drag.sourceId);
        return;
      }
      if (!targetId) {
        // 鬆手在空白 → 就地建節點選單，建完自動連線（藤蔓式生長）。
        const world = screenToWorld(e.clientX, e.clientY);
        if (world) {
          setCreateMenu({
            position: screenInContainer(e.clientX, e.clientY),
            world,
            connectFrom: { nodeId: drag.sourceId, side: drag.side },
          });
        }
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPortDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { capture: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp, { capture: true });
      window.removeEventListener("keydown", onKey);
    };
  }, [portDrag, screenToWorld, screenInContainer, tryConnect]);

  /** 建節點選單確認（雙擊空白 / 連線拖放共用）。 */
  const handleCreateFromMenu = useCallback(
    (type: "text" | "image" | "prompt") => {
      const cm = createMenuRef.current;
      if (!cm) return;
      setCreateMenu(null);
      const id = createNodeAt(type, cm.world);
      if (cm.connectFrom) {
        if (cm.connectFrom.side === "right") tryConnect(cm.connectFrom.nodeId, id);
        else tryConnect(id, cm.connectFrom.nodeId);
      }
    },
    [createNodeAt, tryConnect],
  );

  const handleCreateMenuUpload = useCallback(
    (files: File[], kind: "image" | "reference" = "image") => {
      const cm = createMenuRef.current;
      setCreateMenu(null);
      if (!cm) return;
      void importImageFiles(files, cm.world, kind).then(() => {
        // 連線拖放上傳：與第一個導入節點連線（importImageFiles 已選中最後一個，
        // 簡化：不強行連線，交用戶手動——多檔語義不明確時不猜）。
      });
    },
    [importImageFiles],
  );

  // ── 右鍵選單（沿用 v4 + 連線右鍵 + 字號）
  const openNodeMenu = useCallback((nodeId: string, clientX: number, clientY: number) => {
    const vpPos = screenInContainer(clientX, clientY);
    const world = screenToWorld(clientX, clientY) ?? { x: 0, y: 0 };
    if (!selectedIdsRef.current.has(nodeId)) {
      setSelectedIds(new Set([nodeId]));
      canvasStateRef.current.selectNode(nodeId);
    }
    setMenu({ position: vpPos, world, targetNodeId: nodeId });
  }, [screenInContainer, screenToWorld]);

  const openCanvasMenu = useCallback((screen: { x: number; y: number }, world: { x: number; y: number }) => {
    setMenu({ position: screen, world, targetNodeId: null });
  }, []);

  /** P2：從 reference 節點「存為卡」——取節點圖 + 角色建卡，存檔並鎖定到本畫布。 */
  const saveNodeAsCard = useCallback(
    async (node: CanvasNode, kind: CharacterCardKind) => {
      const url = imageUrlOf(node);
      if (!url) return;
      const now = new Date().toISOString();
      const card: CharacterCard = {
        id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: node.title || (kind === "character" ? "角色卡" : "场景卡"),
        kind,
        // 純參考圖卡：locked 片段為空，鎖定的是參考圖與角色（可日後補描述）。
        prompt: "",
        references: [
          {
            url,
            role: node.type === CanvasNodeType.Reference ? toReferenceImageRole(node.metadata?.referenceRole) : "general",
            name: node.title || "参考图",
          },
        ],
        createdAt: now,
        updatedAt: now,
      };
      const ok = await canvasStateRef.current.upsertCharacterCard(card);
      if (!ok) {
        showError("存卡失败，请稍后再试");
        return;
      }
      canvasStateRef.current.toggleCharacterCard(card.id); // 存為卡即鎖定（生成自動攜帶）
      showError(`已存为${kind === "character" ? "角色" : "场景"}卡并锁定：${card.name}`);
    },
    [showError],
  );

  const menuItems = useMemo((): (CanvasMenuItem | "separator")[] => {
    if (!menu) return [];
    const state = canvasStateRef.current;
    const sel = selectedIdsRef.current;
    const alignChildren: CanvasMenuItem[] = [
      { id: "align-left", label: "左对齐", onSelect: () => alignSelection("left") },
      { id: "align-right", label: "右对齐", onSelect: () => alignSelection("right") },
      { id: "align-top", label: "顶对齐", onSelect: () => alignSelection("top") },
      { id: "align-bottom", label: "底对齐", onSelect: () => alignSelection("bottom") },
      { id: "align-ch", label: "水平居中", onSelect: () => alignSelection("center-h") },
      { id: "align-cv", label: "垂直居中", onSelect: () => alignSelection("center-v") },
      { id: "dist-h", label: "水平均分", disabled: sel.size < 3, onSelect: () => distributeSelection("h") },
      { id: "dist-v", label: "垂直均分", disabled: sel.size < 3, onSelect: () => distributeSelection("v") },
      { id: "arrange", label: "网格整理", onSelect: () => arrangeSelection() },
    ];
    if (menu.targetConnectionId) {
      return [
        {
          id: "delete-connection",
          label: "删除连线",
          danger: true,
          shortcut: "Del",
          onSelect: () => {
            state.removeConnection(menu.targetConnectionId!);
            setSelectedConnectionId(null);
          },
        },
      ];
    }
    if (!menu.targetNodeId) {
      return [
        { id: "new-node", label: "新建节点…", onSelect: () => setCreateMenu({ position: menu.position, world: menu.world }) },
        { id: "paste", label: "粘贴", shortcut: "Ctrl+V", disabled: !clipboardRef.current?.nodes.length, onSelect: () => pasteClipboard(menu.world) },
        { id: "select-all", label: "全选", shortcut: "Ctrl+A", disabled: visibleNodes.length === 0, onSelect: () => setSelectedIds(new Set(visibleNodes.map((n) => n.id))) },
        ...(sel.size >= 2 ? ([{ id: "align", label: "对齐与排列", children: alignChildren }] as CanvasMenuItem[]) : []),
        "separator" as const,
        { id: "library", label: "提示词库 / 素材", onSelect: () => setLibraryOpen(true) },
        { id: "fit", label: "适应视图", onSelect: () => {
          const size = viewportSizeRef.current;
          if (size.width > 0) state.fitView(size.width, size.height);
        } },
        { id: "bg", label: "切换背景", onSelect: () => state.cycleBackground() },
        { id: "help", label: "快捷键帮助", onSelect: () => setHelpOpen(true) },
      ];
    }
    const node = nodeById.get(menu.targetNodeId);
    if (!node) return [];
    const url = imageUrlOf(node);
    const parentId = childToParent.get(node.id);
    const isWorkflowNode = !!(node.metadata?.workflow_id && node.metadata?.session_id);
    const items: (CanvasMenuItem | "separator")[] = [
      { id: "edit-prompt", label: "编辑提示词并生成", onSelect: () => setPromptPanelNodeId(node.id) },
      ...(isWorkflowNode ? ([{ id: "rerun", label: "重新生成（工作流）", onSelect: () => void handleRerun(node.id) }] as CanvasMenuItem[]) : []),
      ...(node.metadata?.status === "error" && node.metadata?.prompt
        ? ([{ id: "retry", label: "重试（沿用参数）", onSelect: () => retryNode(node.id) }] as CanvasMenuItem[])
        : []),
      { id: "connect", label: "连线到其他节点", onSelect: () => setConnecting({ sourceId: node.id, cursor: null }) },
      { id: "rename", label: "重命名", onSelect: () => {
        // 觸發節點內編輯：直接改 title 為當前值走 NodeView 雙擊路徑成本更高，
        // 這裡用 prompt() 太醜——選單觸發交給 NodeView 的雙擊；此項用瀏覽器原生輸入。
        const next = window.prompt("重命名节点", node.title);
        if (next && next.trim() && next.trim() !== node.title) state.renameNode(node.id, next.trim());
      } },
      "separator",
      { id: "copy", label: "复制", shortcut: "Ctrl+C", onSelect: copySelection },
      { id: "paste", label: "粘贴", shortcut: "Ctrl+V", disabled: !clipboardRef.current?.nodes.length, onSelect: () => pasteClipboard(menu.world) },
      { id: "duplicate", label: "创建副本", shortcut: "Ctrl+D", onSelect: duplicateSelection },
    ];
    if (node.type === CanvasNodeType.Text || node.type === CanvasNodeType.Prompt) {
      items.push("separator");
      items.push({ id: "font-up", label: "放大字号", onSelect: () => state.patchNodeMetadata(node.id, { fontSize: Math.min(28, (node.metadata?.fontSize ?? 14.5) + 2) }) });
      items.push({ id: "font-down", label: "缩小字号", onSelect: () => state.patchNodeMetadata(node.id, { fontSize: Math.max(10, (node.metadata?.fontSize ?? 14.5) - 2) }) });
      items.push({ id: "save-asset-text", label: "存入素材库", onSelect: () => void saveNodeToAssets(node.id) });
    }
    // P2：reference 節點 → 存為角色/場景卡（鎖定到本畫布，所有生成自動攜帶）。
    if (node.type === CanvasNodeType.Reference && url) {
      items.push("separator");
      items.push({
        id: "save-as-card",
        label: "存为卡并锁定",
        children: [
          { id: "save-card-character", label: "存为角色卡", onSelect: () => void saveNodeAsCard(node, "character") },
          { id: "save-card-scene", label: "存为场景卡", onSelect: () => void saveNodeAsCard(node, "scene") },
        ],
      });
    }
    // 圖片節點 → 帶角色的參考圖節點（保留位置/尺寸/圖片，補默認角色）。
    if (node.type === CanvasNodeType.Image && url) {
      items.push("separator");
      items.push({
        id: "to-reference",
        label: "转为参考图节点",
        onSelect: () => {
          state.addNodes([
            {
              ...node,
              type: CanvasNodeType.Reference,
              metadata: { ...node.metadata, referenceRole: node.metadata?.referenceRole ?? "general" },
            },
          ]);
        },
      });
    }
    if (url) {
      items.push("separator");
      items.push({ id: "download", label: "下载图片", onSelect: () => void downloadNode(node.id) });
      items.push({
        id: "edit-image",
        label: "编辑图片",
        children: [
          { id: "crop", label: "裁剪", onSelect: () => setEditor({ nodeId: node.id, mode: "crop" }) },
          { id: "split", label: "切图", onSelect: () => setEditor({ nodeId: node.id, mode: "split" }) },
          { id: "mask", label: "抠除 / AI 重绘", onSelect: () => setEditor({ nodeId: node.id, mode: "mask" }) },
          { id: "rotate", label: "旋转", onSelect: () => setEditor({ nodeId: node.id, mode: "rotate" }) },
          { id: "angle", label: "角度（AI 重绘）", onSelect: () => setEditor({ nodeId: node.id, mode: "angle" }) },
        ],
      });
      if (url.startsWith("http")) {
        items.push({ id: "upscale", label: "高清放大", disabled: upscalingIds.has(node.id), onSelect: () => void upscaleNode(node.id) });
      }
      items.push({ id: "save-asset-image", label: "存入素材库", onSelect: () => void saveNodeToAssets(node.id) });
    }
    if (parentId) {
      items.push("separator");
      items.push({ id: "set-primary", label: "设为主图", onSelect: () => state.setBatchPrimary(parentId, node.id) });
      items.push({ id: "remove-from-batch", label: "从批次中删除", danger: true, onSelect: () => handleDeleteNode(node.id) });
    }
    if ((node.batchChildren?.length ?? 0) > 0) {
      items.push("separator");
      items.push({ id: "toggle-batch", label: node.batchExpanded === false ? "展开批次" : "收起批次", onSelect: () => state.toggleBatchExpanded(node.id) });
      items.push({ id: "download-all", label: "下载全部子图 (zip)", onSelect: () => void downloadBatch(node.id) });
    }
    if (sel.size >= 2) {
      items.push("separator");
      items.push({ id: "align", label: "对齐与排列", children: alignChildren });
    }
    items.push("separator");
    items.push({
      id: "delete",
      label: sel.size > 1 ? `删除 ${sel.size} 个节点` : "删除节点",
      shortcut: "Del",
      danger: true,
      onSelect: () => (sel.size > 1 ? deleteSelected() : handleDeleteNode(node.id)),
    });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, nodeById, childToParent, visibleNodes, upscalingIds, saveNodeAsCard]);

  // ── 舊 workflow 節點動作
  const handleRerun = useCallback(async (nodeId: string) => {
    const node = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
    const workflowId = node?.metadata?.workflow_id;
    const sessionId = node?.metadata?.session_id;
    if (!workflowId || !sessionId) return;
    try {
      const response = await fetch(`/api/internal/workflow/node/rerun`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
      const response = await fetch(`/api/internal/workflow/node/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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

  // ── 鍵盤快捷鍵
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.isComposing ||
        (target &&
          (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable))
      ) {
        return;
      }
      if (editorRef.current) return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        if (portDragRef.current) setPortDrag(null);
        else if (connectingRef.current) setConnecting(null);
        else if (createMenuRef.current) setCreateMenu(null);
        else if (menuRef.current) setMenu(null);
        else if (promptPanelRef.current) setPromptPanelNodeId(null);
        else clearSelection();
        return;
      }
      if (mod && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        const nodes = canvasStateRef.current.nodes;
        const byId = new Map(nodes.map((n) => [n.id, n]));
        const parentOf = new Map<string, string>();
        for (const n of nodes) for (const cid of n.batchChildren ?? []) parentOf.set(cid, n.id);
        const all = nodes.filter((n) => {
          const pid = parentOf.get(n.id);
          return !pid || byId.get(pid)?.batchExpanded !== false;
        });
        setSelectedIds(new Set(all.map((n) => n.id)));
        return;
      }
      if (mod && (e.key === "c" || e.key === "C")) {
        copySelection();
        return;
      }
      if (mod && (e.key === "v" || e.key === "V")) {
        // 內部剪貼簿優先；空的話交給 window paste 事件讀系統剪貼簿。
        if (clipboardRef.current?.nodes.length) pasteClipboard();
        return;
      }
      if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        duplicateSelection();
        return;
      }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) canvasStateRef.current.redo();
        else canvasStateRef.current.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        canvasStateRef.current.redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedConnectionRef.current) {
          e.preventDefault();
          canvasStateRef.current.removeConnection(selectedConnectionRef.current);
          setSelectedConnectionId(null);
          return;
        }
        if (selectedIdsRef.current.size > 0) {
          e.preventDefault();
          deleteSelected();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, copySelection, pasteClipboard, duplicateSelection, deleteSelected]);

  // ── A8：系統剪貼簿貼圖/貼文字（畫布容器有 hover/焦點語境時）
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (clipboardRef.current?.nodes.length) return; // 內部剪貼簿優先（keydown 已處理）
      const el = containerRef.current;
      if (!el) return;
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
      const vp = canvasStateRef.current.viewport;
      const center = {
        x: (viewportSizeRef.current.width / 2 - vp.x) / vp.k,
        y: (viewportSizeRef.current.height / 2 - vp.y) / vp.k,
      };
      if (files.length > 0) {
        e.preventDefault();
        void importImageFiles(files, center);
        return;
      }
      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (text) {
        e.preventDefault();
        createNodeAt("text", center, { content: text, title: text.slice(0, 12) || "文本" });
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [importImageFiles, createNodeAt]);

  // ── 連線模式（工具列 Link2）游標跟隨
  const handleContainerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!connectingRef.current) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) setConnecting((prev) => (prev ? { ...prev, cursor: world } : prev));
  }, [screenToWorld]);

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
  }, []);

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
    [generateIntoNode],
  );

  // ── Wave C：agent 操作確認閘
  const runAgentGeneration = useCallback(
    (items: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[]) => {
      for (const item of items) {
        const node = canvasStateRef.current.nodes.find((n) => n.id === item.nodeId);
        if (!node) continue;
        const prompt = item.prompt ?? node.metadata?.prompt;
        if (!prompt) continue;
        if ((item.count ?? 1) <= 1) {
          void generateIntoNode(item.nodeId, { prompt, model: item.model ?? node.metadata?.model, size: item.size ?? node.metadata?.size });
        } else {
          void handleGenerateFromNode(item.nodeId, prompt, { model: item.model, size: item.size, count: item.count });
        }
      }
    },
    [generateIntoNode, handleGenerateFromNode],
  );

  const approveAgentOps = useCallback(() => {
    const { runGeneration } = canvasStateRef.current.applyAgentOps();
    runAgentGeneration(runGeneration);
  }, [runAgentGeneration]);

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
      <style>{`
        .ce-embed-root { height: ${height}; }
        @supports (height: 1dvh) { .ce-embed-root { height: ${toDvh(height)}; } }

        @media (max-width: 767px) {
          .ce-embed-root.ce-compact { height: min(72dvh, 620px) !important; }
        }

        .ce-embed-bar-btn {
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          white-space: nowrap;
          min-width: 2.75rem;
          min-height: 2.75rem;
          padding: 0 1rem;
          font-size: 0.875rem;
          line-height: 1.25rem;
          border: none;
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
          transition: background-color 0.2s ease, transform 0.15s ease;
        }
        .ce-embed-title-pill {
          background: rgba(255, 255, 255, 0.96);
          box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
          backdrop-filter: blur(12px);
          -webkit-backdrop-filter: blur(12px);
        }
        .ce-embed-bar-btn:active { transform: scale(0.96); }

        .ce-embed-empty { font-size: 0.875rem; }

        @media (min-width: 768px) {
          .ce-embed-bar-btn {
            min-width: 0;
            min-height: 0;
            padding: 0.25rem 0.625rem;
            font-size: 0.75rem;
            line-height: 1.125rem;
          }
          .ce-embed-bar-btn:active { transform: none; }
          .ce-embed-empty { font-size: 0.8125rem; }
        }

        @media (prefers-reduced-motion: reduce) {
          .ce-embed-bar-btn { transition: none; }
          .ce-embed-topbar, .ce-embed-leftpop { transition: none; }
        }

        /* 工作站態避讓改由宿主完成：ImagePlayground 把整個 overlay 向右 dock
           （--ce-dock-left = 面板寬 + 12px），畫布全域隨之右移，頂欄與左側彈層
           不再各自加 --ce-chrome-left（避免雙重位移）。行動端面板在底部，
           宿主把 overlay 復位成全屏，這裡只保留頂欄右緣約束讓 chips 能換行。 */
        @media (max-width: 767px) {
          .ce-embed-topbar { right: 0.75rem; }
          /* 行動端 chips 收斂：一排放得下，不再炸成兩行大藥丸。 */
          .ce-embed-topbar .ce-embed-bar-btn {
            min-width: 0;
            min-height: 2.125rem;
            padding: 0 0.7rem;
            font-size: 0.75rem;
            line-height: 1rem;
          }
        }
      `}</style>

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
                onGenerateFromNode={(nodeId, prompt, options) => void handleGenerateFromNode(nodeId, prompt, options)}
                isGenerating={isGenerating}
                onStopGenerate={stopGeneration}
                onOpenPromptLibrary={() => setLibraryOpen(true)}
                referenceCandidates={promptPanelNodeId === node.id ? referenceCandidatesFor(node.id) : undefined}
                selectedReferenceIds={promptPanelNodeId === node.id ? panelRefIds : undefined}
                onToggleReference={(refId) =>
                  setPanelRefIds((prev) => (prev.includes(refId) ? prev.filter((id) => id !== refId) : [...prev, refId]))
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
                onRetry={node.metadata?.status === "error" ? retryNode : undefined}
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
          <span className="ce-embed-title-pill rounded-full px-2.5 py-1 text-ios-caption1 font-medium text-[rgba(0,0,0,0.65)] max-md:hidden">
            画布
          </span>
          {onToggleExpand && (
            <button
              type="button"
              onClick={onToggleExpand}
              aria-pressed={expanded}
              className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
            >
              {expanded ? "收合" : "展开"}
            </button>
          )}
          <button
            type="button"
            onClick={() => canvas.newCanvasSession()}
            aria-label="新建画布"
            className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
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
            className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
          >
            历史画布
          </button>
          <button
            type="button"
            onClick={() => setLibraryOpen(true)}
            aria-label="提示词库与素材"
            className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
          >
            资源库
          </button>
          {/* P2：角色/場景卡——badge 數字 = 當前鎖定生效的卡數 */}
          <button
            type="button"
            onClick={() => setCardsOpen((v) => !v)}
            aria-pressed={cardsOpen}
            aria-label="角色与场景卡"
            className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
          >
            角色卡{canvas.activeCardIds.length > 0 ? ` · ${canvas.activeCardIds.length}` : ""}
          </button>
          {expanded && (
            <button
              type="button"
              onClick={() => setElementListOpen((v) => !v)}
              aria-pressed={elementListOpen}
              aria-label="节点清单"
              className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white max-md:hidden"
            >
              节点清单
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭画布，回到图片结果"
              className="ce-embed-bar-btn pointer-events-auto cursor-pointer rounded-full bg-white/80 font-medium text-[#007AFF] shadow-sm backdrop-blur hover:bg-white active:bg-white"
            >
              关闭画布
            </button>
          )}
        </div>

        {/* 連線模式提示 */}
        {(connecting || portDrag) && (
          <div className="pointer-events-none absolute left-1/2 top-14 z-20 -translate-x-1/2 rounded-full bg-[rgba(0,122,255,0.92)] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-md">
            {portDrag ? "拖到目标节点成线 · 松手在空白处新建节点" : "点击目标节点完成连线 · Esc 取消"}
          </div>
        )}

        {/* Wave C：agent 操作確認閘 */}
        {pendingOps && !agentAutoApprove && (
          <div className="pointer-events-auto absolute bottom-16 left-1/2 z-40 w-[min(92%,460px)] -translate-x-1/2 rounded-2xl bg-white p-3.5 shadow-[0_12px_48px_rgba(0,0,0,0.22)]" data-canvas-interactive>
            <p className="text-[13.5px] font-semibold text-[rgba(0,0,0,0.85)]">AI 助理想操作画布</p>
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-[rgba(0,0,0,0.55)]">
              {pendingOps.label || `共 ${pendingOps.ops.length} 步操作`}
              {" · "}
              {pendingOps.ops.map((op) => op.type).join("、")}
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <button
                type="button"
                onClick={approveAgentOps}
                className="flex-1 rounded-lg bg-black px-3 py-2 text-[13px] font-medium text-white hover:opacity-90"
              >
                允许
              </button>
              <button
                type="button"
                onClick={() => canvas.dismissAgentOps()}
                className="flex-1 rounded-lg bg-[rgba(0,0,0,0.06)] px-3 py-2 text-[13px] font-medium text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.1)]"
              >
                拒绝
              </button>
            </div>
            <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11.5px] text-[rgba(0,0,0,0.45)]">
              <input
                type="checkbox"
                checked={agentAutoApprove}
                onChange={(e) => {
                  setAgentAutoApprove(e.target.checked);
                  window.localStorage.setItem(AGENT_AUTO_APPROVE_KEY, e.target.checked ? "1" : "0");
                }}
              />
              本设备自动允许画布操作（可随时取消）
            </label>
          </div>
        )}
        {agentAutoApprove && pendingOps && (
          <div className="pointer-events-none absolute bottom-16 left-1/2 z-40 -translate-x-1/2 rounded-full bg-[rgba(0,0,0,0.75)] px-3 py-1.5 text-[12px] text-white">
            正在执行 AI 画布操作…
          </div>
        )}

        {/* 操作錯誤/提示 */}
        {actionError && (
          <div
            role="alert"
            className="pointer-events-auto absolute bottom-4 left-1/2 z-30 flex max-w-[85%] -translate-x-1/2 items-center gap-2 rounded-full bg-[rgba(20,20,22,0.92)] px-4 py-2 text-[12.5px] font-medium text-white shadow-lg"
          >
            <span className="min-w-0 truncate">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="关闭提示" className="shrink-0 opacity-80 hover:opacity-100">
              ✕
            </button>
          </div>
        )}

        {/* P2：角色/場景卡面板——卡列表、生效 badge、鎖定/解鎖、刪卡 */}
        {cardsOpen && (
          <div
            data-canvas-interactive
            className="ce-embed-leftpop pointer-events-auto absolute z-20 w-72 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-ios-2xl bg-white shadow-[0_8px_32px_rgba(0,0,0,0.16)]"
            style={{
              left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
              top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
              maxHeight: "min(64dvh, 420px)",
            }}
          >
            <div className="border-b border-[rgba(0,0,0,0.05)] px-3 py-2.5">
              <p className="text-[12.5px] font-semibold text-[rgba(0,0,0,0.8)]">角色 / 场景卡</p>
              <p className="mt-0.5 text-[11px] leading-snug text-[rgba(0,0,0,0.45)]">
                锁定后本画布所有生成自动携带（提示词前缀 + 参考图 + 负面词）
              </p>
            </div>
            {canvas.characterCards.length === 0 ? (
              <p className="px-3.5 py-3 text-ios-caption1 text-[rgba(0,0,0,0.45)]">
                还没有卡 · 右键参考图节点「存为卡并锁定」
              </p>
            ) : (
              canvas.characterCards.map((card) => {
                const active = canvas.activeCardIds.includes(card.id);
                return (
                  <div
                    key={card.id}
                    className="flex items-center gap-2 border-b border-[rgba(0,0,0,0.05)] px-3 py-2.5 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 truncate text-[12.5px] font-medium text-[rgba(0,0,0,0.85)]">
                        <span className="truncate">{card.name}</span>
                        <span className="shrink-0 rounded-full bg-[rgba(0,0,0,0.05)] px-1.5 py-0.5 text-[10px] text-[rgba(0,0,0,0.5)]">
                          {card.kind === "scene" ? "场景" : "角色"}
                        </span>
                      </p>
                      <p className="mt-0.5 truncate text-[11px] text-[rgba(0,0,0,0.42)]">
                        {active ? (
                          <span className="font-medium text-[#34C759]">生效中</span>
                        ) : (
                          "未锁定"
                        )}
                        {card.references.length > 0 ? ` · ${card.references.length} 张参考图` : ""}
                        {card.prompt ? " · 有描述" : ""}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => canvas.toggleCharacterCard(card.id)}
                      className={
                        active
                          ? "shrink-0 cursor-pointer rounded-lg bg-[rgba(52,199,89,0.12)] px-2 py-1 text-[11.5px] font-medium text-[#248A3D] hover:bg-[rgba(52,199,89,0.2)]"
                          : "shrink-0 cursor-pointer rounded-lg bg-[rgba(0,0,0,0.06)] px-2 py-1 text-[11.5px] font-medium text-[rgba(0,0,0,0.6)] hover:bg-[rgba(0,0,0,0.1)]"
                      }
                    >
                      {active ? "解锁" : "锁定"}
                    </button>
                    <button
                      type="button"
                      aria-label={`删除卡 ${card.name}`}
                      onClick={() => void canvas.removeCharacterCard(card.id)}
                      className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-[11.5px] text-[rgba(0,0,0,0.35)] hover:bg-[rgba(0,0,0,0.06)] hover:text-[#FF3B30]"
                    >
                      删除
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* 歷史畫布下拉 */}
        {historyOpen && (
          <div
            data-canvas-interactive
            role="listbox"
            aria-label="历史画布列表"
            className="ce-embed-leftpop pointer-events-auto absolute z-20 w-64 max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-ios-2xl bg-white shadow-[0_8px_32px_rgba(0,0,0,0.16)]"
            style={{
              left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
              top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
              maxHeight: "min(60dvh, 360px)",
            }}
          >
            {canvas.savedProjects.length === 0 ? (
              <p className="px-4 py-3 text-ios-caption1 text-[rgba(0,0,0,0.45)]">还没有保存的画布</p>
            ) : (
              canvas.savedProjects.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  onClick={() => {
                    void canvas.openSavedCanvas(p.id).then(() => setHistoryOpen(false));
                  }}
                  className="flex min-h-[44px] w-full flex-col items-start justify-center gap-0.5 border-b border-[rgba(0,0,0,0.05)] px-4 py-2.5 text-left last:border-b-0 hover:bg-[rgba(0,0,0,0.04)]"
                >
                  <span className="w-full truncate text-ios-caption1 font-medium text-[rgba(0,0,0,0.85)]">{p.title}</span>
                  <span className="text-ios-footnote text-[rgba(0,0,0,0.42)]">
                    {p.nodeCount} 个节点 · {formatRelative(p.updatedAt)}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* B2：節點清單（全屏態）→ 點擊飛行聚焦 */}
        {elementListOpen && expanded && (
          <div
            data-canvas-interactive
            className="ce-embed-leftpop pointer-events-auto absolute z-20 w-60 overflow-y-auto rounded-ios-2xl bg-white shadow-[0_8px_32px_rgba(0,0,0,0.16)]"
            style={{
              left: "calc(0.75rem + env(safe-area-inset-left, 0px))",
              top: "calc(3.5rem + env(safe-area-inset-top, 0px))",
              maxHeight: "min(64dvh, 420px)",
            }}
          >
            {canvas.nodes.length === 0 ? (
              <p className="px-4 py-3 text-ios-caption1 text-[rgba(0,0,0,0.45)]">画布还没有节点</p>
            ) : (
              canvas.nodes.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    const size = viewportSizeRef.current;
                    canvas.flyTo({ x: n.position.x + n.width / 2, y: n.position.y + n.height / 2 }, size.width, size.height);
                    setSelectedIds(new Set([n.id]));
                    canvas.selectNode(n.id);
                  }}
                  className="flex min-h-[38px] w-full items-center gap-2 border-b border-[rgba(0,0,0,0.05)] px-3 py-2 text-left last:border-b-0 hover:bg-[rgba(0,0,0,0.04)]"
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{
                      background:
                        n.metadata?.status === "success"
                          ? "#34C759"
                          : n.metadata?.status === "loading"
                            ? "#007AFF"
                            : n.metadata?.status === "error"
                              ? "#FF3B30"
                              : "rgba(0,0,0,0.18)",
                    }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] text-[rgba(0,0,0,0.75)]">{n.title}</span>
                </button>
              ))
            )}
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
            <p className="ce-embed-empty rounded-ios-2xl bg-white/80 px-4 py-2 text-[rgba(0,0,0,0.5)] shadow-sm backdrop-blur">
              双击空白新建节点，或拖入图片开始 · agent 生成会自动落到这里
            </p>
          </div>
        )}
      </div>

      {/* 快捷鍵幫助 / 資源庫 / 圖片編輯器（overflow 外層渲染） */}
      <CanvasShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
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
      />
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
