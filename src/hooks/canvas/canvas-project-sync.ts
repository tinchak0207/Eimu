// 畫布專案持久化（自 use-canvas-chat.ts 外圍搬遷）。
// 三個持久化 effect：進頁初始化（歷史清單）、儲存 debounce 400ms、壓縮快照上行。
// 擁有 refs：createdAt / saveTimer / hydrated / everHadNodes ——
// projectId 例外：**由主 hook 建立並注入**（REQ-B2b：卡域的讀取端作用域閘也要讀同一個
// 項目 id 讀取器；兩處各自 useRef 就是兩份真相＝閘讀到舊項目而漏判）。
"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import { listCanvasProjects, postCanvasSnapshot, saveCanvasProject } from "@/lib/canvas/client";
import type { CanvasReducerState } from "@/lib/canvas/reducer";
import { toCanvasProject } from "@/lib/canvas/layout";
import type { CanvasEpisode, CanvasProject, CanvasProjectType, CanvasViewport } from "@/lib/canvas/types";
import type { CanvasScriptType } from "@/lib/canvas/project-narration";
import type { CharacterCard } from "@/lib/character-cards";
import {
  SAVE_DEBOUNCE_MS,
  compactMetadataForAgent,
  toProjectSummaries,
  type CanvasBackgroundMode,
  type CanvasBudget,
  type CanvasProjectSummary,
} from "./canvas-chat-types";

/** useCanvasProjectSync 需要的共享 refs / 當前值 / setters（皆由主 hook 提供）。 */
export interface UseCanvasProjectSyncParams {
  // ── 主 hook 維護的「最新值鏈像 ref」（render 期間同步賦值）
  canvasRef: { current: CanvasReducerState };
  viewportRef: { current: CanvasViewport };
  backgroundRef: { current: CanvasBackgroundMode };
  titleRef: { current: string };
  budgetRef: { current: CanvasBudget | null };
  activeCardIdsRef: { current: string[] };
  /**
   * 當前項目 id ref：**由主 hook 建立並注入**（本函式不自建）。
   * REQ-B2b：卡域（use-canvas-cards）的讀取端作用域閘要讀同一個讀取器——
   * 兩處各自 useRef＝兩份真相（閘讀到舊項目 id 就會漏判跨項目卡）。
   */
  projectIdRef: { current: string | null };
  // 作品/劇集三級狀態機（2026-09-15 刀 1 前端接線）：照 activeCardIdsRef 同款「最新值鏈像 ref」。
  projectTypeRef: { current: CanvasProjectType | undefined };
  currentStepRef: { current: number | undefined };
  episodesRef: { current: CanvasEpisode[] };
  /** 專案級風格綁定（P1-8／D34）：同款最新值 ref，供 buildProject 落盤。 */
  styleIdRef: { current: string | undefined };
  /** 解說劇設定（P1-5／D7）：劇本型別與旁白音色，同樣走「最新值鏈像 ref」。 */
  scriptTypeRef: { current: CanvasScriptType | undefined };
  narrationVoiceRef: { current: string | undefined };
  mountedRef: { current: boolean };
  // ── 當前 render 的值（effect 依賴）
  canvas: CanvasReducerState;
  viewport: CanvasViewport;
  backgroundMode: CanvasBackgroundMode;
  projectTitle: string;
  activeCardIds: string[];
  projectType: CanvasProjectType | undefined;
  currentStep: number | undefined;
  episodes: CanvasEpisode[];
  /** 專案級風格綁定（P1-8／D34）；在 save effect 依賴裡，變更即觸發落盤。 */
  styleId: string | undefined;
  /** 解說劇設定（P1-5／D7）；同在 save effect 依賴裡。 */
  scriptType: CanvasScriptType | undefined;
  narrationVoice: string | undefined;
  saveState: "idle" | "saving" | "saved" | "error" | "offline";
  sessionId?: string | null;
  selectedNodeId: string | null;
  activeCharacterCards: CharacterCard[];
  // ── 主 hook 的 state setters（持久化結果寫回）
  setSavedProjects: Dispatch<SetStateAction<CanvasProjectSummary[]>>;
  setSaveState: Dispatch<SetStateAction<"idle" | "saving" | "saved" | "error" | "offline">>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}

/**
 * 專案持久化域：進頁初始化（只抓歷史清單，不自動還原畫布）、
 * 專案儲存（debounce 400ms）、Wave C1 壓縮快照上行（agent 的眼睛）。
 * effect 註冊順序與原 use-canvas-chat 內聯版一致（init → debounce → snapshot）。
 */
export function useCanvasProjectSync(params: UseCanvasProjectSyncParams) {
  const {
    canvasRef, viewportRef, backgroundRef, titleRef, budgetRef, activeCardIdsRef, mountedRef,
    projectTypeRef, currentStepRef, episodesRef, styleIdRef, scriptTypeRef, narrationVoiceRef, projectIdRef,
    canvas, viewport, backgroundMode, projectTitle, activeCardIds, saveState,
    projectType, currentStep, episodes, styleId, scriptType, narrationVoice,
    sessionId, selectedNodeId, activeCharacterCards,
    setSavedProjects, setSaveState, setLoading,
  } = params;

  const createdAtRef = useRef<string | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  // 載入完成前不要存：初始空畫布會把雲端那份覆蓋成空的。
  const hydratedRef = useRef(false);
  // 畫布是否曾有節點：空專案不存，避免歷史清單塞滿剛開又關的空殼。
  const everHadNodesRef = useRef(false);

  // ─────────────────────── 進頁初始化（只抓歷史清單，不自動還原畫布）

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await listCanvasProjects();
      if (cancelled || !mountedRef.current) return;
      if (res.ok && res.data) {
        setSavedProjects(toProjectSummaries(res.data));
      } else if (res.reason === "not_authenticated") {
        // 沒登入：畫布照常能用，只是不存雲端。不擋路、也不假裝存了。
        setSaveState("offline");
      }
      // 進頁永遠開一張全新畫布：不還原最近一份 —— 那正是新舊 session 混淆的根源。
      projectIdRef.current = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createdAtRef.current = new Date().toISOString();
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
      activeCardIdsRef.current,
      projectTypeRef.current,
      currentStepRef.current,
      episodesRef.current,
      // 專案級風格綁定（P1-8／D34）：第 10 個位置參數（照三欄先例往後追加）。
      styleIdRef.current,
      // 解說劇設定（P1-5／D7）：第 11、12 個位置參數。
      scriptTypeRef.current,
      narrationVoiceRef.current,
    );
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
    if (saveState === "offline") return;
    // 有節點才記住「曾經有過」；空畫布從不寫入歷史（避免塞滿剛開又關的空殼）。
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
    // 依賴畫布本體與視口/背景/標題/卡鎖定/作品劇集欄位 + 風格綁定：任何一項變化都該落盤。
    // saveState 刻意不進依賴 —— 它由這個 effect 自己寫，進去會變成自觸發循環。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, viewport, backgroundMode, projectTitle, activeCardIds, projectType, currentStep, episodes, styleId, scriptType, narrationVoice, buildProject]);

  // ─────────────────────── Wave C1：壓縮快照上行（agent 的眼睛）
  // 3s 尾隨防抖（第二輪就緒優化刀C，原 300ms）：sessionId 落地（AI 助理開場）
  // 觸發的第一幀快照會與空態渲染爭搶瀏覽器連接/網路，實測拖過 emptyAt
  // （s=1086, e=1740 vs emptyAt=1411）。快照是盡力而為——agent 只在用戶發
  // 第一條消息時才讀 canvas_state（send 隨 message 上送 canvasState），晚
  // 3 秒上送零影響；持續平移/拖動期間同樣不上報，停手才推最新一幀。失敗靜默。
  useEffect(() => {
    if (!sessionId) return;
    const t = window.setTimeout(() => {
      void postCanvasSnapshot(sessionId, {
        nodes: canvas.nodes.map((n) => ({
          id: n.id,
          type: String(n.type),
          title: n.title,
          position: n.position,
          width: n.width,
          height: n.height,
          ...(compactMetadataForAgent(n.metadata) ? { metadata: compactMetadataForAgent(n.metadata) } : {}),
        })),
        connections: canvas.connections,
        selectedNodeIds: selectedNodeId ? [selectedNodeId] : [],
        viewport,
        // 作品/劇集三欄的上行（2026-09-15 刀 1）：這是 restoreAgentSnapshot 唯一資料源，
        // 不帶則「回舊會話」時三欄恆為空（= 白名單漏一處 → 刷新後空殼的同型病灶）。
        // 刻意只帶 projectType/currentStep 兩個純量指針，**不帶 episodes**：
        //   1. 劇集數上限 200、script 是長文，會頂爆快照 512KB 上限（route 回 413）；
        //   2. 快照上行是壓縮態（見 director SVG 前例），若帶去頭去尾的 episodes，
        //      還原後 debounce 存檔會把截斷版寫回 Blob —— 靜默吃掉劇本原文。
        //   episodes 的持久化走 Blob 正規路徑（saveCanvasProject / openSavedCanvas）。
        ...(projectType ? { projectType } : {}),
        ...(currentStep !== undefined ? { currentStep } : {}),
        // P2：鎖定卡進快照（agent 的 canvas_get_state 讀這份）。
        character_cards: activeCharacterCards.map((c) => ({
          id: c.id,
          kind: c.kind,
          name: c.name,
          prompt: c.prompt,
          ...(c.negativePrompt ? { negative_prompt: c.negativePrompt } : {}),
          reference_count: c.references.length,
          ...(c.loraIds?.length ? { lora_ids: c.loraIds } : {}),
        })),
      });
    }, 3000);
    return () => window.clearTimeout(t);
  }, [sessionId, canvas.nodes, canvas.connections, selectedNodeId, viewport, activeCharacterCards, projectType, currentStep]);

  return { projectIdRef, createdAtRef, saveTimerRef, everHadNodesRef, buildProject };
}
