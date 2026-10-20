"use client";

import { useCallback, useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { CANVAS_READABLE_MIN_SCALE, bezierPath, canvasProjectMeta, clampScale, fitToNodes, fromCanvasProject, normalizeProjectMetaPatch, redoSnapshot, undoSnapshot, type CanvasHistory, type CanvasSnapshot } from "@/lib/canvas/layout";
import { postCanvasOpsResult } from "@/lib/canvas/client";
import { normalizeProjectStyleId } from "@/lib/canvas/project-style";
import { isCanvasScriptType, type CanvasScriptType } from "@/lib/canvas/project-narration";
import { normalizeVoiceId } from "@/lib/voice-library";
import { isCanvasProjectType } from "@/lib/canvas/types";
import type { CanvasAgentOp, CanvasConnection, CanvasEpisode, CanvasNode, CanvasNodeMetadata, CanvasPosition, CanvasProject, CanvasProjectType, CanvasViewport } from "@/lib/canvas/types";
import { isValidCreationStep } from "@/lib/creation-flow-steps";
import { ENTITY_CARD_ID_PREFIX, toAgentOutputNodeRef, type AgentOutputNodeRef } from "@/lib/agent-output-cards";
import type { CharacterCard } from "@/lib/character-cards";
import { toast } from "@/hooks/use-toast";
import { canvasReducer, type CanvasAction } from "./canvas-reducer-adapter";
import type { CanvasBackgroundMode, CanvasDeriveCard, CanvasPlanCard } from "./canvas-chat-types";
import { dequeueAgentOps, getQueueHead, type AgentOpsQueue } from "./canvas-agent-ops-queue";
import { downstreamInvalidationIds, EMITTED_ANCHOR_DEBOUNCE_MS } from "./canvas-chat-helpers";
import { upstreamTextNameFor, type AutoAnchorEmittedCardsOptions } from "./use-canvas-cards";

interface UseCanvasChatOpsParams {
  canvas: ReturnType<typeof canvasReducer>;
  dispatchCanvas: Dispatch<CanvasAction>;
  setPlans: Dispatch<SetStateAction<CanvasPlanCard[]>>;
  setDerives: Dispatch<SetStateAction<CanvasDeriveCard[]>>;
  setSelectedNodeId: Dispatch<SetStateAction<string | null>>;
  setViewportState: Dispatch<SetStateAction<CanvasViewport>>;
  setBackgroundMode: Dispatch<SetStateAction<CanvasBackgroundMode>>;
  setProjectTitle: Dispatch<SetStateAction<string>>;
  setProjectType: Dispatch<SetStateAction<CanvasProjectType | undefined>>;
  setCurrentStep: Dispatch<SetStateAction<number | undefined>>;
  setEpisodes: Dispatch<SetStateAction<CanvasEpisode[]>>;
  setStyleId: Dispatch<SetStateAction<string | undefined>>;
  setScriptType: Dispatch<SetStateAction<CanvasScriptType | undefined>>;
  setNarrationVoice: Dispatch<SetStateAction<string | undefined>>;
  history: CanvasHistory;
  setHistory: Dispatch<SetStateAction<CanvasHistory>>;
  snapshotNow: () => CanvasSnapshot;
  buildProject: () => CanvasProject;
  pushHistory: () => void;
  canvasRef: MutableRefObject<ReturnType<typeof canvasReducer>>;
  viewportRef: MutableRefObject<CanvasViewport>;
  flyRafRef: MutableRefObject<number | null>;
  restoringRef: MutableRefObject<boolean>;
  agentOpsQueueRef: MutableRefObject<AgentOpsQueue>;
  setAgentOpsQueue: Dispatch<SetStateAction<AgentOpsQueue>>;
  characterCards: CharacterCard[];
  autoAnchorEmittedCards: (nodes: readonly AgentOutputNodeRef[], anchorOptions?: AutoAnchorEmittedCardsOptions) => Promise<{ created: number; updated: number; locked: number; backfilled: number }>;
}

export function useCanvasChatOps(P: UseCanvasChatOpsParams) {
  const {
    canvas, dispatchCanvas, setPlans, setDerives, setSelectedNodeId, setViewportState, setBackgroundMode,
    setProjectTitle, setProjectType, setCurrentStep, setEpisodes, setStyleId, setScriptType, setNarrationVoice,
    history, setHistory, snapshotNow, buildProject, pushHistory, canvasRef, viewportRef, flyRafRef, restoringRef,
    agentOpsQueueRef, setAgentOpsQueue, characterCards, autoAnchorEmittedCards,
  } = P;

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
    setViewport,
    cycleBackground,
    fitView,
    centerOn,
    selectNode,
    moveNode,
    resizeNode,
    removeNode,
    commitInteraction,
    moveNodes,
    addNodes,
    replaceWorkflowNodes,
    deleteNodes,
    addConnection,
    removeConnection,
    revokeDownstream,
    renameNode,
    patchNodeMetadata,
    flyTo,
    applyAgentOps,
    dismissAgentOps,
    undo,
    redo,
    loadProject,
    exportProject,
    setProjectMeta,
    clearCanvas,
    pathFor,
    addBatchChild,
    setBatchPrimary,
    revertNode,
    deleteBatchChild,
    toggleBatchExpanded,
    addReference,
    removeReference,
  };
}
