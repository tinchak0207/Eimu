"use client";

// 画布 + chat 的整合 hook。
//
// 一条 SSE、两个状态机：useAgentChat 管连线与 transcript，这里管画布。
// 分流在 use-agent-chat.ts 的 handleSseEvent（onCanvasEvent 出口），
// 所以画布页不会另开一个 session —— 开两个 session 会让 agent 出的图
// 落在另一条流上，画布永远等不到事件。
//
// 职责边界：
//   - 事件 → 画布状态：normalizeCanvasEvent + reduceCanvasEvent（纯函式，已测）
//   - 视口/背景/选取：本地 state，不上送
//   - 专案持久化：debounce 400ms PUT /api/canvas/projects
//   - undo/redo：节点/连线/视口的快照栈
//
// 外围域已拆（2026-08-22 Task 5，符号名不变、本档仍为唯一汇出点）：
//   - canvas/canvas-chat-types.ts        展示型事件类型 + UseCanvasChatReturn（39 成员）
//   - canvas/canvas-reducer-adapter.ts   CanvasAction + canvasReducer（19 种 action）
//   - canvas/canvas-project-sync.ts      三个持久化 effect + 专案身份 refs
//   - canvas/use-canvas-cards.ts         角色/场景卡域
//   - canvas/canvas-event-settler.ts     image.done 对账收敛

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { CANVAS_INITIAL_STATE, layoutGraph } from "@/lib/canvas/reducer";
import {
  CANVAS_EMPTY_HISTORY,
  CANVAS_READABLE_MIN_SCALE,
  bezierPath,
  canvasProjectMeta,
  clampScale,
  fitToNodes,
  fromCanvasProject,
  normalizeProjectMetaPatch,
  pushSnapshot,
  redoSnapshot,
  summarizeCanvasState,
  undoSnapshot,
  type CanvasHistory,
  type CanvasSnapshot,
} from "@/lib/canvas/layout";
import { fetchCanvasProject, listCanvasProjectSummaries, postCanvasOpsResult } from "@/lib/canvas/client";
// 风格 id 值域判据（＝STYLE_LIBRARY 注册面），与落盘/生成端共用同一把尺。
import { normalizeProjectStyleId } from "@/lib/canvas/project-style";
// 解说剧设定（P1-5／D7）：型别值域＋旁白音色的判据（与落盘端同一份）。
import { isCanvasScriptType, type CanvasScriptType } from "@/lib/canvas/project-narration";
import { normalizeVoiceId } from "@/lib/voice-library";
import { CanvasNodeType, isCanvasProjectType } from "@/lib/canvas/types";
import { isValidCreationStep } from "@/lib/creation-flow-steps";
import type {
  CanvasAgentOp,
  CanvasConnection,
  CanvasEpisode,
  CanvasNode,
  CanvasNodeMetadata,
  CanvasPosition,
  CanvasProject,
  CanvasProjectType,
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
import { upstreamTextNameFor, useCanvasCards } from "./canvas/use-canvas-cards";
import { useCanvasEventSettler } from "./canvas/canvas-event-settler";
import { ENTITY_CARD_ID_PREFIX, toAgentOutputNodeRef } from "@/lib/agent-output-cards";
import { toast } from "@/hooks/use-toast";

/** WS4：节点交付→自动落卡的 debounce（串流期间节点内容高频变动，等安静再落卡）。 */
const EMITTED_ANCHOR_DEBOUNCE_MS = 500;

// ─────────────────────────────────────────── 汇出面（barrel：消费端 import 路径零改动）
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

/**
 * 下游闭包（回跳作废用，纯函式，可直接单测）：沿连线 BFS 取 root 全部下游，
 * 滤掉 text/prompt/config（纯资料节点没有生成结果，无所谓作废——与网关
 * `workflow-service.updateNode` 的 BFS 规则逐条对齐：它同样只重置非 text/config）。
 * root 自身不在回传内（回跳改的是上游，被改的那步由用户自己重跑）。
 */
export function downstreamInvalidationIds(
  nodes: Pick<CanvasNode, "id" | "type">[],
  connections: Pick<CanvasConnection, "fromNodeId" | "toNodeId">[],
  rootId: string,
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(rootId)) return [];
  const voidsDataOnly = (id: string): boolean => {
    const type = byId.get(id)?.type;
    return type === CanvasNodeType.Text || type === CanvasNodeType.Prompt || type === CanvasNodeType.Config;
  };
  const visited = new Set<string>([rootId]);
  const out: string[] = [];
  const queue = [rootId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const c of connections) {
      if (c.fromNodeId !== current || visited.has(c.toNodeId)) continue;
      visited.add(c.toNodeId);
      queue.push(c.toNodeId);
      if (byId.has(c.toNodeId) && !voidsDataOnly(c.toNodeId)) out.push(c.toNodeId);
    }
  }
  return out;
}

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
  // 作品/剧集三级状态机（2026-09-15 刀 1 前端接线）：专案级状态，持久化在 CanvasProject 顶层三栏。
  // 写入口＝setProjectMeta（UI 面板与 agent 驱动的画布操作共用），读回＝三处还原点 + canvasProjectMeta。
  const [projectType, setProjectType] = useState<CanvasProjectType | undefined>(undefined);
  const [currentStep, setCurrentStep] = useState<number | undefined>(undefined);
  const [episodes, setEpisodes] = useState<CanvasEpisode[]>([]);
  // 专案级风格绑定（P1-8／对称差 D34）：StyleTemplate.id，与上面三栏同一组档位/同一写入口。
  // 生成时由呼叫端把这个 id 带进 /api/canvas/generate 的 style_id（本 hook 不改生成请求）。
  const [styleId, setStyleId] = useState<string | undefined>(undefined);
  // 解说剧设定（P1-5／D7）：型别＋旁白音色；与风格绑定同款 state（写入口＝setProjectMeta）。
  const [scriptType, setScriptType] = useState<CanvasScriptType | undefined>(undefined);
  const [narrationVoice, setNarrationVoice] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState<UseCanvasChatReturn["saveState"]>("idle");
  const [savedProjects, setSavedProjects] = useState<CanvasProjectSummary[]>([]);
  // Wave C：agent 下发、即时执行的批量画布操作（画布操作自动化，无人工确认闸）。
  //
  // 内部用伫列存（见 canvas-agent-ops-queue.ts）：CanvasAgentOpsEvent 没有
  // session_id，原先单一 nullable slot 在第二个 canvas.ops 事件于第一个尚未
  // resolve 时抵达会直接覆盖掉它，该 request_id 就再也等不到 postCanvasOpsResult
  // （gateway 端工具调用卡到超时）。修法：Map<request_id, entry> 保序伫列，
  // 每笔各自捕获「事件抵达当下」的 session id（resolve 时用这个，不用
  // sessionIdRef.current，否则使用者在操作落地前切 session 会报错 sid）。
  // 对外仍只暴露伫列头（一次只处理一批，resolve 后
  // 自动前进到下一笔）——宿主 CanvasEmbed.tsx 的 effect 一到即自动执行。
  const [agentOpsQueue, setAgentOpsQueue] = useState<AgentOpsQueue>(createAgentOpsQueue);
  const pendingAgentOps = getQueueHeadEvent(agentOpsQueue);

  // ── 角色/场景卡域（P2 跨镜头一致性）：卡列表 + 项目级锁定
  // 项目 id ref 先于卡域建立并注入（REQ-B2b）：卡域的读取端作用域闸要判「锁定卡属不属于
  // 当前项目」，读的就是这一个 ref——卡域在本 hook 之前呼叫，若晚建则闸首帧拿到 null 漏判。
  const projectIdRef = useRef<string | null>(null);
  const {
    characterCards,
    activeCardIds,
    activeCharacterCards,
    setActiveCardIds,
    applyMountCopyChange,
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
    autoAnchorEmittedCards,
  } = useCanvasCards({ getProjectId: () => projectIdRef.current });

  // ── refs：给不参与 render 的路径读最新值
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
  const projectTypeRef = useRef(projectType);
  projectTypeRef.current = projectType;
  const currentStepRef = useRef(currentStep);
  currentStepRef.current = currentStep;
  const episodesRef = useRef(episodes);
  episodesRef.current = episodes;
  // 风格绑定（P1-8／D34）：同款「最新值链像 ref」，供 buildProject 取当下值。
  const styleIdRef = useRef(styleId);
  styleIdRef.current = styleId;
  const scriptTypeRef = useRef(scriptType);
  scriptTypeRef.current = scriptType;
  const narrationVoiceRef = useRef(narrationVoice);
  narrationVoiceRef.current = narrationVoice;
  const selectedNodeIdRef = useRef(selectedNodeId);
  selectedNodeIdRef.current = selectedNodeId;
  const agentOpsQueueRef = useRef(agentOpsQueue);
  agentOpsQueueRef.current = agentOpsQueue;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /** flyTo 动画的 rAF 句柄（新动画/卸载时取消）。 */
  const flyRafRef = useRef<number | null>(null);

  // 进度节流用的两张表：node_id → 计时器 / 最新待送事件。
  const progressTimerRef = useRef<Map<string, number>>(new Map());
  const progressPendingRef = useRef<Map<string, AgentSseEvent>>(new Map());
  const mountedRef = useRef(true);
  // 撤销/重做正在还原时不推快照，否则按一下撤销会先把自己存进 past。
  const restoringRef = useRef(false);

  // ─────────────────────── 换画布 / 历史清单

  /** 开一张全新画布（换 session 或使用者手动「新建画布」）。 */
  const newCanvasSession = useCallback(() => {
    // 旧的 debounce 存档若还挂著，会拿新 projectId 存出空画布、或拿旧 projectId
    // 覆盖掉刚开的新画布 —— 换画布前先把它作废。
    // （saveTimerRef/projectIdRef 等 refs 由下方 useCanvasProjectSync 拥有，
    //   useRef 跨 render 是同一物件，这里的闭包读到的是最新值。）
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
    // 新画布 = 新作品：作品类型/流程步/剧集清单都随旧项目留在历史里。
    setProjectType(undefined);
    setCurrentStep(undefined);
    setEpisodes([]);
    // 风格绑定同层清零：新项目不继承上一张画布的风格（缺省＝无绑定）。
    setStyleId(undefined);
    // 新画布 = 新项目：卡锁定是项目级配置，随旧项目留在历史里。
    setActiveCardIds([]);
    // 新画布要有新身份：后续存档才会写进新的一份，而不是覆写上一张。
    projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createdAtRef.current = new Date().toISOString();
    everHadNodesRef.current = false;
    // 旧节点的进度帧不能再落地到新画布（否则 loading 会凭空冒出来）。
    for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
    progressTimerRef.current.clear();
    progressPendingRef.current.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 createdAtRef/everHadNodesRef/saveTimerRef：三者由下方第 583 行 useCanvasProjectSync 解构取得（在本 callback 之后），列入依赖阵列会在 render 期触发 TDZ；ref 物件身分恒定，省略安全。
  }, [setActiveCardIds]);

  const refreshSavedProjects = useCallback(async () => {
    const res = await listCanvasProjectSummaries();
    if (!mountedRef.current) return;
    if (res.ok && res.data) setSavedProjects(toProjectSummaries(res.data));
    // 失败时静默保留旧值：清单是「顺手看」，不值得为网路抖动清空画面。
  }, []);

  const openSavedCanvas = useCallback(async (id: string) => {
    // 只拉这一张（效能审计 P0-B）：原本为了打开一张画布把全部专案整包下载。
    const res = await fetchCanvasProject(id);
    if (!mountedRef.current) return;
    const target = res.ok ? res.data : undefined;
    if (!target) return;
    // 指向旧专案身份：之后的存档覆写它，而不是另存一份新画布。
    projectIdRef.current = target.id;
    createdAtRef.current = target.createdAt;
    everHadNodesRef.current = target.nodes && target.nodes.length > 0;
    const restored = fromCanvasProject(target);
    dispatchCanvas({ type: "load", nodes: restored.nodes, connections: restored.connections });
    setViewportState(target.viewport ?? { x: 0, y: 0, k: 1 });
    setBackgroundMode(target.backgroundMode ?? "dots");
    setProjectTitle(target.title || "未命名画布");
    setActiveCardIds(Array.isArray(target.cardIds) ? target.cardIds.filter(Boolean) : []);
    // 作品/剧集三栏（＋风格绑定第四栏）：与 cardIds 同层还原
    //（缺栏位＝回到未设定，不残留上一张画布的值）。
    const meta = canvasProjectMeta(target);
    setProjectType(meta.projectType);
    setCurrentStep(meta.currentStep);
    setEpisodes(meta.episodes ?? []);
    setStyleId(meta.styleId);
    setScriptType(meta.scriptType);
    setNarrationVoice(meta.narrationVoice);
    if (target.budget) {
      setBudget({
        usedCoins: target.budget.usedCoins,
        remainingCoins: Math.max(0, target.budget.totalCoins - target.budget.usedCoins),
        updatedAt: Date.now(),
      });
    } else {
      setBudget(null);
    }
    // 换载入的画布是一条全新时间线：历史、选取、展示卡都归零。
    setHistory(CANVAS_EMPTY_HISTORY);
    setSelectedNodeId(null);
    setPlans([]);
    setDerives([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 createdAtRef/everHadNodesRef：由下方第 583 行 useCanvasProjectSync 解构取得（在本 callback 之后），列入依赖会 TDZ；ref 身分恒定。
  }, [setActiveCardIds]);

  /**
   * Agent 快照下行回填（2026-08-26 Bug1b）：resume 到已有历史的 session 时，左聊天
   * 续上但右画布空白 —— 快照此前只有上行没有下行。gateway 存的是上行压缩快照
   * （content/prompt 已截断），fromCanvasProject 负责形状校验与降级。
   * 与 openSavedCanvas 同语义：换载入内容 = 全新时间线，不进撤销栈、选取归零、
   * plans/derives 不动。恢复结果在 sessionId 变化 effect（newCanvasSession 清场）
   * 之后异步到达，load 直接覆盖空画布即可；呼叫端保证仅在 nodes>0 且画布仍空时调用。
   */
  const restoreAgentSnapshot = useCallback(
    (snapshot: {
      nodes?: unknown;
      connections?: unknown;
      viewport?: CanvasViewport;
      projectType?: unknown;
      currentStep?: unknown;
      episodes?: unknown;
      styleId?: unknown;
      scriptType?: unknown;
      narrationVoice?: unknown;
    }): boolean => {
      if (!snapshot || typeof snapshot !== "object") return false;
      const restored = fromCanvasProject(snapshot);
      if (restored.nodes.length === 0) return false;
      everHadNodesRef.current = true;
      // 上行摘要刻意不带座标（版面权在前端 reducer，layout.ts 档头）：
      // fromCanvasProject 把缺座标补成 (0,0)，直接 load 会让所有卡叠在原点
      // （2026-09-14 回旧会话堆叠事故）。无座标快照跑与 live 同款的 DAG 分层
      // 排版；快照真带座标（如 blob 专案形状）则原样还原，不重排。
      const unpositioned = restored.nodes.every((n) => n.position.x === 0 && n.position.y === 0);
      const nodes = unpositioned
        ? layoutGraph({ ...CANVAS_INITIAL_STATE, nodes: restored.nodes, connections: restored.connections }).nodes
        : restored.nodes;
      dispatchCanvas({
        type: "load",
        nodes,
        connections: restored.connections,
        ...(restored.deletedNodes && restored.deletedNodes.length > 0 ? { deletedNodes: restored.deletedNodes } : {}),
        ...(restored.nodeVersions && restored.nodeVersions.length > 0 ? { nodeVersions: restored.nodeVersions } : {}),
      });
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
      // 双向同步方向B：chat 切 session → 画布选中对应节点
      const linked = restored.nodes.find((n) => n.metadata?.session_id === sessionIdRef.current);
      setSelectedNodeId(linked ? linked.id : null);
      // 作品/剧集三栏＋风格绑定：快照有带才覆盖；没带＝保留现值
      //（不可把已存在的作品资讯/风格清成空白）。
      const meta = canvasProjectMeta(snapshot);
      if (meta.projectType !== undefined) setProjectType(meta.projectType);
      if (meta.currentStep !== undefined) setCurrentStep(meta.currentStep);
      if (meta.episodes !== undefined) setEpisodes(meta.episodes);
      if (meta.styleId !== undefined) setStyleId(meta.styleId);
      if (meta.scriptType !== undefined) setScriptType(meta.scriptType);
      if (meta.narrationVoice !== undefined) setNarrationVoice(meta.narrationVoice);
      return true;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 everHadNodesRef：由下方第 583 行 useCanvasProjectSync 解构取得（在本 callback 之后），列入依赖会 TDZ；ref 身分恒定。
    [],
  );

  // 监听 sessionId 变化：换 agent 会话 = 换一张画布，避免旧画布跑进新会话。
  useEffect(() => {
    if (!sessionId) {
      // 09-12 建号权收归发送按钮：null = 「无会话空态」（开新/套模板都经这里）。
      // 放手旧会话锚点——之后 lazy 建出的新会话按「首次会话」处理（走下面
      // isFirst 跳过清场），套模板先铺好的节点才不会被新会话落地瞬间清掉
      // （08-29 空快照/09-01 画布全空血泪路径）。null 本身不清场：此时画布
      // 上可能是用户正打算随首条消息带进新会话的内容。
      prevSessionIdRef.current = null;
      return;
    }
    if (sessionId === prevSessionIdRef.current) return;
    const isFirst = prevSessionIdRef.current == null;
    prevSessionIdRef.current = sessionId;
    // 首次拿到 session：画布本来就是空的（已不再自动还原），不必重置，
    // 否则会白白丢掉 mount 时 mint 的 projectId。空态铺好内容后首发建号
    // 落地也算「首次」——那份内容是用户带来接新会话的，同样不清。
    if (isFirst) return;
    newCanvasSession();
  }, [sessionId, newCanvasSession]);

  useEffect(() => {
    const progressTimers = progressTimerRef.current;
    const progressPending = progressPendingRef.current;
    return () => {
      mountedRef.current = false;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      if (flyRafRef.current !== null) cancelAnimationFrame(flyRafRef.current);
      for (const t of progressTimers.values()) window.clearTimeout(t);
      progressTimers.clear();
      progressPending.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 saveTimerRef：由下方第 583 行 useCanvasProjectSync 解构取得（在本文之后），列入依赖会 TDZ；ref 身分恒定。
  }, []);

  // ─────────────────────── 快照

  const snapshotNow = useCallback((): CanvasSnapshot => {
    const current = canvasRef.current;
    return {
      nodes: current.nodes,
      connections: current.connections,
      viewport: viewportRef.current,
      // 软删节点进快照：否则「删除→撤销」后 deletedNodes 残留已回到 nodes 的重复项。
      ...(current.deletedNodes && current.deletedNodes.length > 0 ? { deletedNodes: current.deletedNodes } : {}),
    };
  }, []);

  /** 动作前推一格快照。事件驱动的变更也推，这样「撤销」能收回 agent 刚加的节点。 */
  const pushHistory = useCallback(() => {
    if (restoringRef.current) return;
    setHistory((prev) => pushSnapshot(prev, snapshotNow()));
  }, [snapshotNow]);

  // ─────────────────────── SSE 画布事件入口

  // 最终一致性收敛（image.done 对账）：settle 函数与 URL 伫列由 settler 域提供。
  const { imageDoneQueueRef, settleCandidateNode, settleStaleNodes, settleFailedNode } = useCanvasEventSettler({
    canvasRef,
    progressTimerRef,
    progressPendingRef,
    dispatchCanvas,
  });

  const handleCanvasEvent = useCallback(
    (event: AgentSseEvent) => {
      // Wave C：agent 批量操作入伫列后由宿主自动执行（CanvasEmbed 的 effect 一到即 approveAgentOps）。入队而非覆盖——
      // 不同 request_id 各自排队，同 request_id 重入视为合法重放（见 queue 模组注解）。
      // 捕获当下 session id：事件本身没有 session_id 栏位，resolve 时要用「抵达
      // 当下」而非「resolve 当下」的 session，否则使用者切 session 后回报会错 sid。
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
          // C-FE：计划帧继续进 reducer——unit 记下 cost_hint，
          // node.created 时盖章到生成卡（「预估 N 币」角标）。侧栏卡片照旧由 plans 渲染。
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
          // 图完成讯号：入队并立即尝试用 task_id 配对落地，卡 loading 的节点
          // 不依赖 gateway 一定发 canvas.node.updated（上游无 task_id 时 gateway
          // 只发 image.done，画布会永远转圈 —— 见 2026-08-16 根因分析）。
          imageDoneQueueRef.current.push(event.data);
          settleCandidateNode(event.data);
          return;
        }
        case "image.failed": {
          // 图失败讯号（refunded/failed/超时）：与 image.done 对称。优先 task_id
          // 配对，没配上的在 turn.done 收敛时按序兜底——绝不能让节点永远转圈。
          settleFailedNode(event.data);
          return;
        }
        case "turn.done":
        case "session.closed":
          // 回合/会话结束：最后收敛，把仍卡 loading 的节点按序配对落地。
          settleStaleNodes();
          return;
        default:
          break;
      }
      // 结构性事件：进 reducer。节点增删是可撤销的动作，所以先存一格。
      if (event.name === "canvas.node.created" || event.name === "canvas.node.deleted" || event.name === "canvas.node.connected" || event.name === "canvas.node.disconnected") {
        pushHistory();
      }

      // 进度节流（行动端）：canvas.node.generating 是高频进度流（同节点每秒
      // 可能多帧）。每节点最多每 PROGRESS_THROTTLE_MS 落地一次 reducer，
      // 窗内只留最新一笔、窗末补送，最后的 progress 不会遗失。
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

      // 节点层级的新状态落地（结果/删除/新建）＝该节点排队中的进度帧作废，
      // 避免「结果都落地了又被旧进度帧盖回 loading」。
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

  // 对外事件入口：外部 chat（AgentChatSurface 的 onCanvasEvent）呼叫。
  const feedCanvasEvent = handleCanvasEvent;
  // 对外摘要提供者（外部 chat 的 canvasStateProvider 用）。空画布回 undefined。
  // 附带用户当前选区与视口缩放：agent 不再是瞎子，能围绕「用户正在看的节点」干活。
  const summarize = () => {
    const state = canvasRef.current;
    const lockedCards = characterCardsRef.current.filter((c) => activeCardIdsRef.current.includes(c.id));
    if (state.nodes.length === 0 && state.units.length === 0 && lockedCards.length === 0) return undefined;
    const base = summarizeCanvasState(state) as unknown as Record<string, unknown>;
    const selected = selectedNodeIdRef.current;
    if (selected) base.selected_node_id = selected;
    base.viewport_scale = Math.round(viewportRef.current.k * 100) / 100;
    // P2：锁定卡进上行摘要（agent 可见——知道哪些外观/场景约束已生效）。
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

  // ─────────────────────── 专案持久化（init → debounce → snapshot，顺序同原内联版）

  const { createdAtRef, saveTimerRef, everHadNodesRef, buildProject } = useCanvasProjectSync({
    canvasRef,
    viewportRef,
    backgroundRef,
    titleRef,
    budgetRef,
    activeCardIdsRef,
    projectIdRef,
    projectTypeRef,
    currentStepRef,
    episodesRef,
    styleIdRef,
    scriptTypeRef,
    narrationVoiceRef,
    mountedRef,
    canvas,
    viewport,
    backgroundMode,
    projectTitle,
    activeCardIds,
    projectType,
    currentStep,
    episodes,
    styleId,
    scriptType,
    narrationVoice,
    saveState,
    sessionId,
    selectedNodeId,
    activeCharacterCards,
    setSavedProjects,
    setSaveState,
    setLoading,
  });

  // ─────────────────────── 视口

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

  // ─────────────────────── 节点编辑

  const selectNode = useCallback((nodeId: string | null) => setSelectedNodeId(nodeId), []);

  /**
   * 拖动/缩放中的每一帧都不推快照 —— 一次拖动会产生上百帧，
   * 全推进去等于把撤销栈当成录影。互动结束时由 commitInteraction 推一格。
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

  /** 互动（拖动/缩放）开始前呼叫：把互动前的状态存成一格。 */
  const commitInteraction = useCallback(() => {
    pushHistory();
  }, [pushHistory]);

  // ─────────────────────── Phase 3 画布交互

  /** 群组拖动：每帧一次 dispatch 移整组。不推 history（由 commitInteraction 收口）。 */
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
   * 同一 workflow 的重复套用 = 替换不是叠加（2026-08-26 Bug3）：addNodes 是追加语义，
   * 同一张模板卡点两次会平铺两份 30+ 节点。这里先删掉 metadata.workflow_id 相同的
   * 全部旧节点（delete_many 连带清掉悬空连线），再 add_nodes 新的一批；两个 dispatch
   * 在同一轮批次里落地，history 只推一格 —— undo 一键回到替换前。
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

  // ─────────────────────── 回跳：作废下游（决策 15，画布侧投影）

  /**
   * 作废某节点的全部下游已完成结果（回跳改上游 = 下游成果失效）。
   * **不新建机制**：作废的真权威在网关——`workflow-service.updateNode` 的 BFS
   *（改上游时把下游重置 pending＋删 nodeContent/nodeCost）与 `rerunFrom`
   *（root+下游闭包重跑）都已经在跑，且 `generate` 的 R5-B 续跑语义
   *（"reuse succeeded node results, only failed/pending nodes will run"）保证
   * 下游只重跑被作废的那些。本函式是**画布侧的同一条规则的立即投影**（用户按下
   * 回跳的那一刻就看见下游变空，不必等网关事件回来），重跑本身仍交宿主既有的
   * rerun 入口（workflow-node-rerun → rerunFrom），不在此另发请求。
   *
   * 规则逐条对齐网关：闭包沿连线 BFS（含 root）；text/config 类（纯资料）不参与
   * 作废——它们没有生成结果，重置只会让卡面无故变空。
   * 回传作废的节点 id（呼叫端据此提示「这些步骤会重跑」，顺序＝BFS 序）。
   */
  const revokeDownstream = useCallback(
    (nodeId: string): string[] => {
      const nodes = canvasRef.current.nodes;
      const connections = canvasRef.current.connections;
      const voidIds = downstreamInvalidationIds(nodes, connections, nodeId);
      if (voidIds.length === 0) return [];
      pushHistory(); // 一格历史：回跳作废可一键撤销
      for (const id of voidIds) {
        dispatchCanvas({
          type: "patch_metadata",
          nodeId: id,
          patch: { status: "idle", content: "", errorDetails: undefined },
        });
      }
      return voidIds;
    },
    [pushHistory],
  );

  // ─────────────────────── Wave A：就地编辑

  const renameNode = useCallback(
    (nodeId: string, title: string) => {
      pushHistory();
      dispatchCanvas({ type: "rename", nodeId, title });
    },
    [pushHistory],
  );

  /** metadata 补丁（文本直编提交、原地生成回填、字号、重试状态）。history 预设推一格。 */
  const patchNodeMetadata = useCallback(
    (nodeId: string, patch: Partial<CanvasNodeMetadata>, opts?: { history?: boolean }) => {
      if (opts?.history !== false) pushHistory();
      dispatchCanvas({ type: "patch_metadata", nodeId, patch });
    },
    [pushHistory],
  );

  // ─────────────────────── WS4：模板节点交付 → 自动落卡（＋分镜引用回填）

  /**
   * 节点投影：canvas 节点 → 落卡模组的结构子集（只读 id/title/metadata 三个栏位）。
   * `metadata` 在落卡模组眼里是不透明袋子；投影是一次唯读宽化（见
   * `toAgentOutputNodeRef` 的注解：CanvasNodeMetadata 是 interface，无 index signature）。
   */
  const emittedNodeRefs = useMemo(() => canvas.nodes.map(toAgentOutputNodeRef), [canvas.nodes]);

  /**
   * 落卡指纹：只装「会改变落卡判定」的栏位——节点 id、已落卡标记、交付物（长度＋尾段 64 字）。
   * 刻意**不含整个 metadata**：回填会写 metadata，指纹若含它就会自己触发自己（无限回圈）。
   * 指纹不变 → 不重跑（同一份交付物重复触发＝零动作）。
   */
  const emittedCardFingerprint = useMemo(
    () =>
      emittedNodeRefs
        .map((n) => {
          const content = typeof n.metadata?.content === "string" ? n.metadata.content : "";
          const marker = typeof n.metadata?.entityCardId === "string" ? n.metadata.entityCardId : "";
          return `${n.id}:${marker}:${content.length}:${content.slice(-64)}`;
        })
        .join("|"),
    [emittedNodeRefs],
  );

  const emittedAnchorDoneRef = useRef("");
  /**
   * 既有自动落卡签章：卡清单是**非同步**载入的（listCharacterCards），节点却可能先到
   * （回旧会话：专案 Blob 先还原、卡清单后回）。少了这一项，「卡上次已落、分镜节点缺引用」
   * 那一轮永远等不到 → 耐久回填在竞态下失效。只认自动落成的前缀卡，人工建卡不动签章。
   *
   * 含**内容**（卡名＋参考图数）不只 id：渐进聚合把 sibling 晚到的图并进既存卡时 **id 不变**，
   * 只认 id 的签章不会再触发一轮 → 第二张参考图永远补不进去。收敛：下一轮计画为空
   * （`updatedCards` 空 ∧ 补名无候选）⇒ 内容不再变 ⇒ 签章稳定 ⇒ 不再重跑。
   */
  const emittedEntityCardSignature = useMemo(
    () =>
      characterCards
        .filter((c) => c.id.startsWith(ENTITY_CARD_ID_PREFIX))
        .map((c) => `${c.id}:${c.name}:${c.references.length}`)
        .join(","),
    [characterCards],
  );
  /** 落卡触发串 = 节点指纹 ＋ 既有自动落成卡签章（两者任一变化都值得重跑一次计画）。 */
  const emittedAnchorTrigger = `${emittedCardFingerprint}|${emittedEntityCardSignature}`;
  /**
   * 节点集合一安静就自动落卡：模板节点交出角色四视图/场景图 → 落成可 @ 引用的卡
   * （幂等由决定性卡 id + existing 比对保证；`metadata.entityCardId` 标记亦视为已建）。
   * 用「已完成触发串」而非逐节点旗标：换模板/换项目（id 全变）自然重跑。
   * 收敛：建卡那轮会写 entityCardId 标记 → 节点指纹变一次 → 第二轮计画为空
   * （marker 已存在不建卡、分镜引用已在）→ 不再产生任何 patch。
   */
  useEffect(() => {
    if (!emittedAnchorTrigger) return;
    if (emittedAnchorTrigger === emittedAnchorDoneRef.current) return;
    const timer = window.setTimeout(() => {
      emittedAnchorDoneRef.current = emittedAnchorTrigger;
      void autoAnchorEmittedCards(canvasRef.current.nodes.map(toAgentOutputNodeRef), {
        // 落卡标记：写进**拥有该卡的那颗节点**的 metadata（自动动作不进撤销栈）。
        onEntityCardId: (nodeId, cardId) => {
          patchNodeMetadata(nodeId, { entityCardId: cardId }, { history: false });
        },
        onShotBackfill: (items) => {
          // 分镜节点的卡引用栏（门禁栏名）写进 metadata：patch 是 merge，栏位形状对得上
          // `CanvasNodeMetadata`（WS7 四栏白名单成员）。自动动作不进撤销栈
          //（history:false，同进度/自然尺寸的写法）。
          for (const item of items) {
            const { nodeId, ...cardRefs } = item;
            patchNodeMetadata(nodeId, cardRefs, { history: false });
          }
        },
        // 卡名**第二来源**（C）：`nameFrom:"input"` 的三键全空时，往上找第一个有非空文本
        // 的上游节点取第一行（走 canvas 连线＝真连线栏位 fromNodeId→toNodeId）。
        resolveName: (ref) => upstreamTextNameFor(ref.id, canvasRef.current.nodes, canvasRef.current.connections),
        // 退回可见化：真的只能拿节点标题当卡名（「正面」）时给一行提示——不新造通知元件，
        // 用站内既有 toast（root layout 已挂 <Toaster/>）。真源＝落卡计画的 nameFallbacks。
        onNameFallback: (fallbacks) => {
          console.warn("[canvas] 实体卡名退回节点标题", fallbacks.length);
          toast({
            description: `有 ${fallbacks.length} 张素材卡未取到名字，暂用节点标题（${fallbacks
              .slice(0, 3)
              .map((f) => f.fallbackName)
              .join("、")}）`,
          });
        },
      });
    }, EMITTED_ANCHOR_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [emittedAnchorTrigger, autoAnchorEmittedCards, patchNodeMetadata]);

  // ─────────────────────── B2：飞行聚焦（450ms easeOutCubic）

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

  // ─────────────────────── Wave C：agent 操作的执行/回报（自动执行；可 undo/redo 撤销）

  /**
   * 执行 agent 伫列头操作（自动执行，无人工确认）。回传 run_generation 清单交宿主触发生成。
   * 用伫列头自己捕获的 session id 回报结果（不是 sessionIdRef.current 当下值）——
   * 这是本次修的 bug 本体：旧版读当下 session，使用者切过 session 就报错 sid。
   * resolve 后从伫列摘除该笔，UI 绑的 pendingAgentOps（伫列头）自动前进到下一笔。
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
      } else if (op.type === "set_project_meta") {
        // 2026-09-16 G1：专案级栏位（作品类型/流程步/剧集清单）的唯一写入口。
        // reducer 只认 nodes/connections，这三栏在 CanvasProject 顶层，故在此执行。
        // 载荷不可信（agent 产出经 SSE 反序列化，型别不保证）：一律先过
        // normalizeProjectMetaPatch 逐栏白名单 —— 非法栏位被省略＝不动该栏，
        // 不让模型的一个错 enum 清掉用户已填的剧集清单。空 patch 直接跳过，
        // 免得多推一次 state 造成无谓的存档 debounce 与快照上行。
        const patch = normalizeProjectMetaPatch(op.patch);
        if (Object.keys(patch).length > 0) setProjectMeta(patch);
      }
    }
    setAgentOpsQueue((prev) => dequeueAgentOps(prev, requestId));
    const sid = entry.capturedSessionId;
    if (sid) {
      const createdIds = pending.ops.filter((o): o is Extract<CanvasAgentOp, { type: "add_node" }> => o.type === "add_node").map((o) => o.node.id);
      void postCanvasOpsResult(sid, requestId, { ok: true, ...(createdIds.length ? { created_node_ids: createdIds } : {}) });
    }
    return result;
    // setProjectMeta 不在依赖阵列：它是 useCallback(..., [])（身分恒定，无过期闭包问题），
    // 且本 useCallback 宣告在它之前 —— 写进阵列会在 render 期读到 TDZ 的 const 而直接炸。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 setProjectMeta：它是本档案第 1051 行才宣告的 useCallback（在本 callback 之后），列入依赖阵列会在 render 期触发 TDZ（Cannot access before initialization）；身分恒定故无闭包过期风险。
  }, [pushHistory]);

  /**
   * 拒绝 agent 伫列头操作（结果回报 gateway，让工具调用拿到明确拒绝而非超时）。
   * 同样用该笔捕获的 session id，不用 sessionIdRef.current。
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
    dispatchCanvas({
      type: "load",
      nodes: snapshot.nodes,
      connections: snapshot.connections,
      ...(snapshot.deletedNodes && snapshot.deletedNodes.length > 0 ? { deletedNodes: snapshot.deletedNodes } : {}),
    });
    setViewportState(snapshot.viewport);
    // 还原是同步 dispatch，但 React 批次更新到下一帧才落地；
    // 用 microtask 解锁，避免同一轮里的 pushHistory 把还原也记成一步。
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

  // ─────────────────────── 专案汇入/汇出/清空

  const loadProject = useCallback(
    (project: {
      nodes?: unknown;
      connections?: unknown;
      viewport?: CanvasViewport;
      backgroundMode?: CanvasBackgroundMode;
      title?: string;
      projectType?: unknown;
      currentStep?: unknown;
      episodes?: unknown;
      styleId?: unknown;
      scriptType?: unknown;
      narrationVoice?: unknown;
    }) => {
      pushHistory();
      const restored = fromCanvasProject(project);
      dispatchCanvas({
        type: "load",
        nodes: restored.nodes,
        connections: restored.connections,
        ...(restored.deletedNodes && restored.deletedNodes.length > 0 ? { deletedNodes: restored.deletedNodes } : {}),
        ...(restored.nodeVersions && restored.nodeVersions.length > 0 ? { nodeVersions: restored.nodeVersions } : {}),
      });
      if (project.viewport) setViewportState(project.viewport);
      if (project.backgroundMode) setBackgroundMode(project.backgroundMode);
      if (project.title) setProjectTitle(project.title);
      // 与 openSavedCanvas 同语义但「不覆盖没带的栏位」：汇入档可能只含 nodes。
      const meta = canvasProjectMeta(project);
      if (meta.projectType !== undefined) setProjectType(meta.projectType);
      if (meta.currentStep !== undefined) setCurrentStep(meta.currentStep);
      if (meta.episodes !== undefined) setEpisodes(meta.episodes);
      if (meta.styleId !== undefined) setStyleId(meta.styleId);
      if (meta.scriptType !== undefined) setScriptType(meta.scriptType);
      if (meta.narrationVoice !== undefined) setNarrationVoice(meta.narrationVoice);
      setSelectedNodeId(null);
    },
    [pushHistory],
  );

  const exportProject = useCallback((): CanvasProject => buildProject(), [buildProject]);

  /**
   * 专案级栏位写入口（刀 1 前端接线；P1-8 起多带风格绑定第四栏）。
   * UI 面板与 agent 驱动路径共用这一个出口；传入 `undefined` = 清除该栏
   * （例：电影改回未设定、解除风格绑定）。只做型别守门（非法值不进 state，
   * 免得存档时被 store 静默丢掉），完整清洗仍只在 project-store。
   */
  const setProjectMeta = useCallback(
    (patch: {
      projectType?: CanvasProjectType;
      currentStep?: number;
      episodes?: CanvasEpisode[];
      styleId?: string;
      scriptType?: string;
      narrationVoice?: string;
    }) => {
      if ("projectType" in patch && (patch.projectType === undefined || isCanvasProjectType(patch.projectType))) {
        setProjectType(patch.projectType);
      }
      if ("currentStep" in patch && (patch.currentStep === undefined || isValidCreationStep(patch.currentStep))) {
        setCurrentStep(patch.currentStep);
      }
      if ("episodes" in patch) setEpisodes(patch.episodes ?? []);
      // 风格绑定：合法＝STYLE_LIBRARY 注册表查得到（同一把尺：normalizeProjectStyleId）；
      // `undefined` 依 "k" in patch 惯例＝清除绑定。
      if ("styleId" in patch && (patch.styleId === undefined || normalizeProjectStyleId(patch.styleId))) {
        setStyleId(patch.styleId === undefined ? undefined : (normalizeProjectStyleId(patch.styleId) as string));
      }
      // 解说剧设定（P1-5／D7）：值域判据与落盘端同一份（isCanvasScriptType／normalizeVoiceId）；
      // `undefined` 依 "k" in patch 惯例＝清除该栏。
      if ("scriptType" in patch && (patch.scriptType === undefined || isCanvasScriptType(patch.scriptType))) {
        setScriptType(patch.scriptType as CanvasScriptType | undefined);
      }
      if ("narrationVoice" in patch && (patch.narrationVoice === undefined || normalizeVoiceId(patch.narrationVoice))) {
        setNarrationVoice(
          patch.narrationVoice === undefined ? undefined : (normalizeVoiceId(patch.narrationVoice) as string),
        );
      }
    },
    [],
  );

  const clearCanvas = useCallback(() => {
    pushHistory();
    dispatchCanvas({ type: "clear" });
    setPlans([]);
    setDerives([]);
    setSelectedNodeId(null);
  }, [pushHistory]);

  // ─────────────────────── 几何

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

  const revertNode = useCallback(
    (nodeId: string, version?: number) => {
      pushHistory();
      dispatchCanvas({ type: "revert_node", nodeId, version });
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
    nodeVersions: canvas.nodeVersions ?? [],
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
    // REQ-B2：项目 id 直读 ref（ref 由 useCanvasProjectSync 拥有，不另存一份状态）。
    getProjectId: () => projectIdRef.current,
    pathFor,
    moveNodes,
    addNodes,
    replaceWorkflowNodes,
    deleteNodes,
    addConnection,
    removeConnection,
    revokeDownstream,
    addBatchChild,
    setBatchPrimary,
    revertNode,
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
    applyMountCopyChange,
    projectType,
    currentStep,
    episodes,
    styleId,
    scriptType,
    narrationVoice,
    setProjectMeta,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
  };
}
