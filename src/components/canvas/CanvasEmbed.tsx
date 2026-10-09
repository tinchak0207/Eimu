"use client";

// CanvasEmbed —— 画布嵌合（v5）：agent 对话右侧结果面板的画布渲染模式。
//
// v5（2026-08-16，ABCD 全波）在 v4（多选/框选/快捷键/右键/批次/编辑器）之上：
//   A1 port 拖线：节点左右圆点拖出虚线，松手在节点=成线（含环路阻止）、
//      松手在空白=就地建节点选单并自动连线（工作流像藤蔓生长）
//   A2 点选即面板：干净点击节点直接吊出生成面板；生成中可「停止」
//   A4 空节点=生成落地位：空图片节点 count=1 结果原地回填，不另建节点
//   A6 双击空白=建节点选单（桌面）；A8 拖图入画布/系统剪贴簿贴图
//   A7 邻接高亮：hover/选中 → 上下游连线与节点同时点亮
//   A5 连线可选可删；A9 缩放控件+快捷键帮助；A12 失败就地重试（参数不丢）
//   B1 视口裁剪（±280px 才渲染）；B2 节点清单+450ms 飞行聚焦；B3 缩略图降采样
//   C  agent 画布操作自动化：canvas.ops 一到即自动落地（无人工确认闸；可 undo/redo 撤销），
//      执行后结果回流 gateway；run_generation 由本层代跑
//   D  提示词库/云端素材库面板接线；编辑器角度重绘/AI 重绘回调接生成管线
//
// 2026-08-22 域拆分（docs/plans/2026-08-22-large-file-refactor.md Task 7）：
// 纯函数/类型 → embed/embed-helpers.ts、交互域 → embed/use-canvas-interaction.ts、
// 生成编排 → embed/use-canvas-generation.ts、键盘/剪贴簿 → embed/use-canvas-shortcuts.ts、
// 右键选单 → embed/context-menu-items.ts、浮层+样式 → embed/CanvasEmbedOverlays.tsx。
// 本档保留组件壳 + 节点挂载（visibleNodes.map 的 CanvasNodeView）+ 顶栏。
//
// 认证立场：生成/超分走 Bearer + x-user-id（与 playground 同款 getStoredToken），
// 未登入诚实报错，不假装能生成。

import { useRef, useEffect, useState, useCallback, useMemo } from "react";
import { X } from "lucide-react";
import type { UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import { CanvasNodeType, type CanvasConnection, type CanvasNode } from "@/lib/canvas/types";
import type { CanvasGenerationReference } from "@/lib/canvas/semantic-nodes";
import { bezierPath } from "@/lib/canvas/layout";
import { InfiniteCanvas } from "./InfiniteCanvas";
import { CanvasConnections } from "./CanvasConnections";
import { CanvasNodeViewMemo } from "./CanvasNodeView";
import { useLiveViewport } from "./embed/use-live-viewport";
import { CanvasMiniMap } from "./CanvasMiniMap";
import { CanvasContextMenu, type CanvasMenuItem } from "./CanvasContextMenu";
import { CanvasImageEditorDialog, type CanvasImageEditMode, type CanvasImageEditResult } from "./CanvasImageEditorDialog";
import { CanvasZoomControls } from "./CanvasZoomControls";
import { CanvasShortcutsHelp } from "./CanvasShortcutsHelp";
import { CanvasNodeCreateMenu } from "./CanvasNodeCreateMenu";
import { CanvasLibraryPanel } from "./CanvasLibraryPanel";
import { ProjectAssetLibraryPanel } from "@/components/assets/ProjectAssetLibraryPanel";
// WS-审查（2026-09-24 能力建设）：资产／分镜审查面板 + 纯转换（批准状态一律经面板导出的纯函式组装，
// 不在宿主重写第二份形状）。外部开启介面＝`openReviewPanel()` 派 CustomEvent，本档挂监听。
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
// 批准状态（路 1 落地的真源）：写入走 setApproval、分镜侧清洗走 shotApprovalFor（内部即 normalizeApprovalState）。
import { setApproval } from "@/lib/character-cards";
import type { ApprovalState } from "@/lib/character-cards";
import { DEFAULT_AGENT_SETTINGS, getAgentSettings } from "@/lib/agent-chat-client";
import type { AgentInteractionMode } from "@/lib/agent-chat-client";
import { DEFAULT_IMAGE_MODEL_ID } from "@/lib/image-model-ids.js";
import { LoraLibraryPanel, type SelectedLora } from "@/components/canvas-workstation/panels/LoraLibraryPanel";
import "@/components/canvas-workstation/panels/panels.css";
import { cn } from "@/lib/utils";
import { CULL_MARGIN_PX, ENTER_STAGGER_MS, buildAuthHeaders, fileToDataUrl, imageUrlOf } from "./embed/embed-helpers";
import { useCanvasInteraction } from "./embed/use-canvas-interaction";
import { useCanvasGeneration } from "./embed/use-canvas-generation";
import { useCanvasShortcuts } from "./embed/use-canvas-shortcuts";
import { buildCanvasEmbedMenuItems } from "./embed/context-menu-items";
import { CanvasEmbedOverlays } from "./embed/CanvasEmbedOverlays";
import { CHARACTER_CARD_KIND_LABEL } from "@/lib/character-cards";
import { shotEntityCardIdsFromMetadata } from "./CanvasNodePromptPanel";
import {
  centerViewport,
  easeOutCubic,
  engineeringFocusViewport,
  fitStageViewport,
  gatherOffsets,
  gatherVisuals,
  GATHER_RANGE,
  hudLayout,
  LOD_TARGET_SCALE,
  lodBlend,
  quantizeScale,
  nextLod,
  summarizeStages,
  zoomAroundCenter,
  type CanvasLod,
  type CanvasStageId,
  type CanvasStageSummary,
} from "@/lib/canvas/lod";
import { useCameraFlight } from "./embed/use-camera-flight";
import type { InspectInput } from "./node-view/node-inspect";
import { CanvasStageOverview } from "./CanvasStageOverview";
import { CanvasBoardOverview } from "./CanvasBoardOverview";
import { CanvasEngineeringPanel } from "./CanvasEngineeringPanel";

export interface CanvasEmbedProps {
  /** useCanvasChat 的完整 return（chat 部分由宿主另外用，这里只用画布部分）。 */
  canvas: UseCanvasChatReturn;
  /** embed 高度；不传则撑满父容器。 */
  height?: string;
  /** 面板关闭（回到 ImageDisplay 模式）时触发。 */
  onClose?: () => void;
  /** 全屏展开态：顶部薄条改显示「收合」。 */
  expanded?: boolean;
  /** 展开/收合切换：compact 时显示「展开」、全屏时显示「收合」。 */
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

/** 语义缩放工程层只在 ≥768px 视窗开放（手机不出工程透析）。 */
function useWideViewport(): boolean {
  const [wide, setWide] = useState(true);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => setWide(mq.matches);
    setWide(mq.matches);
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener("change", onChange);
      else mq.removeListener(onChange);
    };
  }, []);
  return wide;
}

export function CanvasEmbed({ canvas: hostCanvas, height = "100%", onClose, expanded = false, onToggleExpand }: CanvasEmbedProps) {
  // 效能 P0-1（2026-10-01）：每帧视口只活在本地，停手才回写宿主——宿主在 ImagePlayground 根，
  // 每帧 setState 等于整站重渲染。下游一律读这个 canvas（viewport/setViewport 是 live 版）。
  const live = useLiveViewport(hostCanvas.viewport, hostCanvas.setViewport);
  const { flush: flushViewport } = live;
  const hostFitView = hostCanvas.fitView;
  const hostCenterOn = hostCanvas.centerOn;
  const liveFitView = useCallback<UseCanvasChatReturn["fitView"]>(
    (width, height) => {
      flushViewport();
      hostFitView(width, height);
    },
    [flushViewport, hostFitView],
  );
  const liveCenterOn = useCallback<UseCanvasChatReturn["centerOn"]>(
    (world, width, height) => {
      flushViewport();
      hostCenterOn(world, width, height);
    },
    [flushViewport, hostCenterOn],
  );
  const canvas = useMemo<UseCanvasChatReturn>(
    () => ({ ...hostCanvas, viewport: live.viewport, setViewport: live.setViewport, fitView: liveFitView, centerOn: liveCenterOn }),
    [hostCanvas, live.viewport, live.setViewport, liveFitView, liveCenterOn],
  );
  // 移动中给节点量化倍率（6% 一格）：memo 过的节点卡不必每帧重渲染；停手回到精确值（拖拽换算用）。
  const nodeScale = live.moving ? quantizeScale(canvas.viewport.k) : canvas.viewport.k;
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
  // 面板行内 @ 引用的素材卡 id（与 panelRefIds 同级同生命周期；生成时收窄参考集）。
  const [panelEntityIds, setPanelEntityIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // LoRA 库（2026-08-27 自专业工作站迁入）：同款滑入面板，选中结果注入生成链路。
  const [loraPanelOpen, setLoraPanelOpen] = useState(false);
  const [selectedLora, setSelectedLora] = useState<SelectedLora | null>(null);
  const [elementListOpen, setElementListOpen] = useState(false);
  // P2：角色/场景卡面板（左侧弹出，与历史画布/节点清单同模式）。
  const [cardsOpen, setCardsOpen] = useState(false);
  // G2（2026-09-16）：作品/剧集面板（同款左侧弹层；资料取自 hook 三栏出口 + nodes）。
  const [creationFlowOpen, setCreationFlowOpen] = useState(false);
  // REQ-B2 团队资产空间：项目资产库面板（右侧滑入，同资源库/角色卡同款弹层语汇）。
  const [projectAssetsOpen, setProjectAssetsOpen] = useState(false);
  // 登入态只在面板打开时读一次（buildAuthHeaders 读 cookie＋localStorage，放 render 里＝每帧一次）。
  const isLoggedIn = useMemo(() => projectAssetsOpen && Boolean(buildAuthHeaders()), [projectAssetsOpen]);
  const libraryLoggedIn = useMemo(() => libraryOpen && Boolean(buildAuthHeaders()), [libraryOpen]);
  // WS-审查（2026-09-24）：资产／分镜审查面板（null＝关）。两个面共用一颗画布工具列入口。
  const [reviewPanel, setReviewPanel] = useState<ReviewPanelKind | null>(null);
  // 缩略图预设收合（2026-09-27）：常驻会压住缩放条与右侧节点，入口在缩放胶囊。
  const [minimapOpen, setMinimapOpen] = useState(false);
  // 语义缩放（2026-09-30）：k → LOD（带迟滞）；ref 存上一层，只在换层时 setState。
  const allowEngineering = useWideViewport();
  const [lod, setLod] = useState<CanvasLod>(2);
  const lodRef = useRef<CanvasLod>(2);
  const [engineeringNodeId, setEngineeringNodeId] = useState<string | null>(null);
  useEffect(() => {
    const next = nextLod(lodRef.current, canvas.viewport.k, { allowEngineering });
    if (next === lodRef.current) return;
    lodRef.current = next;
    setLod(next);
    // 鸟瞰／画布层不挂载节点：内嵌 prompt 面板跟著收掉。
    if (next <= 1) setPromptPanelNodeId(null);
  }, [canvas.viewport.k, allowEngineering]);
  const stageSummaries = useMemo(() => summarizeStages(canvas.nodes), [canvas.nodes]);
  const gatherOffsetMap = useMemo(() => gatherOffsets(canvas.nodes, stageSummaries), [canvas.nodes, stageSummaries]);
  // 连续转场系数（k 是唯一真源）：每帧写进内容层 CSS 变数，节点/连线靠 CSS 反应。
  const blend = lodBlend(canvas.viewport.k);
  const gatherRaw = blend.gather;
  const gatherEased = easeOutCubic(gatherRaw);
  const xray = allowEngineering ? blend.xray : 0;
  const gatherLook = gatherVisuals(gatherRaw);
  // 拆机内容「输入」段：每颗节点的入边来源（连线/节点变了才重算；Map 值引用稳定）。
  const boardInputMap = useMemo(() => {
    const byId = new Map(canvas.nodes.map((n) => [n.id, n]));
    const map = new Map<string, InspectInput[]>();
    for (const c of canvas.connections) {
      const src = byId.get(c.fromNodeId);
      if (!src) continue;
      const list = map.get(c.toNodeId) ?? [];
      list.push({ id: src.id, label: src.title, type: src.type });
      map.set(c.toNodeId, list);
    }
    return map;
  }, [canvas.nodes, canvas.connections]);
  // 只给「透析带内＋在视野里」的节点挂拆机内容：放大时视野里本来就没几张卡，成本可控。
  const xrayOn = xray > 0;
  const boardNodeIds = useMemo(() => {
    const ids = new Set<string>();
    if (!xrayOn || viewportSize.width <= 0) return ids;
    const { x, y, k } = canvas.viewport;
    const margin = 80 / k;
    const wx0 = -x / k - margin;
    const wy0 = -y / k - margin;
    const wx1 = (viewportSize.width - x) / k + margin;
    const wy1 = (viewportSize.height - y) / k + margin;
    for (const n of canvas.nodes) {
      if (n.position.x + n.width < wx0 || n.position.x > wx1 || n.position.y + n.height < wy0 || n.position.y > wy1) continue;
      ids.add(n.id);
    }
    return ids;
  }, [xrayOn, canvas.viewport, viewportSize, canvas.nodes]);
  // 鸟瞰收束后节点会卸载；再散开时跳过首次进场的 stagger（不然节点会「排队」出现）。
  const nodesRemountedRef = useRef(false);
  const fullyGathered = gatherRaw >= 1;
  useEffect(() => {
    if (fullyGathered) nodesRemountedRef.current = true;
  }, [fullyGathered]);

  // 相机飞行：三段按钮／点阶段卡／待审 CTA／透析全走这里（飞行途中转场自动发生）。
  const viewportRef = live.viewportRef;
  const { flyTo } = useCameraFlight({
    setViewport: canvas.setViewport,
    viewportRef,
    sizeRef: viewportSizeRef,
    containerRef,
    reduceMotion,
  });
  // 飞向某阶段途中：其他阶段节点压暗；落地后 300ms 恢复（被使用者中止也照时限恢复，不残留）。
  const [focusStage, setFocusStage] = useState<CanvasStageId | null>(null);
  const focusStageTimerRef = useRef<number | null>(null);
  const holdStageFocus = useCallback((stage: CanvasStageId, ms: number) => {
    setFocusStage(stage);
    if (focusStageTimerRef.current !== null) window.clearTimeout(focusStageTimerRef.current);
    focusStageTimerRef.current = window.setTimeout(() => {
      focusStageTimerRef.current = null;
      setFocusStage(null);
    }, ms);
  }, []);
  useEffect(
    () => () => {
      if (focusStageTimerRef.current !== null) window.clearTimeout(focusStageTimerRef.current);
    },
    [],
  );
  const STAGE_FLIGHT_MS = 820;
  /** 三层按钮的相机飞行：穿带飞行有带内减速，820ms 让形变本身约 600ms。 */
  const LOD_FLIGHT_MS = 820;
  const handleSelectStage = useCallback(
    (stage: CanvasStageSummary) => {
      const size = viewportSizeRef.current;
      if (!stage.bbox || size.width <= 0) return;
      holdStageFocus(stage.id, STAGE_FLIGHT_MS + 300);
      // 先无感对位：鸟瞰态画布上只有周期点阵，把阶段质心平移到被点的卡片中心底下（k 不变），
      // 起飞后卡片沿直线收进质心、质心沿直线走到视口中心——不会先往节点真实位置绕一下。
      // k 同时无感跳到聚合带下缘（鸟瞰态 HUD 不随 k 变）：省掉「卡片原地干等 k 爬进带」的空转。
      const current = viewportRef.current;
      const slot = hudLayout(size).slots[stage.id - 1];
      const k0 = Math.max(current.k, GATHER_RANGE.end - 0.004);
      const from =
        stage.centroid && slot
          ? {
              x: slot.x + slot.width / 2 - stage.centroid.x * k0,
              y: slot.y + slot.height / 2 - stage.centroid.y * k0,
              k: k0,
            }
          : undefined;
      flyTo(fitStageViewport(stage.bbox, size), { duration: STAGE_FLIGHT_MS, from });
    },
    [flyTo, holdStageFocus, viewportRef],
  );
  const handleReviewStage = useCallback(
    (stage: CanvasStageSummary) => {
      const id = stage.firstPendingNodeId;
      const target = id ? canvasStateRef.current.nodes.find((n) => n.id === id) : undefined;
      const size = viewportSizeRef.current;
      if (!target || size.width <= 0) return;
      holdStageFocus(stage.id, STAGE_FLIGHT_MS + 300);
      flyTo(
        centerViewport({ x: target.position.x + target.width / 2, y: target.position.y + target.height / 2 }, 0.7, size),
        { duration: STAGE_FLIGHT_MS, onDone: () => canvasStateRef.current.selectNode(target.id) },
      );
    },
    [flyTo, holdStageFocus],
  );
  const handleSelectLod = useCallback(
    (level: CanvasLod) => {
      const size = viewportSizeRef.current;
      if (size.width <= 0) return;
      flyTo(zoomAroundCenter(viewportRef.current, LOD_TARGET_SCALE[level], size), { duration: LOD_FLIGHT_MS });
    },
    [flyTo, viewportRef],
  );
  // 透析：开面板＋把卡片飞到面板左侧可见区正中，同时进 focus 模式。
  const openEngineering = useCallback(
    (nodeId: string) => {
      setEngineeringNodeId(nodeId);
      const target = canvasStateRef.current.nodes.find((n) => n.id === nodeId);
      const size = viewportSizeRef.current;
      if (!target || size.width <= 0) return;
      // 面板 fixed 贴视窗右缘（w-[26rem]、right 0.75rem）：换算成画布座标，卡片置中于面板左侧可见区。
      const rect = containerRef.current?.getBoundingClientRect();
      const panelLeft = window.innerWidth - 12 - Math.min(416, window.innerWidth - 24);
      const free = rect ? { left: 16, right: Math.max(160, Math.min(size.width, panelLeft - rect.left) - 28) } : undefined;
      flyTo(engineeringFocusViewport(target, size, viewportRef.current.k, free), { duration: 560 });
    },
    [flyTo, viewportRef],
  );
  // 互动档位（决策 1/2）：只有协作档才是停点；全自动档下审查面板可看可改、不阻塞流程。
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>(DEFAULT_AGENT_SETTINGS.interaction_mode);

  // ── 最新值 refs（组件壳域）
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

  /** 档位回读（网关为准，失败静默落预设——与 getAgentSettings 自身契约一致，永不 reject）。 */
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
   * 外部开启介面（决策 10 的第二个门，步骤条由另一路实作）：
   * 监听 `REVIEW_PANEL_OPEN_EVENT`，把 `openReviewPanel({ panel })` 的请求翻成面板状态。
   * 没有宿主挂载时呼叫端拿不到任何回应——`openReviewPanel()` 已在该处声明「回传 true 只代表事件已派发」。
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

  // 批次收起 → 子节点隐藏；B1 视口裁剪 → 萤幕外 ±280px 不渲染。
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

  // ── 交互域（选取/框选/连线/埠拖拽/对齐/下载/建节点/右键选单定位；L227-237 交互 state 与镜像 refs 由 hook 持有并回传）
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
    handleImportScene3d,
    openNodeMenu,
    openCanvasMenu,
    saveNodeAsCard,
  } = interaction;

  /** A7：邻接集合（hover 优先，退回选中主节点）。 */
  const highlightNodeId = hoveredNodeId ?? canvas.selectedNodeId;

  // ── 生成编排域（A4 原地回填 / 批次子节点 / A12 重试 / 停止 / 高清放大 / agent 代跑）
  const {
    isGenerating,
    upscalingIds,
    extractingFramesIds,
    callCanvasGenerate,
    generateIntoNode,
    handleGenerateFromNode,
    stopGeneration,
    retryNode,
    upscaleNode,
    extractFramesFromNode,
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

  // ── 键盘快捷键 + 系统剪贴簿（A8）
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

  // ── 旧 workflow 节点动作（站点代理 → 网关 /workflow/node/rerun|update；
  // 旧 /api/internal/workflow/* 路径在站点从不存在，生产 404，已废弃）
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

  // ── D：存入素材库
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
        openEngineering,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menu, nodeById, childToParent, visibleNodes, upscalingIds, saveNodeAsCard],
  );

  // ── 连线模式（工具列 Link2）游标跟随
  const handleContainerPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!connectingRef.current) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (world) setConnecting((prev) => (prev ? { ...prev, cursor: world } : prev));
  }, [screenToWorld, connectingRef, setConnecting]);

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
  }, [promptPanelNodeId, setPanelRefIds]);

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
   * @ 可引用的素材卡候选 = 项目锁定且过作用域裁决的卡（activeCharacterCards）。
   * 语义是「全画布可用」，不是「只连上游的卡」；音频卡不做视觉引用故滤掉。
   * nodeId 参数只为与 referenceCandidatesFor 同形（呼叫端条件式写法照抄）。
   */
  const entityCandidatesFor = useCallback(
    (_nodeId: string) =>
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
   * 本镜节点 metadata 已指定的实体卡 id（character/scene/prop 三栏联集去重）。
   * 供 prompt 面板「本镜参考素材」清单的 shot 来源；节点没指定时为空阵列（既有行为不变）。
   * 推导本体在 CanvasNodePromptPanel.shotEntityCardIdsFromMetadata（纯函式，可直测）。
   */
  const shotEntityCardIdsFor = useCallback(
    (nodeId: string): string[] => shotEntityCardIdsFromMetadata(nodeById.get(nodeId)?.metadata),
    [nodeById],
  );

  // ── WS-审查（2026-09-24）：资产／分镜审查域的接线
  // 分镜列＝画布节点投影（纯函式在面板档内，可单测）；场景名由外层 Group 的 storyboardScene 解析。
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
  /** 入口徽章＝待批准＋已驳回的总数（仅显示，不构成任何阻塞）。 */
  const reviewPendingCount = useMemo(() => {
    const cards = reviewSummary(canvas.characterCards);
    const shots = reviewSummary(reviewShots);
    return cards.pending + cards.rejected + shots.pending + shots.rejected;
  }, [canvas.characterCards, reviewShots]);

  /** 逐张重生成（决策 11：不过扣费确认卡，直接扣）。落地＝覆盖该格原图（决策 6）。 */
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
        // cards: [] ＝明确关闭卡注入：卡的片段与参考图已在本 payload 内显式给定，
        // 再注入一次会让「要被换掉的那张图」同时当参考（把错误传染给新图）。
        const images = await callCanvasGenerate(
          buildAssetRegeneratePayload(card, referenceIndex, DEFAULT_IMAGE_MODEL_ID),
          controller.signal,
          { cards: [], referenceScope: "all" },
        );
        const image = images[0];
        if (!image?.url) return null;
        const saved = await state.upsertCharacterCard(applyReplaceReference(card, referenceIndex, image.url));
        if (!saved) {
          // 图生了但没写回卡片＝不算成功（不谎报；原图未动，用户可重试）
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

  /** 用户上传自有素材＝直接覆盖原图（决策 6）；压缩走既有的 `fileToDataUrl` 轮子（原地不改既有函式）。 */
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

  /** 驳回（决策 4）：写状态与理由后停下——不重生成、不花钱。写入走真源 `setApproval`。 */
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

  /** 整批一键批准（决策 3）：逐笔套同一动作；失败逐笔如实报，不谎报整批成功。 */
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
   * 分镜批准状态写入（路 1 的冻结栏位；清洗走 `shotApprovalFor` → 真源 `normalizeApprovalState`）。
   * **持久化已通**（2026-09-24 收口片）：`CanvasNodeMetadata.approval` 已宣告，且双白名单两端
   * （`layout.toNodeMetadata` 读取端、`canvas-chat-types.compactMetadataForAgent` 上行端）
   * 都放行该键——刷新/回旧会话后分镜审查面板的批准态不再消失。
   */
  const patchShotApproval = useCallback(
    (nodeId: string, approval: ApprovalState) => {
      canvasStateRef.current.patchNodeMetadata(nodeId, { approval });
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

  // ── A8：拖档案入画布
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

  // ── 编辑器产物 → 子节点插回
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

  /** D：角度 AI 重绘 / mask AI 重绘 → 生成 loading 子节点 → 原地回填。 */
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

  // ── Wave C：agent 画布操作自动化
  const approveAgentOps = useCallback(() => {
    const { runGeneration } = canvasStateRef.current.applyAgentOps();
    runAgentGeneration(runGeneration);
  }, [runAgentGeneration, canvasStateRef]);

  // 画布操作自动化是产品主线：agent 下发的 ops 一到即执行，不设人工确认闸。
  // 使用者仍可用 undo/redo 撤销（approveAgentOps → applyAgentOps 内已 pushHistory）。
  useEffect(() => {
    if (!canvas.pendingAgentOps) return;
    approveAgentOps();
  }, [canvas.pendingAgentOps, approveAgentOps]);

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
      {/* REQ-B2b：挂用＝copy-on-use——面板把副本 id 交回来，这里锁进项目 cardIds（生成注入读的就是它） */}
      <ProjectAssetLibraryPanel
        open={projectAssetsOpen}
        onClose={() => setProjectAssetsOpen(false)}
        projectId={canvas.getProjectId()}
        isLoggedIn={isLoggedIn}
        onCopyChange={canvas.applyMountCopyChange}
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
    </>
  );
}

