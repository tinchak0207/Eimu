"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { ImageDisplay } from "@/components/ImageDisplay";
import { PromptInput, type PromptInputMode } from "@/components/PromptInput";
import { CaseShowcase } from "@/components/CaseShowcase";
import type { ShowcaseCase } from "@/lib/showcase-cases";
import { FaqSection } from "@/components/FaqSection";
import { UseCaseLinks } from "@/components/UseCaseLinks";
import { useCanvasChat, type UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import {
  FALLBACK_PROGRESS_DURATION_MS,
  NORMAL_PROGRESS_DURATION_MS,
} from "@/components/GenerationProgressBar";
import { useImageGeneration } from "@/hooks/use-image-generation";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import {
  MODEL_CONFIGS,
  PROVIDERS,
  ProviderKey,
} from "@/lib/provider-config";
import {
  defaultGenerateAudio,
  defaultAspectRatio,
  defaultDuration,
  defaultOutputResolution,
  generationCoins,
  generationModel,
  normalizeGenerationConfig,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { enhancePrompt, type StylePreset } from "@/lib/prompt-enhancer";
import { hasEnoughQuota } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/local-test-mode";
import { cn } from "@/lib/utils";
import { getInitialSuggestions, type Suggestion } from "@/lib/suggestions";
import type { ReferenceImage } from "@/lib/image-types";
import { CanvasChatWorkstation } from "@/components/canvas-workstation/CanvasChatWorkstation";
import { AgentTemplateCarousel } from "@/components/canvas-workstation/AgentTemplateCarousel";
import { templateToCanvasLayout } from "@/components/canvas-workstation/agent-template-canvas";
import { DIRECTOR_RENDER_REQUEST_EVENT } from "@/components/director-mini/DirectorMiniViewport";
import { AGENT_TEMPLATES, cropTemplate, type AgentTemplate } from "@/lib/agent-templates";
import { fetchAgentCanvasSnapshot } from "@/lib/canvas/client";
import { useAgentParamReflect } from "@/hooks/use-agent-param-reflect";

// 2026-08-27 專業工作站入口移除：AI 工作站（agent 模式）已吸收其獨有機制
// （LoRA 庫 / 配方模板 / kunpeng 風格库），舊工作站不再被動態 import。

// AGENT_PARAM_LABELS（D-12 撤销条项目名）留在 hooks/use-agent-param-reflect.ts；
// 撤销条 UI 已随罪状 7 删除，钩子里的三态标记仍服务参数回流。

// 聊天区的懒加载 import 在 PromptInput 里：聊天区是那张卡片的一个面，
// 由持有 toggle 的组件自己按需拉 chunk，这里不再需要它。

/** 卡片的四个面。第四个面 agent 与 edit / upscale 同级，见 PromptInput。 */
type PlaygroundMode = PromptInputMode;

export function ImagePlayground({ suggestions }: { suggestions: Suggestion[] }) {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  // D-1 + D-24 状态B：agent 是卡片的第四个面，和 edit / upscale 同一层级的 toggle。
  // 按下去只换卡片中间那块控件区（共用 generate/edit/upscale 那套 dust 转场），
  // 卡片底板、右边结果画布、底下案例区全部原地不动，也不跳 /agent 独立页。
  const [mode, setMode] = useState<PlaygroundMode>("generate");
  const [displayMode, setDisplayMode] = useState<PlaygroundMode>("generate");
  const [animState, setAnimState] = useState<"idle" | "exit" | "enter">("idle");
  // 别的页面（D-18 图库卡）用 ?agent=1&q= 交接过来的一句话。
  const [agentSeed, setAgentSeed] = useState("");
  // 2026-08-25 模板庫：點卡注入 pending（nonce 讓「換一張卡」也是新注入）。
  // directive 是隱形引導詞：隨首條訊息經網關 system 欄位注入，用戶全程不可見。
  const [agentTemplateInjection, setAgentTemplateInjection] = useState<{ text: string; nonce: number; directive?: string } | null>(null);
  // C4 生成閉環事件橋：導演台視口「生成真实画面」完成 capture+上傳後 dispatch
  // director-render-request → 與模板庫共用同一注入 setter（AgentChatSurface 的
  // injection effect 會等 connection open 後靜默發送）。卸載時移除監聽。
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: unknown }>).detail;
      if (!detail || typeof detail.text !== "string" || !detail.text.trim()) return;
      setAgentTemplateInjection({ text: detail.text, nonce: Date.now() });
    };
    window.addEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
    return () => window.removeEventListener(DIRECTOR_RENDER_REQUEST_EVENT, handler);
  }, []);
  // 模板庫退場旗標：發出第一條用戶消息（模板注入或手打）即收起，之後不再出現。
  const [agentTemplateDismissed, setAgentTemplateDismissed] = useState(false);
  // wish 插件深链（?agent=1&session=<uuid>）：落地后直开该会话而非新开对话。
  const [initialAgentSessionId, setInitialAgentSessionId] = useState("");
  const { images, timings, failedProviders, isLoading, startGeneration, cancelTask, tasks } = useImageGeneration();
  const { user, isLoggedIn, refresh } = useAuth();
  const { toast } = useToast();
  const initialSuggestions = useMemo(() => getInitialSuggestions(suggestions), [suggestions]);
  const [selectedModels, setSelectedModels] = useState(MODEL_CONFIGS.fast);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(() => defaultAspectRatio(MODEL_CONFIGS.fast.image_tinchak));
  const [outputResolution, setOutputResolution] = useState<OutputResolution>(() => defaultOutputResolution(MODEL_CONFIGS.fast.image_tinchak));
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(() => defaultDuration(MODEL_CONFIGS.fast.image_tinchak));
  const [generateAudio, setGenerateAudio] = useState(() => defaultGenerateAudio(MODEL_CONFIGS.fast.image_tinchak));
  const [stylePreset, setStylePreset] = useState<StylePreset>("none");
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
// PixAI edit/upscale results are delivered straight to the result canvas on
// the right; they do not go through the normal generation queue.
const [pixaiResultUrl, setPixaiResultUrl] = useState<string | null>(null);
  // v3 embed：右側結果面板 mode。2026-08-25 canvas 常駐化：agent 模式右側
  // 一進入就是 canvas（模板庫或畫布），不再有「AI 助理左邊、圖片結果右邊」
  // 的中間態。非 agent 模式（generate/edit/upscale）維持 ImageDisplay。
  // 畫布工作站（2026-08-16，暴君裁定「擠」）：畫布模式 = 全場畫布，聊天卡
  // 變成左側浮動面板，expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  // 遼闊是預設，不是獎勵——不再有「compact 嵌右欄」這種把畫布塞縫裡的狀態。
  // 面板兩態/寬度/拖寬與 localStorage 持久化抽到 canvas-workstation/use-chat-panel。
  // 單一 SSE：AgentChatSurface 自建 useAgentChat，其 onCanvasEvent 出口餵回畫布。
  // 用 ref 解開循環依賴：onCanvasEvent 轉交 canvasHostRef；canvasHost 後建，餵回 ref。
  const canvasHostRef = useRef<UseCanvasChatReturn | null>(null);
  const handleCanvasEvent = useCallback((event: AgentSseEvent) => {
    // 畫布資料管線只吃 canvas 結構事件，tool.invoke 不入 reducer
    // （模式切換已不需要：canvas 常駐化後 agent 模式右側恆為 canvas）。
    if (event.name === "tool.invoke") {
      return;
    }
    canvasHostRef.current?.feedCanvasEvent(event);
  }, []);
  const handleCanvasSummary = useCallback(() => canvasHostRef.current?.summarize(), []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  // Bug1a：模板庫退場旗標隨「進入新對話」復位。session id 變了 = 開新聊天 =
  // 畫布已被清空，模板庫必須再次出現（「開啟新聊天就代表 Canvas 進入模板展示態」）；
  // 續上同一會話（toggle 往返 / 刷新 resume）不復位 —— 那是繼續對話，不是新開始。
  // ref 記住上一個非空 id：卸載-重掛時的 onSessionChange(null) 中間態不許把
  // 錨點洗掉，否則同會話 resume 也會被誤判成「新對話」而重播模板庫。
  const prevAgentSessionRef = useRef<string | null>(null);
  const handleAgentSessionChange = useCallback((nextSessionId: string | null) => {
    if (nextSessionId === null) {
      setCurrentSessionId(null);
      return;
    }
    if (nextSessionId !== prevAgentSessionRef.current) {
      prevAgentSessionRef.current = nextSessionId;
      setAgentTemplateDismissed(false);
    }
    setCurrentSessionId(nextSessionId);
  }, []);
  const canvasHost = useCanvasChat(currentSessionId);
  canvasHostRef.current = canvasHost;

  // 雙向同步方向A：畫布選中 workflow 節點 → chat 切到該節點所屬會話。
  // switchSessionRef 由 AgentChatSurface 上拋（畫布 → chat 方向唯一入口）；
  // 節點不帶 session_id（普通生成/提示卡）不切，避免誤切。
  // 反饋閉環靠 currentSessionId 兜底：切完後 selectedNodeId 對應節點的
  // session_id === currentSessionId，相等判斷擋住死循環。
  const switchSessionRef = useRef<((sessionId: string) => Promise<boolean>) | null>(null);
  // 暴君裁定 2026-09-01：套模板「留舊開新」——AgentChatSurface 上拋 startNewSession。
  const startNewSessionRef = useRef<(() => Promise<boolean>) | null>(null);
  const lastLinkedSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    const nodeId = canvasHost.selectedNodeId;
    if (!nodeId) return;
    const node = canvasHost.nodes.find((n) => n.id === nodeId);
    const targetSessionId = node?.metadata?.session_id;
    if (!targetSessionId) return;
    if (targetSessionId === currentSessionId) return;
    if (lastLinkedSelectionRef.current === nodeId) return;
    lastLinkedSelectionRef.current = nodeId;
    void switchSessionRef.current?.(targetSessionId);
  }, [canvasHost.selectedNodeId, canvasHost.nodes, currentSessionId]);

  // 模板庫只在「畫布空且無對話」的初始態出現：有任何節點/計畫（模板鋪過、
  // agent 建過、或歷史專案恢復）或已發過消息（agentTemplateDismissed）就讓位。
  const showAgentTemplateGallery =
    displayMode === "agent" &&
    !agentTemplateDismissed &&
    canvasHost.nodes.length === 0 &&
    canvasHost.plans.length === 0;

  /**
   * 2026-08-25 模板卡點擊（卡即動作）：
   * ① initialPrompt 經既有 useAgentChat 鏈路自動發出（PromptInput →
   *    AgentChatSurface 的 agentInjection：等連線 open 才 send，會話未開先 autoStart）。
   * ② 模板 slots 經 recipeTemplateToRecallConfig → templateToCanvasLayout
   *    → useCanvasChat.replaceWorkflowNodes 鋪成 workflow，等 agent 修改。
   * ③ 首條消息落地即收起畫廊（onUserMessage）。
   * 2026-08-26 環節選擇：第二參 selectedIndices 來自卡面圓環，先 cropTemplate
   *    裁剪（全選 = 原對象零開銷），注入與鋪畫布都用裁剪後的模板。
   * 09-01 裁定：套模板先 startNewSession 留舊開新，鋪設與注入延遲到新 session 落地（見 pendingTemplateRef effect）。
   */
  const pendingTemplateRef = useRef<AgentTemplate | null>(null);
  // 復用路徑判斷用：start() 的 .then 結算時 React state 尚未提交，
  // state 讀到的是閉包舊值，鏡像 ref 才能拿到此刻真實 sessionId。
  const currentSessionIdRef = useRef<string | null>(null);
  currentSessionIdRef.current = currentSessionId;
  // Bug3：同一 workflow 重點 = 替換不是疊加。cropTemplate 裁剪後 template.id 不變，
  // 重選環節再點同一張卡 = 同 id 替換：舊節點及其連線一次清掉，history 一格可整體 undo。
  const applyPendingTemplate = useCallback((cropped: AgentTemplate) => {
    const layout = templateToCanvasLayout(cropped);
    canvasHostRef.current?.replaceWorkflowNodes(cropped.id, layout.nodes, layout.connections);
    setAgentTemplateInjection({ text: cropped.initialPrompt, nonce: Date.now(), directive: cropped.directive });
    setAgentTemplateDismissed(true);
  }, []);
  // 暴君裁定 09-01：套模板鋪進新會話。session 切換（含 newCanvasSession 清場）
  // 落地後才鋪節點+注入——本 effect 註冊在 useCanvasChat 之後，清場先跑、鋪設後跑；
  // 也晚於 AgentChatSurface 的 onSessionChange（子 effect 先行），dismissed 復位不會蓋掉。
  useEffect(() => {
    const pending = pendingTemplateRef.current;
    if (!pending || !currentSessionId) return;
    pendingTemplateRef.current = null;
    applyPendingTemplate(pending);
  }, [currentSessionId]);
  const handleUseAgentTemplate = useCallback((template: AgentTemplate, selectedIndices: number[]) => {
    const cropped = cropTemplate(template, selectedIndices);
    setAgentTemplateDismissed(true);
    const start = startNewSessionRef.current;
    if (!start) {
      // ref 未接上（極端時序）：退回舊行為直接鋪在當前會話，模板不能憑空消失。
      applyPendingTemplate(cropped);
      return;
    }
    pendingTemplateRef.current = cropped;
    void Promise.resolve(start()).then((ok) => {
      if (!ok) {
        // 開新失敗（closed/網路）：沒有 session 變化 effect 會啞火，退回當前會話直接鋪。
        if (pendingTemplateRef.current === cropped) {
          pendingTemplateRef.current = null;
          applyPendingTemplate(cropped);
        }
        return;
      }
      // 復用路徑（競態治本）：startNewSession 復用了在途管線剛建的新鮮會話，
      // sessionId 沒有發生 transition → pending effect 永不觸發。就地結算：
      // 若此刻 state 已指向該會話（effect 也會跑，pending 已清，冪等），直接鋪。
      if (pendingTemplateRef.current === cropped && currentSessionIdRef.current) {
        pendingTemplateRef.current = null;
        applyPendingTemplate(cropped);
      }
    });
  }, [applyPendingTemplate]);

  // Bug1b：會話恢復回填。refresh/重進後左聊天續上（本地存檔 resume），但右畫布
  // 空白 —— 快照此前只有上行沒有下行。監聽 currentSessionId：每個新拿到的 sid 拉
  // 一次閘道存檔（GET 同上行端點），僅當 nodes>0 才回填；拉取異步到達時 sessionId
  // 變化 effect（newCanvasSession 清場）已跑完，load 直接覆蓋即可。用戶搶先鋪過
  // 模板（或有計畫卡）就不覆蓋，避免快照把剛做好的東西沖掉。
  const restoredSnapshotForRef = useRef<string | null>(null);
  useEffect(() => {
    const sid = currentSessionId;
    if (!sid || restoredSnapshotForRef.current === sid) return;
    restoredSnapshotForRef.current = sid;
    let cancelled = false;
    void (async () => {
      const snapshot = await fetchAgentCanvasSnapshot(sid);
      if (cancelled || !snapshot) return;
      const host = canvasHostRef.current;
      if (!host || host.nodes.length > 0 || host.plans.length > 0) return;
      host.restoreAgentSnapshot(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);
  const [progressStartedAt, setProgressStartedAt] = useState<number>();
  const [progressDurationMs, setProgressDurationMs] = useState(NORMAL_PROGRESS_DURATION_MS);
  const [showProgress, setShowProgress] = useState(false);

  // 進度條 ETA：服務端已按模型統計成功生成的耗時 p80（/api/user/model-eta，
  // 數據源 = generation_attempt.latency_ms 遙測）。掛載時拉一次；讀不到
  // （遙測不可用/樣本不足）就沿用固定 duration。ETA 不顯示，只調進度流逝。
  const [modelEtaMs, setModelEtaMs] = useState<Record<string, number>>({});
  useEffect(() => {
    let cancelled = false;
    fetch("/api/user/model-eta")
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { models?: Record<string, number> } | null) => {
        if (!cancelled && payload?.models) setModelEtaMs(payload.models);
      })
      .catch(() => {
        // ETA 是加分項：拉不到就靜默用固定 duration。
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const etaDurationForModel = useCallback(
    (modelId: string): number => modelEtaMs[modelId] ?? NORMAL_PROGRESS_DURATION_MS,
    [modelEtaMs],
  );

  // 2026-08-25 canvas 常駐化：右側面板 mode 由 displayMode 唯一決定——agent 模式
  // 恆為 canvas（模板庫→畫布），非 agent 模式恆為 ImageDisplay。原黏性旗標/
  // workflow_start 切換/節點數回退等中間態邏輯全部收斂刪除。
  const resultMode: "image" | "canvas" = displayMode === "agent" ? "canvas" : "image";
  const inCanvasWorkstation = displayMode === "agent";
  // ─── 畫布工作站：畫布模式鎖頁面捲動（面板記憶載入/持久化在 use-chat-panel）───
  useEffect(() => {
    if (!inCanvasWorkstation) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inCanvasWorkstation]);

  const redirectToGithub = useCallback(() => {
    window.location.href = "/api/auth/github/start";
  }, []);

  const triggerTransition = useCallback((next: PlaygroundMode) => {
    setAnimState("exit");
    setMode(next); // 按钮选中状态立即更新
    setTimeout(() => {
      setDisplayMode(next);
      setAnimState("enter");
      setTimeout(() => setAnimState("idle"), 320);
    }, 260);
  }, []);

  const handleModeChange = useCallback((next: PlaygroundMode) => {
    if (animState !== "idle") return;
    if (next === mode && mode !== "generate") {
      triggerTransition("generate");
    } else if (next !== mode) {
      triggerTransition(next);
    }
  }, [mode, animState, triggerTransition]);

  // D-18 交接：/history 的「交给 AI 助理继续做」带 ?agent=1&q= 回首页。
  // 那些页面不像这张卡片能就地翻面，只能带着话跳过来；落地后直接开在 agent 面。
  // 读完就把 query 从地址栏抹掉（replaceState，不进历史）：留着它刷新会重复注入。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("agent") !== "1") return;
    // URL 里塞进来的东西不可信，截一下长度，别让它撑爆输入区。
    setAgentSeed((params.get("q") ?? "").slice(0, 500));
    // 会话深链：只接受 UUID 形状（36 位十六进制+连字符），别的值当没带。
    const sessionParam = params.get("session") ?? "";
    if (/^[0-9a-f-]{36}$/i.test(sessionParam)) setInitialAgentSessionId(sessionParam);
    setMode("agent");
    setDisplayMode("agent");
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // 交接语只属于它被交给的那一次对话：离开 agent 面就作废。
  // 不清的话，使用者半小时后再 toggle 开助理，会被塞回一句
  // 「照这个想法再做一版：…」——那是上次从图库带过来的话，早就不是他现在想做的事。
  useEffect(() => {
    if (mode !== "agent" && agentSeed) setAgentSeed("");
  }, [mode, agentSeed]);

  /**
   * 工作站的 applyCreatorResource 依赖 [onModelChange]，一旦这个 prop 每次
   * render 都换身份，<CreatorResourcePanel> 的 memo 就完全失效，
   * 32 张资源卡（含 32 个 next/image）会跟着生成期间的每一次 render 重渲染。
   * setState 的 updater 形式让依赖数组可以是空的。
   */
  const handleModelChange = useCallback((modelId: string) => {
    const normalized = normalizeGenerationConfig(modelId).config;
    setSelectedModels((current) => ({ ...current, image_tinchak: modelId }));
    setAspectRatio(normalized.aspectRatio);
    setOutputResolution(normalized.outputResolution);
    setDurationSeconds(normalized.durationSeconds);
    setGenerateAudio(normalized.generateAudio ?? false);
    // 参考图的清理交给下面的 effect：副作用（提示）不能写在 setState 的 updater 里。
  }, []);

  // ── D-12：助理动过的参数回流到工作台控件（三态復原抽到 use-agent-param-reflect）──
  // userSet* 系列 setter 的身分（useCallback 依賴陣列）在 hook 內原樣保留：
  // PromptInput 那側沒有 memo 依賴，但工作站 onModelChange 的穩定引用設計
  // 不允許這裡換身分。
  const {
    handleParamsReflected,
    userSetAspectRatio,
    userSetOutputResolution,
    userSetModel,
  } = useAgentParamReflect({
    modelId: selectedModels.image_tinchak,
    aspectRatio,
    outputResolution,
    handleModelChange,
    setAspectRatio,
    setOutputResolution,
  });

  /**
   * 模型不支持参考图时清空并说明原因。
   */
  useEffect(() => {
    if (generationModel(selectedModels.image_tinchak)?.referenceImages) return;
    if (referenceImages.length === 0) return;
    setReferenceImages([]);
  }, [selectedModels.image_tinchak, referenceImages.length]);

  const handlePromptSubmit = useCallback(async (rawPrompt: string) => {
    if (!LOCAL_TEST_MODE && (!isLoggedIn || !user)) {
      redirectToGithub();
      return;
    }
    const requiredCoins = generationCoins(selectedModels.image_tinchak, {
      resolution: outputResolution,
      durationSeconds,
      generateAudio,
    });
    if (!LOCAL_TEST_MODE && user && !hasEnoughQuota(user, requiredCoins)) {
      toast({ title: "余额不足", description: "请先充值再继续做图", variant: "destructive" });
      return;
    }
    const finalPrompt = enhancePrompt(rawPrompt, stylePreset);
    setProgressStartedAt(Date.now());
    setProgressDurationMs(etaDurationForModel(selectedModels.image_tinchak));
    setShowProgress(true);
    await startGeneration(finalPrompt, ["image_tinchak"], { image_tinchak: selectedModels.image_tinchak }, {
      referenceImages,
      qualityMode: outputResolution === "1k" ? "fast" : "quality",
      aspectRatio,
      outputResolution,
      durationSeconds,
      generateAudio,
    });
    if (!LOCAL_TEST_MODE) {
      refresh().catch(() => {});
    }
  }, [isLoggedIn, user, stylePreset, selectedModels, outputResolution, durationSeconds, generateAudio, aspectRatio, startGeneration, toast, refresh, referenceImages, redirectToGithub]);

  const usedFallback = images.some((image) =>
    image.endpointLabel === "fallback" && (image.image || image.imageUrl),
  );
  const hasGeneratedImage = images.some((image) => image.image || image.imageUrl || image.videoUrl);

  useEffect(() => {
    if (usedFallback) setProgressDurationMs(FALLBACK_PROGRESS_DURATION_MS);
  }, [usedFallback]);

  // 離頁再回來時本地沒有進度條狀態，但 hook 恢復了 server 端還在跑的任務（isLoading=true）：
  // 補喚進度條，避免「回來進度消失」；完成時由上方 effect 依 isLoading=false 收起並揭曉結果。
  useEffect(() => {
    if (!isLoading || showProgress || failedProviders.length > 0) return;
    if (hasGeneratedImage) return;
    setShowProgress(true);
    setProgressStartedAt(Date.now());
  }, [failedProviders.length, hasGeneratedImage, isLoading, showProgress]);

  useEffect(() => {
    if (failedProviders.length > 0 || hasGeneratedImage) {
      setShowProgress(false);
      return;
    }
    if (!showProgress || !progressStartedAt || isLoading) return;
    const elapsed = Date.now() - progressStartedAt;
    const remaining = Math.max(0, progressDurationMs - elapsed);
    const timer = window.setTimeout(() => setShowProgress(false), remaining + 450);
    return () => window.clearTimeout(timer);
  }, [failedProviders.length, hasGeneratedImage, isLoading, progressDurationMs, progressStartedAt, showProgress]);

  const revealGeneratedResult = !showProgress;
  const resultView = useMemo(() => {
    const key: ProviderKey = "image_tinchak";
    const imageItem = images.find((img) => img.provider === key);
    // agent 模式只產圖片（kotone-bridge 回傳的是靜態圖）。右側空態與展示都
    // 該按圖片走，不能繼承普通模式的影片模型選擇——否则右側空態显示
    // 「视频会出现在这里」，与「生成图片」的请求自相矛盾。
    const mediaTypeOverride = displayMode === "agent" ? "image" : undefined;
    return {
      image: revealGeneratedResult ? imageItem?.image : null,
      imageUrl: revealGeneratedResult ? (pixaiResultUrl ?? imageItem?.imageUrl) : null,
      videoUrl: revealGeneratedResult ? imageItem?.videoUrl : null,
      mediaType:
        mediaTypeOverride ??
        imageItem?.mediaType ??
        generationModel(imageItem?.modelId ?? selectedModels[key])?.kind ??
        "image",
      modelId: imageItem?.modelId ?? selectedModels[key],
      timing: showProgress
        ? { startTime: progressStartedAt ?? Date.now(), durationMs: progressDurationMs }
        : timings[key],
      failed: revealGeneratedResult && failedProviders.includes(key),
    };
  }, [images, selectedModels, revealGeneratedResult, showProgress, progressStartedAt, progressDurationMs, timings, failedProviders, pixaiResultUrl, displayMode]);

  const renderState = isLoading
    ? "处理中"
    : failedProviders.length > 0
      ? "需要重试"
      : images.some((i) => i.image || i.imageUrl || i.videoUrl)
        ? "已完成"
        : "当前可用";

  // 人工终止：取最新一个未完成任务作为取消目标（hook 的 tasks 按
  // createdAt 降序，mergeGenerationTaskProjections 已排序）。
  const activeTask = tasks.find((task) => task.status === "queued" || task.status === "running") ?? null;
  const handleCancelGenerate = activeTask
    ? () => { void cancelTask(activeTask.taskId); }
    : undefined;

  return (
    <>
      {/* 這一層不參與模式轉場：dust 動畫的範圍只有卡片中間那塊控制區
          （在 PromptInput 裡）。上一版讓整頁跟著翻面，等於為了開個聊天區
          把首頁整塊換掉——使用者要的是卡片換一面，不是換個網站。 */}
      <div className="min-h-screen bg-transparent pb-28 pt-10 sm:pb-32">
            <div className="page-shell">
              <div className={inCanvasWorkstation ? "block" : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]"}>
                {/* min-w-0 is load-bearing: an auto-sized grid column takes its
                    minimum from the item's min-content, so a single nowrap
                    control inside the card would widen the column past the
                    viewport and push the whole page sideways on phones.
                    畫布工作站的殼（inline style + 全場畫布 overlay + 面板殼/拖寬
                    手柄）抽到 canvas-workstation/CanvasChatWorkstation；inCanvas
                    Workstation 仍在這裡派生並經 props 下發。面板內容（D-12 撤銷條
                    + PromptInput）經 children 原地注入——聊天卡 DOM 不搬家，SSE
                    會話與輸入狀態零丟失；chatHeaderExtra（收合按鈕）由面板兩態
                    決定，經 render prop 回傳接線。 */}
                <CanvasChatWorkstation
                  inCanvasWorkstation={inCanvasWorkstation}
                  isLoading={isLoading}
                  canvasHost={canvasHost}
                  {...(showAgentTemplateGallery ? { overlayContent: <AgentTemplateCarousel templates={AGENT_TEMPLATES} onUseTemplate={handleUseAgentTemplate} /> } : {})}
                >
                  {(chatHeaderExtra) => (
                    <>
                  {/* 罪状 7（暴君人肉评测）：聊天框顶栏的「AI 助理改了 N 项设置 /
                      模型 / 恢复我的设定」撤销条整块删除（非隐藏）——控件上已是现值，
                      再画一遍被动过什么只是噪音；D-12 的参数回流本身（模型/比例/
                      解析度真正被改掉）仍然生效，撤的只是这条提示栏。 */}
                  <PromptInput
                    onSubmit={handlePromptSubmit}
                    isLoading={isLoading}
                    onCancelGenerate={handleCancelGenerate}
                    isLoggedIn={LOCAL_TEST_MODE ? true : isLoggedIn}
                    suggestions={initialSuggestions}
                    stylePreset={stylePreset}
                    onStyleChange={setStylePreset}
                    aspectRatio={aspectRatio}
                    onAspectRatioChange={userSetAspectRatio}
                    outputResolution={outputResolution}
                    onOutputResolutionChange={userSetOutputResolution}
                    durationSeconds={durationSeconds}
                    onDurationChange={setDurationSeconds}
                    generateAudio={generateAudio}
                    onGenerateAudioChange={setGenerateAudio}
                    referenceImages={referenceImages}
                    onReferenceImagesChange={setReferenceImages}
                    models={PROVIDERS.image_tinchak.models}
                    modelId={selectedModels.image_tinchak}
                    onModelChange={userSetModel}
                    mode={mode}
                    onModeChange={handleModeChange}
                    animState={animState}
                    displayMode={displayMode}
                    fillAvailableHeight={inCanvasWorkstation}
                    /* 收合面板按鈕併入聊天 header——面板頂欄已刪，觸發前後
                       同一個 header 同一套操作（2026-08-22 統一裁定）。按鈕本體
                       在 CanvasChatWorkstation（面板兩態是它的私有狀態），經
                       render prop 回傳到這裡接線。 */
                    chatHeaderExtra={chatHeaderExtra}
                    onEditResult={setPixaiResultUrl}
                    onUpscaleResult={setPixaiResultUrl}
                    onParamsReflected={handleParamsReflected}
                    onImageResult={setPixaiResultUrl}
                    agentSeed={agentSeed}
                    initialAgentSessionId={initialAgentSessionId}
                    onCanvasEvent={handleCanvasEvent}
                    canvasStateProvider={handleCanvasSummary}
                    onSessionChange={handleAgentSessionChange}
                    switchSessionRef={switchSessionRef}
                    startNewSessionRef={startNewSessionRef}
                    agentInjection={agentTemplateInjection}
                    onUserMessage={() => setAgentTemplateDismissed(true)}
                  />
                    </>
                  )}
                </CanvasChatWorkstation>

                {/* Result canvas only — the picker moved onto the left rail, so
                    this column no longer needs an identity header or a status
                    badge duplicating the one ImageDisplay already draws.
                    畫布工作站態：整欄隱藏（畫布已是全場主角）。 */}
                <div className={cn("flex min-w-0 flex-col", inCanvasWorkstation && "hidden")}>
                  <ImageDisplay
                    modelId={resultView.modelId}
                    provider="image_tinchak"
                    image={resultView.image}
                    imageUrl={resultView.imageUrl}
                    videoUrl={resultView.videoUrl}
                    mediaType={resultView.mediaType}
                    timing={resultView.timing}
                    failed={resultView.failed}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* 場景指南及以下为 SEO 内容：保留 DOM，但视觉隐藏。 */}
          <div className="hidden" aria-hidden="true">
            <UseCaseLinks />
            <FaqSection />
          </div>

      {(!showProgress && (isLoading || failedProviders.length > 0)) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-30 flex justify-center px-4 sm:bottom-6">
          <div className="pointer-events-auto lg-bar flex items-center gap-3 rounded-ios-4xl px-5 py-2.5">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                isLoading ? "bg-[#34C759] animate-pulse" : "bg-[#FF3B30]",
              )}
            />
            <span className="text-ios-footnote text-[rgba(0,0,0,0.58)]">{renderState}</span>
          </div>
        </div>
      )}

    </>
  );
}
