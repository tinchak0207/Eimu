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
import { fetchCanvasProject, listCanvasProjectSummaries, postCanvasOpsResult, type CanvasClientResult } from "@/lib/canvas/client";
// P2-C：聊天的画布归属（canvasIds / primaryCanvasId）改走宿主注入的
// `findChatBySession`（共享 store 的 ProjectChatView 直传项目档原值）——
// 不再自行调用 listProjects 直读原始项目档（那多一轮 GET /api/projects）。
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
  type ChatCanvasEntry,
  type CanvasDeriveCard,
  type CanvasPlanCard,
  type CanvasProjectSummary,
  type UseCanvasChatProjectContext,
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

import { useCanvasChatOps } from "./canvas/canvas-chat-ops";

// ─────────────────────────────────────────── 汇出面（barrel：消费端 import 路径零改动）
export { canvasReducer } from "./canvas/canvas-reducer-adapter";
export type { CanvasAction } from "./canvas/canvas-reducer-adapter";
export type {
  CanvasBackgroundMode,
  CanvasBudget,
  CanvasDeriveCard,
  CanvasPlanCard,
  CanvasProjectSummary,
  ChatCanvasEntry,
  UseCanvasChatProjectContext,
  UseCanvasChatReturn,
} from "./canvas/canvas-chat-helpers";
export { downstreamInvalidationIds } from "./canvas/canvas-chat-helpers";

export function useCanvasChat(
  sessionId?: string | null,
  projectContext?: UseCanvasChatProjectContext,
): UseCanvasChatReturn {
  const [canvas, dispatchCanvas] = useReducer(canvasReducer, CANVAS_INITIAL_STATE);
  const [plans, setPlans] = useState<CanvasPlanCard[]>([]);
  const [derives, setDerives] = useState<CanvasDeriveCard[]>([]);
  const [budget, setBudget] = useState<CanvasBudget | null>(null);
  const [viewport, setViewportState] = useState<CanvasViewport>({ x: 0, y: 0, k: 1 });
  const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("dots");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [history, setHistory] = useState<CanvasHistory>(CANVAS_EMPTY_HISTORY);
  const [projectTitle, setProjectTitle] = useState("未命名画布");
  // P2-A：当前打开的画布 id（与 projectIdRef 同值，但 projectIdRef 是 ref 不触发 render，
  // 「画布清单 isActive / 对外 activeCanvasId」需要一份 state 才能重绘）。
  const [activeCanvasId, setActiveCanvasId] = useState<string | null>(null);
  // P2-A：当前会话在项目档里的画布归属（canvasIds + primaryCanvasId）。
  // null ＝ 未归属会话（或明细尚未载入）→ canvasList 退回「只含当前这一张」。
  const [chatCanvases, setChatCanvases] = useState<{
    projectId: string;
    canvasIds: string[];
    primaryCanvasId?: string;
  } | null>(null);
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
  //
  // 2026-10-09 前置改造：当前画布 → **创作项目 id**（`prj_…`）反查（共享 store 的
  // findProjectIdByCanvas）。画布 id（projectIdRef，`canvas-…`）与创作项目 id 是两套命名空间，
  // **各自独立传递**：projectIdRef 仍持画布 id（持久化/旧作用域路径用），creativeProjectId 单列
  // （标签驱动注入用）——不得把画布 id 冒充成 creativeProjectId。
  // 归属落定会触发宿主重渲染（ImagePlayground 订阅同一 store，projectContext 每次 render 换新物件）
  // → 本 memo 重算；activeCanvasId 变化（mint/切画布）亦然。
  const creativeProjectId = useMemo(() => {
    const find = projectContext?.findProjectIdByCanvas;
    return find && activeCanvasId ? find(activeCanvasId) : null;
  }, [projectContext, activeCanvasId]);
  // 项目 id ref 先于卡域建立并注入（REQ-B2b）：卡域的读取端作用域闸要判「锁定卡属不属于
  // 当前项目」，读的就是这一个 ref——卡域在本 hook 之前呼叫，若晚建则闸首帧拿到 null 漏判。
  const projectIdRef = useRef<string | null>(null);
  const {
    characterCards,
    activeCardIds,
    activeCharacterCards,
    setActiveCardIds,
    applyMountCopyChange,
    refreshCharacterCards,
    characterCardsRef,
    activeCardIdsRef,
    upsertCharacterCard,
    removeCharacterCard,
    toggleCharacterCard,
    autoAnchorEmittedCards,
  } = useCanvasCards({ getProjectId: () => projectIdRef.current, creativeProjectId });

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
  // P2-A：项目上下文（宿主注入的 store 动作/查询）放 ref——保持切换画布的 callback
  // 身份稳定（变则 sessionId effect 重跑），对齐 ImagePlayground 的 projectAttachRef 写法。
  const projectCtxRef = useRef<UseCanvasChatProjectContext | undefined>(projectContext);
  projectCtxRef.current = projectContext;
  // P2-C 自愈式补登：同一 (sessionId, canvasId) 只提交一次（防写风暴；失败不重试循环）。
  const attachedCanvasPairsRef = useRef<Set<string>>(new Set());
  // P2-C 配对守门：记录「当前画布属于哪个会话」。只在画布本体变更时重新配对，
  // 或旧配对为空（首次建会话认领进页 mint 的画布）时认领；否则切聊天的过渡帧
  // （sessionId 已是新值、activeCanvasId 还是旧会话的）不会把旧画布误挂到新会话。
  const healPairRef = useRef<{ sid: string | null; canvasId: string | null }>({ sid: null, canvasId: null });
  // P2-A：savedProjects 的最新值（切画布前判「主画布在不在清单里」用；不在则先 refresh）。
  const savedProjectsRef = useRef<CanvasProjectSummary[]>([]);
  savedProjectsRef.current = savedProjects;
  /** flyTo 动画的 rAF 句柄（新动画/卸载时取消）。 */
  const flyRafRef = useRef<number | null>(null);

  // 进度节流用的两张表：node_id → 计时器 / 最新待送事件。
  const progressTimerRef = useRef<Map<string, number>>(new Map());
  const progressPendingRef = useRef<Map<string, AgentSseEvent>>(new Map());
  const mountedRef = useRef(true);
  // 撤销/重做正在还原时不推快照，否则按一下撤销会先把自己存进 past。
  const restoringRef = useRef(false);

  // ─────────────────────── 换画布 / 历史清单

  /**
   * 把画布清成「指定 id 的空画布」（**不 mint id**）。
   * P2-D 抽出的原语：① newCanvasSession（id = 新 mint）与「采用一张未落盘的主画布 id」
   * 共用同一组清场动作。后者的动机＝修「空画布在切走切回时堆积」：主画布 fetch 失败
   * （空画布从不落盘 ⇒ Blob 里没有）时，**不能再 mint 第二张**——那会让每次切回都往
   * 项目档 chats[].canvasIds 追加一个空壳。采用该 id、以空态开始即可，归属真源不动。
   */
  const adoptEmptyCanvas = useCallback(
    (id: string) => {
      // 旧的 debounce 存档若还挂著，会拿新 projectId 存出空画布、或拿旧 projectId
      // 覆盖掉刚开的画布 —— 换画布前先把它作废。
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
      // 指向给定 id：后续存档才会写进这一份（而不是覆写上一张，或另存一份）。
      projectIdRef.current = id;
      createdAtRef.current = new Date().toISOString();
      everHadNodesRef.current = false;
      // P2-A：对外 activeCanvasId 跟新身份同步（projectIdRef 是 ref 不触发重绘）。
      setActiveCanvasId(id);
      // 旧节点的进度帧不能再落地到新画布（否则 loading 会凭空冒出来）。
      for (const t of progressTimerRef.current.values()) window.clearTimeout(t);
      progressTimerRef.current.clear();
      progressPendingRef.current.clear();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 createdAtRef/everHadNodesRef/saveTimerRef：三者由下方第 583 行 useCanvasProjectSync 解构取得（在本 callback 之后），列入依赖阵列会在 render 期触发 TDZ；ref 物件身分恒定，省略安全。
    },
    [setActiveCardIds, setActiveCanvasId],
  );

  /** 开一张全新画布（换 session 或使用者手动「新建画布」）。 */
  const newCanvasSession = useCallback(() => {
    adoptEmptyCanvas(`canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }, [adoptEmptyCanvas]);

  const refreshSavedProjects = useCallback(async () => {
    const res = await listCanvasProjectSummaries();
    if (!mountedRef.current) return;
    if (res.ok && res.data) setSavedProjects(toProjectSummaries(res.data));
    // 失败时静默保留旧值：清单是「顺手看」，不值得为网路抖动清空画面。
  }, []);

  /**
   * 内部：真正「把某张已落盘的画布拉下来并载入」。
   * 回吐 fetch 结果，供 `openChatCanvasForSession` 分辨失败种类（P2-E：只有确认
   * `not_found` 才敢采用空态）。对外契约仍是 `openSavedCanvas`（`Promise<void>`，
   * 见 canvas-chat-types 的 `UseCanvasChatReturn`）——本函数不进对外接口。
   */
  const loadSavedCanvas = useCallback(async (id: string): Promise<CanvasClientResult<CanvasProject>> => {
    // 只拉这一张（效能审计 P0-B）：原本为了打开一张画布把全部专案整包下载。
    const res = await fetchCanvasProject(id);
    if (!mountedRef.current) return res;
    const target = res.ok ? res.data : undefined;
    if (!target) return res;
    // 指向旧专案身份：之后的存档覆写它，而不是另存一份新画布。
    projectIdRef.current = target.id;
    // P2-A：成功载入才算「打开」，把对外 activeCanvasId 同步过去（失败时不动，避免指到没载入的 id）。
    setActiveCanvasId(target.id);
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
    return res;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 createdAtRef/everHadNodesRef：由下方第 583 行 useCanvasProjectSync 解构取得（在本 callback 之后），列入依赖会 TDZ；ref 身分恒定。
  }, [setActiveCardIds, setActiveCanvasId]);

  /** 对外签名 `(id: string) => Promise<void>`（UseCanvasChatReturn 契约）：打开一张历史画布。 */
  const openSavedCanvas = useCallback(
    async (id: string): Promise<void> => {
      await loadSavedCanvas(id);
    },
    [loadSavedCanvas],
  );

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

  // 监听 sessionId 变化：换 agent 会话 → 打开**该聊天自己的画布**（没有才新建）。
  // （本刀 2026-10-09 P2-A：原实现是「换会话无条件 newCanvasSession()」＝聊天↔画布一对一。
  //  现改为在项目档里查该会话的 primaryCanvasId：有 → 切过去；无 → mint 新画布并挂上；
  //  未归属会话 → 保持现状 mint 新画布，不造项目归属。真正的 switch 逻辑见下方
  //  openChatCanvasForSession（因需要 flushSave，定义在 useCanvasProjectSync 之后）。）

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

  const { createdAtRef, saveTimerRef, everHadNodesRef, buildProject, flushSave } = useCanvasProjectSync({
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
    setActiveCanvasId,
    onRemoteSnapshot: (snapshot) => {
      restoreAgentSnapshot(snapshot as Parameters<typeof restoreAgentSnapshot>[0]);
    },
  });

  // ─────────────────────── P2-A：聊天内多画布（切换 / 新建 / 清单）
  // ─────────────────────── P2-C：自愈式幂等补登

  /**
   * 读当前会话在项目档里的画布归属（canvasIds + primaryCanvasId + 所属 projectId）。
   * 走宿主注入的 `findChatBySession` / `findProjectIdBySession`（共享 store，同一份真源），
   * **不**再自行直读原始项目档（listProjects）。未归属 / 未知 → null。
   */
  const readChatCanvases = useCallback(
    (sid: string): { projectId: string; canvasIds: string[]; primaryCanvasId?: string } | null => {
      const ctx = projectCtxRef.current;
      const detail = ctx?.findChatBySession ? ctx.findChatBySession(sid) : null;
      const projectId = ctx?.findProjectIdBySession ? ctx.findProjectIdBySession(sid) : null;
      if (!detail || !projectId) return null;
      return {
        projectId,
        canvasIds: Array.isArray(detail.canvasIds) ? detail.canvasIds : [],
        ...(detail.primaryCanvasId ? { primaryCanvasId: detail.primaryCanvasId } : {}),
      };
    },
    [],
  );

  /**
   * P2-C 自愈式幂等补登（本刀核心）。
   *
   * 规则：当前会话**已被某项目挂过**（findProjectIdBySession 有值）且当前画布 id
   * **不在**该聊天条目的 canvasIds 里 ⇒ 走 store 的 attachCanvas 补登
   * （既有语义：不存在则追加、primary 只补不抢——这里不改它，也不自拼 PUT）。
   *
   * - 未归属会话 ⇒ 什么都不做，**零 /api/projects* 请求**（不因此造归属）。
   * - 防写风暴：同一 (sessionId, canvasId) 只提交一次；失败不重试循环。
   * - 回传 attach promise（已登记 / 已存在 / 未归属时回 null），供呼叫端落地后回读。
   */
  const ensureCanvasAttached = useCallback(
    (sid: string | null | undefined, canvasId: string | null | undefined, title?: string): Promise<void> | null => {
      if (!sid || !canvasId) return null;
      const ctx = projectCtxRef.current;
      const projectId = ctx?.findProjectIdBySession ? ctx.findProjectIdBySession(sid) : null;
      if (!projectId) return null; // 未归属：零动作、零请求
      const chat = ctx?.findChatBySession ? ctx.findChatBySession(sid) : null;
      if (chat && chat.canvasIds.includes(canvasId)) return null; // 已登记
      const attach = ctx?.attachCanvas;
      if (!attach) return null;
      const key = `${sid}:${canvasId}`;
      if (attachedCanvasPairsRef.current.has(key)) return null; // 同一对只提交一次
      attachedCanvasPairsRef.current.add(key);
      return attach(projectId, sid, canvasId, title);
    },
    [],
  );

  /**
   * 切到指定画布：**先 flush 当前画布存档**（否则切走即丢改动），再载入目标画布。
   * 回吐载入结果（P2-E：呼叫端要分辨「确认不存在」与其他失败）；无动作时回 null。
   */
  const switchCanvasTo = useCallback(
    async (id: string): Promise<CanvasClientResult<CanvasProject> | null> => {
      if (!id || id === projectIdRef.current) return null;
      await flushSave();
      if (!mountedRef.current) return null;
      return loadSavedCanvas(id); // 成功载入时内部把 projectIdRef / activeCanvasId 指向 id
    },
    [flushSave, loadSavedCanvas],
  );

  /**
   * 换会话时打开该聊天自己的画布（P2-A 核心）。三判定与 P0 的 attachChat 同口径：
   * 未归属会话 → 保持现状（mint 新画布，不造归属）。
   */
  const openChatCanvasForSession = useCallback(
    async (sid: string) => {
      const findProject = projectCtxRef.current?.findProjectIdBySession;
      const projectId = findProject ? findProject(sid) : null;
      if (!projectId) {
        // 未归属会话：与现状一致（mint 新画布），**不**因此造项目归属。
        setChatCanvases(null);
        newCanvasSession();
        return;
      }
      const detail = readChatCanvases(sid);
      if (detail) setChatCanvases(detail);
      const primary = detail?.primaryCanvasId ?? null;
      if (primary) {
        // 先确保主画布在 savedProjects 里（清单口径正确），必要时刷新摘要。
        if (!savedProjectsRef.current.some((p) => p.id === primary)) {
          await refreshSavedProjects();
          if (!mountedRef.current) return;
        }
        const openRes = await switchCanvasTo(primary);
        if (!mountedRef.current) return;
        // 载入成功（含「已在该画布」的空动作）：projectIdRef 已被指向 primary，收工。
        if (projectIdRef.current === primary) return;
        // P2-E 收窄：**只有服务器明确说这张不存在**（fetch 回 reason=not_found，
        // 即 HTTP 404 ＋ code=not_found）才采用该 id、从空态开始——修「空画布在切走
        // 切回时堆积」（P2-D），同时不再 mint 第二张。
        // 其他失败（网络瞬断／5xx／鉴权／解析）**一律按兵不动**：不 mint、不 adopt、
        // 不改 projectIdRef、不写 /api/projects*，保持当前画布。旧 P2-D 是无条件 adopt，
        // 若那张画布其实已落盘只是本次 fetch 瞬断，用户会在「看起来空的」画布上作画，
        // 下一次存档就把线上真实内容覆盖成只含新节点——覆盖数据比堆积空画布严重。
        // 该 id 是否落盘不影响归属：归属真源在项目档 chats[].primaryCanvasId，保持原值。
        if (openRes?.reason === "not_found") {
          adoptEmptyCanvas(primary);
        } else if (openRes) {
          // 失败只记一次（不重试、不弹卡：画布存档本就有 offline/error 降级语义）。
          console.warn(`[canvas] 主画布 ${primary} 载入失败（${openRes.reason ?? "unknown"}），保持当前画布`);
        }
        return;
      }
      // 有项目但无主画布：mint 新画布 + 挂到会话（attachCanvasAction 会补 primary）。
      newCanvasSession();
      const newId = projectIdRef.current;
      if (!newId) return;
      setChatCanvases({
        projectId,
        canvasIds: [...(detail?.canvasIds ?? []), newId],
        primaryCanvasId: newId,
      });
      ensureCanvasAttached(sid, newId);
    },
    [adoptEmptyCanvas, ensureCanvasAttached, newCanvasSession, readChatCanvases, refreshSavedProjects, switchCanvasTo],
  );

  // P2-C 自愈式补登 effect（本刀核心）：触发点覆盖 ① sessionId 变化之后
  // ② 画布 mint 之后（进页 init mint / newCanvasSession / createCanvas 都经
  // activeCanvasId 变更被这里看到）。
  //
  // 配对守门：只补登「确实属于这个会话」的画布——healPairRef 记录画布变更时配到的会话；
  // 仅当画布本体变了、或旧配对为空（首次建会话认领进页 mint 的画布）时才重新配对。
  // 这样切聊天的过渡帧（sessionId 已是新值、activeCanvasId 还是旧会话的画布）不会误挂。
  // 依赖 projectContext（host 每次 render 换新物件）：store 归属落定后会再跑一次，
  // 覆盖「会话先到、attachChat 后落定」的竞态（首次会话补登靠这格兜底）。
  useEffect(() => {
    const prev = healPairRef.current;
    if (!sessionId) {
      // 空会话态：画布归属未定，留给下一个会话认领（null 本身不清场）。
      healPairRef.current = { sid: null, canvasId: activeCanvasId };
    } else if (prev.canvasId !== activeCanvasId || prev.sid == null) {
      // 画布换了（mint / 切画布 / 新建），或首次拿到会话认领进页 mint 的画布 → 配对。
      healPairRef.current = { sid: sessionId, canvasId: activeCanvasId };
    }
    const pair = healPairRef.current;
    ensureCanvasAttached(pair.sid, pair.canvasId);
  }, [activeCanvasId, sessionId, projectContext, ensureCanvasAttached]);

  // 监听 sessionId 变化（P2-A：换聊天 → 打开该聊天的画布，不再无条件新建）。
  useEffect(() => {
    if (!sessionId) {
      // 09-12 建号权收归发送按钮：null = 「无会话空态」（开新/套模板都经这里）。
      // 放手旧会话锚点——之后 lazy 建出的新会话按「首次会话」处理（走下面
      // isFirst 跳过清场），套模板先铺好的节点才不会被新会话落地瞬间清掉
      // （08-29 空快照/09-01 画布全空血泪路径）。null 本身不清场：此时画布
      // 上可能是用户正打算随首条消息带进新会话的内容。
      prevSessionIdRef.current = null;
      setChatCanvases(null);
      return;
    }
    if (sessionId === prevSessionIdRef.current) return;
    const isFirst = prevSessionIdRef.current == null;
    prevSessionIdRef.current = sessionId;
    // 首次拿到 session：画布本来就是空的（已不再自动还原），不必重置，
    // 否则会白白丢掉 mount 时 mint 的 projectId。空态铺好内容后首发建号
    // 落地也算「首次」——那份内容是用户带来接新会话的，同样不清。
    if (isFirst) return;
    void openChatCanvasForSession(sessionId);
  }, [sessionId, openChatCanvasForSession]);

  /**
   * 对外：切到当前聊天内已有的某张画布（UI 下拉用）。切前先 flush（见 switchCanvasTo）。
   * 不切会话（切会话仍只走 switchSessionRef 那条入口）。
   */
  const switchCanvas = useCallback(
    (canvasId: string) => {
      void switchCanvasTo(canvasId);
    },
    [switchCanvasTo],
  );

  /**
   * 对外：在当前聊天内新建一张画布并切过去，回新 id。
   * - 无当前会话 → null（不造无主画布）。
   * - 先同步 flush 当前画布（buildProject 当场 stringify 旧 projectId + 旧节点，故下面
   *   立刻改 ref 也不丢），再 mint 新画布（清场）。
   * - 若会话已归属某项目 → attachCanvas 把新画布挂上（primary 不动）。
   */
  const createCanvas = useCallback(
    (title?: string): string | null => {
      const sid = sessionIdRef.current;
      if (!sid) return null;
      const findProject = projectCtxRef.current?.findProjectIdBySession;
      const projectId = findProject ? findProject(sid) : null;
      void flushSave(); // 同步快照旧画布并落盘
      newCanvasSession(); // mint 新画布 + 清场（内部 setActiveCanvasId）
      const newId = projectIdRef.current;
      if (!newId) return null;
      if (projectId) {
        setChatCanvases((prev) =>
          prev && prev.projectId === projectId
            ? {
                ...prev,
                canvasIds: prev.canvasIds.includes(newId) ? prev.canvasIds : [...prev.canvasIds, newId],
              }
            : { projectId, canvasIds: [newId] },
        );
        const attaching = ensureCanvasAttached(sid, newId, title);
        if (attaching) {
          void attaching.then(() => {
            // 回读真实归属（primary 由 attachCanvasAction 补，本地乐观值可能不带）。
            if (!mountedRef.current) return;
            const detail = readChatCanvases(sid);
            if (detail) setChatCanvases(detail);
          });
        }
      }
      return newId;
    },
    [ensureCanvasAttached, flushSave, newCanvasSession, readChatCanvases],
  );

  /** 当前聊天的画布清单（归属真源＝项目档 chats[].canvasIds；标题/时间取 savedProjects）。 */
  const canvasList = useMemo<ChatCanvasEntry[]>(() => {
    const primary = chatCanvases?.primaryCanvasId ?? null;
    let ids: string[];
    if (chatCanvases) {
      ids = [...chatCanvases.canvasIds];
      // 当前画布若不在 canvasIds 里（例：手动从历史打开了一张别的画布），也要出现在列表里。
      if (activeCanvasId && !ids.includes(activeCanvasId)) ids.push(activeCanvasId);
    } else {
      // 未归属会话（或明细未载入）→ 只含当前这一张。
      ids = activeCanvasId ? [activeCanvasId] : [];
    }
    const byId = new Map(savedProjects.map((p) => [p.id, p]));
    return ids.map((id) => {
      const summary = byId.get(id);
      const parsed = summary ? Date.parse(summary.updatedAt) : NaN;
      return {
        id,
        title: summary?.title || "未命名画布",
        updatedAt: Number.isFinite(parsed) ? parsed : 0,
        isPrimary: id === primary,
        isActive: id === activeCanvasId,
      };
    });
  }, [chatCanvases, activeCanvasId, savedProjects]);

  const ops = useCanvasChatOps({
    canvas, dispatchCanvas, setPlans, setDerives, setSelectedNodeId, setViewportState, setBackgroundMode,
    setProjectTitle, setProjectType, setCurrentStep, setEpisodes, setStyleId, setScriptType, setNarrationVoice,
    history, setHistory, snapshotNow, buildProject, pushHistory, canvasRef, viewportRef, flyRafRef, restoringRef,
    agentOpsQueueRef, setAgentOpsQueue, characterCards, autoAnchorEmittedCards,
  });
  const { setViewport, cycleBackground, fitView, centerOn, selectNode, moveNode, resizeNode, removeNode, commitInteraction, undo, redo, loadProject, exportProject, clearCanvas, pathFor, moveNodes, addNodes, replaceWorkflowNodes, deleteNodes, addConnection, removeConnection, revokeDownstream, addBatchChild, setBatchPrimary, revertNode, deleteBatchChild, toggleBatchExpanded, addReference, removeReference, renameNode, patchNodeMetadata, flyTo, applyAgentOps, dismissAgentOps, setProjectMeta } = ops;

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
    // P2-A：聊天内多画布
    canvasList,
    activeCanvasId,
    switchCanvas,
    createCanvas,
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
    refreshCharacterCards,
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
