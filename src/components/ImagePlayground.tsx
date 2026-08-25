"use client";

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import dynamic from "next/dynamic";
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
import { Bot, ChevronDown, RotateCcw } from "lucide-react";
import { hasEnoughQuota } from "@/lib/new-api-client";
import { LOCAL_TEST_MODE } from "@/lib/sub2api";
import { PRO_LORA_TOUR_ARMED_KEY } from "@/lib/lora-tour-content";
import { cn } from "@/lib/utils";
import { getInitialSuggestions, type Suggestion } from "@/lib/suggestions";
import type { ReferenceImage } from "@/lib/image-types";
import type { ProfessionalRunConfig } from "@/components/pro-workstation/InvokeInspiredWorkstation";
import { CanvasChatWorkstation } from "@/components/canvas-workstation/CanvasChatWorkstation";
import { AgentTemplateGallery } from "@/components/canvas-workstation/AgentTemplateGallery";
import { applyTemplateToCanvas } from "@/components/canvas-workstation/agent-template-canvas";
import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import { useAgentParamReflect, AGENT_PARAM_LABELS } from "@/hooks/use-agent-param-reflect";

// workstation.css 有意「不」在这里 import：它是 ~37KB 的专业模式专用样式，
// 从这里静态 import 会让它进入首页的 render-blocking <link rel=stylesheet>。
// 它跟着 InvokeInspiredWorkstation 自己的 import 走懒加载 chunk（同文件里的
// driver.js/dist/driver.css 已经证明这条路径可行）。占位需要的 .pro-app-shell
// 基块留在 globals.css 里。
const InvokeInspiredWorkstation = dynamic(() => import("@/components/pro-workstation/InvokeInspiredWorkstation").then((mod) => mod.InvokeInspiredWorkstation), {
  ssr: false,
  loading: () => <div className="lg-card rounded-ios-4xl p-5 text-ios-footnote text-[rgba(0,0,0,0.46)]">加载专业工作站...</div>,
});

// AGENT_PARAM_LABELS（D-12 撤销条项目名）随三态復原一起抽到
// hooks/use-agent-param-reflect.ts，从这里 import。

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
  // 2026-08-25 模板庫：點卡注入 pending（nonce 讓「換一張卡」也是新注入）。
  const [agentTemplateInjection, setAgentTemplateInjection] = useState<{ text: string; nonce: number } | null>(null);
  // 模板庫退場旗標：發出第一條用戶消息（模板注入或手打）即收起，之後不再出現。
  const [agentTemplateDismissed, setAgentTemplateDismissed] = useState(false);
  // wish 插件深链（?agent=1&session=<uuid>）：落地后直开该会话而非新开对话。
  const [initialAgentSessionId, setInitialAgentSessionId] = useState("");
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
  /** 案例卡「用此工作流打开」待灌入工作台的配方（nonce 保证同一案例可重复触发）。 */
  const [showcaseRecipe, setShowcaseRecipe] = useState<{ json: string; nonce: number } | null>(null);
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
  const canvasHost = useCanvasChat(currentSessionId);
  canvasHostRef.current = canvasHost;

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
   *    → useCanvasChat.addNodes 鋪成 workflow，等 agent 修改。
   * ③ 首條消息落地即收起畫廊（onUserMessage）。
   */
  const handleUseAgentTemplate = useCallback((template: AgentTemplate) => {
    setAgentTemplateInjection({ text: template.initialPrompt, nonce: Date.now() });
    applyTemplateToCanvas(canvasHostRef.current?.addNodes, template);
    setAgentTemplateDismissed(true);
  }, []);
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

  // 2026-08-25 canvas 常駐化：右側面板 mode 由 displayMode 唯一決定——agent 模式
  // 恆為 canvas（模板庫→畫布），非 agent 模式恆為 ImageDisplay。原黏性旗標/
  // workflow_start 切換/節點數回退等中間態邏輯全部收斂刪除。
  const resultMode: "image" | "canvas" = displayMode === "agent" ? "canvas" : "image";
  const inCanvasWorkstation = displayMode === "agent" && !showProfessionalMode;
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

  // ── D-12：助理动过的参数回流到工作台控件（三态復原抽到 use-agent-param-reflect）──
  // userSet* 系列 setter 的身分（useCallback 依賴陣列）在 hook 內原樣保留：
  // PromptInput 那側沒有 memo 依賴，但工作站 onModelChange 的穩定引用設計
  // 不允許這裡換身分。
  const {
    agentBaseline,
    agentTouched,
    handleParamsReflected,
    undoAgentParam,
    restoreMyParams,
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

  /**
   * 案例卡「用此工作流打开」：把案例携带的完整配方交给专业工作台，
   * 经 workflow-recall 通道（parseWorkflowRecallConfig → applyWorkflowRecallConfig）
   * 灌入 —— 与 R 键 / PNG 内嵌工作流同一条配方载入管线，不另开入口。
   */
  const handleOpenShowcaseWorkflow = useCallback((item: ShowcaseCase) => {
    if (!item.recipe) return;
    setShowcaseRecipe({ json: JSON.stringify(item.recipe), nonce: Date.now() });
    openProfessionalMode();
  }, [openProfessionalMode]);

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
            externalRecipeJson={showcaseRecipe}
          />
        </div>
      )}

      {!showProfessionalMode && (
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
                  {...(showAgentTemplateGallery ? { overlayContent: <AgentTemplateGallery templates={AGENT_TEMPLATES} onUseTemplate={handleUseAgentTemplate} /> } : {})}
                >
                  {(chatHeaderExtra) => (
                    <>
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
                    onSessionChange={setCurrentSessionId}
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

          {/* 聊天区开在卡片里，不占屏，所以案例轮播照常留着：
              使用者一边跟助理聊，一边还能看到案例、点一下换个方向。 */}
          <CaseShowcase onUsePrompt={handleUseCasePrompt} onOpenWorkflow={handleOpenShowcaseWorkflow} />
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
