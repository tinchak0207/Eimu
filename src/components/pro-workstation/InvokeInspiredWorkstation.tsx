"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Driver } from "driver.js";
import "driver.js/dist/driver.css";
// 这 ~37KB 只有专业模式用到。留在这个懒加载组件里，Next 会把它切成独立的
// CSS chunk，随 InvokeInspiredWorkstation 的 chunk 一起下发，
// 不会进入首页的 render-blocking <link rel=stylesheet>。
import "./workstation.css";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  ImagePlus,
  Plus,
  X,
} from "lucide-react";
import { MAX_REFERENCE_IMAGES, ReferenceImageUpload } from "@/components/ReferenceImageUpload";
import { useAuth } from "@/hooks/use-auth";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
// base64 → data URL 的对象身份缓存，与标准模式的 ImageDisplay 共用同一份实现
import { resultSrc } from "@/components/image-src";
import type { ImageResult, ReferenceImageRole } from "@/lib/image-types";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import { cn } from "@/lib/utils";
import { formatPublicGenerationSummary } from "@/lib/public-generation-summary";
import {
  mobilePanelForTaskStage,
  workstationTaskStage,
  type WorkstationTaskStage,
} from "@/lib/workstation-mobile-stage";
import { embedWorkflowIntoPng } from "@/lib/workflow-png";
import { measureNaturalSize } from "@/lib/reference-image-size";
import {
  WORKSTATION_COMMANDS,
  isWorkstationEditableTarget,
  workstationCommandForKey,
  type WorkstationCommandId,
} from "@/lib/workstation-commands";
import {
  AD_SIZE_OPTIONS,
  normalizeSizeSelection,
  sizeForSlot,
} from "@/lib/ad-formats";
import {
  type BrandKit,
  EMPTY_BRAND_KIT,
  buildBrandContext,
  clearBrandKit,
  hasBrandKit,
  loadBrandKit,
  saveBrandKit,
} from "@/lib/brand-kit";
// 只取类型：类型在编译期被擦除，所以 14 条场景模板与 32 条创作资源的数据体
// 不会进入专业模式入场 chunk，而是跟着下面 dynamic() 的面板 chunk 走。
import type { ScenarioTemplate } from "@/lib/scenario-templates";
import type { CreatorResource } from "@/lib/creator-resource-library";
import type { KunpengStyleAsset } from "@/lib/kunpeng-style-assets";
import type { KunpengPromptTemplate } from "@/lib/kunpeng-prompt-templates";
import { buildKunpengStylePrompt } from "@/lib/kunpeng-style-assets";
// 风格库刻意保持静态 import：getStyleById / applyStyleToPrompt / mergeStyleNegative
// 与 STYLE_LIBRARY 同在一个模块里且互相引用，tree shaking 无法把数据摘掉；
// 而这三个函数在生成提交、场景套用、工作流回填三条同步路径上都要立刻可用。
// 拆分需要改 src/lib/style-library.ts，不在本次改动范围内。
import {
  STYLE_CATEGORIES,
  applyStyleToPrompt,
  getStyleById,
  mergeStyleNegative,
} from "@/lib/style-library";
import { imageGenerationCoins } from "@/lib/provider-config";
import {
  GENERATION_MODEL_IDS,
  defaultDuration,
  defaultGenerateAudio,
  defaultOutputResolution,
  generationCoins,
  generationCapabilities,
  generationModel,
  imageSizeForAspectRatio,
  modelBaseName,
  modelDurations,
  modelSupportsAudio,
  type ModelUsageTipParams,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { ModelPicker } from "@/components/ModelPicker";
import { LoraLibraryPanel, type SelectedLora } from "@/components/pro-workstation/LoraLibraryPanel";
import {
  WORKFLOW_PRESETS,
  REFERENCE_IMAGE_ROLES,
  type WorkspaceMode,
  type MobilePanel,
  normalizeLeftPanelTab,
  type LeftPanelTab,
  type InspectorTab,
  type CanvasTool,
  type GalleryMode,
  type SlotState,
  type RegionalPromptItem,
  type TemplateStateSnapshot,
  PRODUCTION_INTENT_OPTIONS,
  WORKSPACE_MODES,
  MOBILE_PANELS,
  CANVAS_TOOLS,
  BRUSH_SIZES,
  LEFT_PANEL_TABS,
  INSPECTOR_TABS,
  SLOT_STATE_LABELS,
  LORA_TOUR_STORAGE_KEY,
  LORA_TOUR_STEP_COUNT,
  type LayoutPrefs,
  type PromptDraft,
  readLayoutPrefs,
  readPromptDraft,
  writePromptDraft,
  DEFAULT_SECTION_OPEN,
  type NoticeLevel,
  type CanvasNotice,
  useEventCallback,
  waitForSelector,
  CREATIVE_TEMPLATE_COUNT,
  qualityProfileOptions,
  adSizeOptionsForModel,
  failureHint,
} from "./workstation-constants";
import {
  type ProfessionalRunConfig,
  type InvokeInspiredWorkstationProps,
  DraggableReferenceTile,
  type SlotItemView,
  BoardsPanel,
} from "./workstation-subcomponents";
import { WorkstationTopbar } from "./panels/WorkstationTopbar";
import { InspectorPanel } from "./panels/InspectorPanel";
import { CanvasStage } from "./panels/CanvasStage";
import { LeftSettingsTab, WorkstationRunBar } from "./panels/LeftSettingsTab";
import { LeftPromptTab } from "./panels/LeftPromptTab";
import { usePanelResize } from "./use-panel-resize";
import { useCanvasAnnotation } from "./use-canvas-annotation";
import { useBoardsLibrary } from "./use-boards-library";
import { useWorkstationRecall } from "./workstation-recall";
import { useRecipeTemplates } from "./use-recipe-templates";
import { RecipeTemplateSaveDialog } from "./RecipeTemplateSaveDialog";
import { createWorkstationTours } from "./workstation-tours";
export { INVOKE_AI_WORKSTATION_SOURCE, WORKFLOW_PRESETS, REFERENCE_IMAGE_ROLES } from "./workstation-constants";
export type { ProfessionalRunConfig } from "./workstation-subcomponents";


export function InvokeInspiredWorkstation({
  referenceImages,
  onReferenceImagesChange,
  images,
  isLoading,
  recentWorkflows,
  tasks,
  onRun,
  modelId,
  onModelChange,
  onExitProfessionalMode,
  loraTourFromGuide,
  capabilityNotice,
  active = true,
  externalResultUrl,
  onTemplateResult,
}: InvokeInspiredWorkstationProps) {
  // 訂閱定價覆寫：管理員改價後本頁報價立即重算。
  usePricingRevision();
  const { user, isLoggedIn, logout, token } = useAuth();
  const draftRef = useRef<PromptDraft | null>(null);
  if (draftRef.current === null) draftRef.current = readPromptDraft();
  const initialDraft = draftRef.current;
  const layoutPrefsRef = useRef<LayoutPrefs | null>(null);
  if (layoutPrefsRef.current === null) layoutPrefsRef.current = readLayoutPrefs();
  const initialLayout = layoutPrefsRef.current;

  const [prompt, setPrompt] = useState(initialDraft.prompt ?? "");
  const [contextPrompt, setContextPrompt] = useState(initialDraft.contextPrompt ?? "");
  const [negativePrompt, setNegativePrompt] = useState(initialDraft.negativePrompt ?? "");
  const [workflowPreset, setWorkflowPreset] = useState(WORKFLOW_PRESETS[0].id);
  const [productionIntent, setProductionIntent] = useState("general");
  const [imageSizes, setImageSizes] = useState<string[]>(["1024x1024"]);
  const [qualityProfile, setQualityProfile] = useState("balanced");
  const [styleTemplateId, setStyleTemplateId] = useState<string | null>(null);
  const [styleCategory, setStyleCategory] = useState(STYLE_CATEGORIES[0]);
  const [scenarioId, setScenarioId] = useState<string | null>(null);
  const [templateUndo, setTemplateUndo] = useState<{ label: string; snapshot: TemplateStateSnapshot } | null>(null);
  const [brandKit, setBrandKit] = useState<BrandKit>(EMPTY_BRAND_KIT);
  const [brandKitMessage, setBrandKitMessage] = useState("");
  const [seedHint, setSeedHint] = useState("");
  const [copies, setCopies] = useState(2);
  const [concurrency, setConcurrency] = useState(2);
  const [durationSeconds, setDurationSeconds] = useState<number | undefined>(() => defaultDuration(modelId));
  const [generateAudio, setGenerateAudio] = useState(() => defaultGenerateAudio(modelId));
  const [selectedLora, setSelectedLora] = useState<SelectedLora | null>(null);
  const [loraPanelOpen, setLoraPanelOpen] = useState(false);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  /** 专业模式 LoRA 引导第 1 步自动展开的模型选择器（受控给 ModelPicker）。 */
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [regionalPrompts, setRegionalPrompts] = useState<RegionalPromptItem[]>([]);
  const [restoreConfigText, setRestoreConfigText] = useState("");
  const [restoreConfigMessage, setRestoreConfigMessage] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>("canvas");
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>("create");
  const [leftPanelTab, setLeftPanelTab] = useState<LeftPanelTab>(
    normalizeLeftPanelTab(initialLayout.leftTab) ?? "prompt",
  );
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(initialLayout.inspectorTab ?? "queue");
  const [activeCanvasTool, setActiveCanvasTool] = useState<CanvasTool>("select");
  /**
   * 中栏成片墙与右栏图库原本共用一个 galleryMode，动 A 处 B 处会无声跟着变
   * （在中栏切到「文件夹」，右栏图库也换了）。两处是不同的浏览上下文，各自独立。
   */
  const [viewerGalleryMode, setViewerGalleryMode] = useState<GalleryMode>("images");
  const [inspectorGalleryMode, setInspectorGalleryMode] = useState<GalleryMode>("images");
  /**
   * 手风琴开合状态提升为受控 state。
   *
   * 原本 open 写死在 JSX 上，而三个 tab 的内容区是条件渲染（卸载重挂），
   * 于是每次跨 tab 往返，用户展开的「更多要求」被强制收回、收起的「创作模板」
   * 被强制展开 —— 每次切 tab 都要重建一次工作环境。默认只开「画面描述」与
   * 「队列」，其余收起（原本默认展开的两个大手风琴合计 600px+，会把提示词
   * 顶出视窗）。
   */
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>(() => ({
    ...DEFAULT_SECTION_OPEN,
    ...(initialLayout.sections ?? {}),
  }));
  const toggleSection = useEventCallback((key: string, open: boolean) => {
    setSectionOpen((current) => (current[key] === open ? current : { ...current, [key]: open }));
  });
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [dismissedStaleResultKey, setDismissedStaleResultKey] = useState<string | null>(null);
  const loraTourRef = useRef<Driver | null>(null);
  const loraGridWaitingRef = useRef(false);
  const loraTourAdvancingRef = useRef(false);
  const prevSelectedLoraRef = useRef<SelectedLora | null>(null);

  const isVideoModel = generationModel(modelId)?.kind === "video";
  const isPixaiModel = modelId.startsWith("pixai-");
  const isPixaiModelRef = useRef(isPixaiModel);
  isPixaiModelRef.current = isPixaiModel;
  const videoResolutions = generationModel(modelId)?.resolutions ?? ["1k"];
  const currentVideoResolution = (videoResolutions.includes(defaultOutputResolution(modelId)) ? defaultOutputResolution(modelId) : videoResolutions[0]) as OutputResolution;

  const advanceLoraTourFromModelSelection = useEventCallback(async (tour: Driver) => {
    if (loraTourAdvancingRef.current || tour.getActiveIndex() !== 0) return;
    loraTourAdvancingRef.current = true;
    setModelMenuOpen(false);
    setLoraPanelOpen(true);
    setLeftPanelTab("settings");
    if (window.matchMedia("(max-width: 1023px)").matches) setMobilePanel("settings");
    try {
      await waitForSelector("#pro-tour-lora", 2500);
      if (loraTourRef.current !== tour || tour.getActiveIndex() !== 0) return;
      document.querySelector("#pro-tour-lora")?.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 120));
      if (loraTourRef.current !== tour || tour.getActiveIndex() !== 0) return;
      tour.moveNext();
      requestAnimationFrame(() => tour.refresh());
    } finally {
      loraTourAdvancingRef.current = false;
    }
  });

  /**
   * 换模型时重置影片参数与 LoRA。
   *
   * 旧版这里静默 `setSelectedLora(null)`，只有另一条 effect 会发通知，
   * 于是「挑好 LoRA → 换模型试试 → LoRA 没了且没人告诉我」。现在：
   * 新模型同样支持 LoRA 就保留选择；确实要清才发 warn 级通知。
   */
  useEffect(() => {
    setDurationSeconds(defaultDuration(modelId));
    setGenerateAudio(defaultGenerateAudio(modelId));
  }, [modelId]);

  /** 提示词草稿：切模式 / 刷新 / 误关页面都不该丢。debounce 400ms 落盘。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      writePromptDraft({ prompt, contextPrompt, negativePrompt });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [prompt, contextPrompt, negativePrompt]);

  /**
   * 有未提交的提示词时拦一次离开确认。只在专业模式可见时生效 ——
   * 否则普通模式用户会因为一份自己看不到的旧草稿被莫名拦住。
   */
  useEffect(() => {
    if (!active || !prompt.trim()) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active, prompt]);

  /**
   * 版位与质量档位都由模型能力表派生，不再硬编码。
   *
   * 旧版专业模式只给 3 个版位、3 个质量档（其中「草稿」「标准」参数完全一致，
   * 且都标着假的「2 币/张」）。支持 14 种比例的模型在这里反而比普通模式能选的更少。
   */
  const sizeOptions = useMemo(() => adSizeOptionsForModel(modelId), [modelId]);
  const qualityOptions = useMemo(() => qualityProfileOptions(modelId), [modelId]);

  /** 模型不支持当前尺寸选择时收敛到它支持的版位，并说明原因。 */
  useEffect(() => {
    if (isVideoModel) return;
    const allowed = new Set(sizeOptions.map((option) => option.id));
    const kept = imageSizes.filter((id) => allowed.has(id));
    if (kept.length === imageSizes.length) return;
    setImageSizes(kept.length ? kept : [sizeOptions[0]?.id ?? "1024x1024"]);
    setCanvasNotice("已调整版位：所选模型不支持原来的画幅。", "warn");
    // setCanvasNotice 引用稳定（useEventCallback），不进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, isVideoModel, sizeOptions]);

  /** 质量档位收敛：PixAI 全系只有 1K，「高清」在这些模型下不存在。 */
  useEffect(() => {
    if (qualityOptions.some((option) => option.id === qualityProfile)) return;
    setQualityProfile(qualityOptions[0]?.id ?? "balanced");
    setCanvasNotice("已切到标准画质：所选模型只支持 1K。", "warn");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, qualityProfile, qualityOptions]);

  useEffect(() => {
    if (!loraTourFromGuide) return;
    setLoraPanelOpen(true);
    setLeftPanelTab("settings");
    // 手机版：底部导航也要切到「参数」面板，左面板才可见
    if (window.matchMedia("(max-width: 1023px)").matches) {
      setMobilePanel("settings");
    }
    const timer = window.setTimeout(() => {
      if (window.localStorage.getItem(LORA_TOUR_STORAGE_KEY)) return;
      void startLoraTour();
    }, 600);
    return () => window.clearTimeout(timer);
  // startLoraTour 在下方由工廠建立，故此 effect 只依賴引導旗標；函式本身為穩定用途。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loraTourFromGuide]);

  useEffect(() => {
    if (!isPixaiModel) return;
    setModelMenuOpen(false);
    const tour = loraTourRef.current;
    // 只在引导第 1 步（选 PixAI 模型）时自动推进；其它步骤的模型切换不干扰
    if (!tour || tour.getActiveIndex() !== 0) return;
    void advanceLoraTourFromModelSelection(tour);
  }, [isPixaiModel, advanceLoraTourFromModelSelection]);

  /** 引导第 1 步期间下拉菜单不允许被收起（点外面/选中模型前），选中 PixAI 后放行。 */
  const handleModelMenuOpenChange = (open: boolean) => {
    if (open) {
      setModelMenuOpen(true);
      return;
    }
    const tour = loraTourRef.current;
    const duringStep1 = !!tour && tour.getActiveIndex() === 0 && !isPixaiModelRef.current;
    if (duringStep1) return;
    setModelMenuOpen(false);
  };

  /**
   * 换模型前先问，而不是换完再通知「已移除」。
   *
   * 旧版路径是：用户换模型 → effect 发现新模型不支持 LoRA / 参考图 → 直接清掉 ——
   * 挑了十分钟的 LoRA、传了三张参考图，在一次好奇的模型切换里全部消失，
   * 事后那条「已移除 LoRA」的提示 4.5 秒就自己走了，也没有任何撤销入口。
   */
  const handleWorkstationModelChange = useEventCallback((nextModelId: string) => {
    if (nextModelId !== modelId) {
      const nextCaps = generationCapabilities(nextModelId);
      const losing: string[] = [];
      if (selectedLora && !nextCaps?.lora) losing.push("已选的 LoRA");
      if (referenceImages.length > 0 && !nextCaps?.referenceImages) {
        losing.push(`${referenceImages.length} 张参考图`);
      }
      if (losing.length > 0) {
        const label = modelBaseName(nextModelId);
        if (!window.confirm(`切到 ${label} 会清掉${losing.join("、")}（该模型不支持）。确定切换？`)) {
          setCanvasNotice("已取消切换，配置保持不变。");
          return;
        }
      }
    }
    onModelChange(nextModelId);
    const tour = loraTourRef.current;
    if (nextModelId.startsWith("pixai-") && tour?.getActiveIndex() === 0) {
      void advanceLoraTourFromModelSelection(tour);
    }
  });

  useEffect(() => {
    const tour = loraTourRef.current;
    const prev = prevSelectedLoraRef.current;
    prevSelectedLoraRef.current = selectedLora;
    // 用户真正点选了一张 LoRA 卡（从无到有）→ 最后一步引导自动完成
    if (!tour || !selectedLora || prev) return;
    if (tour.getActiveIndex() !== LORA_TOUR_STEP_COUNT - 1) return;
    tour.moveNext();
  }, [selectedLora]);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [canvasZoom, setCanvasZoom] = useState<"fit" | "actual">("fit");
  const [notice, setNotice] = useState<CanvasNotice | null>(null);
  /** 本批次开始时间与秒级时钟，用来算已耗时和预计剩余。 */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runClock, setRunClock] = useState(() => Date.now());
  const noticeSeqRef = useRef(0);

  /**
   * 同名包装：25 个既有调用点无需改签名，但现在带分级且会自动清除。
   * info/warn 4.5 秒后自己消失，error 保留到用户处理（有关闭钮）。
   */
  const setCanvasNotice = useEventCallback((text: string, level: NoticeLevel = "info") => {
    noticeSeqRef.current += 1;
    setNotice(text ? { text, level, seq: noticeSeqRef.current } : null);
  });

  useEffect(() => {
    if (!notice || notice.level === "error") return;
    const timer = window.setTimeout(() => {
      setNotice((current) => (current?.seq === notice.seq ? null : current));
    }, 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const studioBodyRef = useRef<HTMLDivElement>(null);
  const tourRef = useRef<Driver | null>(null);
  const manualResultSelectionRef = useRef(false);
  const lastAutoSelectedTaskRef = useRef<string | null>(null);
  const lastMobileTaskStageRef = useRef<WorkstationTaskStage>("prepare");

  // 面板缩放引擎：分栏宽度 + 拖拽 + 键盘调栏 + 佈局落盘（2026-08-22 拆出 use-panel-resize）。
  const {
    panelWidths,
    resizingSide,
    startPanelResize,
    handlePanelResize,
    endPanelResize,
    nudgePanel,
    resetPanel,
    handleResizeKeyDown,
  } = usePanelResize({
    initialLayout,
    leftPanelTab,
    inspectorTab,
    sectionOpen,
    inspectorExpanded,
    setInspectorExpanded,
    setCanvasNotice,
    studioBodyRef,
  });

  const activePreset = WORKFLOW_PRESETS.find((preset) => preset.id === workflowPreset) ?? WORKFLOW_PRESETS[0];
  const allResults = useMemo(() => {
    const current = [...images];
    const known = new Set(current.map((image) => image.resultId ?? image.slotId).filter(Boolean));
    for (const task of tasks) {
      for (const result of task.results) {
        if (known.has(result.resultId)) continue;
        current.push({
          provider: "image_tinchak",
          slotId: `${task.taskId}:${result.resultId}`,
          image: null,
          imageUrl: task.kind === "video_generate" ? null : result.url,
          videoUrl: task.kind === "video_generate" ? result.url : null,
          mediaType: task.kind === "video_generate" ? "video" : "image",
          modelId: task.modelId,
          workflow: task.submittedConfig.workflow,
          taskId: task.taskId,
          resultId: result.resultId,
        });
        known.add(result.resultId);
      }
    }
    if (externalResultUrl) {
      const slotId = `pixai-external:${externalResultUrl}`;
      if (!known.has(slotId)) {
        current.push({
          provider: "image_tinchak",
          slotId,
          image: null,
          imageUrl: externalResultUrl,
          videoUrl: null,
          mediaType: "image",
          modelId: "pixai",
          resultId: slotId,
        });
      }
    }
    return current;
  }, [images, tasks, externalResultUrl]);
  const completedSlots = tasks.length
    ? tasks.filter((task) => task.status === "succeeded").length
    : images.filter((image) => image.image || image.imageUrl || image.videoUrl).length;
  const failedSlots = tasks.length
    ? tasks.filter((task) => ["failed", "cancelled", "refunded", "unknown"].includes(task.status)).length
    : images.filter((image) => !isLoading && image.image === null && image.imageUrl === null && !image.videoUrl).length;
  const runningSlots = tasks.length
    ? tasks.filter((task) => task.status === "running" || task.status === "queued").length
    : isLoading ? Math.max(0, copies - completedSlots - failedSlots) : 0;
  /**
   * 可看的成片（有 image / imageUrl / videoUrl 的那些），是「上一张 / 下一张」、
   * 计数器 n/N、灯箱翻页共用的唯一列表。
   *
   * 旧版只有 `selectedResult ?? 第一张` 这一条兜底：selectedSlotId 指向一张已经被
   * 新一批结果挤掉的图时，画布悄悄显示第一张，而图库里没有任何卡片是高亮的 ——
   * 用户以为自己选中的还是刚才那张，实际在对着另一张图做标注。
   */
  const viewableResults = useMemo(
    () => allResults.filter((image) => image.image || image.imageUrl || image.videoUrl),
    [allResults],
  );
  const resultKey = (image: ImageResult) => image.resultId ?? image.slotId ?? "";
  const selectedResultIndex = viewableResults.findIndex((image) => resultKey(image) === selectedSlotId);
  const selectedResult = selectedResultIndex >= 0 ? viewableResults[selectedResultIndex] : undefined;
  const visibleResult = selectedResult ?? viewableResults[0];
  const visibleResultIndex = selectedResultIndex >= 0 ? selectedResultIndex : viewableResults.length ? 0 : -1;
  /**
   * 生成进度与预计剩余时间。
   *
   * 旧版整个生成过程只有一个「正在生成」文字和转圈：一批 8 张要跑两三分钟，
   * 用户完全不知道跑到第几张、还要等多久，只能反复切到队列数格子。
   * 这里按「已完成 + 失败」占总数的比例算进度，用实测均耗时外推剩余时间。
   */
  const runTotal = tasks.length || copies;
  const runSettled = completedSlots + failedSlots;
  const runProgress = runTotal > 0 ? Math.min(1, runSettled / runTotal) : 0;
  const runElapsedMs = runStartedAt ? runClock - runStartedAt : 0;
  const runEtaSeconds =
    runSettled > 0 && runSettled < runTotal && runElapsedMs > 0
      ? Math.max(1, Math.round((runElapsedMs / runSettled) * (runTotal - runSettled) / 1000))
      : null;
  const runEtaLabel = runEtaSeconds === null
    ? null
    : runEtaSeconds >= 60
      ? `约 ${Math.ceil(runEtaSeconds / 60)} 分钟`
      : `约 ${runEtaSeconds} 秒`;

  /** 秒级心跳只在生成期间存在：跑完立刻停掉，不留常驻 interval。 */
  useEffect(() => {
    if (!isLoading && runningSlots === 0) return;
    setRunClock(Date.now());
    const timer = window.setInterval(() => setRunClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLoading, runningSlots]);

  /** 整批落地后清掉计时起点，下一批重新计。 */
  useEffect(() => {
    if (isLoading || runningSlots > 0) return;
    if (runStartedAt === null) return;
    setRunStartedAt(null);
  }, [isLoading, runningSlots, runStartedAt]);

  const stageTask = activeTaskId ? tasks.find((task) => task.taskId === activeTaskId) ?? tasks[0] : tasks[0];
  const mobileTaskStage = workstationTaskStage({
    status: stageTask?.status,
    submitting: isLoading,
    hasResult: Boolean(stageTask?.results.length || visibleResult),
  });
  const promptStats = {
    chars: prompt.trim().length,
    estimatedTokens: Math.ceil(prompt.trim().length / 4),
    state: prompt.trim().length > 1200 ? "偏长" : prompt.trim().length > 600 ? "适中" : "精简",
  };
  const activeWorkspace = WORKSPACE_MODES.find((mode) => mode.id === workspaceMode) ?? WORKSPACE_MODES[0];
  const imageSize = imageSizes[0] ?? "1024x1024";
  const imageSizeLabel = imageSizes
    .map((id) => AD_SIZE_OPTIONS.find((option) => option.id === id)?.label ?? id)
    .join(" + ");
  /**
   * 单价与总价的唯一来源。
   *
   * 「数量」折叠面板里原本自己算一遍、底部没有任何地方显示总价，用户要点开第三个
   * tab 的第三个手风琴才知道这次要花多少币。现在算一次，运行条与面板共用。
   */
  const coinsPerRun = isVideoModel
    ? generationCoins(modelId, {
      resolution: currentVideoResolution,
      durationSeconds: durationSeconds ?? defaultDuration(modelId),
      generateAudio,
    })
    : imageGenerationCoins(modelId, qualityProfile === "print" ? "quality" : "fast");
  const totalCoins = Math.round(coinsPerRun * copies * 10) / 10;
  const runUnit = isVideoModel ? "条" : "张";
  const activeStyle = getStyleById(styleTemplateId);
  const activeLeftTab = LEFT_PANEL_TABS.find((tab) => tab.id === leftPanelTab) ?? LEFT_PANEL_TABS[0];
  const activeInspectorTab = INSPECTOR_TABS.find((tab) => tab.id === inspectorTab) ?? INSPECTOR_TABS[0];
  const localSlotItems = useMemo<SlotItemView[]>(() => Array.from({ length: copies }, (_, index) => {
    const image = images[index];
    // videoUrl 也算出片。旧版只看 image / imageUrl：影片模型跑成功后这里判定成
    // failed，队列显示「失败」、失败计数 +1，而画布上影片正在正常播放。
    const hasResult = !!(image?.image || image?.imageUrl || image?.videoUrl);
    const isFailed = !!image && !isLoading && !hasResult;
    const state: SlotState = hasResult
      ? "done"
      : isFailed
        ? "failed"
        : isLoading && index < Math.min(copies, completedSlots + failedSlots + concurrency)
          ? "running"
          : !image && !isLoading
            ? "idle"
            : "queued";
    const slotSize = image?.workflow?.imageSize ?? sizeForSlot(imageSizes, index);
    const sizeTag = imageSizes.length > 1
      ? `${(AD_SIZE_OPTIONS.find((option) => option.id === slotSize)?.label ?? slotSize).split(" ")[0]} · `
      : "";
    return {
      id: image?.slotId ?? `slot-${index + 1}`,
      // 本地槽位同样带上 resultId，让「点队列 → 画布定位」在任务流未接管时也能命中。
      resultId: image?.resultId ?? image?.slotId,
      label: `任务 ${index + 1}`,
      state,
      detail: state === "idle"
        ? `${sizeTag}等待开始`
        : `${sizeTag}${formatPublicGenerationSummary(image ?? { modelId })}`,
    };
  }), [copies, images, isLoading, concurrency, imageSizes, completedSlots, failedSlots, modelId]);
  const taskSlotItems = useMemo<SlotItemView[]>(() => tasks.slice(0, 30).map((task, index) => {
    const state: SlotState = task.status === "succeeded"
      ? "done"
      : task.status === "running"
        ? "running"
        : task.status === "queued"
          ? "queued"
          : ["failed", "cancelled", "refunded", "unknown"].includes(task.status)
            ? "failed"
            : "idle";
    const stamp = new Date(task.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    return {
      id: task.taskId,
      taskId: task.taskId,
      resultId: task.primaryResultId,
      label: task.prompt?.trim().slice(0, 24) || `任务 ${index + 1}`,
      state,
      // 失败行显示可执行的原因，而不是「模型名 · 时间」——旧版失败与成功的副标题一模一样。
      detail: state === "failed" ? failureHint(task) : `${task.modelId} · ${stamp}`,
    };
  }), [tasks]);
  const slotItems = taskSlotItems.length ? taskSlotItems : localSlotItems;
  /**
   * 按 id 查槽位状态，不再按数组下标。
   *
   * 图库卡片原本写 SLOT_STATE_LABELS[slotItems[index]?.state]：index 是图库里的位置，
   * 而 slotItems 来自 tasks（按 createdAt 倒序）或本地槽位（按提交顺序）—— 两个数组
   * 顺序不同、长度也不同，于是第 3 张成片可能显示第 3 个任务的「失败」。
   */
  const slotStateById = useMemo(() => {
    const map = new Map<string, SlotState>();
    for (const slot of slotItems) {
      if (slot.resultId) map.set(slot.resultId, slot.state);
      if (slot.taskId) map.set(slot.taskId, slot.state);
      map.set(slot.id, slot.state);
    }
    return map;
  }, [slotItems]);
  const slotStateFor = (image: ImageResult): SlotState => {
    for (const key of [image.resultId, image.taskId, image.slotId]) {
      const state = key ? slotStateById.get(key) : undefined;
      if (state) return state;
    }
    return "queued";
  };
  const failedSlotCount = slotItems.filter((slot) => slot.state === "failed").length;
  const firstFailedTask = tasks.find((task) => ["failed", "cancelled", "refunded", "unknown"].includes(task.status));

  useEffect(() => {
    if (lastMobileTaskStageRef.current === mobileTaskStage) return;
    lastMobileTaskStageRef.current = mobileTaskStage;
    const nextPanel = mobilePanelForTaskStage(mobileTaskStage);
    setMobilePanel(nextPanel);
    if (nextPanel === "output") {
      setInspectorExpanded(true);
      setInspectorTab("queue");
    }
    if (nextPanel === "canvas") setWorkspaceMode("canvas");
  }, [mobileTaskStage]);

  useEffect(() => {
    const newestSucceeded = tasks.find((task) => task.status === "succeeded" && task.primaryResultId);
    if (!newestSucceeded || manualResultSelectionRef.current) return;
    if (lastAutoSelectedTaskRef.current === newestSucceeded.taskId) return;
    lastAutoSelectedTaskRef.current = newestSucceeded.taskId;
    setActiveTaskId(newestSucceeded.taskId);
    setSelectedSlotId(newestSucceeded.primaryResultId ?? null);
    setWorkspaceMode("canvas");
  }, [tasks]);

  /**
   * selectedSlotId 指向的成片已经不在列表里时，把它归位到真正显示的那张。
   *
   * 画布本身有 `selectedResult ?? 第一张` 的兜底，所以看起来没事；但 selectedSlotId
   * 仍是那个失效 id，于是图库高亮、provenance 卡片高亮、data-active-result-id 全都
   * 落空，而依赖 selectedSlotId 的缩放复位也不会触发 —— 用户对着第一张图，
   * 界面各处却认为选中的是另一张已经不存在的图。
   */
  useEffect(() => {
    if (selectedSlotId === null) return;
    // 这里不调用 resultKey：它每次渲染都是新函数，进依赖数组会让本效应每帧都跑。
    if (viewableResults.some((image) => (image.resultId ?? image.slotId ?? "") === selectedSlotId)) return;
    const fallback = viewableResults[0];
    setSelectedSlotId(fallback ? (fallback.resultId ?? fallback.slotId ?? null) : null);
  }, [selectedSlotId, viewableResults]);

  useEffect(() => {
    if (generationCapabilities(modelId)?.lora || !selectedLora) return;
    setSelectedLora(null);
    setCanvasNotice("已移除 LoRA：所选模型不支持 LoRA。");
  }, [modelId, selectedLora, setCanvasNotice]);

  const canRun = prompt.trim().length > 0 && !isLoading;
  const appendUniqueText = (current: string, next: string) => {
    const currentText = current.trim();
    if (!next.trim()) return current;
    if (currentText.includes(next.trim())) return current;
    return currentText ? `${currentText}\n${next.trim()}` : next.trim();
  };

  const activeRegionalPrompts = regionalPrompts.filter((item) => item.enabled && item.text.trim());

  const buildRunConfig = (requestedCopies = copies): ProfessionalRunConfig => {
    const brandContext = buildBrandContext(brandKit);
    return {
      prompt: applyStyleToPrompt(activeStyle, prompt.trim()),
      contextPrompt: brandContext ? appendUniqueText(contextPrompt, brandContext) : contextPrompt,
      negativePrompt: mergeStyleNegative(activeStyle, negativePrompt),
      negativeHint: activePreset.negativeHint,
      workflowPreset,
      workflowPresetLabel: activePreset.label,
      promptHint: activePreset.promptHint,
      productionIntent,
      imageSize,
      imageSizes,
      ...(styleTemplateId ? { styleTemplate: styleTemplateId } : {}),
      qualityProfile,
      seedHint,
      regionalPrompts: activeRegionalPrompts.map((item) => ({ text: item.text.trim() })),
      estimatedCredits: Math.max(requestedCopies, activePreset.estimatedCredits),
      referenceImageRoles: Object.fromEntries(
        referenceImages.map((image) => [image.id, image.role ?? "general"]),
      ) as Record<string, ReferenceImageRole>,
      copies: requestedCopies,
      concurrency,
      ...(isVideoModel
        ? { durationSeconds: durationSeconds ?? defaultDuration(modelId), generateAudio: defaultGenerateAudio(modelId) || generateAudio }
        : {}),
      ...(selectedLora ? { loraModelVersionIds: [selectedLora.versionId] } : {}),
    };
  };

  const run = (requestedCopies = copies) => {
    if (!canRun) return;
    manualResultSelectionRef.current = false;
    lastAutoSelectedTaskRef.current = null;
    setActiveTaskId(null);
    setRunStartedAt(Date.now());
    setRunClock(Date.now());
    // 生成不再吞掉「撤销套用」：套用场景 → 生成 → 觉得不如原来的，
    // 旧版此处 setTemplateUndo(null) 让退路在最需要的时刻刚好消失。
    setInspectorTab("queue");
    setLoraPanelOpen(false);
    setInspectorExpanded(true);
    setMobilePanel("output");
    onRun(buildRunConfig(requestedCopies));
  };

  /**
   * 主按钮永远可点，点不动时说明原因。
   *
   * 旧版是 disabled={!canRun}：提示词为空时按钮变灰、点击完全没有反应，也没有任何
   * 文字说明缺什么 —— 新用户唯一的线索是 title 属性，而触屏根本没有 hover。
   * 现在保持可点：缺提示词就把焦点送回输入框并说清楚，正在生成就提示排队中。
   */
  const handleRunClick = useEventCallback(() => {
    if (isLoading) {
      setCanvasNotice("上一批还在生成，完成后会自动出图。", "info");
      return;
    }
    if (!prompt.trim()) {
      setCanvasNotice("先写一句画面描述，再点生成。", "warn");
      setLeftPanelTab("prompt");
      setMobilePanel("create");
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>("#pro-prompt-input");
        input?.scrollIntoView({ block: "center", behavior: "smooth" });
        input?.focus();
      });
      return;
    }
    run();
  });

  const retryTask = (task: GenerationTaskProjection) => {
    const workflow = task.submittedConfig.workflow ?? {};
    manualResultSelectionRef.current = false;
    lastAutoSelectedTaskRef.current = null;
    setRunStartedAt(Date.now());
    setRunClock(Date.now());
    // 重试整份用旧任务的配置提交，因此不再改写编辑器里的提示词 ——
    // 旧版 setPrompt(task.prompt) 会把用户重试期间正在写的下一稿直接覆盖掉。
    if (task.modelId !== modelId) {
      onModelChange(task.modelId);
      setCanvasNotice(`已切回 ${task.modelId} 重试这条任务。`, "warn");
    }
    setInspectorTab("queue");
    setInspectorExpanded(true);
    setMobilePanel("output");
    onRun({
      prompt: task.prompt ?? "",
      contextPrompt: workflow.contextPrompt ?? "",
      negativePrompt: workflow.negativePrompt ?? "",
      negativeHint: workflow.negativeHint ?? "",
      workflowPreset: workflow.workflowPreset ?? WORKFLOW_PRESETS[0].id,
      workflowPresetLabel: workflow.workflowPresetLabel ?? WORKFLOW_PRESETS[0].label,
      promptHint: workflow.promptHint ?? WORKFLOW_PRESETS[0].promptHint,
      productionIntent: workflow.productionIntent ?? "general",
      imageSize: workflow.imageSize ?? imageSizeForAspectRatio(task.submittedConfig.aspectRatio),
      imageSizes: workflow.imageSizes?.length ? workflow.imageSizes : [workflow.imageSize ?? imageSizeForAspectRatio(task.submittedConfig.aspectRatio)],
      styleTemplate: workflow.styleTemplate,
      qualityProfile: workflow.qualityProfile ?? task.submittedConfig.qualityMode,
      seedHint: workflow.seedHint ?? "",
      regionalPrompts: workflow.regionalPrompts ?? [],
      estimatedCredits: workflow.estimatedCredits ?? 1,
      // 旧版硬写 {} 与 1：带参考图的任务重试后参考图角色全部退化成 general，
      // 多张任务重试只出 1 张，用户以为「重试」等于原样再跑一次，结果得到另一个东西。
      referenceImageRoles: Object.fromEntries(
        (workflow.referenceImages ?? []).map((image) => [image.name, image.role]),
      ) as Record<string, ReferenceImageRole>,
      copies: Math.max(1, workflow.copies ?? 1),
      concurrency: Math.max(1, workflow.concurrency ?? 1),
      durationSeconds: task.submittedConfig.durationSeconds,
      generateAudio: task.submittedConfig.generateAudio,
      loraModelVersionIds: task.submittedConfig.loraModelVersionIds,
      retryOfTaskId: task.taskId,
    });
  };

  const updateReferenceRole = useEventCallback((id: string, role: ReferenceImageRole) => {
    onReferenceImagesChange(referenceImages.map((image) => image.id === id ? { ...image, role } : image));
  });

  const updateReferenceStrength = useEventCallback((id: string, strength: number) => {
    onReferenceImagesChange(referenceImages.map((image) => image.id === id ? { ...image, strength } : image));
  });

  const captureTemplateState = (): TemplateStateSnapshot => ({
    modelId,
    prompt,
    contextPrompt,
    negativePrompt,
    workflowPreset,
    productionIntent,
    imageSizes: [...imageSizes],
    qualityProfile,
    copies,
    styleTemplateId,
    styleCategory,
    scenarioId,
  });

  const applyScenario = useEventCallback((scenario: ScenarioTemplate) => {
    setTemplateUndo({ label: scenario.name, snapshot: captureTemplateState() });
    setScenarioId(scenario.id);
    setContextPrompt(scenario.contextPrompt);
    setNegativePrompt(scenario.negativePrompt);
    setWorkflowPreset(scenario.workflowPreset);
    setProductionIntent(scenario.productionIntent);
    setQualityProfile(scenario.qualityProfile);
    setImageSizes(normalizeSizeSelection(scenario.sizes));
    setCopies(Math.max(1, Math.min(8, scenario.copies)));
    const style = getStyleById(scenario.styleId);
    if (style) {
      setStyleTemplateId(style.id);
      setStyleCategory(style.category);
    } else {
      setStyleTemplateId(null);
    }
    setLeftPanelTab("prompt");
    setCanvasNotice(`已套用「${scenario.name}」。补充画面描述后即可生成。`);
  });

  const applyCreatorResource = useEventCallback((resource: CreatorResource) => {
    setTemplateUndo({ label: resource.title, snapshot: captureTemplateState() });
    onModelChange(resource.modelId);
    setPrompt(resource.prompt);
    setContextPrompt("");
    setNegativePrompt(resource.negativePrompt);
    setWorkflowPreset(resource.workflowPreset);
    setImageSizes(normalizeSizeSelection([resource.imageSize]));
    setCopies(resource.copies);
    setScenarioId(null);
    setStyleTemplateId(null);
    setLeftPanelTab("prompt");
    setMobilePanel("create");
    setCanvasNotice(resource.needsReference
      ? `已套用「${resource.title}」。请在提示词下方添加参考图后生成。`
      : `已套用「${resource.title}」。替换花括号中的内容即可生成。`);
  });

  /** 鲲鹏风格（161 条）：把 promptSuffix + visualDNA + cameraLanguage 追加到画面描述末尾。 */
  const applyKunpengStyle = useEventCallback((style: KunpengStyleAsset) => {
    setTemplateUndo({ label: style.name, snapshot: captureTemplateState() });
    const styleBlock = buildKunpengStylePrompt(style);
    setPrompt((current) => (current.trim() ? `${current.trim()}\n\n${styleBlock}` : styleBlock));
    setScenarioId(null);
    setLeftPanelTab("prompt");
    setMobilePanel("create");
    setCanvasNotice(`已套用风格「${style.name}」。风格块已追加到画面描述末尾。`);
  });

  /** 鲲鹏提示词模板：注入模板骨架（正文逐字），用户替换花括号占位即可。 */
  const applyKunpengPromptTemplate = useEventCallback((template: KunpengPromptTemplate) => {
    setTemplateUndo({ label: template.title, snapshot: captureTemplateState() });
    setPrompt((current) => (current.trim() ? `${current.trim()}\n\n${template.body}` : template.body));
    setLeftPanelTab("prompt");
    setMobilePanel("create");
    setCanvasNotice(`已注入模板「${template.title}」。替换花括号中的占位内容即可。`);
  });

  const undoTemplateApply = useEventCallback(() => {
    if (!templateUndo) return;
    const { label, snapshot } = templateUndo;
    onModelChange(snapshot.modelId);
    setPrompt(snapshot.prompt);
    setContextPrompt(snapshot.contextPrompt);
    setNegativePrompt(snapshot.negativePrompt);
    setWorkflowPreset(snapshot.workflowPreset);
    setProductionIntent(snapshot.productionIntent);
    setImageSizes(snapshot.imageSizes);
    setQualityProfile(snapshot.qualityProfile);
    setCopies(snapshot.copies);
    setStyleTemplateId(snapshot.styleTemplateId);
    setStyleCategory(snapshot.styleCategory);
    setScenarioId(snapshot.scenarioId);
    setTemplateUndo(null);
    setCanvasNotice(`已撤销「${label}」。`);
  });

  const handleToggleStyle = useCallback((id: string) => {
    setStyleTemplateId((current) => current === id ? null : id);
  }, []);

  const toggleImageSize = (sizeId: string) => {
    setImageSizes((current) => normalizeSizeSelection(
      current.includes(sizeId) ? current.filter((item) => item !== sizeId) : [...current, sizeId],
    ));
  };

  const handleSaveBrandKit = () => {
    saveBrandKit(brandKit);
    setBrandKitMessage(hasBrandKit(brandKit) ? "品牌信息已保存。" : "品牌信息为空。");
  };

  const handleClearBrandKit = () => {
    clearBrandKit();
    setBrandKit(EMPTY_BRAND_KIT);
    setBrandKitMessage("已清空品牌信息。");
  };

  const addRegionalPrompt = (initialText = "") => {
    setLeftPanelTab("prompt");
    setRegionalPrompts((items) => [
      { id: `region-${Date.now()}`, text: initialText, enabled: true },
      ...items,
    ]);
  };

  const updateRegionalPrompt = (id: string, patch: Partial<RegionalPromptItem>) => {
    setRegionalPrompts((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item));
  };

  const removeRegionalPrompt = (id: string) => {
    setRegionalPrompts((items) => items.filter((item) => item.id !== id));
  };

  const openResultOnCanvas = (image: ImageResult) => {
    if (!image.image && !image.imageUrl && !image.videoUrl) return;
    manualResultSelectionRef.current = true;
    setSelectedSlotId(image.resultId ?? image.slotId ?? null);
    setActiveTaskId(image.taskId ?? null);
    setWorkspaceMode("canvas");
    setCanvasNotice("");
  };

  /**
   * 在成片之间前后翻页。
   *
   * 旧版只能靠鼠标点缩略图：没有键盘、没有按钮，8 张一批要来回点 8 次。
   * 这里用 viewableResults 的下标环形移动，与画布右下的 n/N 计数同一个来源。
   */
  const stepResult = useEventCallback((delta: number) => {
    if (viewableResults.length === 0) {
      setCanvasNotice("还没有成片可以翻页。");
      return;
    }
    const base = visibleResultIndex >= 0 ? visibleResultIndex : 0;
    const next = (base + delta + viewableResults.length) % viewableResults.length;
    openResultOnCanvas(viewableResults[next]);
  });

  const openTaskSlot = (slot: SlotItemView) => {
    if (!slot.taskId) return;
    setActiveTaskId(slot.taskId);
    const result = slot.resultId
      ? allResults.find((image) => image.resultId === slot.resultId)
      : allResults.find((image) => image.taskId === slot.taskId);
    if (result) {
      openResultOnCanvas(result);
      return;
    }
    setInspectorTab("queue");
    setCanvasNotice(slot.state === "failed" ? "任务失败，可保留原记录后重新生成。" : "任务仍在服务器处理，可安全刷新页面。");
  };

  /** 只重试这一行对应的任务，用它自己当时提交的配置。 */
  const retrySlot = useEventCallback((slot: SlotItemView) => {
    const task = tasks.find((item) => item.taskId === slot.taskId);
    if (!task) {
      setCanvasNotice("这条记录已经不在队列里，请重新生成。", "warn");
      return;
    }
    retryTask(task);
  });

  const appendReferenceImage = async (
    file: File,
    role: ReferenceImageRole,
    strength?: number,
    source?: { resultId?: string; taskId?: string },
    replaceOldest = false,
  ) => {
    const base = replaceOldest ? referenceImages.slice(1) : referenceImages;
    const previewUrl = URL.createObjectURL(file);
    // 量完自然尺寸再入列（blob URL 解碼是毫秒級）；失敗不阻塞入列。
    const naturalSize = await measureNaturalSize(previewUrl);
    onReferenceImagesChange([
      ...base,
      {
        id: `result-${Date.now()}`,
        name: file.name,
        file,
        previewUrl,
        size: file.size,
        role,
        ...(strength !== undefined ? { strength } : {}),
        ...(source?.resultId ? { sourceResultId: source.resultId } : {}),
        ...(source?.taskId ? { sourceGenerationId: source.taskId } : {}),
        ...(naturalSize ?? {}),
      },
    ]);
  };

  const resultToBlob = async (image: ImageResult): Promise<Blob> => {
    if (image.image) {
      const binary = atob(image.image);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return new Blob([bytes], { type: "image/png" });
    }
    const response = await fetch(image.imageUrl as string);
    if (!response.ok) throw new Error(`status ${response.status}`);
    return response.blob();
  };

  /**
   * 「这张图当时用的提示词」。
   *
   * workflow 元数据里存了除提示词以外的一切；提示词挂在产出它的 task 上。
   * 找不到 task 的只能是本轮本地结果，此时编辑器内容才等于它的提示词。
   */
  const promptForResult = (image: ImageResult): string | undefined => {
    const fromTask = tasks.find((task) => task.taskId === image.taskId)?.prompt?.trim();
    if (fromTask) return fromTask;
    return image.taskId ? undefined : prompt.trim() || undefined;
  };

  // ── 配置召回（2026-08-22 拆出 workstation-recall）────────────────────────

  const {
    buildProvenanceConfig,
    copyProvenanceConfig,
    restoreProvenanceConfig,
    restoreProvenanceConfigFromPng,
    restoreHistoryEntry,
    applyResultRecipe,
    applyRecipeTemplate,
  } = useWorkstationRecall({
    modelId,
    prompt,
    contextPrompt,
    negativePrompt,
    workflowPreset,
    productionIntent,
    imageSize,
    imageSizes,
    styleTemplateId,
    qualityProfile,
    seedHint,
    copies,
    concurrency,
    activeRegionalPrompts,
    activePreset,
    referenceImages,
    restoreConfigText,
    promptForResult,
    captureTemplateState,
    onModelChange,
    onReferenceImagesChange,
    setCanvasNotice,
    setLeftPanelTab,
    setRestoreConfigMessage,
    setters: {
      setPrompt,
      setContextPrompt,
      setNegativePrompt,
      setWorkflowPreset,
      setProductionIntent,
      setImageSizes,
      setStyleTemplateId,
      setQualityProfile,
      setSeedHint,
      setCopies,
      setConcurrency,
      setTemplateUndo,
      setRegionalPrompts,
    },
  });

  // ── 配方模板（六槽具名 profile + 捕获器，2026-08-25 主线一第三件）────────
  // 模板加载/保存走既有用户偏好存储面（/api/recipe-templates，登录用户）；
  // 套用动作复用 useWorkstationRecall 的同一条解析路径，确认卡在 RecipeTemplateSection 内。

  const recipeTemplates = useRecipeTemplates();
  const [saveTemplateTarget, setSaveTemplateTarget] = useState<ImageResult | null>(null);

  const handleSaveAsTemplate = useEventCallback((image: ImageResult) => {
    setSaveTemplateTarget(image);
  });

  const handleSaveTemplate = useEventCallback(async (name: string) => {
    if (!saveTemplateTarget) return { ok: false, message: "没有可捕获的成片。" };
    // 捕获的就是「这张成片当时」的完整配方（buildProvenanceConfig 权威来源，
    // 与复制配置 / PNG 嵌入 / R 键回填四方共用，不另造第二份结构）
    const config = buildProvenanceConfig(saveTemplateTarget);
    const result = await recipeTemplates.saveTemplate({ name, config });
    return result.ok
      ? { ok: true, message: "已存为模板「" + result.item.name + "」，可在左栏「配方模板」中载入。" }
      : { ok: false, message: result.message };
  });

  const handleDeleteUserRecipeTemplate = useEventCallback(async (id: string) => {
    const removed = await recipeTemplates.deleteTemplate(id);
    setCanvasNotice(removed ? "已删除该模板。" : "模板删除失败，请稍后再试。", removed ? "info" : "warn");
  });

  /**
   * 下载成片。
   *
   * 旧版只在全屏灯箱里有一个下载钮，且实现是 `anchor.href = 远端 URL` + `download`：
   * 跨源时 download 属性被浏览器忽略，点击变成「在当前标签页打开图片」，用户得再右键
   * 另存一次。这里统一走 blob + object URL，既能跨源真正下载，也能给中栏和图库卡复用。
   */
  const downloadResult = useEventCallback(async (image?: ImageResult) => {
    if (!image) {
      setCanvasNotice("还没有可下载的成片。", "warn");
      return;
    }
    const isVideo = image.mediaType === "video";
    const name = `${image.resultId ?? image.slotId ?? "result"}.${isVideo ? "mp4" : "png"}`;
    try {
      const href = isVideo ? image.videoUrl : null;
      let blob = isVideo ? null : await resultToBlob(image);
      // 把这张成片的工作流嵌入 PNG 檔尾：别人拖回工作台即可一键复刻。
      if (blob && image.workflow) {
        try {
          const config = buildProvenanceConfig(image);
          const embedded = embedWorkflowIntoPng(
            new Uint8Array(await blob.arrayBuffer()),
            JSON.stringify(config),
          );
          blob = new Blob([embedded.buffer as ArrayBuffer], { type: "image/png" });
        } catch {
          // 嵌入失败不阻断下载：仍按原图下载。
        }
      }
      const objectUrl = blob ? URL.createObjectURL(blob) : null;
      const anchor = document.createElement("a");
      anchor.href = objectUrl ?? href ?? resultSrc(image) ?? "";
      anchor.download = name;
      anchor.click();
      if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    } catch {
      setCanvasNotice("下载失败：无法读取成片文件，可稍后重试。", "error");
    }
  });

  const sendResultToAssets = async (image?: ImageResult) => {
    if (!image || (!image.image && !image.imageUrl)) {
      setCanvasNotice("还没有可转为参考的成片。");
      return;
    }
    const replaceOldest = referenceImages.length >= MAX_REFERENCE_IMAGES;
    if (replaceOldest && !window.confirm(`参考图已达 ${MAX_REFERENCE_IMAGES} 张上限。是否替换最早添加的一张？`)) {
      setCanvasNotice("未替换参考图，原成片仍保留在图库。");
      return;
    }
    try {
      const blob = await resultToBlob(image);
      const name = `成片-${(image.slotId ?? `${images.indexOf(image) + 1}`).slice(-6)}.png`;
      const file = new File([blob], name, { type: blob.type || "image/png" });
      await appendReferenceImage(file, activePreset.defaultRole, undefined, {
        resultId: image.resultId,
        taskId: image.taskId,
      }, replaceOldest);
      // 复用从「回填图片」升维为「回填配方」：同一颗 R 键/同一个复用动作，
      // 除参考图外把这张成片的完整配方预填进表单；带 workflow 元数据的成片
      // 回填后六槽摊开在提示词页可改，模型显式参数化、可换模型重跑。
      const recipeApplied = applyResultRecipe(image);
      setLeftPanelTab(recipeApplied ? "prompt" : "assets");
      setCanvasNotice(recipeApplied
        ? "已设为参考图，并回填这张成片的完整配方，可撤销、可改可换模型重跑。"
        : "已设为参考图。");
    } catch {
      setCanvasNotice("设置参考图失败，请先下载图片。");
    }
  };

  /**
   * 把历史里的某张图直接设为参考图。
   *
   * HistoryInspectorPanel 三层都声明了 onUseAsReference，但从来没有调用方传过 ——
   * 于是那颗按钮在任何情况下都不渲染，「在这张的基础上继续画」这条最自然的
   * 迭代路径只能靠：恢复参数 → 生成一张一样的 → 再设为参考，绕三步且多花一次币。
   */
  const useHistoryEntryAsReference = useEventCallback(
    (entry: { results?: ReadonlyArray<{ image?: string | null; imageUrl?: string | null }> }) => {
      const source = entry.results?.find((item) => item.image || item.imageUrl);
      if (!source) {
        setCanvasNotice("这条记录没有可用的成片图。", "warn");
        return;
      }
      // 只取图本身：历史记录的 provider 是宽 string，硬转成 ImageResult 会把
      // 一个不属于本站的 provider 值偷带进参考图链路。
      void sendResultToAssets({
        image: source.image ?? null,
        imageUrl: source.imageUrl ?? null,
        // 带上 slotId，否则命名会回落到 images.indexOf() 的 -1，存成「成片-0.png」
        slotId: `history-${Date.now().toString().slice(-6)}`,
      } as ImageResult);
    },
  );

  // ── 成片文件夹（2026-08-22 拆出 use-boards-library）─────────────────────

  const {
    boards,
    shots,
    shotUrls,
    activeBoardId,
    setActiveBoardId,
    newBoardName,
    setNewBoardName,
    referenceImportBoardId,
    setReferenceImportBoardId,
    referenceImportingId,
    referenceImportMessage,
    filteredShots,
    referenceImportShots,
    shotCounts,
    activeBoard,
    refreshBoards,
    handleImportShotAsReference,
    handleCreateBoard,
    handleDeleteBoard,
    handleDeleteActiveBoard,
    saveResultToBoard,
    handleMoveShot,
    handleToggleStar,
    handleDeleteShot,
    downloadShot,
    handleExportBoard,
  } = useBoardsLibrary({
    referenceImages,
    onReferenceImagesChange,
    activePreset,
    images,
    setCanvasNotice,
    resultToBlob,
    promptForResult,
  });


  /**
   * 「屏幕上这张图」与「编辑器现在的设置」之间的漂移。
   *
   * 画布上的成片是过去某一次生成的产物，改完模型／提示词／尺寸之后它不会跟着变 ——
   * 旧版对此没有任何提示，用户会把眼前这张图当成当前设置的效果，然后基于一个
   * 早已不成立的前提继续微调。这里把差异点列出来，并给一条回到那次设置的退路。
   *
   * 不做 useMemo：只是几次字符串比较加一次 tasks.find，而 promptForResult 与
   * activeStyle 每次渲染都是新引用，写进依赖数组等于每次都重算，反而更绕。
   */
  const staleConfigFields: string[] = [];
  if (visibleResult) {
    const shotWorkflow = visibleResult.workflow;
    if (visibleResult.modelId && visibleResult.modelId !== modelId) {
      staleConfigFields.push(`模型 ${modelBaseName(visibleResult.modelId)} → ${modelBaseName(modelId)}`);
    }
    const shotPrompt = promptForResult(visibleResult);
    if (shotPrompt && shotPrompt !== applyStyleToPrompt(activeStyle, prompt.trim())) {
      staleConfigFields.push("提示词");
    }
    const shotSize = shotWorkflow?.imageSize
      ?? (shotWorkflow?.aspectRatio ? imageSizeForAspectRatio(shotWorkflow.aspectRatio) : undefined);
    if (shotSize && shotSize !== imageSize) {
      staleConfigFields.push(`尺寸 ${shotSize} → ${imageSize}`);
    }
    if (shotWorkflow?.qualityProfile && shotWorkflow.qualityProfile !== qualityProfile) {
      staleConfigFields.push("画质");
    }
    if (isVideoModel
      && shotWorkflow?.durationSeconds
      && shotWorkflow.durationSeconds !== (durationSeconds ?? defaultDuration(modelId))) {
      staleConfigFields.push("时长");
    }
  }

  /** 把编辑器改回产出这张成片时的设置。 */
  const restoreVisibleResultConfig = useEventCallback(() => {
    if (!visibleResult) return;
    const shotWorkflow = visibleResult.workflow;
    setTemplateUndo({ label: "改回成片设置", snapshot: captureTemplateState() });
    if (visibleResult.modelId && visibleResult.modelId !== modelId) onModelChange(visibleResult.modelId);
    const shotPrompt = promptForResult(visibleResult);
    if (shotPrompt) setPrompt(shotPrompt);
    // 成片的提示词里已经含风格文本，恢复后清空风格，避免二次套用（与恢复历史同一处理）。
    setStyleTemplateId(null);
    if (shotWorkflow?.contextPrompt !== undefined) setContextPrompt(shotWorkflow.contextPrompt);
    if (shotWorkflow?.negativePrompt !== undefined) setNegativePrompt(shotWorkflow.negativePrompt);
    if (shotWorkflow?.imageSizes?.length) {
      setImageSizes(normalizeSizeSelection(shotWorkflow.imageSizes));
    } else if (shotWorkflow?.imageSize) {
      setImageSizes(normalizeSizeSelection([shotWorkflow.imageSize]));
    } else if (shotWorkflow?.aspectRatio) {
      setImageSizes(normalizeSizeSelection([imageSizeForAspectRatio(shotWorkflow.aspectRatio)]));
    }
    if (shotWorkflow?.qualityProfile) setQualityProfile(shotWorkflow.qualityProfile);
    if (shotWorkflow?.productionIntent) setProductionIntent(shotWorkflow.productionIntent);
    if (shotWorkflow?.seedHint !== undefined) setSeedHint(shotWorkflow.seedHint);
    if (shotWorkflow?.durationSeconds) setDurationSeconds(shotWorkflow.durationSeconds);
    setCanvasNotice("编辑器已改回这张成片的设置。");
  });

  const activateWorkspace = (mode: WorkspaceMode) => {
    setWorkspaceMode(mode);
    if (mode === "viewer") {
      setInspectorTab("gallery");
    }
  };

  const activateMobilePanel = (panel: MobilePanel) => {
    setMobilePanel(panel);
    if (panel === "create") setLeftPanelTab("prompt");
    if (panel === "settings") setLeftPanelTab("settings");
    if (panel === "canvas") setWorkspaceMode("canvas");
  };

  // ── 画布标注层（2026-08-22 拆出 use-canvas-annotation）──────────────────

  const {
    canvasViewportRef,
    annotationCanvasRef,
    baseImageRef,
    hasAnnotation,
    brushSize,
    setBrushSize,
    strokeCount,
    zoomScale,
    panOffset,
    isPanning,
    zoomAtPointer,
    resetZoom,
    startPan,
    movePan,
    endPan,
    handleAnnotationPointerDown,
    handleAnnotationPointerMove,
    handleAnnotationPointerUp,
    undoAnnotation,
    clearAnnotation,
    exportAnnotationToReference,
  } = useCanvasAnnotation({
    canvasZoom,
    selectedSlotId,
    activeCanvasTool,
    setActiveCanvasTool,
    referenceImages,
    visibleResult,
    setCanvasNotice,
    appendReferenceImage,
    setContextPrompt,
    appendUniqueText,
  });

  // ── 引导 ────────────────────────────────────────────────────────────────

  const { startTour, startLoraTour } = createWorkstationTours({
    tourRef,
    loraTourRef,
    loraGridWaitingRef,
    loraTourAdvancingRef,
    isPixaiModelRef,
    setMobilePanel,
    setLeftPanelTab,
    setInspectorTab,
    setLoraPanelOpen,
    setModelMenuOpen,
    toggleSection,
    activateWorkspace,
    advanceLoraTourFromModelSelection,
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    setBrandKit(loadBrandKit());
    refreshBoards();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!studioBodyRef.current || !window.matchMedia("(max-width: 1023px)").matches) return;
    studioBodyRef.current.scrollTop = 0;
  }, [mobilePanel]);

  const renderBoardsPanel = () => (
    <BoardsPanel
      boards={boards}
      shots={filteredShots}
      shotUrls={shotUrls}
      shotCounts={shotCounts}
      totalShots={shots.length}
      activeBoardId={activeBoardId}
      newBoardName={newBoardName}
      hasActiveBoard={!!activeBoard}
      onSelectBoard={setActiveBoardId}
      onNameChange={setNewBoardName}
      onCreate={handleCreateBoard}
      onDeleteActive={handleDeleteActiveBoard}
      onExport={handleExportBoard}
      onMoveShot={handleMoveShot}
      onToggleStar={handleToggleStar}
      onDeleteShot={handleDeleteShot}
      onDownload={downloadShot}
    />
  );

  const runRef = useRef(run);
  runRef.current = run;
  const executeCommand = useEventCallback((commandId: WorkstationCommandId) => {
    if (commandId === "run") {
      runRef.current();
      return;
    }
    if (commandId === "focus_prompt") {
      setMobilePanel("create");
      setLeftPanelTab("prompt");
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLTextAreaElement>("#pro-prompt-input");
        // 左栏可滚动，光标进了视口外的输入框等于「键盘没反应」，所以先滚进来再聚焦。
        input?.scrollIntoView({ block: "nearest" });
        input?.focus();
      });
      return;
    }
    if (commandId === "open_lora") {
      if (!generationCapabilities(modelId)?.lora) {
        setCanvasNotice("当前模型不支持 LoRA，请先选择 PixAI 模型。");
        setMobilePanel("settings");
        setLeftPanelTab("settings");
        return;
      }
      setLoraPanelOpen(true);
      setLeftPanelTab("settings");
      setMobilePanel("settings");
      requestAnimationFrame(() => document.querySelector("#pro-tour-lora")?.scrollIntoView({ block: "center" }));
      return;
    }
    if (commandId === "open_queue") {
      setInspectorTab("queue");
      setInspectorExpanded(true);
      setMobilePanel("output");
      return;
    }
    if (commandId === "open_gallery") {
      setInspectorTab("gallery");
      setInspectorExpanded(true);
      setMobilePanel("output");
      return;
    }
    if (commandId === "reuse_result") {
      if (visibleResult) void sendResultToAssets(visibleResult);
      else setCanvasNotice("还没有可复用的结果。");
      return;
    }
    if (commandId === "prev_result" || commandId === "next_result") {
      stepResult(commandId === "next_result" ? 1 : -1);
      return;
    }
    if (commandId === "download_result") {
      // D 键早就在键位表里，却一直没有分支：按下去被 preventDefault 后什么也没发生。
      if (visibleResult) void downloadResult(visibleResult);
      else setCanvasNotice("还没有可下载的成片。");
      return;
    }
    if (commandId === "undo_annotation") {
      undoAnnotation();
      return;
    }
    if (commandId === "show_commands") {
      setCommandPaletteOpen(true);
      return;
    }
    setCommandPaletteOpen(false);
    setModelMenuOpen(false);
  });
  useEffect(() => {
    /**
     * 只在专业模式真正可见时接管键盘。
     *
     * 工作站在普通模式下不是卸载而是 `.hidden`（保留草稿与队列状态），于是这个
     * window 级监听一直活着：普通模式下按 Cmd+Enter 会触发专业模式的 run() 并真的
     * 扣币出图，用户看到的却只有余额变少。`/` 同理会把焦点抢到看不见的输入框里。
     */
    if (!active) return;
    // 原生 keydown 替代 react-hotkeys-hook：单一快捷键不值 ~4KB gz 依赖，
    // 且 ref 模式让热键永远拿到最新闭包、零重绑
    const onKeyDown = (event: KeyboardEvent) => {
      const commandId = workstationCommandForKey({
        key: event.key,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
        defaultPrevented: event.defaultPrevented,
        composing: event.isComposing,
        editable: isWorkstationEditableTarget(event.target),
        modalOpen: Boolean(document.querySelector('[role="dialog"][aria-modal="true"]')),
      });
      if (!commandId) return;
      if (commandId === "close_overlay" && !commandPaletteOpen && !modelMenuOpen) return;
      event.preventDefault();
      executeCommand(commandId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, commandPaletteOpen, executeCommand, modelMenuOpen]);

  useEffect(() => {
    if (!lightboxOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setLightboxOpen(false);
        return;
      }
      // 全屏看图时左右键翻页：旧版全屏后键盘完全失效，只能关掉、点下一张、再全屏。
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        stepResult(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        stepResult(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [lightboxOpen, stepResult]);

  return (
    <section
      className="pro-studio-shell"
      data-active-task-id={activeTaskId ?? undefined}
      data-active-result-id={selectedSlotId ?? undefined}
    >
      <WorkstationTopbar
        activeWorkspaceTitle={activeWorkspace.title}
        workspaceMode={workspaceMode}
        onActivateWorkspace={activateWorkspace}
        completedSlots={completedSlots}
        runningSlots={runningSlots}
        failedSlots={failedSlots}
        executeCommand={executeCommand}
        isLoggedIn={isLoggedIn}
        user={user}
        onLogout={logout}
        startTour={startTour}
        onExitProfessionalMode={onExitProfessionalMode}
        isLoading={isLoading}
        runTotal={runTotal}
        runSettled={runSettled}
        runProgress={runProgress}
        runEtaLabel={runEtaLabel}
        mobilePanel={mobilePanel}
        onActivateMobilePanel={activateMobilePanel}
        prompt={prompt}
        handleRunClick={handleRunClick}
        canRun={canRun}
        copies={copies}
      />
      <div
        ref={studioBodyRef}
        className="pro-studio-body"
        data-mobile-panel={mobilePanel}
        data-explorer-focus={loraPanelOpen ? "lora" : undefined}
        data-inspector-state={inspectorExpanded ? "expanded" : "rail"}
        style={{
          position: "relative",
          ["--pro-left-w" as string]: `${panelWidths.left}px`,
          ["--pro-right-w" as string]: `${panelWidths.right}px`,
        }}
      >
        {/*
          左栏原本挂了 onClickCapture：只要点到任何一个按钮（换版位、选风格、加参考图……）
          右栏就整条收成 72px 轨道，中栏跟着横跳 ~250px。改成由用户显式控制收放
          （右栏顶部的收起按钮 / 再点一次当前 tab / 分隔条），不再替用户猜。
        */}
        <aside className="pro-left-panel pro-glass-panel">
          {/*
            模型选择常驻在提示词上方。
            原本 ModelPicker 藏在第三个 tab（参数）的第一个手风琴（尺寸）里面 ——
            换模型这件事和写提示词一样高频，却要先切 tab 再往下找，且切走之后
            看不到当前用的是哪个模型。现在它和提示词、运行条在同一列视线里。
          */}
          <div className="pro-model-row" id="pro-tour-model">
            <ModelPicker
              models={[...GENERATION_MODEL_IDS]}
              value={modelId}
              onChange={handleWorkstationModelChange}
              resolution={isVideoModel ? currentVideoResolution : qualityProfile === "print" ? "2k" : "1k"}
              durationSeconds={isVideoModel ? durationSeconds : undefined}
              generateAudio={isVideoModel ? generateAudio : undefined}
              stripVendorPrefix
              menuOpen={modelMenuOpen}
              onMenuOpenChange={handleModelMenuOpenChange}
              onApplyTipParams={(params: ModelUsageTipParams) => {
                // 模型卡「一键带入」：建议参数走本工作站的既有表单填充路径——
                // 比例→尺寸选择、画质→档位（1k=balanced，2k/4k=print）、时长/音轨直填。
                if (params.aspectRatio) {
                  setImageSizes(normalizeSizeSelection([imageSizeForAspectRatio(params.aspectRatio)]));
                }
                if (params.outputResolution) {
                  setQualityProfile(params.outputResolution === "1k" ? "balanced" : "print");
                }
                if (params.durationSeconds != null) setDurationSeconds(params.durationSeconds);
                if (params.generateAudio != null) setGenerateAudio(params.generateAudio);
              }}
            />
          </div>
          {/*
            role="tablist" 原本只有 aria-selected：没有 aria-controls 指向面板、
            三个 tab 全部 tabindex=0（Tab 键要按三次才能离开这一组）、方向键无效。
            现在是标准的 roving tabindex + 方向键切换。
          */}
          <div
            className="pro-side-tabs"
            id="pro-tour-left-tabs"
            role="tablist"
            aria-label="创作步骤"
            aria-orientation="horizontal"
            onKeyDown={(event) => {
              const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const index = LEFT_PANEL_TABS.findIndex((tab) => tab.id === leftPanelTab);
              const next = LEFT_PANEL_TABS[(index + delta + LEFT_PANEL_TABS.length) % LEFT_PANEL_TABS.length];
              setLeftPanelTab(next.id);
              requestAnimationFrame(() => document.getElementById(`pro-left-tab-${next.id}`)?.focus());
            }}
          >
            {LEFT_PANEL_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`pro-left-tab-${tab.id}`}
                aria-selected={leftPanelTab === tab.id}
                aria-controls={`pro-left-panel-${tab.id}`}
                tabIndex={leftPanelTab === tab.id ? 0 : -1}
                onClick={() => setLeftPanelTab(tab.id)}
                className={cn(leftPanelTab === tab.id && "is-active")}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <p className="pro-panel-hint">{activeLeftTab.hint}</p>

          {leftPanelTab === "prompt" && (
            <LeftPromptTab
              prompt={prompt}
              onPromptChange={setPrompt}
              referenceImages={referenceImages}
              onReferenceImagesChange={onReferenceImagesChange}
              onWorkflowDetected={restoreProvenanceConfigFromPng}
              promptStats={promptStats}
              onSetLeftPanelTab={setLeftPanelTab}
              sectionOpen={sectionOpen}
              toggleSection={toggleSection}
              onApplyResource={applyCreatorResource}
              onApplyScenario={applyScenario}
              onApplyKunpengStyle={applyKunpengStyle}
              onApplyKunpengPromptTemplate={applyKunpengPromptTemplate}
              isLoggedIn={isLoggedIn}
              userRecipeTemplates={recipeTemplates.items}
              userRecipeTemplatesLoading={recipeTemplates.loading}
              onApplyRecipeTemplate={applyRecipeTemplate}
              onDeleteUserRecipeTemplate={handleDeleteUserRecipeTemplate}
              templateUndoLabel={templateUndo?.label}
              onUndo={undoTemplateApply}
              token={token}
              onTemplateResult={onTemplateResult}
              setCanvasNotice={setCanvasNotice}
              styleCategory={styleCategory}
              onStyleCategoryChange={setStyleCategory}
              styleTemplateId={styleTemplateId}
              onToggleStyle={handleToggleStyle}
              activeStyle={activeStyle}
              onClearStyle={() => setStyleTemplateId(null)}
              contextPrompt={contextPrompt}
              onContextPromptChange={setContextPrompt}
              negativePrompt={negativePrompt}
              onNegativePromptChange={setNegativePrompt}
              regionalPrompts={regionalPrompts}
              onAddRegionalPrompt={addRegionalPrompt}
              onUpdateRegionalPrompt={updateRegionalPrompt}
              onRemoveRegionalPrompt={removeRegionalPrompt}
              activeRegionalPrompts={activeRegionalPrompts}
              brandKit={brandKit}
              onBrandKitChange={setBrandKit}
              onSaveBrandKit={handleSaveBrandKit}
              onClearBrandKit={handleClearBrandKit}
              brandKitMessage={brandKitMessage}
            />
          )}

          {leftPanelTab === "assets" && (
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-left-panel-assets"
              aria-labelledby="pro-left-tab-assets"
            >
              <div className="pro-accordion">
                <div className="pro-panel-title">
                  参考图设置
                  <em className="pro-title-count">{referenceImages.length}</em>
                  <button type="button" className="pro-inline-panel-link" onClick={() => setLeftPanelTab("prompt")}>
                    <ArrowLeft className="h-3.5 w-3.5" />
                    画面描述
                  </button>
                </div>
                <p className="pro-section-note">为每张图选择用途，并调整影响强度。</p>
                <ReferenceImageUpload value={referenceImages} onChange={onReferenceImagesChange} compact onWorkflowDetected={restoreProvenanceConfigFromPng} />
                <div className="pro-reference-import">
                  <div className="pro-reference-import-head">
                    <span><FolderOpen className="h-3.5 w-3.5" />从文件夹导入</span>
                    <select
                      value={referenceImportBoardId}
                      onChange={(event) => setReferenceImportBoardId(event.target.value)}
                      aria-label="选择参考图文件夹"
                    >
                      <option value="all">全部文件夹</option>
                      {boards.map((board) => (
                        <option key={board.id} value={board.id}>{board.name}</option>
                      ))}
                    </select>
                  </div>
                  {referenceImportShots.length > 0 ? (
                    <div className="pro-reference-import-grid">
                      {referenceImportShots.map((shot) => {
                        const imported = referenceImages.some((image) => image.id === `shot-${shot.id}`);
                        const importing = referenceImportingId === shot.id;
                        return (
                          <button
                            key={shot.id}
                            type="button"
                            onClick={() => handleImportShotAsReference(shot)}
                            disabled={imported || importing || referenceImages.length >= MAX_REFERENCE_IMAGES}
                            className={cn(imported && "is-imported")}
                            title={imported ? "已导入参考图" : `导入 ${shot.name}`}
                          >
                            <span className="pro-reference-import-thumb">
                              {shotUrls[shot.id] ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={shotUrls[shot.id]} alt="" />
                              ) : (
                                <ImagePlus className="h-4 w-4" />
                              )}
                            </span>
                            <span className="pro-reference-import-name">{shot.name}</span>
                            <span className="pro-reference-import-state">
                              {importing ? "导入中" : imported ? "已导入" : <Plus className="h-3 w-3" />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="pro-reference-import-empty">这个文件夹还没有图片。</p>
                  )}
                  {referenceImportMessage && <p className="pro-reference-import-message" aria-live="polite">{referenceImportMessage}</p>}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {referenceImages.map((image) => (
                    <DraggableReferenceTile
                      key={image.id}
                      image={image}
                      onRoleChange={updateReferenceRole}
                      onStrengthChange={updateReferenceStrength}
                    />
                  ))}
                </div>
                {referenceImages.length === 0 && (
                  <p className="rounded-ios-xl bg-white/30 px-3 py-2 text-ios-caption2 font-semibold text-foreground/45">
                    还没有参考图。可直接生成，也可以上传产品图或人物图。
                  </p>
                )}
              </div>
            </div>
          )}

          {leftPanelTab === "settings" && (
            <LeftSettingsTab
              modelId={modelId}
              isVideoModel={isVideoModel}
              isPixaiModel={isPixaiModel}
              sectionOpen={sectionOpen}
              toggleSection={toggleSection}
              sizeOptions={sizeOptions}
              toggleImageSize={toggleImageSize}
              imageSizes={imageSizes}
              durationSeconds={durationSeconds}
              setDurationSeconds={setDurationSeconds}
              generateAudio={generateAudio}
              setGenerateAudio={setGenerateAudio}
              loraPanelOpen={loraPanelOpen}
              setLoraPanelOpen={setLoraPanelOpen}
              setInspectorExpanded={setInspectorExpanded}
              selectedLora={selectedLora}
              setSelectedLora={setSelectedLora}
              qualityProfile={qualityProfile}
              setQualityProfile={setQualityProfile}
              qualityOptions={qualityOptions}
              productionIntent={productionIntent}
              setProductionIntent={setProductionIntent}
              seedHint={seedHint}
              setSeedHint={setSeedHint}
              copies={copies}
              setCopies={setCopies}
              concurrency={concurrency}
              setConcurrency={setConcurrency}
              runUnit={runUnit}
              totalCoins={totalCoins}
              imageSizeLabel={imageSizeLabel}
            />
          )}
          {/*
            运行条常驻左栏底部：主按钮和提示词框在同一列，鼠标不再横穿整个屏幕。
            右上角那颗生成按钮保留（键盘党和肌肉记忆），但主路径在这里。
            摘要行把「模型 · 画幅 · 张数 · 总币」摊开，用户不必点进第三个 tab 才知道花多少。
          */}
          <WorkstationRunBar
            modelId={modelId}
            isVideoModel={isVideoModel}
            durationSeconds={durationSeconds}
            imageSizeLabel={imageSizeLabel}
            copies={copies}
            runUnit={runUnit}
            totalCoins={totalCoins}
            handleRunClick={handleRunClick}
            isLoading={isLoading}
            canRun={canRun}
          />
        </aside>

        <button
          type="button"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左栏宽度（方向键微调，Home 复位）"
          aria-valuenow={panelWidths.left}
          aria-valuemin={200}
          title="拖动调整左栏宽度 · 双击复位"
          className={cn("pro-resize-handle pro-resize-handle--left", resizingSide === "left" && "is-dragging")}
          onPointerDown={(event) => startPanelResize("left", event)}
          onPointerMove={handlePanelResize}
          onPointerUp={endPanelResize}
          onPointerCancel={endPanelResize}
          onDoubleClick={() => resetPanel("left")}
          onKeyDown={(event) => handleResizeKeyDown("left", event)}
        />
        <CanvasStage
          workspaceMode={workspaceMode}
          activeWorkspaceTitle={activeWorkspace.title}
          capabilityNotice={capabilityNotice}
          notice={notice}
          setNotice={setNotice}
          activeCanvasTool={activeCanvasTool}
          setActiveCanvasTool={setActiveCanvasTool}
          canvasZoom={canvasZoom}
          setCanvasZoom={setCanvasZoom}
          setCanvasNotice={setCanvasNotice}
          viewerGalleryMode={viewerGalleryMode}
          setViewerGalleryMode={setViewerGalleryMode}
          renderBoardsPanel={renderBoardsPanel}
          shots={shots}
          allResults={allResults}
          resultKey={resultKey}
          slotStateFor={slotStateFor}
          openResultOnCanvas={openResultOnCanvas}
          downloadResult={downloadResult}
          referenceImages={referenceImages}
          executeCommand={executeCommand}
          setLeftPanelTab={setLeftPanelTab}
          visibleResult={visibleResult}
          setLightboxOpen={setLightboxOpen}
          canvasViewportRef={canvasViewportRef}
          baseImageRef={baseImageRef}
          annotationCanvasRef={annotationCanvasRef}
          isPanning={isPanning}
          startPan={startPan}
          movePan={movePan}
          endPan={endPan}
          panOffset={panOffset}
          zoomScale={zoomScale}
          zoomAtPointer={zoomAtPointer}
          resetZoom={resetZoom}
          handleAnnotationPointerDown={handleAnnotationPointerDown}
          handleAnnotationPointerMove={handleAnnotationPointerMove}
          handleAnnotationPointerUp={handleAnnotationPointerUp}
          isLoading={isLoading}
          runningSlots={runningSlots}
          runTotal={runTotal}
          runUnit={runUnit}
          runSettled={runSettled}
          runProgress={runProgress}
          runEtaLabel={runEtaLabel}
          viewableResults={viewableResults}
          visibleResultIndex={visibleResultIndex}
          stepResult={stepResult}
          staleConfigFields={staleConfigFields}
          dismissedStaleResultKey={dismissedStaleResultKey}
          setDismissedStaleResultKey={setDismissedStaleResultKey}
          restoreVisibleResultConfig={restoreVisibleResultConfig}
          sendResultToAssets={sendResultToAssets}
          saveResultToBoard={saveResultToBoard}
          copyProvenanceConfig={copyProvenanceConfig}
          activateWorkspace={activateWorkspace}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          strokeCount={strokeCount}
          undoAnnotation={undoAnnotation}
          hasAnnotation={hasAnnotation}
          exportAnnotationToReference={exportAnnotationToReference}
          clearAnnotation={clearAnnotation}
        />
        <button
          type="button"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度（方向键微调，Home 复位）"
          aria-valuenow={panelWidths.right}
          aria-valuemin={220}
          title="拖动调整右栏宽度 · 双击复位"
          className={cn("pro-resize-handle pro-resize-handle--right", resizingSide === "right" && "is-dragging")}
          onPointerDown={(event) => startPanelResize("right", event)}
          onPointerMove={handlePanelResize}
          onPointerUp={endPanelResize}
          onPointerCancel={endPanelResize}
          onDoubleClick={() => resetPanel("right")}
          onKeyDown={(event) => handleResizeKeyDown("right", event)}
        />
        <InspectorPanel
          inspectorTab={inspectorTab}
          setInspectorTab={setInspectorTab}
          inspectorExpanded={inspectorExpanded}
          setInspectorExpanded={setInspectorExpanded}
          setLoraPanelOpen={setLoraPanelOpen}
          activeInspectorTabHint={activeInspectorTab.hint}
          sectionOpen={sectionOpen}
          toggleSection={toggleSection}
          isLoading={isLoading}
          runningSlots={runningSlots}
          runTotal={runTotal}
          runSettled={runSettled}
          runProgress={runProgress}
          runEtaLabel={runEtaLabel}
          tasks={tasks}
          copies={copies}
          completedSlots={completedSlots}
          failedSlots={failedSlots}
          slotItems={slotItems}
          openTaskSlot={openTaskSlot}
          retrySlot={retrySlot}
          firstFailedTask={firstFailedTask}
          retryTask={retryTask}
          run={run}
          failedSlotCount={failedSlotCount}
          inspectorGalleryMode={inspectorGalleryMode}
          setInspectorGalleryMode={setInspectorGalleryMode}
          renderBoardsPanel={renderBoardsPanel}
          allResults={allResults}
          selectedSlotId={selectedSlotId}
          activePresetLabel={activePreset.label}
          referenceImages={referenceImages}
          openResultOnCanvas={openResultOnCanvas}
          copyProvenanceConfig={copyProvenanceConfig}
          saveResultToBoard={saveResultToBoard}
          onSaveAsTemplate={handleSaveAsTemplate}
          restoreHistoryEntry={restoreHistoryEntry}
          useHistoryEntryAsReference={useHistoryEntryAsReference}
          recentWorkflows={recentWorkflows}
          restoreConfigText={restoreConfigText}
          setRestoreConfigText={setRestoreConfigText}
          restoreProvenanceConfig={restoreProvenanceConfig}
          restoreConfigMessage={restoreConfigMessage}
          visibleResult={visibleResult}
        />
      </div>
      {commandPaletteOpen && (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/55 p-4 backdrop-blur-lg"
          role="dialog"
          aria-modal="true"
          aria-label="工作台快捷键"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) executeCommand("close_overlay");
          }}
        >
          <div className="w-full max-w-lg overflow-hidden rounded-ios-3xl lg-sheet p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-bold text-foreground">工作台快捷键</h3>
                <p className="mt-0.5 text-ios-caption1 font-semibold text-muted-foreground">输入框与输入法组合期间不会误触。</p>
              </div>
              <button type="button" onClick={() => executeCommand("close_overlay")} className="flex h-10 w-10 items-center justify-center rounded-full bg-black/5 text-muted-foreground" aria-label="关闭快捷键">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="grid gap-1.5">
              {WORKSTATION_COMMANDS.filter((command) => command.id !== "show_commands").map((command) => (
                <button
                  key={command.id}
                  type="button"
                  onClick={() => {
                    executeCommand("close_overlay");
                    executeCommand(command.id);
                  }}
                  disabled={command.id === "run" ? !canRun : command.id === "reuse_result" ? !visibleResult : false}
                  className="flex min-h-12 items-center gap-3 rounded-ios-xl px-3 text-left transition-colors hover:bg-black/5 disabled:opacity-40"
                >
                  <span className="min-w-0 flex-1">
                    <strong className="block text-ios-subhead text-foreground">{command.label}</strong>
                    <span className="block text-ios-caption2 font-semibold text-muted-foreground">{command.description}</span>
                  </span>
                  <kbd className="shrink-0 rounded-lg bg-white px-2 py-1 text-ios-caption2 font-bold text-muted-foreground shadow-sm">{command.shortcut}</kbd>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {lightboxOpen && visibleResult && createPortal(
        <div
          className="pro-lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="全屏查看成片"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLightboxOpen(false);
          }}
        >
          <button type="button" className="pro-lightbox-close" onClick={() => setLightboxOpen(false)} aria-label="关闭全屏">
            <X className="h-5 w-5" />
          </button>
          <div className="pro-lightbox-stage">
            {visibleResult.mediaType === "video" && visibleResult.videoUrl ? (
              <video src={visibleResult.videoUrl} controls autoPlay playsInline />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={resultSrc(visibleResult)} alt="生成结果" />
            )}
          </div>
          {viewableResults.length > 1 && (
            <>
              <button
                type="button"
                className="pro-lightbox-page pro-lightbox-page--prev"
                onClick={() => stepResult(-1)}
                aria-label="上一张"
              >
                <ChevronLeft className="h-6 w-6" />
              </button>
              <button
                type="button"
                className="pro-lightbox-page pro-lightbox-page--next"
                onClick={() => stepResult(1)}
                aria-label="下一张"
              >
                <ChevronRight className="h-6 w-6" />
              </button>
            </>
          )}
          <div className="pro-lightbox-meta">
            <span>{formatPublicGenerationSummary(visibleResult)}</span>
            {!(visibleResult.mediaType === "video") && (
              <>
                <button type="button" onClick={() => sendResultToAssets(visibleResult)}>
                  设为参考
                </button>
                <button type="button" onClick={() => saveResultToBoard(visibleResult)}>
                  存入文件夹
                </button>
              </>
            )}
            {/* 下载改走 downloadResult：跨域 URL 直接 anchor.download 会被浏览器忽略成「打开新标签」。 */}
            <button type="button" onClick={() => downloadResult(visibleResult)}>
              下载
            </button>
          </div>
        </div>,
        document.body,
      )}

      {/* 模板捕获器命名卡：把一次成功出图的配方沉淀为用户具名模板 */}
      {saveTemplateTarget && (
        <RecipeTemplateSaveDialog
          image={saveTemplateTarget}
          config={buildProvenanceConfig(saveTemplateTarget)}
          defaultName={saveTemplateTarget.workflow?.workflowPresetLabel ?? activePreset.label}
          onClose={() => setSaveTemplateTarget(null)}
          onSave={handleSaveTemplate}
          onSaved={(message) => {
            setCanvasNotice(message);
            setSaveTemplateTarget(null);
          }}
        />
      )}
    </section>
  );
}
