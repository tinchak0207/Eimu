"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import { ImageDisplay } from "@/components/ImageDisplay";
import { PromptInput, type PromptInputMode } from "@/components/PromptInput";
import { CaseShowcase } from "@/components/CaseShowcase";
import { FaqSection } from "@/components/FaqSection";
import { UseCaseLinks } from "@/components/UseCaseLinks";
import { useCanvasChat, type UseCanvasChatReturn } from "@/hooks/use-canvas-chat";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
const CanvasEmbed = dynamic(() => import("@/components/canvas/CanvasEmbed").then((m) => m.CanvasEmbed), { ssr: false });
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
  type ModelMode,
} from "@/lib/provider-config";
import {
  aspectRatioFromImageSize,
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
import type { ReflectedParams } from "@/lib/agent-param-reflect";
import { Bot, ChevronDown, ChevronUp, MessageCircle, PanelLeftClose, PanelLeftOpen, RotateCcw } from "lucide-react";
import { hasEnoughQuota } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/sub2api";
import { PRO_LORA_TOUR_ARMED_KEY } from "@/lib/lora-tour-content";
import { cn } from "@/lib/utils";
import { getInitialSuggestions, type Suggestion } from "@/lib/suggestions";
import type { ReferenceImage } from "@/lib/image-types";
import type { ProfessionalRunConfig } from "@/components/pro-workstation/InvokeInspiredWorkstation";

// workstation.css 有意「不」在这里 import：它是 ~37KB 的专业模式专用样式，
// 从这里静态 import 会让它进入首页的 render-blocking <link rel=stylesheet>。
// 它跟着 InvokeInspiredWorkstation 自己的 import 走懒加载 chunk（同文件里的
// driver.js/dist/driver.css 已经证明这条路径可行）。占位需要的 .pro-app-shell
// 基块留在 globals.css 里。
const InvokeInspiredWorkstation = dynamic(() => import("@/components/pro-workstation/InvokeInspiredWorkstation").then((mod) => mod.InvokeInspiredWorkstation), {
  ssr: false,
  loading: () => <div className="lg-card rounded-ios-4xl p-5 text-ios-footnote text-[rgba(0,0,0,0.46)]">加载专业工作站...</div>,
});

/** D-12 撤销条上的项目名。顺序即显示顺序。 */
const AGENT_PARAM_LABELS: ReadonlyArray<{
  key: "modelId" | "aspectRatio" | "resolution";
  label: string;
}> = [
  { key: "modelId", label: "模型" },
  { key: "aspectRatio", label: "比例" },
  { key: "resolution", label: "解析度" },
];

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
  const [showProfessionalMode, setShowProfessionalMode] = useState(false);
  const [hasOpenedProfessionalMode, setHasOpenedProfessionalMode] = useState(false);
  const [mode, setMode] = useState<PlaygroundMode>("generate");
  const [displayMode, setDisplayMode] = useState<PlaygroundMode>("generate");
  const [animState, setAnimState] = useState<"idle" | "exit" | "enter">("idle");
  // 别的页面（D-18 图库卡）用 ?agent=1&q= 交接过来的一句话。
  const [agentSeed, setAgentSeed] = useState("");
  // 只有从普通模式 LoRA 引导末步「前往专业模式」进入时才为 true，触发专业模式 LoRA 教学
  const [loraTourFromGuide, setLoraTourFromGuide] = useState(false);
  const { images, timings, failedProviders, isLoading, recentWorkflows, tasks, startGeneration } = useImageGeneration({ enableServerHistory: showProfessionalMode });
  const { user, isLoggedIn, refresh } = useAuth();
  const { toast } = useToast();
  const initialSuggestions = useMemo(() => getInitialSuggestions(suggestions), [suggestions]);
  const [selectedModels, setSelectedModels] = useState(MODEL_CONFIGS.fast);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(() => defaultAspectRatio(MODEL_CONFIGS.fast.image_tinchak));
  const [outputResolution, setOutputResolution] = useState<OutputResolution>(() => defaultOutputResolution(MODEL_CONFIGS.fast.image_tinchak));
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(() => defaultDuration(MODEL_CONFIGS.fast.image_tinchak));
  const [generateAudio, setGenerateAudio] = useState(() => defaultGenerateAudio(MODEL_CONFIGS.fast.image_tinchak));
  const [stylePreset, setStylePreset] = useState<StylePreset>("none");
  const [casePrompt, setCasePrompt] = useState("");
  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
// PixAI edit/upscale results are delivered straight to the result canvas on
// the right; they do not go through the normal generation queue.
const [pixaiResultUrl, setPixaiResultUrl] = useState<string | null>(null);
  // v3 embed：右側結果面板 mode。agent 開始建畫布（收到 canvas.plan）→ 切 canvas。
  const [resultMode, setResultMode] = useState<"image" | "canvas">("image");
  // 畫布工作站（2026-08-16，暴君裁定「擠」）：畫布模式 = 全場畫布，聊天卡
  // 變成左側浮動面板，expanded|rail 兩態 + 右緣拖寬，localStorage 記憶。
  // 遼闊是預設，不是獎勵——不再有「compact 嵌右欄」這種把畫布塞縫裡的狀態。
  const [chatPanelState, setChatPanelState] = useState<"expanded" | "rail">("expanded");
  const [chatPanelWidth, setChatPanelWidth] = useState(420);
  const chatPanelDragRef = useRef<{ pointerId: number; startX: number; startW: number } | null>(null);
  // 單一 SSE：AgentChatSurface 自建 useAgentChat，其 onCanvasEvent 出口餵回畫布。
  // 用 ref 解開循環依賴：onCanvasEvent 轉交 canvasHostRef；canvasHost 後建，餵回 ref。
  const canvasHostRef = useRef<UseCanvasChatReturn | null>(null);
  const handleCanvasEvent = useCallback((event: AgentSseEvent) => {
    // 第一次 workflow_start 調用即切畫布：不等 canvas.plan/節點事件落地，agent 一發起
    // 工作流右側面板就進 canvas 模式（黏性旗標照舊，畫布清空也不會被踢回圖片模式）。
    if (event.name === "tool.invoke") {
      if (event.data.tool === "workflow_start") {
        enteredCanvasRef.current = true;
        setResultMode("canvas");
      }
      // 畫布資料管線只吃 canvas 結構事件，tool.invoke 不入 reducer。
      return;
    }
    canvasHostRef.current?.feedCanvasEvent(event);
  }, []);
  const handleCanvasSummary = useCallback(() => canvasHostRef.current?.summarize(), []);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const canvasHost = useCanvasChat(currentSessionId);
  canvasHostRef.current = canvasHost;
  // canvas 黏性旗標：同一 agent session 內進過畫布就維持畫布，避免「新建画布」清空後被踢回圖片模式。
  const enteredCanvasRef = useRef(false);
  const [progressStartedAt, setProgressStartedAt] = useState<number>();
  const [progressDurationMs, setProgressDurationMs] = useState(NORMAL_PROGRESS_DURATION_MS);
  const [showProgress, setShowProgress] = useState(false);
  const [capabilityNotice, setCapabilityNotice] = useState("");

  useEffect(() => {
    if (showProfessionalMode) {
      document.body.classList.add("pro-mode-active");
    } else {
      document.body.classList.remove("pro-mode-active");
    }
    return () => document.body.classList.remove("pro-mode-active");
  }, [showProfessionalMode]);

  // v3 embed：畫布只屬於 AI 助理模式。agent 開始建畫布（有節點/計畫）→ 右側面板切 CanvasEmbed。
  // 畫布有節點時維持 canvas；畫布清空才回 ImageDisplay。
  // 離開 agent 面（generate/edit/upscale）一律回到 ImageDisplay——畫布不會因為
  // 之前助理會話的節點殘留或專案恢復而在非助理模式下冒出來。
  useEffect(() => {
    if (displayMode !== "agent") {
      // 離開 agent 面：畫布不再屬於當前檢視，一律回圖片模式。
      enteredCanvasRef.current = false;
      setResultMode("image");
      return;
    }
    // 同一 agent session 內只要進過畫布就維持畫布 —— 剛按「新建画布」時畫布是空的，
    // 若只看 nodes/plans 就會把使用者踢回圖片模式，看不到畫布了。
    if (enteredCanvasRef.current) {
      setResultMode("canvas");
      return;
    }
    if (canvasHost.nodes.length > 0 || canvasHost.plans.length > 0) {
      enteredCanvasRef.current = true;
      setResultMode("canvas");
    } else {
      setResultMode("image");
    }
  }, [displayMode, canvasHost.nodes.length, canvasHost.plans.length]);

  // ─── 畫布工作站：面板記憶載入/持久化 + 畫布模式鎖頁面捲動 ───
  useEffect(() => {
    const s = window.localStorage.getItem("canvas-chat-panel-state");
    if (s === "rail") {
      setChatPanelState("rail");
    } else if (!s && window.matchMedia("(max-width: 767px)").matches) {
      // 手機首次進工作站：抽屜預設收成 rail。展開態是 46dvh 的底部抽屜，
      // 一進場就蓋掉半屏畫布（節點卡只剩標題列可見）——要看畫布再收、要聊再開。
      setChatPanelState("rail");
    }
    const w = Number(window.localStorage.getItem("canvas-chat-panel-width"));
    if (Number.isFinite(w) && w >= 320 && w <= 560) setChatPanelWidth(w);
  }, []);
  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-state", chatPanelState);
  }, [chatPanelState]);
  useEffect(() => {
    window.localStorage.setItem("canvas-chat-panel-width", String(chatPanelWidth));
  }, [chatPanelWidth]);
  const inCanvasWorkstation = displayMode === "agent" && resultMode === "canvas" && !showProfessionalMode;
  useEffect(() => {
    if (!inCanvasWorkstation) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [inCanvasWorkstation]);

  // 換 agent 會話 = 畫布重來：黏性旗標也要重算，否則新會話的空畫布會沿用上一會話的 canvas 模式。
  useEffect(() => {
    enteredCanvasRef.current = false;
  }, [currentSessionId]);

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

  const handleExitProfessionalMode = useCallback(() => setShowProfessionalMode(false), []);
  const openProfessionalMode = useCallback(() => {
    // 只有普通模式 LoRA 引导末步按过「前往专业模式」才播放专业模式 LoRA 教学
    const armed = typeof window !== "undefined" && window.localStorage.getItem(PRO_LORA_TOUR_ARMED_KEY) === "1";
    if (armed) window.localStorage.removeItem(PRO_LORA_TOUR_ARMED_KEY);
    setLoraTourFromGuide(armed);
    setHasOpenedProfessionalMode(true);
    setShowProfessionalMode(true);
  }, []);

  /**
   * 普通模式和专业模式共用同一个稳定引用，绝不要在 JSX 里写成行内箭头函数：
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

  // ── D-12：助理动过的参数回流到工作台控件 ──
  // 三态就是这里的 baseline / 现值 两者比对出来的：
  //   原值      = agentBaseline 里存的那份（助理第一次改之前的快照）
  //   agent 改成 = agentTouched 里有这个 key，且现值 !== baseline
  //   使用者手改 = 使用者自己动了控件 → 该 key 从 agentTouched 移除
  // 只快照一次：助理连改三轮，「恢复我的设定」也要回到它插手之前那一版。
  const [agentBaseline, setAgentBaseline] = useState<{
    modelId: string;
    aspectRatio: AspectRatio;
    resolution: OutputResolution;
  } | null>(null);
  const [agentTouched, setAgentTouched] = useState<Set<"modelId" | "aspectRatio" | "resolution">>(
    new Set(),
  );

  const handleParamsReflected = useCallback((params: ReflectedParams) => {
    setAgentBaseline((prev) =>
      prev ?? {
        modelId: selectedModels.image_tinchak,
        aspectRatio,
        resolution: outputResolution,
      },
    );
    const touched = new Set<"modelId" | "aspectRatio" | "resolution">();
    if (params.modelId !== undefined) {
      touched.add("modelId");
      handleModelChange(params.modelId);
    }
    // 模型换了之后比例/解析度的合法集合也变了，但 reflectParams 已按
    // 助理选的模型校验过，这里直接写入即可。
    if (params.aspectRatio !== undefined) {
      touched.add("aspectRatio");
      setAspectRatio(params.aspectRatio);
    }
    if (params.resolution !== undefined) {
      touched.add("resolution");
      setOutputResolution(params.resolution);
    }
    setAgentTouched((prev) => new Set([...prev, ...touched]));
  }, [selectedModels.image_tinchak, aspectRatio, outputResolution, handleModelChange]);

  /** 逐项撤销：把某一项还原成助理插手之前的值。 */
  const undoAgentParam = useCallback((key: "modelId" | "aspectRatio" | "resolution") => {
    if (!agentBaseline) return;
    if (key === "modelId") handleModelChange(agentBaseline.modelId);
    if (key === "aspectRatio") setAspectRatio(agentBaseline.aspectRatio);
    if (key === "resolution") setOutputResolution(agentBaseline.resolution);
    setAgentTouched((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [agentBaseline, handleModelChange]);

  // 三态里的第三态：使用者自己动了控件 → 这一项不再算「agent 改成」。
  // 关键是不共用 setter：助理回流走 setAspectRatio/setOutputResolution 原始
  // setter，使用者走下面这两个包装。这样不需要任何「现在是谁在改」的标志位，
  // 也就没有标志位漏关导致误判的可能。
  const userSetAspectRatio = useCallback((next: AspectRatio) => {
    setAspectRatio(next);
    setAgentTouched((prev) => {
      if (!prev.has("aspectRatio")) return prev;
      const s = new Set(prev);
      s.delete("aspectRatio");
      return s;
    });
  }, []);

  const userSetOutputResolution = useCallback((next: OutputResolution) => {
    setOutputResolution(next);
    setAgentTouched((prev) => {
      if (!prev.has("resolution")) return prev;
      const s = new Set(prev);
      s.delete("resolution");
      return s;
    });
  }, []);

  const userSetModel = useCallback((next: string) => {
    handleModelChange(next);
    // 换模型会顺带重置比例与解析度（normalizeGenerationConfig），
    // 所以这三项的 agent 标记一起清掉，否则会留下指向旧模型的假标记。
    setAgentTouched((prev) => (prev.size === 0 ? prev : new Set()));
  }, [handleModelChange]);

  /** 全局「恢复我的设定」：三项一起回到助理插手之前。 */
  const restoreMyParams = useCallback(() => {
    if (!agentBaseline) return;
    handleModelChange(agentBaseline.modelId);
    setAspectRatio(agentBaseline.aspectRatio);
    setOutputResolution(agentBaseline.resolution);
    setAgentTouched(new Set());
  }, [agentBaseline, handleModelChange]);


  /**
   * 模型不支持参考图时清空并说明原因。
   *
   * 旧版把 setCapabilityNotice 写在 setReferenceImages 的 updater 内部 —— updater 必须
   * 是纯函数，StrictMode 会调用两次，并发渲染下 React 还可能重放它，
   * 于是这条提示什么时候出现取决于运气。移到 effect 里，清空与提示同时发生。
   */
  useEffect(() => {
    if (generationModel(selectedModels.image_tinchak)?.referenceImages) return;
    if (referenceImages.length === 0) return;
    setReferenceImages([]);
    setCapabilityNotice("已移除参考图：所选模型不支持参考图输入。");
  }, [selectedModels.image_tinchak, referenceImages.length]);

  const handleUseCasePrompt = (prompt: string, style: StylePreset) => {
    setCasePrompt(prompt);
    setStylePreset(style);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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
    setProgressDurationMs(NORMAL_PROGRESS_DURATION_MS);
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

  const handleProfessionalRun = useCallback(async (config: ProfessionalRunConfig) => {
    if (!LOCAL_TEST_MODE && (!isLoggedIn || !user)) {
      redirectToGithub();
      return;
    }
    const requestedQuality: ModelMode = config.qualityProfile === "print" ? "quality" : "fast";
    const normalized = normalizeGenerationConfig(selectedModels.image_tinchak, {
      aspectRatio: aspectRatioFromImageSize(config.imageSize),
      outputResolution: requestedQuality === "quality" ? "2k" : "1k",
      durationSeconds: config.durationSeconds,
      generateAudio: config.generateAudio,
      qualityMode: requestedQuality,
      referenceCount: referenceImages.length,
      loraModelVersionIds: config.loraModelVersionIds,
    });
    const qualityMode: ModelMode = normalized.config.qualityMode;
    /**
     * 余额校验必须按「单张价 × 张数」算。
     *
     * 旧版是 generationCoins(modelId, normalized.config)：generationCoins 读的键是
     * resolution，而 normalized.config 里叫 outputResolution —— 传进去等于没传，2K
     * 一律按 1K 计价；再加上完全没乘 copies，界面写着「16 币」时这里只校验 1 币。
     * 结果是余额不足的用户能提交，扣费在服务端才失败，8 张里可能只有前几张成功。
     */
    const copies = Math.max(1, config.copies ?? 1);
    const coinsPerImage = generationCoins(selectedModels.image_tinchak, {
      resolution: normalized.config.outputResolution,
      durationSeconds: normalized.config.durationSeconds,
      generateAudio: normalized.config.generateAudio,
    });
    const requiredCoins = Math.round(coinsPerImage * copies * 10) / 10;
    // 能力调整提示是一次性的：这一轮没有被裁掉的字段就要清掉上一轮留下的横幅，
    // 否则「已移除参考图」会一直挂在画布标题栏，直到用户刷新页面。
    setCapabilityNotice(
      normalized.clearedFields.length
        ? `已按模型能力调整：${normalized.clearedFields.join("、")}。`
        : "",
    );
    if (!LOCAL_TEST_MODE && user && !hasEnoughQuota(user, requiredCoins)) {
      toast({
        title: "余额不足",
        description: `这次需要 ${requiredCoins} 币（${coinsPerImage} 币 × ${copies} 张），请先充值再继续`,
        variant: "destructive",
      });
      return;
    }
    /**
     * 专业模式不再套用普通模式的 stylePreset。
     *
     * 工作站有自己的风格系统（106 张风格卡 + applyStyleToPrompt），提示词交到这里时
     * 已经是最终稿。旧版又叠一层 enhancePrompt(prompt, stylePreset)，会把用户在普通
     * 模式随手点过的「电影感」偷偷混进专业模式的每一次生成，且界面上完全看不出来。
     */
    const finalPrompt = config.prompt;
    setProgressStartedAt(Date.now());
    setProgressDurationMs(NORMAL_PROGRESS_DURATION_MS);
    setShowProgress(true);
    await startGeneration(finalPrompt, ["image_tinchak"], { image_tinchak: selectedModels.image_tinchak }, {
      referenceImages,
      qualityMode,
      contextPrompt: config.contextPrompt,
      negativePrompt: config.negativePrompt,
      negativeHint: config.negativeHint,
      workflowPreset: config.workflowPreset,
      workflowPresetLabel: config.workflowPresetLabel,
      promptHint: config.promptHint,
      productionIntent: config.productionIntent,
      imageSize: config.imageSize,
      imageSizes: config.imageSizes,
      aspectRatio: normalized.config.aspectRatio,
      outputResolution: normalized.config.outputResolution,
      durationSeconds: normalized.config.durationSeconds,
      generateAudio: normalized.config.generateAudio,
      loraModelVersionIds: normalized.config.loraModelVersionIds,
      styleTemplate: config.styleTemplate,
      qualityProfile: config.qualityProfile,
      seedHint: config.seedHint,
      regionalPrompts: config.regionalPrompts,
      estimatedCredits: config.estimatedCredits,
      referenceImageRoles: config.referenceImageRoles,
      copies: config.copies,
      concurrency: config.concurrency,
      retryOfTaskId: config.retryOfTaskId,
    });
    if (!LOCAL_TEST_MODE) {
      refresh().catch(() => {});
    }
  }, [isLoggedIn, user, selectedModels, startGeneration, toast, refresh, referenceImages, redirectToGithub]);

  const usedFallback = images.some((image) =>
    image.endpointLabel === "fallback" && (image.image || image.imageUrl),
  );
  const hasGeneratedImage = images.some((image) => image.image || image.imageUrl || image.videoUrl);

  useEffect(() => {
    if (usedFallback) setProgressDurationMs(FALLBACK_PROGRESS_DURATION_MS);
  }, [usedFallback]);

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

  return (
    <>
      {hasOpenedProfessionalMode && (
        <div className={cn("pro-app-shell", !showProfessionalMode && "hidden")} aria-hidden={!showProfessionalMode}>
          <InvokeInspiredWorkstation
            active={showProfessionalMode}
            suggestions={initialSuggestions}
            referenceImages={referenceImages}
            onReferenceImagesChange={setReferenceImages}
            images={images}
            isLoading={isLoading}
            recentWorkflows={recentWorkflows}
            tasks={tasks}
            onRun={handleProfessionalRun}
            modelId={selectedModels.image_tinchak}
            onModelChange={handleModelChange}
            onExitProfessionalMode={handleExitProfessionalMode}
            loraTourFromGuide={loraTourFromGuide}
            capabilityNotice={capabilityNotice}
            externalResultUrl={pixaiResultUrl}
            onTemplateResult={setPixaiResultUrl}
          />
        </div>
      )}

      {!showProfessionalMode && (
        <>
          {/* 畫布工作站樣式：面板 fixed 浮於畫布上、兩態寬度過渡、行動端改底部抽屜。
              Liquid glass 紀律：面板是唯一一層玻璃卡——內層 PromptInput 的 lg-card
              在工作站態拍扁（透明、無影、無圓角），不許卡中卡堆疊。 */}
          <style>{`
            @keyframes canvas-ws-fade {
              from { opacity: 0; }
              to { opacity: 1; }
            }
            @keyframes canvas-ws-panel-in {
              from { opacity: 0; transform: translateX(-18px) scale(0.985); }
              to { opacity: 1; transform: none; }
            }
            .canvas-ws-overlay { animation: canvas-ws-fade 0.32s ease-out; }
            .canvas-chat-panel {
              position: fixed;
              z-index: 60;
              top: calc(0.75rem + env(safe-area-inset-top, 0px));
              bottom: calc(0.75rem + env(safe-area-inset-bottom, 0px));
              left: 0.75rem;
              display: flex;
              flex-direction: column;
              min-height: 0;
              max-height: calc(100dvh - 1.5rem - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px));
              max-width: calc(100vw - 1.5rem);
              border-radius: 22px;
              background: rgba(255, 255, 255, 0.78);
              backdrop-filter: blur(28px) saturate(180%);
              -webkit-backdrop-filter: blur(28px) saturate(180%);
              border: 1px solid rgba(255, 255, 255, 0.55);
              box-shadow: 0 16px 56px rgba(0, 0, 0, 0.16), inset 0 0 0 0.5px rgba(255, 255, 255, 0.4);
              overflow: hidden;
              transition: width 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
              animation: canvas-ws-panel-in 0.36s cubic-bezier(0.2, 0.8, 0.2, 1);
            }
            .canvas-chat-rail { width: 3.25rem !important; }
            .canvas-chat-scroll {
              flex: 1;
              min-height: 0;
              overflow-y: auto;
              padding: 0.5rem 0.625rem 0.625rem;
              overscroll-behavior: contain;
            }
            .canvas-chat-rail .canvas-chat-scroll { display: none; }
            /* 面板態聊天區填滿面板：scroll 容器變縱向 flex、不再自己滾，
               滾動收進 transcript 內部（agent 面的固定高在 46dvh 抽屜裡會溢出被裁）。 */
            .canvas-chat-scroll.canvas-chat-scroll-fill {
              display: flex;
              flex-direction: column;
              overflow: hidden;
              overflow-y: hidden;
            }
            .canvas-chat-scroll-fill > * { min-height: 0; }
            .canvas-chat-scroll-fill > section.lg-card {
              flex: 1 1 0%;
              /* 防御：卡片内部（agent 面）超高时也不许把 section 撑高，
                 滚动一律收进 transcript；否则 composer 会被推出面板外。 */
              min-height: 0;
              overflow: hidden;
            }
            .canvas-chat-scroll-fill > :not(section.lg-card) { flex-shrink: 0; }
            .agent-composer-anchor { flex-shrink: 0; }
            /* 卡中卡拍扁：面板已是玻璃面，內層卡片交出自己的底/影/框，內容直接坐在玻璃上。 */
            .canvas-chat-scroll > .lg-card {
              background: transparent;
              box-shadow: none;
              border: 0;
              border-radius: 0;
              backdrop-filter: none;
              -webkit-backdrop-filter: none;
            }
            .canvas-chat-resize {
              position: absolute;
              top: 0;
              bottom: 0;
              right: -2px;
              width: 10px;
              cursor: col-resize;
              z-index: 5;
              touch-action: none;
            }
            .canvas-chat-resize:hover { background: linear-gradient(to right, transparent, rgba(0, 122, 255, 0.25)); }
            @media (prefers-reduced-motion: reduce) {
              .canvas-ws-overlay, .canvas-chat-panel { animation: none; }
              .canvas-chat-panel { transition: none; }
            }
            @media (max-width: 767px) {
              .canvas-chat-panel {
                left: 0.5rem;
                right: 0.5rem;
                top: calc(5rem + env(safe-area-inset-top, 0px));
                bottom: calc(0.5rem + env(safe-area-inset-bottom, 0px));
                height: auto;
                width: auto !important;
                transition: top 0.32s cubic-bezier(0.2, 0.8, 0.2, 1);
              }
              .canvas-chat-panel::before {
                content: "";
                position: absolute;
                top: 6px;
                left: 50%;
                transform: translateX(-50%);
                width: 36px;
                height: 4px;
                border-radius: 999px;
                background: rgba(0, 0, 0, 0.16);
              }
              .canvas-chat-rail { top: auto; height: 3.25rem; width: auto !important; }
              .canvas-chat-rail::before { display: none; }
              .canvas-chat-resize { display: none; }
            }
          `}</style>
          {/* 畫布工作站：畫布吃滿全場（遼闊是預設，不再塞右欄縫裡），聊天卡原地
              換裝成左側浮動面板——DOM 不搬家，SSE 會話與輸入狀態零丟失。
              --ce-chrome-left：畫布頂欄 chips 向右避讓面板，跟著面板寬度過渡。 */}
          {inCanvasWorkstation && (
            <div
              className="canvas-ws-overlay fixed inset-x-0 top-0 z-50 h-[100dvh] bg-[#F2F2F7]"
              style={{ "--ce-chrome-left": `${chatPanelState === "expanded" ? chatPanelWidth + 12 : 64}px` } as React.CSSProperties}
            >
              <CanvasEmbed canvas={canvasHost} expanded onClose={() => setResultMode("image")} />
            </div>
          )}
          {/* 这一层不参与模式转场：dust 动画的范围只有卡片中间那块控件区
              （在 PromptInput 里）。上一版让整页跟着翻面，等于为了开个聊天区
              把首页整块换掉——使用者要的是卡片换一面，不是换个网站。 */}
          <div className="min-h-screen bg-transparent pb-28 pt-10 sm:pb-32">
            <div className="page-shell">
              <div className={inCanvasWorkstation ? "block" : "grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(380px,460px)]"}>
                {/* min-w-0 is load-bearing: an auto-sized grid column takes its
                    minimum from the item's min-content, so a single nowrap
                    control inside the card would widen the column past the
                    viewport and push the whole page sideways on phones. */}
                <div
                  className={cn(
                    inCanvasWorkstation ? "canvas-chat-panel" : "min-w-0",
                    inCanvasWorkstation && chatPanelState === "rail" && "canvas-chat-rail",
                  )}
                  style={inCanvasWorkstation && chatPanelState === "expanded" ? { width: chatPanelWidth } : undefined}
                >
                  {/* 面板頂欄（工作站態才顯形）：標題 + 收合/展開 */}
                  <div
                    className={
                      inCanvasWorkstation
                        ? cn(
                            "flex shrink-0 items-center gap-1.5 border-b border-[rgba(0,0,0,0.06)] px-2.5 py-2",
                            chatPanelState === "rail" && "h-full flex-col justify-start gap-2 border-b-0 py-2.5 max-md:h-auto max-md:flex-row",
                          )
                        : "hidden"
                    }
                  >
                    {chatPanelState === "expanded" ? (
                      <>
                        <MessageCircle className="h-4 w-4 shrink-0 text-[#007AFF]" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[rgba(0,0,0,0.75)]">
                          AI 助理
                        </span>
                        <button
                          type="button"
                          onClick={() => setChatPanelState("rail")}
                          title="收起对话面板"
                          aria-label="收起对话面板"
                          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[rgba(0,0,0,0.45)] transition-colors hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.75)]"
                        >
                          <PanelLeftClose className="h-4 w-4 max-md:hidden" aria-hidden="true" />
                          <ChevronDown className="hidden h-4 w-4 max-md:block" aria-hidden="true" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setChatPanelState("expanded")}
                          title="展开对话面板"
                          aria-label="展开对话面板"
                          className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[#007AFF] transition-colors hover:bg-[rgba(0,122,255,0.1)]"
                        >
                          <PanelLeftOpen className="h-4 w-4 max-md:hidden" aria-hidden="true" />
                          <ChevronUp className="hidden h-4 w-4 max-md:block" aria-hidden="true" />
                        </button>
                        <MessageCircle
                          className={cn("h-4 w-4 shrink-0 text-[rgba(0,0,0,0.35)]", isLoading && "animate-pulse text-[#007AFF]")}
                          aria-hidden="true"
                        />
                        <span className="hidden text-[12px] font-medium text-[rgba(0,0,0,0.45)] max-md:inline">AI 助理</span>
                      </>
                    )}
                  </div>
                  <div className={inCanvasWorkstation ? cn("canvas-chat-scroll min-w-0 flex-1 space-y-3", chatPanelState === "expanded" && "canvas-chat-scroll-fill") : "space-y-3"}>
                  {/* D-12：助理改过的项在这里显形，可逐项撤销，也可一键恢复原设定。
                      不显示「原值 → 现值」的箭头对照：控件上已经是现值，
                      再画一遍只是噪音；使用者要的是「这项被动过」和「还我」。 */}
                  {agentBaseline && agentTouched.size > 0 && (
                    <div className="lg-card flex shrink-0 flex-wrap items-center gap-2 rounded-ios-2xl px-3.5 py-2.5">
                      <Bot className="h-3.5 w-3.5 shrink-0 text-[#007AFF]" aria-hidden="true" />
                      <span className="text-ios-caption1 text-[rgba(0,0,0,0.52)]">
                        AI 助理改了 {agentTouched.size} 项设置
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {AGENT_PARAM_LABELS.filter(({ key }) => agentTouched.has(key)).map(
                          ({ key, label }) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => undoAgentParam(key)}
                              className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-2.5 text-ios-caption1 font-medium text-[rgba(0,0,0,0.62)] transition-colors duration-200 hover:bg-[rgba(0,0,0,0.09)] hover:text-[rgba(0,0,0,0.85)]"
                              title={`撤销「${label}」，还原成你原来的设定`}
                            >
                              <RotateCcw className="h-3 w-3" aria-hidden="true" />
                              {label}
                            </button>
                          ),
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={restoreMyParams}
                        className="ml-auto shrink-0 cursor-pointer rounded-full bg-[rgba(0,122,255,0.10)] px-3 py-1 text-ios-caption1 font-semibold text-[#007AFF] transition-colors duration-200 hover:bg-[rgba(0,122,255,0.16)]"
                      >
                        恢复我的设定
                      </button>
                    </div>
                  )}
                  <PromptInput
                    onSubmit={handlePromptSubmit}
                    isLoading={isLoading}
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
                    externalPrompt={casePrompt}
                    referenceImages={referenceImages}
                    onReferenceImagesChange={setReferenceImages}
                    models={PROVIDERS.image_tinchak.models}
                    modelId={selectedModels.image_tinchak}
                    onModelChange={userSetModel}
                    isProfessionalMode={showProfessionalMode}
                    onToggleProfessionalMode={openProfessionalMode}
                    mode={mode}
                    onModeChange={handleModeChange}
                    animState={animState}
                    displayMode={displayMode}
                    fillAvailableHeight={inCanvasWorkstation}
                    onEditResult={setPixaiResultUrl}
                    onUpscaleResult={setPixaiResultUrl}
                    onParamsReflected={handleParamsReflected}
                    onImageResult={setPixaiResultUrl}
                    agentSeed={agentSeed}
                    onCanvasEvent={handleCanvasEvent}
                    canvasStateProvider={handleCanvasSummary}
                    onSessionChange={setCurrentSessionId}
                  />
                  </div>
                  {/* 面板右緣拖寬手柄（320–560px） */}
                  <div
                    className={inCanvasWorkstation && chatPanelState === "expanded" ? "canvas-chat-resize" : "hidden"}
                    onPointerDown={(e) => {
                      chatPanelDragRef.current = { pointerId: e.pointerId, startX: e.clientX, startW: chatPanelWidth };
                      e.currentTarget.setPointerCapture(e.pointerId);
                      e.preventDefault();
                    }}
                    onPointerMove={(e) => {
                      const d = chatPanelDragRef.current;
                      if (!d || d.pointerId !== e.pointerId) return;
                      setChatPanelWidth(Math.min(560, Math.max(320, d.startW + (e.clientX - d.startX))));
                    }}
                    onPointerUp={(e) => {
                      if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
                    }}
                    onPointerCancel={(e) => {
                      if (chatPanelDragRef.current?.pointerId === e.pointerId) chatPanelDragRef.current = null;
                    }}
                    aria-hidden="true"
                  />
                </div>

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

          {/* 聊天区开在卡片里，不占屏，所以案例轮播照常留着：
              使用者一边跟助理聊，一边还能看到案例、点一下换个方向。 */}
          <CaseShowcase onUsePrompt={handleUseCasePrompt} />
          {/* 場景指南及以下为 SEO 内容：保留 DOM，但视觉隐藏。 */}
          <div className="hidden" aria-hidden="true">
            <UseCaseLinks />
            <FaqSection />
          </div>
        </>
      )}

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
