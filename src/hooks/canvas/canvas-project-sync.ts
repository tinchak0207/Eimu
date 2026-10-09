// 画布专案持久化（自 use-canvas-chat.ts 外围搬迁）。
// 三个持久化 effect：进页初始化（历史清单）、储存 debounce 400ms、压缩快照上行。
// 拥有 refs：createdAt / saveTimer / hydrated / everHadNodes ——
// projectId 例外：**由主 hook 建立并注入**（REQ-B2b：卡域的读取端作用域闸也要读同一个
// 项目 id 读取器；两处各自 useRef 就是两份真相＝闸读到旧项目而漏判）。
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listCanvasProjectSummaries, postCanvasSnapshot, saveCanvasProject } from "@/lib/canvas/client";
import type { CanvasReducerState } from "@/lib/canvas/reducer";
import { toCanvasProject } from "@/lib/canvas/layout";
import type { CanvasEpisode, CanvasProject, CanvasProjectType, CanvasViewport } from "@/lib/canvas/types";
import type { CanvasScriptType } from "@/lib/canvas/project-narration";
import type { CharacterCard } from "@/lib/character-cards";
import {
  SAVE_DEBOUNCE_MS,
  toProjectSummaries,
  type CanvasBackgroundMode,
  type CanvasBudget,
  type CanvasProjectSummary,
} from "./canvas-chat-types";
import { buildAgentCanvasSnapshot } from "./canvas-agent-snapshot";

/** 纯视口变动的静默存档防抖（比内容存档长：连续平移/缩放只落最后一笔）。 */
const VIEWPORT_SAVE_DEBOUNCE_MS = 1500;

/** useCanvasProjectSync 需要的共享 refs / 当前值 / setters（皆由主 hook 提供）。 */
export interface UseCanvasProjectSyncParams {
  // ── 主 hook 维护的「最新值链像 ref」（render 期间同步赋值）
  canvasRef: { current: CanvasReducerState };
  viewportRef: { current: CanvasViewport };
  backgroundRef: { current: CanvasBackgroundMode };
  titleRef: { current: string };
  budgetRef: { current: CanvasBudget | null };
  activeCardIdsRef: { current: string[] };
  /**
   * 当前项目 id ref：**由主 hook 建立并注入**（本函式不自建）。
   * REQ-B2b：卡域（use-canvas-cards）的读取端作用域闸要读同一个读取器——
   * 两处各自 useRef＝两份真相（闸读到旧项目 id 就会漏判跨项目卡）。
   */
  projectIdRef: { current: string | null };
  // 作品/剧集三级状态机（2026-09-15 刀 1 前端接线）：照 activeCardIdsRef 同款「最新值链像 ref」。
  projectTypeRef: { current: CanvasProjectType | undefined };
  currentStepRef: { current: number | undefined };
  episodesRef: { current: CanvasEpisode[] };
  /** 专案级风格绑定（P1-8／D34）：同款最新值 ref，供 buildProject 落盘。 */
  styleIdRef: { current: string | undefined };
  /** 解说剧设定（P1-5／D7）：剧本型别与旁白音色，同样走「最新值链像 ref」。 */
  scriptTypeRef: { current: CanvasScriptType | undefined };
  narrationVoiceRef: { current: string | undefined };
  mountedRef: { current: boolean };
  // ── 当前 render 的值（effect 依赖）
  canvas: CanvasReducerState;
  viewport: CanvasViewport;
  backgroundMode: CanvasBackgroundMode;
  projectTitle: string;
  activeCardIds: string[];
  projectType: CanvasProjectType | undefined;
  currentStep: number | undefined;
  episodes: CanvasEpisode[];
  /** 专案级风格绑定（P1-8／D34）；在 save effect 依赖里，变更即触发落盘。 */
  styleId: string | undefined;
  /** 解说剧设定（P1-5／D7）；同在 save effect 依赖里。 */
  scriptType: CanvasScriptType | undefined;
  narrationVoice: string | undefined;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  sessionId?: string | null;
  selectedNodeId: string | null;
  activeCharacterCards: CharacterCard[];
  // ── 主 hook 的 state setters（持久化结果写回）
  setSavedProjects: Dispatch<SetStateAction<CanvasProjectSummary[]>>;
  setSaveState: Dispatch<SetStateAction<"idle" | "saving" | "saved" | "error" | "offline">>;
  setLoading: Dispatch<SetStateAction<boolean>>;
  /**
   * P2-A：进页 mint 出新画布 id 后，把它回报给主 hook 的 `activeCanvasId` state。
   * 否则「当前打开哪张画布」在首帧会留在 null，画布清单的 isActive 标不中。
   */
  setActiveCanvasId: Dispatch<SetStateAction<string | null>>;
}

/**
 * 专案持久化域：进页初始化（只抓历史清单，不自动还原画布）、
 * 专案储存（debounce 400ms）、Wave C1 压缩快照上行（agent 的眼睛）。
 * effect 注册顺序与原 use-canvas-chat 内联版一致（init → debounce → snapshot）。
 */
export function useCanvasProjectSync(params: UseCanvasProjectSyncParams) {
  const {
    canvasRef, viewportRef, backgroundRef, titleRef, budgetRef, activeCardIdsRef, mountedRef,
    projectTypeRef, currentStepRef, episodesRef, styleIdRef, scriptTypeRef, narrationVoiceRef, projectIdRef,
    canvas, viewport, backgroundMode, projectTitle, activeCardIds, saveState,
    projectType, currentStep, episodes, styleId, scriptType, narrationVoice,
    sessionId, selectedNodeId, activeCharacterCards,
    setSavedProjects, setSaveState, setLoading, setActiveCanvasId,
  } = params;

  const createdAtRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  // 载入完成前不要存：初始空画布会把云端那份覆盖成空的。
  const hydratedRef = useRef(false);
  // 画布是否曾有节点：空专案不存，避免历史清单塞满刚开又关的空壳。
  const everHadNodesRef = useRef(false);
  // P2-A：flushSave 要照存档 effect 的 offline 闸（不能同步从 render 值读 saveState）。
  const saveStateRef = useRef(saveState);
  saveStateRef.current = saveState;

  // ─────────────────────── 进页初始化（只抓历史清单，不自动还原画布）

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listCanvasProjectSummaries();
      if (cancelled || !mountedRef.current) return;
      if (res.ok && res.data) {
        setSavedProjects(toProjectSummaries(res.data));
      } else if (res.reason === "not_authenticated") {
        // 没登入：画布照常能用，只是不存云端。不挡路、也不假装存了。
        setSaveState("offline");
      }
      // 进页永远开一张全新画布：不还原最近一份 —— 那正是新旧 session 混淆的根源。
      projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdAtRef.current = new Date().toISOString();
      hydratedRef.current = true;
      // P2-A：把 minted id 回报给主 hook（activeCanvasId）。
      setActiveCanvasId(projectIdRef.current);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [mountedRef, projectIdRef, setLoading, setSaveState, setSavedProjects, setActiveCanvasId]);

  // ─────────────────────── 专案储存（debounce 400ms）

  const buildProject = useCallback((): CanvasProject => {
    const id = projectIdRef.current ?? `canvas-${Date.now()}`;
    const b = budgetRef.current;
    return toCanvasProject(
      { id, title: titleRef.current, ...(createdAtRef.current ? { createdAt: createdAtRef.current } : {}) },
      canvasRef.current,
      viewportRef.current,
      backgroundRef.current,
      b ? { totalCoins: b.usedCoins + b.remainingCoins, usedCoins: b.usedCoins } : undefined,
      activeCardIdsRef.current,
      projectTypeRef.current,
      currentStepRef.current,
      episodesRef.current,
      // 专案级风格绑定（P1-8／D34）：第 10 个位置参数（照三栏先例往后追加）。
      styleIdRef.current,
      // 解说剧设定（P1-5／D7）：第 11、12 个位置参数。
      scriptTypeRef.current,
      narrationVoiceRef.current,
    );
  }, [activeCardIdsRef, backgroundRef, budgetRef, canvasRef, currentStepRef, episodesRef, narrationVoiceRef, projectIdRef, projectTypeRef, scriptTypeRef, styleIdRef, titleRef, viewportRef]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveState === "offline") return;
    // 有节点才记住「曾经有过」；空画布从不写入历史（避免塞满刚开又关的空壳）。
    if (canvas.nodes.length > 0) everHadNodesRef.current = true;
    if (canvas.nodes.length === 0 && !everHadNodesRef.current) return;
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
    // 依赖画布本体与背景/标题/卡锁定/作品剧集栏位 + 风格绑定：任何一项变化都该落盘（视口另走下方静默存档）。
    // saveState 刻意不进依赖 —— 它由这个 effect 自己写，进去会变成自触发循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, backgroundMode, projectTitle, activeCardIds, projectType, currentStep, episodes, styleId, scriptType, narrationVoice, buildProject]);

  // 只动了视口（平移/缩放）：效能审计 P1-4（2026-10-01）——原本每次停手 400ms 就整份存档＋两次 setSaveState
  // （＝宿主所在的整页重渲染两次）。视口只是「回来时停在哪」，静默、拉长防抖；内容存档照常带最新视口（viewportRef）。
  const viewportSaveTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveState === "offline") return;
    if (!everHadNodesRef.current) return;
    if (viewportSaveTimerRef.current !== null) window.clearTimeout(viewportSaveTimerRef.current);
    viewportSaveTimerRef.current = window.setTimeout(() => {
      viewportSaveTimerRef.current = null;
      // 内容存档排队中就不重复送（它会带上同一份视口）。
      if (saveTimerRef.current !== null) return;
      void saveCanvasProject(buildProject());
    }, VIEWPORT_SAVE_DEBOUNCE_MS);
    // 不在 cleanup 清计时器：关掉画布前的最后一次停手也要落盘（下一轮 effect 开头会自行清旧计时器）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewport]);

  // ─────────────────────── P2-A：切画布前的即时存档（flush）

  /**
   * 把当前画布的待存改动**立刻**落盘（不等 400ms debounce）。
   *
   * 动机（本刀最容易翻车的一格）：换聊天/切到旧画布时，`openSavedCanvas` 会把
   * `projectIdRef` 换成目标画布 id；若此刻还挂着旧画布的 debounce 计时器，它醒来
   * 就会拿**新 projectId**存出旧画布内容（覆写目标），或拿旧 projectId 把改动吞掉。
   * 所以切走前必须先把旧画布存完。
   *
   * 关键：`buildProject()` 与 `saveCanvasProject()` 都在**呼叫当下同步执行**
   * （fetch body 当场 stringify），所以呼叫者可以「同步 flush → 立刻改 ref」而不丢：
   * 存档请求已带旧 projectId 与旧节点。
   *
   * 闸门与下方存档 effect 逐条对齐：未 hydrate / offline / 空且从未有节点 → 不存。
   */
  const flushSave = useCallback((): Promise<void> => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (!hydratedRef.current) return Promise.resolve();
    if (saveStateRef.current === "offline") return Promise.resolve();
    if (canvasRef.current.nodes.length === 0 && !everHadNodesRef.current) return Promise.resolve();
    const project = buildProject();
    setSaveState("saving");
    return saveCanvasProject(project).then((res) => {
      if (!mountedRef.current) return;
      if (res.ok) setSaveState("saved");
      else setSaveState(res.reason === "not_authenticated" ? "offline" : "error");
    });
  }, [buildProject, canvasRef, everHadNodesRef, mountedRef, saveTimerRef, setSaveState]);

  // ─────────────────────── Wave C1：压缩快照上行（agent 的眼睛）
  // 3s 尾随防抖（第二轮就绪优化刀C，原 300ms）：sessionId 落地（AI 助理开场）
  // 触发的第一帧快照会与空态渲染争抢浏览器连接/网路，实测拖过 emptyAt
  // （s=1086, e=1740 vs emptyAt=1411）。快照是尽力而为——agent 只在用户发
  // 第一条消息时才读 canvas_state（send 随 message 上送 canvasState），晚
  // 3 秒上送零影响；持续平移/拖动期间同样不上报，停手才推最新一帧。失败静默。
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setTimeout(() => {
      // 上行载荷唯一建构子（canvas-agent-snapshot）：节点压缩白名单 ＋ `dsl`（全量 state
      // 反推的可逆声明）＋ `node_versions`（版本索引）。作品/剧集三栏只带纯量指针、
      // **不带 episodes**：剧集上限 200、script 长文会顶爆 512KB（route 413），且截断版
      // 回写 Blob 会静默吃掉剧本原文——episodes 走 saveCanvasProject 正规路径。
      void postCanvasSnapshot(
        sessionId,
        buildAgentCanvasSnapshot({
          nodes: canvas.nodes,
          connections: canvas.connections,
          selectedNodeIds: selectedNodeId ? [selectedNodeId] : [],
          viewport,
          ...(projectType ? { projectType } : {}),
          ...(currentStep !== undefined ? { currentStep } : {}),
          characterCards: activeCharacterCards,
          ...(canvas.nodeVersions ? { nodeVersions: canvas.nodeVersions } : {}),
          // DSL namespace＝画布 project id（同一张画布＝一条产线；族4 的 workflow 名由此来）。
          ...(projectIdRef.current ? { projectId: projectIdRef.current } : {}),
        }),
      );
    }, 3000);
    return () => window.clearTimeout(t);
  }, [sessionId, canvas.nodes, canvas.connections, canvas.nodeVersions, selectedNodeId, viewport, activeCharacterCards, projectType, currentStep]);

  return { projectIdRef, createdAtRef, saveTimerRef, everHadNodesRef, buildProject, flushSave };
}
