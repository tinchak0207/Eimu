"use client";

// 畫布 + chat 的整合 hook。
//
// 一條 SSE、兩個狀態機：useAgentChat 管連線與 transcript，這裡管畫布。
// 分流在 use-agent-chat.ts 的 handleSseEvent（onCanvasEvent 出口），
// 所以畫布頁不會另開一個 session —— 開兩個 session 會讓 agent 出的圖
// 落在另一條流上，畫布永遠等不到事件。
//
// 職責邊界：
//   - 事件 → 畫布狀態：normalizeCanvasEvent + reduceCanvasEvent（純函式，已測）
//   - 視口/背景/選取：本地 state，不上送
//   - 專案持久化：debounce 400ms PUT /api/canvas/projects
//   - undo/redo：節點/連線/視口的快照棧

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { CANVAS_INITIAL_STATE, reduceCanvasEvent, type CanvasReducerState } from "@/lib/canvas/reducer";
import {
  CANVAS_EMPTY_HISTORY,
  bezierPath,
  fitToNodes,
  fromCanvasProject,
  normalizeCanvasEvent,
  pushSnapshot,
  redoSnapshot,
  summarizeCanvasState,
  toCanvasProject,
  undoSnapshot,
  type CanvasHistory,
  type CanvasSnapshot,
} from "@/lib/canvas/layout";
import { listCanvasProjects, pickLatestProject, saveCanvasProject } from "@/lib/canvas/client";
import type {
  CanvasConnection,
  CanvasNode,
  CanvasPlanEvent,
  CanvasPosition,
  CanvasProject,
  CanvasUnit,
  CanvasViewport,
} from "@/lib/canvas/types";

// ─────────────────────────────────────────── 畫布 action

/**
 * reduceCanvasEvent 的簽名是 (state, CanvasSseEvent)，不是標準 reducer。
 * 這裡包一層 adapter，同時容納「本端動作」（載入專案、拖動節點、undo 還原）。
 */
type CanvasAction =
  | { type: "event"; event: AgentSseEvent }
  | { type: "load"; nodes: CanvasNode[]; connections: CanvasConnection[] }
  | { type: "move"; nodeId: string; position: CanvasPosition }
  | { type: "resize"; nodeId: string; width: number; height: number }
  | { type: "remove"; nodeId: string }
  | { type: "clear" };

function canvasReducer(state: CanvasReducerState, action: CanvasAction): CanvasReducerState {
  switch (action.type) {
    case "event": {
      const normalized = normalizeCanvasEvent(action.event);
      // derive.started / budget.updated 不改畫布結構，由 hook 另存展示狀態。
      if (!normalized) return state;
      return reduceCanvasEvent(state, normalized);
    }
    case "load":
      return { units: [], nodes: action.nodes, connections: action.connections };
    case "move":
      return {
        ...state,
        nodes: state.nodes.map((n) => (n.id === action.nodeId ? { ...n, position: action.position } : n)),
      };
    case "resize":
      return {
        ...state,
        nodes: state.nodes.map((n) =>
          n.id === action.nodeId ? { ...n, width: action.width, height: action.height } : n,
        ),
      };
    case "remove":
      return {
        units: state.units.map((u) => ({
          ...u,
          nodes: u.nodes.filter((n) => n.id !== action.nodeId),
          connections: u.connections.filter((c) => c.fromNodeId !== action.nodeId && c.toNodeId !== action.nodeId),
        })),
        nodes: state.nodes.filter((n) => n.id !== action.nodeId),
        connections: state.connections.filter(
          (c) => c.fromNodeId !== action.nodeId && c.toNodeId !== action.nodeId,
        ),
      };
    case "clear":
      return CANVAS_INITIAL_STATE;
  }
}

// ─────────────────────────────────────────── 展示型事件狀態

/** canvas.plan 的計畫卡（左側欄）。 */
export interface CanvasPlanCard extends CanvasPlanEvent {
  receivedAt: number;
}

/** canvas.derive.started 的指揮解讀卡。 */
export interface CanvasDeriveCard {
  unitId: string;
  sourceNodeId: string;
  instruction: string;
  interpretation?: string;
  receivedAt: number;
}

/** canvas.budget.updated 的預算信封。 */
export interface CanvasBudget {
  usedCoins: number;
  remainingCoins: number;
  updatedAt: number;
}

export type CanvasBackgroundMode = "dots" | "lines" | "blank";

const SAVE_DEBOUNCE_MS = 400;
const PLAN_CARD_LIMIT = 30;
const DERIVE_CARD_LIMIT = 20;

export interface UseCanvasChatReturn {
  // ── 事件入口：外部 chat（AgentChatSurface 的 useAgentChat onCanvasEvent）轉交這裡。
  feedCanvasEvent: (event: AgentSseEvent) => void;
  /** 每次 send 上送的畫布摘要（供外部掛到 chat 的 canvasStateProvider）。 */
  summarize: () => unknown;
  // ── 畫布狀態
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  units: CanvasUnit[];
  plans: CanvasPlanCard[];
  derives: CanvasDeriveCard[];
  budget: CanvasBudget | null;
  // ── 視口
  viewport: CanvasViewport;
  setViewport: (next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => void;
  backgroundMode: CanvasBackgroundMode;
  cycleBackground: () => void;
  fitView: (width: number, height: number) => void;
  centerOn: (world: CanvasPosition, viewportWidth: number, viewportHeight: number) => void;
  // ── 選取 / 編輯
  selectedNodeId: string | null;
  selectNode: (nodeId: string | null) => void;
  moveNode: (nodeId: string, position: CanvasPosition) => void;
  resizeNode: (nodeId: string, width: number, height: number) => void;
  removeNode: (nodeId: string) => void;
  commitInteraction: () => void;
  // ── 歷史
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  // ── 專案
  projectTitle: string;
  setProjectTitle: (title: string) => void;
  loading: boolean;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  loadProject: (project: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport; backgroundMode?: CanvasBackgroundMode; title?: string }) => void;
  exportProject: () => CanvasProject;
  clearCanvas: () => void;
  // ── 幾何工具（元件用）
  pathFor: (connection: CanvasConnection) => string | null;
}

export function useCanvasChat(): UseCanvasChatReturn {
  const [canvas, dispatchCanvas] = useReducer(canvasReducer, CANVAS_INITIAL_STATE);
  const [plans, setPlans] = useState<CanvasPlanCard[]>([]);
  const [derives, setDerives] = useState<CanvasDeriveCard[]>([]);
  const [budget, setBudget] = useState<CanvasBudget | null>(null);
  const [viewport, setViewportState] = useState<CanvasViewport>({ x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<CanvasHistory>(CANVAS_EMPTY_HISTORY);
  const [projectTitle, setProjectTitle] = useState("未命名画布");
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<UseCanvasChatReturn["saveState"]>("idle");

  // ── refs：給不參與 render 的路徑讀最新值
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const backgroundRef = useRef(backgroundMode);
  backgroundRef.current = backgroundMode;
  const titleRef = useRef(projectTitle);
  titleRef.current = projectTitle;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;

  const projectIdRef = useRef<string | null>(null);
  const createdAtRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  // 載入完成前不要存：初始空畫布會把雲端那份覆蓋成空的。
  const hydratedRef = useRef(false);
  // 撤銷/重做正在還原時不推快照，否則按一下撤銷會先把自己存進 past。
  const restoringRef = useRef(false);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
  }, []);

  // ─────────────────────── 快照

  const snapshotNow = useCallback((): CanvasSnapshot => {
    return {
      nodes: canvasRef.current.nodes,
      connections: canvasRef.current.connections,
      viewport: viewportRef.current,
    };
  }, []);

  /** 動作前推一格快照。事件驅動的變更也推，這樣「撤銷」能收回 agent 剛加的節點。 */
  const pushHistory = useCallback(() => {
    if (restoringRef.current) return;
    setHistory((prev) => pushSnapshot(prev, snapshotNow()));
  }, [snapshotNow]);

  // ─────────────────────── SSE 畫布事件入口

  const handleCanvasEvent = useCallback(
    (event: AgentSseEvent) => {
      switch (event.name) {
        case "canvas.plan":
          setPlans((prev) => {
            if (prev.some((p) => p.unit_id === event.data.unit_id)) return prev;
            const next = [...prev, { ...event.data, receivedAt: Date.now() }];
            return next.slice(Math.max(0, next.length - PLAN_CARD_LIMIT));
          });
          return;
        case "canvas.derive.started":
          setDerives((prev) => {
            const next = [
              ...prev,
              {
                unitId: event.data.unit_id,
                sourceNodeId: event.data.source_node_id,
                instruction: event.data.instruction,
                ...(event.data.interpretation ? { interpretation: event.data.interpretation } : {}),
                receivedAt: Date.now(),
              },
            ];
            return next.slice(Math.max(0, next.length - DERIVE_CARD_LIMIT));
          });
          return;
        case "canvas.budget.updated":
          setBudget({
            usedCoins: event.data.used_coins,
            remainingCoins: event.data.remaining_coins,
            updatedAt: Date.now(),
          });
          return;
        default:
          break;
      }
      // 結構性事件：進 reducer。節點增刪是可撤銷的動作，所以先存一格。
      if (event.name === "canvas.node.created" || event.name === "canvas.node.deleted" || event.name === "canvas.node.connected") {
        pushHistory();
      }
      dispatchCanvas({ type: "event", event });
    },
    [pushHistory],
  );

  // 對外事件入口：外部 chat（AgentChatSurface 的 onCanvasEvent）呼叫。
  const feedCanvasEvent = handleCanvasEvent;
  // 對外摘要提供者（外部 chat 的 canvasStateProvider 用）。空畫布回 undefined。
  const summarize = () => {
    const state = canvasRef.current;
    if (state.nodes.length === 0 && state.units.length === 0) return undefined;
    return summarizeCanvasState(state);
  };

  // ─────────────────────── 專案載入（進頁時還原最近一份）

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listCanvasProjects();
      if (cancelled || !mountedRef.current) return;
      if (res.ok && res.data) {
        const latest = pickLatestProject(res.data);
        if (latest) {
          projectIdRef.current = latest.id;
          createdAtRef.current = latest.createdAt;
          const restored = fromCanvasProject(latest);
          dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
          setViewportState(latest.viewport ?? { x: 0, y: 0, k: 1 });
          setBackgroundMode(latest.backgroundMode ?? "dots");
          setProjectTitle(latest.title || "未命名画布");
          if (latest.budget) {
            setBudget({
              usedCoins: latest.budget.usedCoins,
              remainingCoins: Math.max(0, latest.budget.totalCoins - latest.budget.usedCoins),
              updatedAt: Date.now(),
            });
          }
        }
      } else if (res.reason === "not_authenticated") {
        // 沒登入：畫布照常能用，只是不存雲端。不擋路、也不假裝存了。
        setSaveState("offline");
      }
      if (!projectIdRef.current) {
        projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        createdAtRef.current = new Date().toISOString();
      }
      hydratedRef.current = true;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ─────────────────────── 專案儲存（debounce 400ms）

  const buildProject = useCallback((): CanvasProject => {
    const id = projectIdRef.current ?? `canvas-${Date.now()}`;
    const b = budgetRef.current;
    return toCanvasProject(
      { id, title: titleRef.current, ...(createdAtRef.current ? { createdAt: createdAtRef.current } : {}) },
      canvasRef.current,
      viewportRef.current,
      backgroundRef.current,
      b ? { totalCoins: b.usedCoins + b.remainingCoins, usedCoins: b.usedCoins } : undefined,
    );
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveState === "offline") return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const project = buildProject();
      setSaveState("saving");
      void saveCanvasProject(project).then((res) => {
        if (!mountedRef.current) return;
        if (res.ok) setSaveState("saved");
        else setSaveState(res.reason === "not_authenticated" ? "offline" : "error");
      });
    }, SAVE_DEBOUNCE_MS);
    // 依賴畫布本體與視口/背景/標題：任何一項變化都該落盤。
    // saveState 刻意不進依賴 —— 它由這個 effect 自己寫，進去會變成自觸發循環。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, viewport, backgroundMode, projectTitle, buildProject]);

  // ─────────────────────── 視口

  const setViewport = useCallback((next: CanvasViewport | ((prev: CanvasViewport) => CanvasViewport)) => {
    setViewportState((prev) => (typeof next === "function" ? next(prev) : next));
  }, []);

  const cycleBackground = useCallback(() => {
    setBackgroundMode((prev) => (prev === "dots" ? "lines" : prev === "lines" ? "blank" : "dots"));
  }, []);

  const fitView = useCallback(
    (width: number, height: number) => {
      pushHistory();
      setViewportState(fitToNodes(canvasRef.current.nodes, width, height));
    },
    [pushHistory],
  );

  const centerOn = useCallback((world: CanvasPosition, viewportWidth: number, viewportHeight: number) => {
    setViewportState((prev) => ({
      ...prev,
      x: viewportWidth / 2 - world.x * prev.k,
      y: viewportHeight / 2 - world.y * prev.k,
    }));
  }, []);

  // ─────────────────────── 節點編輯

  const selectNode = useCallback((nodeId: string | null) => setSelectedNodeId(nodeId), []);

  /**
   * 拖動/縮放中的每一帧都不推快照 —— 一次拖動會產生上百帧，
   * 全推進去等於把撤銷棧當成錄影。互動結束時由 commitInteraction 推一格。
   */
  const moveNode = useCallback((nodeId: string, position: CanvasPosition) => {
    dispatchCanvas({ type: "move", nodeId, position });
  }, []);

  const resizeNode = useCallback((nodeId: string, width: number, height: number) => {
    dispatchCanvas({ type: "resize", nodeId, width, height });
  }, []);

  const removeNode = useCallback(
    (nodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "remove", nodeId });
      setSelectedNodeId((prev) => (prev === nodeId ? null : prev));
    },
    [pushHistory],
  );

  /** 互動（拖動/縮放）開始前呼叫：把互動前的狀態存成一格。 */
  const commitInteraction = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  // ─────────────────────── undo / redo

  const applySnapshot = useCallback((snapshot: CanvasSnapshot) => {
    restoringRef.current = true;
    dispatchCanvas({ type: "load", nodes: snapshot.nodes, connections: snapshot.connections });
    setViewportState(snapshot.viewport);
    // 還原是同步 dispatch，但 React 批次更新到下一帧才落地；
    // 用 microtask 解鎖，避免同一輪裡的 pushHistory 把還原也記成一步。
    void Promise.resolve().then(() => {
      restoringRef.current = false;
    });
  }, []);

  const undo = useCallback(() => {
    const result = undoSnapshot(history, snapshotNow());
    if (!result) return;
    setHistory(result.history);
    applySnapshot(result.snapshot);
  }, [history, snapshotNow, applySnapshot]);

  const redo = useCallback(() => {
    const result = redoSnapshot(history, snapshotNow());
    if (!result) return;
    setHistory(result.history);
    applySnapshot(result.snapshot);
  }, [history, snapshotNow, applySnapshot]);

  // ─────────────────────── 專案匯入/匯出/清空

  const loadProject = useCallback(
    (project: {
      nodes?: unknown;
      connections?: unknown;
      viewport?: CanvasViewport;
      backgroundMode?: CanvasBackgroundMode;
      title?: string;
    }) => {
      pushHistory();
      const restored = fromCanvasProject(project);
      dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
      if (project.viewport) setViewportState(project.viewport);
      if (project.backgroundMode) setBackgroundMode(project.backgroundMode);
      if (project.title) setProjectTitle(project.title);
      setSelectedNodeId(null);
    },
    [pushHistory],
  );

  const exportProject = useCallback((): CanvasProject => buildProject(), [buildProject]);

  const clearCanvas = useCallback(() => {
    pushHistory();
    dispatchCanvas({ type: "clear" });
    setPlans([]);
    setDerives([]);
    setSelectedNodeId(null);
  }, [pushHistory]);

  // ─────────────────────── 幾何

  const nodeIndex = useMemo(() => {
    const map = new Map<string, CanvasNode>();
    for (const n of canvas.nodes) map.set(n.id, n);
    return map;
  }, [canvas.nodes]);

  const pathFor = useCallback(
    (connection: CanvasConnection): string | null => {
      const from = nodeIndex.get(connection.fromNodeId);
      const to = nodeIndex.get(connection.toNodeId);
      if (!from || !to) return null;
      return bezierPath(from, to);
    },
    [nodeIndex],
  );

  return {
    feedCanvasEvent,
    summarize,
    nodes: canvas.nodes,
    connections: canvas.connections,
    units: canvas.units,
    plans,
    derives,
    budget,
    viewport,
    setViewport,
    backgroundMode,
    cycleBackground,
    fitView,
    centerOn,
    selectedNodeId,
    selectNode,
    moveNode,
    resizeNode,
    removeNode,
    commitInteraction,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo,
    redo,
    projectTitle,
    setProjectTitle,
    loading,
    saveState,
    loadProject,
    exportProject,
    clearCanvas,
    pathFor,
  };
}
