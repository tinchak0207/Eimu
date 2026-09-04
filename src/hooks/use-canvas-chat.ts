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
//
// 外圍域已拆（2026-08-22 Task 5，符號名不變、本檔仍為唯一匯出點）：
//   - canvas/canvas-chat-types.ts        展示型事件類型 + UseCanvasChatReturn（39 成員）
//   - canvas/canvas-reducer-adapter.ts   CanvasAction + canvasReducer（19 種 action）
//   - canvas/canvas-project-sync.ts      三個持久化 effect + 專案身份 refs
//   - canvas/use-canvas-cards.ts         角色/場景卡域
//   - canvas/canvas-event-settler.ts     image.done 對賬收斂

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { CANVAS_INITIAL_STATE } from "@/lib/canvas/reducer";
import {
  CANVAS_EMPTY_HISTORY,
  CANVAS_READABLE_MIN_SCALE,
  bezierPath,
  clampScale,
  fitToNodes,
  fromCanvasProject,
  pushSnapshot,
  redoSnapshot,
  summarizeCanvasState,
  undoSnapshot,
  type CanvasHistory,
  type CanvasSnapshot,
} from "@/lib/canvas/layout";
import { listCanvasProjects, postCanvasOpsResult } from "@/lib/canvas/client";
import type {
  CanvasAgentOp,
  CanvasConnection,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasPosition,
  CanvasProject,
  CanvasViewport,
} from "@/lib/canvas/types";
import { canvasReducer } from "./canvas/canvas-reducer-adapter";
import {
  DERIVE_CARD_LIMIT,
  PLAN_CARD_LIMIT,
  PROGRESS_THROTTLE_MS,
  toProjectSummaries,
  type CanvasBackgroundMode,
  type CanvasBudget,
  type CanvasDeriveCard,
  type CanvasPlanCard,
  type CanvasProjectSummary,
  type UseCanvasChatReturn,
} from "./canvas/canvas-chat-types";
import {
  createAgentOpsQueue,
  dequeueAgentOps,
  enqueueAgentOps,
  getQueueHead,
  getQueueHeadEvent,
  type AgentOpsQueue,
} from "./canvas/canvas-agent-ops-queue";
import { useCanvasProjectSync } from "./canvas/canvas-project-sync";
import { useCanvasCards } from "./canvas/use-canvas-cards";
import { useCanvasEventSettler } from "./canvas/canvas-event-settler";

// ─────────────────────────────────────────── 匯出面（barrel：消費端 import 路徑零改動）
export { canvasReducer } from "./canvas/canvas-reducer-adapter";
export type { CanvasAction } from "./canvas/canvas-reducer-adapter";
export type {
  CanvasBackgroundMode,
  CanvasBudget,
  CanvasDeriveCard,
  CanvasPlanCard,
  CanvasProjectSummary,
  UseCanvasChatReturn,
} from "./canvas/canvas-chat-types";

export function useCanvasChat(sessionId?: string | null): UseCanvasChatReturn {
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
  const [savedProjects, setSavedProjects] = useState<CanvasProjectSummary[]>([]);
  // Wave C：agent 下發、待確認/執行的批量畫布操作。
  //
  // 內部用佇列存（見 canvas-agent-ops-queue.ts）：CanvasAgentOpsEvent 沒有
  // session_id，原先單一 nullable slot 在第二個 canvas.ops 事件於第一個尚未
  // resolve 時抵達會直接覆蓋掉它，該 request_id 就再也等不到 postCanvasOpsResult
  // （gateway 端工具調用卡到超時）。修法：Map<request_id, entry> 保序佇列，
  // 每筆各自捕獲「事件抵達當下」的 session id（resolve 時用這個，不用
  // sessionIdRef.current，否則使用者在確認前切 session 會報錯 sid）。
  // 對外仍只暴露佇列頭給 UI（Option A：確認閘 UI 一次顯示一批，resolve 後
  // 自動前進到下一筆）——CanvasEmbed.tsx/CanvasEmbedOverlays.tsx 零改動。
  const [agentOpsQueue, setAgentOpsQueue] = useState<AgentOpsQueue>(createAgentOpsQueue);
  const pendingAgentOps = getQueueHeadEvent(agentOpsQueue);

  // ── 角色/場景卡域（P2 跨鏡頭一致性）：卡列表 + 項目級鎖定
  const {
    characterCards,
    activeCardIds,
    activeCharacterCards,
    setActiveCardIds,
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  } = useCanvasCards();

  // ── refs：給不參與 render 的路徑讀最新值
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const backgroundRef = useRef(backgroundMode);
  backgroundRef.current = backgroundMode;
  const prevSessionIdRef = useRef<string | null | undefined>(null);
  const titleRef = useRef(projectTitle);
  titleRef.current = projectTitle;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const agentOpsQueueRef = useRef(agentOpsQueue);
  agentOpsQueueRef.current = agentOpsQueue;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /** flyTo 動畫的 rAF 句柄（新動畫/卸載時取消）。 */
  const flyRafRef = useRef<number | null>(null);

  // 進度節流用的兩張表：node_id → 計時器 / 最新待送事件。
  const progressTimerRef = useRef<Map<string, number>>(new Map());
  const progressPendingRef = useRef<Map<string, AgentSseEvent>>(new Map());
  const mountedRef = useRef(true);
  // 撤銷/重做正在還原時不推快照，否則按一下撤銷會先把自己存進 past。
  const restoringRef = useRef(false);

  // ─────────────────────── 換畫布 / 歷史清單

  /** 開一張全新畫布（換 session 或使用者手動「新建画布」）。 */
  const newCanvasSession = useCallback(() => {
    // 舊的 debounce 存檔若還掛著，會拿新 projectId 存出空畫布、或拿舊 projectId
    // 覆蓋掉剛開的新畫布 —— 換畫布前先把它作廢。
    // （saveTimerRef/projectIdRef 等 refs 由下方 useCanvasProjectSync 擁有，
    //   useRef 跨 render 是同一物件，這裡的閉包讀到的是最新值。）
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    dispatchCanvas({ type: "clear" });
    setPlans([]);
    setDerives([]);
    setBudget(null);
    setSelectedNodeId(null);
    setHistory(CANVAS_EMPTY_HISTORY);
    setProjectTitle("未命名画布");
    setViewportState({ x: 0, y: 0, k: 1 });
    // 新畫布 = 新項目：卡鎖定是項目級配置，隨舊項目留在歷史裡。
    setActiveCardIds([]);
    // 新畫布要有新身份：後續存檔才會寫進新的一份，而不是覆寫上一張。
    projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdAtRef.current = new Date().toISOString();
    everHadNodesRef.current = false;
    // 舊節點的進度幀不能再落地到新畫布（否則 loading 會憑空冒出來）。
    for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
    progressTimerRef.current.clear();
    progressPendingRef.current.clear();
  }, []);

  const refreshSavedProjects = useCallback(async () => {
    const res = await listCanvasProjects();
    if (!mountedRef.current) return;
    if (res.ok && res.data) setSavedProjects(toProjectSummaries(res.data));
    // 失敗時靜默保留舊值：清單是「順手看」，不值得為網路抖動清空畫面。
  }, []);

  const openSavedCanvas = useCallback(async (id: string) => {
    const res = await listCanvasProjects();
    if (!mountedRef.current) return;
    const target = res.ok && res.data ? res.data.find((p) => p.id === id) : undefined;
    if (!target) return;
    // 指向舊專案身份：之後的存檔覆寫它，而不是另存一份新畫布。
    projectIdRef.current = target.id;
    createdAtRef.current = target.createdAt;
    everHadNodesRef.current = target.nodes && target.nodes.length > 0;
    const restored = fromCanvasProject(target);
    dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
    setViewportState(target.viewport ?? { x: 0, y: 0, k: 1 });
    setBackgroundMode(target.backgroundMode ?? "dots");
    setProjectTitle(target.title || "未命名画布");
    setActiveCardIds(Array.isArray(target.cardIds) ? target.cardIds.filter(Boolean) : []);
    if (target.budget) {
      setBudget({
        usedCoins: target.budget.usedCoins,
        remainingCoins: Math.max(0, target.budget.totalCoins - target.budget.usedCoins),
        updatedAt: Date.now(),
      });
    } else {
      setBudget(null);
    }
    // 換載入的畫布是一條全新時間線：歷史、選取、展示卡都歸零。
    setHistory(CANVAS_EMPTY_HISTORY);
    setSelectedNodeId(null);
    setPlans([]);
    setDerives([]);
  }, []);

  /**
   * Agent 快照下行回填（2026-08-26 Bug1b）：resume 到已有歷史的 session 時，左聊天
   * 續上但右畫布空白 —— 快照此前只有上行沒有下行。gateway 存的是上行壓縮快照
   * （content/prompt 已截斷），fromCanvasProject 負責形狀校驗與降級。
   * 與 openSavedCanvas 同語義：換載入內容 = 全新時間線，不進撤銷棧、選取歸零、
   * plans/derives 不動。恢復結果在 sessionId 變化 effect（newCanvasSession 清場）
   * 之後異步到達，load 直接覆蓋空畫布即可；呼叫端保證僅在 nodes>0 且畫布仍空時調用。
   */
  const restoreAgentSnapshot = useCallback(
    (snapshot: { nodes?: unknown; connections?: unknown; viewport?: CanvasViewport }): boolean => {
      if (!snapshot || typeof snapshot !== "object") return false;
      const restored = fromCanvasProject(snapshot);
      if (restored.nodes.length === 0) return false;
      everHadNodesRef.current = true;
      dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
      if (
        typeof snapshot.viewport?.x === "number" &&
        typeof snapshot.viewport?.y === "number" &&
        typeof snapshot.viewport?.k === "number"
      ) {
        setViewportState({
          x: snapshot.viewport.x,
          y: snapshot.viewport.y,
          k: clampScale(snapshot.viewport.k),
        });
      }
      // 雙向同步方向B：chat 切 session → 畫布選中對應節點
      const linked = restored.nodes.find((n) => n.metadata?.session_id === sessionIdRef.current);
      setSelectedNodeId(linked ? linked.id : null);
      return true;
    },
    [],
  );

  // 監聽 sessionId 變化：換 agent 會話 = 換一張畫布，避免舊畫布跑進新會話。
  useEffect(() => {
    if (!sessionId) return;
    if (sessionId === prevSessionIdRef.current) return;
    const isFirst = prevSessionIdRef.current == null;
    prevSessionIdRef.current = sessionId;
    // 首次拿到 session：畫布本來就是空的（已不再自動還原），不必重置，
    // 否則會白白丟掉 mount 時 mint 的 projectId。
    if (isFirst) return;
    newCanvasSession();
  }, [sessionId, newCanvasSession]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (flyRafRef.current !== null) cancelAnimationFrame(flyRafRef.current);
      for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
      progressTimerRef.current.clear();
      progressPendingRef.current.clear();
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

  // 最終一致性收斂（image.done 對賬）：settle 函數與 URL 佇列由 settler 域提供。
  const { imageDoneQueueRef, settleCandidateNode, settleStaleNodes, settleFailedNode } = useCanvasEventSettler({
    canvasRef,
    progressTimerRef,
    progressPendingRef,
    dispatchCanvas,
  });

  const handleCanvasEvent = useCallback(
    (event: AgentSseEvent) => {
      // Wave C：agent 批量操作先落確認閘（不直接進 reducer）。入隊而非覆蓋——
      // 不同 request_id 各自排隊，同 request_id 重入視為合法重放（見 queue 模組註解）。
      // 捕獲當下 session id：事件本身沒有 session_id 欄位，resolve 時要用「抵達
      // 當下」而非「resolve 當下」的 session，否則使用者切 session 後回報會錯 sid。
      if (event.name === "canvas.ops") {
        if (event.data?.request_id && Array.isArray(event.data?.ops)) {
          setAgentOpsQueue((prev) => enqueueAgentOps(prev, event.data, sessionIdRef.current ?? null));
        }
        return;
      }
      switch (event.name) {
        case "canvas.plan":
          setPlans((prev) => {
            if (prev.some((p) => p.unit_id === event.data.unit_id)) return prev;
            const next = [...prev, { ...event.data, receivedAt: Date.now() }];
            return next.slice(Math.max(0, next.length - PLAN_CARD_LIMIT));
          });
          // C-FE：計劃幀繼續進 reducer——unit 記下 cost_hint，
          // node.created 時蓋章到生成卡（「預估 N 幣」角標）。側欄卡片照舊由 plans 渲染。
          break;
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
        case "image.done": {
          // 圖完成訊號：入隊並立即嘗試用 task_id 配對落地，卡 loading 的節點
          // 不依賴 gateway 一定發 canvas.node.updated（上游無 task_id 時 gateway
          // 只發 image.done，畫布會永遠轉圈 —— 見 2026-08-16 根因分析）。
          imageDoneQueueRef.current.push(event.data);
          settleCandidateNode(event.data);
          return;
        }
        case "image.failed": {
          // 圖失敗訊號（refunded/failed/超時）：與 image.done 對稱。優先 task_id
          // 配對，沒配上的在 turn.done 收斂時按序兜底——絕不能讓節點永遠轉圈。
          settleFailedNode(event.data);
          return;
        }
        case "turn.done":
        case "session.closed":
          // 回合/會話結束：最後收斂，把仍卡 loading 的節點按序配對落地。
          settleStaleNodes();
          return;
        default:
          break;
      }
      // 結構性事件：進 reducer。節點增刪是可撤銷的動作，所以先存一格。
      if (event.name === "canvas.node.created" || event.name === "canvas.node.deleted" || event.name === "canvas.node.connected" || event.name === "canvas.node.disconnected") {
        pushHistory();
      }

      // 進度節流（行動端）：canvas.node.generating 是高頻進度流（同節點每秒
      // 可能多幀）。每節點最多每 PROGRESS_THROTTLE_MS 落地一次 reducer，
      // 窗內只留最新一筆、窗末補送，最後的 progress 不會遺失。
      if (event.name === "canvas.node.generating") {
        const nodeId = event.data.node_id;
        progressPendingRef.current.set(nodeId, event);
        if (progressTimerRef.current.has(nodeId)) return;
        const timer = window.setTimeout(() => {
          progressTimerRef.current.delete(nodeId);
          const latest = progressPendingRef.current.get(nodeId);
          progressPendingRef.current.delete(nodeId);
          if (latest) dispatchCanvas({ type: "event", event: latest });
        }, PROGRESS_THROTTLE_MS);
        progressTimerRef.current.set(nodeId, timer);
        dispatchCanvas({ type: "event", event });
        return;
      }

      // 節點層級的新狀態落地（結果/刪除/新建）＝該節點排隊中的進度幀作廢，
      // 避免「結果都落地了又被舊進度幀蓋回 loading」。
      const supersededNodeId =
        event.name === "canvas.node.updated" || event.name === "canvas.node.deleted"
          ? event.data.node_id
          : event.name === "canvas.node.created"
            ? event.data.node.id
            : null;
      if (supersededNodeId) {
        const t = progressTimerRef.current.get(supersededNodeId);
        if (t !== undefined) {
          window.clearTimeout(t);
          progressTimerRef.current.delete(supersededNodeId);
          progressPendingRef.current.delete(supersededNodeId);
        }
      }

      dispatchCanvas({ type: "event", event });
    },
    [pushHistory, imageDoneQueueRef, settleCandidateNode, settleFailedNode, settleStaleNodes],
  );

  // 對外事件入口：外部 chat（AgentChatSurface 的 onCanvasEvent）呼叫。
  const feedCanvasEvent = handleCanvasEvent;
  // 對外摘要提供者（外部 chat 的 canvasStateProvider 用）。空畫布回 undefined。
  // 附帶用戶當前選區與視口縮放：agent 不再是瞎子，能圍繞「用戶正在看的節點」幹活。
  const summarize = () => {
    const state = canvasRef.current;
    const lockedCards = characterCardsRef.current.filter((c) => activeCardIdsRef.current.includes(c.id));
    if (state.nodes.length === 0 && state.units.length === 0 && lockedCards.length === 0) return undefined;
    const base = summarizeCanvasState(state) as unknown as Record<string, unknown>;
    const selected = selectedNodeIdRef.current;
    if (selected) base.selected_node_id = selected;
    base.viewport_scale = Math.round(viewportRef.current.k * 100) / 100;
    // P2：鎖定卡進上行摘要（agent 可見——知道哪些外觀/場景約束已生效）。
    base.character_cards = lockedCards.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      prompt: c.prompt,
      ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
      reference_count: c.references.length,
      ...(c.loraIds?.length ? { lora_ids: c.loraIds } : {}),
    }));
    return base;
  };

  // ─────────────────────── 專案持久化（init → debounce → snapshot，順序同原內聯版）

  const { projectIdRef, createdAtRef, saveTimerRef, everHadNodesRef, buildProject } = useCanvasProjectSync({
    canvasRef,
    viewportRef,
    backgroundRef,
    titleRef,
    budgetRef,
    activeCardIdsRef,
    mountedRef,
    canvas,
    viewport,
    backgroundMode,
    projectTitle,
    activeCardIds,
    saveState,
    sessionId,
    selectedNodeId,
    activeCharacterCards,
    setSavedProjects,
    setSaveState,
    setLoading,
  });

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
      setViewportState(fitToNodes(canvasRef.current.nodes, width, height, 80, CANVAS_READABLE_MIN_SCALE));
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
    dispatchCanvas({
      type: "move",
      nodeId,
      position,
    });
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

  // ─────────────────────── Phase 3 畫布交互

  /** 群組拖動：每幀一次 dispatch 移整組。不推 history（由 commitInteraction 收口）。 */
  const moveNodes = useCallback((moves: { nodeId: string; position: CanvasPosition }[]) => {
    if (moves.length === 0) return;
    dispatchCanvas({ type: "move_many", moves });
  }, []);

  const addNodes = useCallback(
    (nodes: CanvasNode[], connections?: CanvasConnection[]) => {
      if (nodes.length === 0 && !(connections?.length)) return;
      pushHistory();
      dispatchCanvas({ type: "add_nodes", nodes, ...(connections ? { connections } : {}) });
    },
    [pushHistory],
  );

  /**
   * 同一 workflow 的重複套用 = 替換不是疊加（2026-08-26 Bug3）：addNodes 是追加語義，
   * 同一張模板卡點兩次會平鋪兩份 30+ 節點。這裡先刪掉 metadata.workflow_id 相同的
   * 全部舊節點（delete_many 連帶清掉懸空連線），再 add_nodes 新的一批；兩個 dispatch
   * 在同一輪批次裡落地，history 只推一格 —— undo 一鍵回到替換前。
   */
  const replaceWorkflowNodes = useCallback(
    (workflowId: string, nodes: CanvasNode[], connections?: CanvasConnection[]) => {
      if (!workflowId) return;
      pushHistory();
      const staleIds = canvasRef.current.nodes
        .filter((n) => n.metadata?.workflow_id === workflowId)
        .map((n) => n.id);
      if (staleIds.length > 0) dispatchCanvas({ type: "delete_many", nodeIds: staleIds });
      if (nodes.length > 0 || connections?.length) {
        dispatchCanvas({ type: "add_nodes", nodes, ...(connections ? { connections } : {}) });
      }
    },
    [pushHistory],
  );

  const deleteNodes = useCallback(
    (nodeIds: string[]) => {
      if (nodeIds.length === 0) return;
      pushHistory();
      dispatchCanvas({ type: "delete_many", nodeIds });
      setSelectedNodeId((prev) => (prev && nodeIds.includes(prev) ? null : prev));
    },
    [pushHistory],
  );

  const addConnection = useCallback(
    (fromNodeId: string, toNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "connect", fromNodeId, toNodeId });
    },
    [pushHistory],
  );

  const removeConnection = useCallback(
    (connectionId: string) => {
      pushHistory();
      dispatchCanvas({ type: "disconnect", connectionId });
    },
    [pushHistory],
  );

  // ─────────────────────── Wave A：就地編輯

  const renameNode = useCallback(
    (nodeId: string, title: string) => {
      pushHistory();
      dispatchCanvas({ type: "rename", nodeId, title });
    },
    [pushHistory],
  );

  /** metadata 補丁（文本直編提交、原地生成回填、字號、重試狀態）。history 預設推一格。 */
  const patchNodeMetadata = useCallback(
    (nodeId: string, patch: Partial<CanvasNodeMetadata>, opts?: { history?: boolean }) => {
      if (opts?.history !== false) pushHistory();
      dispatchCanvas({ type: "patch_metadata", nodeId, patch });
    },
    [pushHistory],
  );

  // ─────────────────────── B2：飛行聚焦（450ms easeOutCubic）

  const flyTo = useCallback((world: CanvasPosition, viewportWidth: number, viewportHeight: number, targetK?: number) => {
    const start = viewportRef.current;
    const endK = clampScale(targetK ?? Math.max(start.k, 0.85));
    const endX = viewportWidth / 2 - world.x * endK;
    const endY = viewportHeight / 2 - world.y * endK;
    if (flyRafRef.current !== null) cancelAnimationFrame(flyRafRef.current);
    const t0 = performance.now();
    const DURATION = 450;
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / DURATION);
      const e = 1 - Math.pow(1 - t, 3);
      setViewportState({
        x: start.x + (endX - start.x) * e,
        y: start.y + (endY - start.y) * e,
        k: start.k + (endK - start.k) * e,
      });
      flyRafRef.current = t < 1 ? requestAnimationFrame(step) : null;
    };
    flyRafRef.current = requestAnimationFrame(step);
  }, []);

  // ─────────────────────── Wave C：agent 操作的確認/執行/拒絕

  /**
   * 批准並執行 agent 待審操作。回傳 run_generation 清單交宿主觸發生成。
   * 用佇列頭自己捕獲的 session id 回報結果（不是 sessionIdRef.current 當下值）——
   * 這是本次修的 bug 本體：舊版讀當下 session，使用者切過 session 就報錯 sid。
   * resolve 後從佇列摘除該筆，UI 綁的 pendingAgentOps（佇列頭）自動前進到下一筆。
   */
  const applyAgentOps = useCallback((): { runGeneration: { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] } => {
    const head = getQueueHead(agentOpsQueueRef.current);
    const result = { runGeneration: [] as { nodeId: string; prompt?: string; model?: string; size?: string; count?: number }[] };
    if (!head) return result;
    const { requestId, entry } = head;
    const pending = entry.event;
    pushHistory();
    dispatchCanvas({ type: "agent_ops", ops: pending.ops });
    for (const op of pending.ops) {
      if (op.type === "select_nodes") {
        setSelectedNodeId(op.ids[0] ?? null);
      } else if (op.type === "set_viewport") {
        setViewportState((prev) => ({ ...prev, ...op.viewport, k: clampScale(op.viewport.k ?? prev.k) }));
      } else if (op.type === "run_generation") {
        result.runGeneration.push({ nodeId: op.node_id, prompt: op.prompt, model: op.model, size: op.size, count: op.count });
      }
    }
    setAgentOpsQueue((prev) => dequeueAgentOps(prev, requestId));
    const sid = entry.capturedSessionId;
    if (sid) {
      const createdIds = pending.ops.filter((o): o is Extract<CanvasAgentOp, { type: "add_node" }> => o.type === "add_node").map((o) => o.node.id);
      void postCanvasOpsResult(sid, requestId, { ok: true, ...(createdIds.length ? { created_node_ids: createdIds } : {}) });
    }
    return result;
  }, [pushHistory]);

  /**
   * 拒絕 agent 待審操作（結果回報 gateway，讓工具調用拿到明確拒絕而非超時）。
   * 同樣用該筆捕獲的 session id，不用 sessionIdRef.current。
   */
  const dismissAgentOps = useCallback((reason?: string) => {
    const head = getQueueHead(agentOpsQueueRef.current);
    if (!head) return;
    const { requestId, entry } = head;
    setAgentOpsQueue((prev) => dequeueAgentOps(prev, requestId));
    const sid = entry.capturedSessionId;
    if (sid) {
      void postCanvasOpsResult(sid, requestId, { ok: false, error: reason ?? "用户拒绝了此次画布操作" });
    }
  }, []);

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

  // ─────────────────────── 批次操作

  const addBatchChild = useCallback(
    (parentId: string, child: CanvasNode) => {
      pushHistory();
      dispatchCanvas({ type: "batch_add_child", parentId, child });
    },
    [pushHistory],
  );

  const setBatchPrimary = useCallback(
    (parentId: string, childId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_set_primary", parentId, childId });
    },
    [pushHistory],
  );

  const deleteBatchChild = useCallback(
    (parentId: string, childId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_delete_child", parentId, childId });
    },
    [pushHistory],
  );

  const toggleBatchExpanded = useCallback(
    (parentId: string) => {
      pushHistory();
      dispatchCanvas({ type: "batch_toggle_expanded", parentId });
    },
    [pushHistory],
  );

  // ─────────────────────── @引用操作

  const addReference = useCallback(
    (nodeId: string, referenceNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "add_reference", nodeId, referenceNodeId });
    },
    [pushHistory],
  );

  const removeReference = useCallback(
    (nodeId: string, referenceNodeId: string) => {
      pushHistory();
      dispatchCanvas({ type: "remove_reference", nodeId, referenceNodeId });
    },
    [pushHistory],
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
    newCanvasSession,
    savedProjects,
    refreshSavedProjects,
    openSavedCanvas,
    restoreAgentSnapshot,
    pathFor,
    moveNodes,
    addNodes,
    replaceWorkflowNodes,
    deleteNodes,
    addConnection,
    removeConnection,
    addBatchChild,
    setBatchPrimary,
    deleteBatchChild,
    toggleBatchExpanded,
    addReference,
    removeReference,
    renameNode,
    patchNodeMetadata,
    flyTo,
    pendingAgentOps,
    applyAgentOps,
    dismissAgentOps,
    characterCards,
    activeCardIds,
    activeCharacterCards,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  };
}
