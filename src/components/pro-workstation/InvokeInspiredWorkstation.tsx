"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import type { Driver } from "driver.js";
import "driver.js/dist/driver.css";
// 这 ~37KB 只有专业模式用到。留在这个懒加载组件里，Next 会把它切成独立的
// CSS chunk，随 InvokeInspiredWorkstation 的 chunk 一起下发，
// 不会进入首页的 render-blocking <link rel=stylesheet>。
import "./workstation.css";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clipboard,
  CreditCard,
  Download,
  FileJson,
  FolderOpen,
  Gauge,
  History,
  ImagePlus,
  Images,
  Keyboard,
  Layers3,
  Library,
  Wand2,
  Loader2,
  LogOut,
  Palette,
  Play,
  Plus,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  User,
  X,
} from "lucide-react";
import { MAX_REFERENCE_IMAGES, ReferenceImageUpload } from "@/components/ReferenceImageUpload";
import { HistoryInspectorPanel } from "@/components/pro-workstation/HistoryInspectorPanel";
import { WalletBadge } from "@/components/WalletBadge";
import { CheckinCalendar } from "@/components/CheckinCalendar";
import { useAuth } from "@/hooks/use-auth";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
// base64 → data URL 的对象身份缓存，与标准模式的 ImageDisplay 共用同一份实现
import { resultSrc } from "@/components/image-src";
import type { ImageResult, ReferenceImageRole } from "@/lib/image-types";
import type { PersistedGenerationEntry } from "@/lib/generation-cache";
import type { GenerationTaskProjection } from "@/lib/generation-task-types";
import { cn } from "@/lib/utils";
import { WORKFLOW_SCHEMA_VERSION } from "@/lib/generation-workflow";
import { formatPublicGenerationSummary } from "@/lib/public-generation-summary";
import {
  mobilePanelForTaskStage,
  workstationTaskStage,
  type WorkstationTaskStage,
} from "@/lib/workstation-mobile-stage";
import { extractPromptSection, parseWorkflowRecallConfig, type WorkflowRecallConfig } from "@/lib/workflow-recall";
import { embedWorkflowIntoPng } from "@/lib/workflow-png";
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
  type BoardFolder,
  type SavedShotMeta,
  createBoard,
  deleteBoard,
  deleteShot,
  ensureDefaultBoard,
  getShotBlob,
  listBoards,
  listShots,
  moveShot,
  saveShot,
  toggleShotStar,
} from "@/lib/boards-store";
import {
  type BrandKit,
  EMPTY_BRAND_KIT,
  buildBrandContext,
  clearBrandKit,
  hasBrandKit,
  loadBrandKit,
  saveBrandKit,
} from "@/lib/brand-kit";
import { exportShotsZip } from "@/lib/export-zip";
// 只取类型：类型在编译期被擦除，所以 14 条场景模板与 32 条创作资源的数据体
// 不会进入专业模式入场 chunk，而是跟着下面 dynamic() 的面板 chunk 走。
import type { ScenarioTemplate } from "@/lib/scenario-templates";
import type { CreatorResource } from "@/lib/creator-resource-library";
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
  ANNOTATION_CONTEXT_NOTE,
  type LayoutPrefs,
  type PromptDraft,
  readLayoutPrefs,
  writeLayoutPrefs,
  readPromptDraft,
  writePromptDraft,
  DEFAULT_SECTION_OPEN,
  type NoticeLevel,
  type CanvasNotice,
  type AnnotationStroke,
  useEventCallback,
  waitForSelector,
  CREATIVE_TEMPLATE_COUNT,
  qualityProfileOptions,
  adSizeOptionsForModel,
  failureHint,
} from "./workstation-constants";
import {
  CreatorResourcePanel,
  TemplatePanel,
  StyleGrid,
  type ProfessionalRunConfig,
  type InvokeInspiredWorkstationProps,
  DraggableReferenceTile,
  type SlotItemView,
  QueueSlotList,
  BoardsPanel,
} from "./workstation-subcomponents";
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
  const [boards, setBoards] = useState<BoardFolder[]>([]);
  const [shots, setShots] = useState<SavedShotMeta[]>([]);
  const [shotUrls, setShotUrls] = useState<Record<string, string>>({});
  const [activeBoardId, setActiveBoardId] = useState<string>("all");
  const [referenceImportBoardId, setReferenceImportBoardId] = useState<string>("all");
  const [referenceImportingId, setReferenceImportingId] = useState<string | null>(null);
  const [referenceImportMessage, setReferenceImportMessage] = useState("");
  const [newBoardName, setNewBoardName] = useState("");
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
  const [panelWidths, setPanelWidths] = useState({
    left: initialLayout.left ?? 440,
    right: initialLayout.right ?? 320,
  });
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
  const [resizingSide, setResizingSide] = useState<"left" | "right" | null>(null);
  const panelResizeRef = useRef<{ side: "left" | "right"; startX: number; startWidth: number; container: number } | null>(null);
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

  /** 布局偏好落盘：分栏宽度、当前 tab、手风琴开合。 */
  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeLayoutPrefs({
        left: panelWidths.left,
        right: panelWidths.right,
        leftTab: leftPanelTab,
        inspectorTab,
        sections: sectionOpen,
      });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [panelWidths, leftPanelTab, inspectorTab, sectionOpen]);

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
  const [hasAnnotation, setHasAnnotation] = useState(false);
  /** 标注笔粗细。旧版硬编码 6px（擦除 26px），小物件太粗、大区域太钝。 */
  const [brushSize, setBrushSize] = useState(6);
  /** 撤销栈深度，只为渲染「撤销」按钮的可用态；笔迹本体在 strokesRef 里。 */
  const [strokeCount, setStrokeCount] = useState(0);
  /** 原图模式的缩放倍率与平移。旧版只有「适应 / 原图大小」二值，检查细节等于用吸管看画。 */
  const [zoomScale, setZoomScale] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  /** 只用于切换 grabbing 光标：拖拽位移本身走 ref，不靠这个 state 驱动。 */
  const [isPanning, setIsPanning] = useState(false);
  /** 本批次开始时间与秒级时钟，用来算已耗时和预计剩余。 */
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [runClock, setRunClock] = useState(() => Date.now());
  /** 原图模式的容器与拖拽状态，滚轮缩放要拿到真实 DOM 才能绑非 passive 监听。 */
  const canvasViewportRef = useRef<HTMLDivElement | null>(null);
  const panDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  /** 撤销栈：每笔存 points + width + mode，切缩放/改栏宽后靠它重绘，不再静默丢失。 */
  const strokesRef = useRef<AnnotationStroke[]>([]);
  const currentStrokeRef = useRef<AnnotationStroke | null>(null);
  const canvasSizeRef = useRef<{ width: number; height: number } | null>(null);
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

  const annotationCanvasRef = useRef<HTMLCanvasElement>(null);
  const baseImageRef = useRef<HTMLImageElement>(null);
  const studioBodyRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const hasAnnotationRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const shotUrlPendingRef = useRef<Set<string>>(new Set());
  const tourRef = useRef<Driver | null>(null);
  const manualResultSelectionRef = useRef(false);
  const lastAutoSelectedTaskRef = useRef<string | null>(null);
  const lastMobileTaskStageRef = useRef<WorkstationTaskStage>("prepare");
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
  const filteredShots = useMemo(() => shots
    .filter((shot) => activeBoardId === "all" || shot.boardId === activeBoardId)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt), [shots, activeBoardId]);
  const referenceImportShots = useMemo(() => shots
    .filter((shot) => referenceImportBoardId === "all" || shot.boardId === referenceImportBoardId)
    .sort((a, b) => Number(b.starred) - Number(a.starred) || b.createdAt - a.createdAt), [shots, referenceImportBoardId]);
  const shotCounts = useMemo(() => {
    const counts = new Map<string, number>();
    shots.forEach((shot) => counts.set(shot.boardId, (counts.get(shot.boardId) ?? 0) + 1));
    return counts;
  }, [shots]);
  const activeBoard = boards.find((board) => board.id === activeBoardId);
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

  const restoreRegionalPrompts = (entries?: Array<{ text: string; weight?: number }>) => {
    if (!entries?.length) return;
    setRegionalPrompts(entries.map((entry, index) => ({
      id: `recall-${Date.now()}-${index}`,
      text: entry.text,
      enabled: true,
    })));
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

  const appendReferenceImage = (
    file: File,
    role: ReferenceImageRole,
    strength?: number,
    source?: { resultId?: string; taskId?: string },
    replaceOldest = false,
  ) => {
    const base = replaceOldest ? referenceImages.slice(1) : referenceImages;
    onReferenceImagesChange([
      ...base,
      {
        id: `result-${Date.now()}`,
        name: file.name,
        file,
        previewUrl: URL.createObjectURL(file),
        size: file.size,
        role,
        ...(strength !== undefined ? { strength } : {}),
        ...(source?.resultId ? { sourceResultId: source.resultId } : {}),
        ...(source?.taskId ? { sourceGenerationId: source.taskId } : {}),
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
      appendReferenceImage(file, activePreset.defaultRole, undefined, {
        resultId: image.resultId,
        taskId: image.taskId,
      }, replaceOldest);
      setLeftPanelTab("assets");
      setCanvasNotice("已设为参考图。");
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

  // ── 成片文件夹 ────────────────────────────────────────────────────────────

  const refreshBoards = async () => {
    const [boardList, shotList] = await Promise.all([listBoards(), listShots()]);
    setBoards(boardList);
    setShots(shotList);
  };

  const handleImportShotAsReference = useEventCallback(async (shot: SavedShotMeta) => {
    const referenceId = `shot-${shot.id}`;
    if (referenceImages.some((image) => image.id === referenceId)) {
      setReferenceImportMessage("这张图片已经在参考图中。");
      return;
    }
    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      setReferenceImportMessage(`参考图已达上限，最多 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }
    setReferenceImportingId(shot.id);
    setReferenceImportMessage("");
    try {
      const blob = await getShotBlob(shot.id);
      if (!blob) throw new Error("missing shot blob");
      const file = new File([blob], shot.name, { type: blob.type || "image/png" });
      onReferenceImagesChange([
        ...referenceImages,
        {
          id: referenceId,
          name: shot.name,
          file,
          previewUrl: URL.createObjectURL(file),
          size: file.size,
          role: activePreset.defaultRole,
        },
      ]);
      setReferenceImportMessage(`已从文件夹导入「${shot.name}」。`);
    } catch {
      setReferenceImportMessage("导入失败，请重试。");
    } finally {
      setReferenceImportingId(null);
    }
  });

  const handleCreateBoard = useEventCallback(async () => {
    const board = await createBoard(newBoardName.trim());
    setNewBoardName("");
    setActiveBoardId(board.id);
    await refreshBoards();
    setCanvasNotice(`已创建「${board.name}」。`);
  });

  const handleDeleteBoard = useEventCallback(async (boardId: string) => {
    const board = boards.find((item) => item.id === boardId);
    if (!board) return;
    const count = shots.filter((shot) => shot.boardId === boardId).length;
    if (count > 0 && !window.confirm(`删除文件夹「${board.name}」会同时删除其中 ${count} 张图片，确定吗？`)) return;
    setShotUrls((current) => {
      shots.filter((shot) => shot.boardId === boardId).forEach((shot) => {
        if (current[shot.id]) URL.revokeObjectURL(current[shot.id]);
      });
      return Object.fromEntries(Object.entries(current).filter(([id]) => !shots.some((shot) => shot.id === id && shot.boardId === boardId)));
    });
    await deleteBoard(boardId);
    setActiveBoardId("all");
    await refreshBoards();
    setCanvasNotice(`已删除「${board.name}」。`);
  });

  const handleDeleteActiveBoard = useEventCallback(() => {
    if (activeBoard) handleDeleteBoard(activeBoard.id);
  });

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

  const saveResultToBoard = async (image?: ImageResult) => {
    if (!image || (!image.image && !image.imageUrl)) {
      setCanvasNotice("还没有可存入的成片。");
      return;
    }
    try {
      const blob = await resultToBlob(image);
      const target = activeBoard ?? await ensureDefaultBoard();
      const presetLabel = image.workflow?.workflowPresetLabel ?? activePreset.label;
      await saveShot(blob, {
        boardId: target.id,
        name: `${presetLabel}-${(image.slotId ?? `${images.indexOf(image) + 1}`).slice(-4)}.png`,
        modelId: image.modelId,
        presetLabel,
        // 存的是「这张图当时的提示词」，不是编辑器里现在的内容。
        // 旧版写 prompt.trim()：半小时前生成的图，存进文件夹时被贴上刚写的另一段描述，
        // 之后凭这条记录复现只会得到完全不同的画面。
        prompt: promptForResult(image),
        imageSize: image.workflow?.imageSize,
      });
      await refreshBoards();
      setCanvasNotice(`已存入「${target.name}」。`);
    } catch {
      setCanvasNotice("存入失败，请重试。");
    }
  };

  const handleMoveShot = useEventCallback(async (shotId: string, boardId: string) => {
    await moveShot(shotId, boardId);
    await refreshBoards();
  });

  const handleToggleStar = useEventCallback(async (shotId: string) => {
    await toggleShotStar(shotId);
    await refreshBoards();
  });

  const handleDeleteShot = useEventCallback(async (shotId: string) => {
    /**
     * 删除文件夹里的成片是不可逆的（IndexedDB 里删掉就没有了，也没有回收站），
     * 而这个按钮在卡片上跟「下载」紧挨着。旧版点下去立刻删，只留一句「已删除」。
     */
    const shot = shots.find((item) => item.id === shotId);
    if (!window.confirm(`删除「${shot?.name ?? "这张成片"}」？此操作无法撤销。`)) return;
    setShotUrls((current) => {
      if (current[shotId]) URL.revokeObjectURL(current[shotId]);
      const next = { ...current };
      delete next[shotId];
      return next;
    });
    await deleteShot(shotId);
    await refreshBoards();
    setCanvasNotice("成片已从文件夹删除");
  });

  const downloadShot = useEventCallback((shot: SavedShotMeta) => {
    const url = shotUrls[shot.id];
    if (!url) return;
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = shot.name;
    anchor.click();
  });

  const handleExportBoard = useEventCallback(async () => {
    if (!filteredShots.length) {
      setCanvasNotice("当前文件夹没有可导出的图片。");
      return;
    }
    const items: Array<{ name: string; blob: Blob }> = [];
    for (const shot of filteredShots) {
      const blob = await getShotBlob(shot.id);
      if (blob) items.push({ name: shot.name, blob });
    }
    await exportShotsZip(items, `${activeBoard?.name ?? "全部成片"}`);
    setCanvasNotice(`已导出 ${items.length} 张图片。`);
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

  // ── 画布标注层 ────────────────────────────────────────────────────────────

  /** 把一笔画到 context 上；缩放系数用于画布尺寸变化后的等比重绘。 */
  const paintStroke = (
    context: CanvasRenderingContext2D,
    stroke: AnnotationStroke,
    scaleX: number,
    scaleY: number,
  ) => {
    if (stroke.points.length === 0) return;
    const scale = Math.min(scaleX, scaleY);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    context.lineWidth = Math.max(1, stroke.width * scale);
    context.strokeStyle = stroke.mode === "erase" ? "rgba(0,0,0,1)" : "rgba(255, 59, 48, 0.85)";
    context.beginPath();
    const first = stroke.points[0];
    context.moveTo(first.x * scaleX, first.y * scaleY);
    if (stroke.points.length === 1) {
      context.lineTo(first.x * scaleX + 0.01, first.y * scaleY + 0.01);
    } else {
      for (const point of stroke.points.slice(1)) {
        context.lineTo(point.x * scaleX, point.y * scaleY);
      }
    }
    context.stroke();
    context.globalCompositeOperation = "source-over";
  };

  /** 按 strokesRef 重画整层。撤销、尺寸变化、切缩放模式都走这里。 */
  const repaintAnnotations = () => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokesRef.current) {
      const scaleX = stroke.canvasWidth ? canvas.width / stroke.canvasWidth : 1;
      const scaleY = stroke.canvasHeight ? canvas.height / stroke.canvasHeight : 1;
      paintStroke(context, stroke, scaleX, scaleY);
    }
    const hasDrawn = strokesRef.current.some((stroke) => stroke.mode === "draw");
    hasAnnotationRef.current = hasDrawn;
    setHasAnnotation(hasDrawn);
  };

  /**
   * 画布尺寸变化时按比例重绘，而不是丢掉标注。
   *
   * 旧版一改栏宽、一切「原图大小」，canvas 的 client 尺寸变化就直接把位图清零，
   * 用户刚圈好的区域凭空消失且没有任何提示。现在每笔都记在 strokesRef 里，
   * 尺寸变了就等比重画。
   */
  const syncAnnotationCanvasSize = () => {
    const canvas = annotationCanvasRef.current;
    if (!canvas) return;
    const { clientWidth, clientHeight } = canvas;
    if (clientWidth === 0 || clientHeight === 0) return;
    if (canvas.width !== clientWidth || canvas.height !== clientHeight) {
      canvas.width = clientWidth;
      canvas.height = clientHeight;
      canvasSizeRef.current = { width: clientWidth, height: clientHeight };
      repaintAnnotations();
    }
  };

  const annotationPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /**
   * 原图模式的滚轮缩放与拖拽平移。
   *
   * 旧版缩放只有「适应 / 原图大小」两档：想看清一只眼睛的细节，只能切原图后
   * 用滚动条一格格找，找到了也没法再放大 —— 等于用吸管看画。现在滚轮（或触控板
   * 双指）缩放 0.25×–8×，按住拖动平移，双击回 100%。
   */
  const zoomAtPointer = useEventCallback((factor: number) => {
    const next = Math.min(8, Math.max(0.25, zoomScale * factor));
    if (next === zoomScale) return;
    // 缩放围绕画布中心，同时等比拉伸已有位移，视觉焦点不会跳走
    const ratio = next / zoomScale;
    setZoomScale(next);
    setPanOffset((current) => ({ x: current.x * ratio, y: current.y * ratio }));
  });

  const resetZoom = useEventCallback(() => {
    setZoomScale(1);
    setPanOffset({ x: 0, y: 0 });
  });

  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (canvasZoom !== "actual" || activeCanvasTool !== "select") return;
    panDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: panOffset.x,
      originY: panOffset.y,
    };
    setIsPanning(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = panDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    setPanOffset({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY),
    });
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (panDragRef.current?.pointerId !== event.pointerId) return;
    panDragRef.current = null;
    setIsPanning(false);
  };

  // 切回「适应」或换图时复位，否则下次进原图模式还停在上一张的放大位置
  useEffect(() => {
    if (canvasZoom === "fit") resetZoom();
  }, [canvasZoom, resetZoom]);

  useEffect(() => {
    resetZoom();
  }, [selectedSlotId, resetZoom]);

  /**
   * wheel 必须用非 passive 的原生监听。
   *
   * React 的 onWheel 走 passive 通道，里面的 preventDefault 被浏览器忽略：
   * 缩放会连带把整个左栏/页面一起滚走。所以这里手动绑，且只在原图模式下绑。
   */
  useEffect(() => {
    if (canvasZoom !== "actual") return;
    const node = canvasViewportRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      // deltaY 单位随设备差异很大，只取方向，每格固定 1.12 倍
      zoomAtPointer(event.deltaY < 0 ? 1.12 : 1 / 1.12);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [canvasZoom, zoomAtPointer]);

  const drawAnnotationSegment = (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    // 擦除半径跟随笔粗（约 3 倍），不再是与笔粗脱钩的固定 26px
    const width = activeCanvasTool === "erase" ? brushSize * 3 : brushSize;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (activeCanvasTool === "erase") {
      context.globalCompositeOperation = "destination-out";
      context.strokeStyle = "rgba(0,0,0,1)";
    } else {
      context.globalCompositeOperation = "source-over";
      context.strokeStyle = "rgba(255, 59, 48, 0.85)";
    }
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x + 0.01, to.y + 0.01);
    context.stroke();
    context.globalCompositeOperation = "source-over";
    // 首段标注只 setState 一次，后续笔迹零重渲染（绘制全在 canvas 位图上）
    if (activeCanvasTool === "annotate" && !hasAnnotationRef.current) {
      hasAnnotationRef.current = true;
      setHasAnnotation(true);
    }
  };

  const handleAnnotationPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeCanvasTool === "select") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    syncAnnotationCanvasSize();
    isDrawingRef.current = true;
    const point = annotationPoint(event);
    lastPointRef.current = point;
    const canvas = annotationCanvasRef.current;
    currentStrokeRef.current = {
      points: [point],
      width: activeCanvasTool === "erase" ? brushSize * 3 : brushSize,
      mode: activeCanvasTool === "erase" ? "erase" : "draw",
      canvasWidth: canvas?.width ?? 0,
      canvasHeight: canvas?.height ?? 0,
    };
    drawAnnotationSegment(point, point);
  };

  const handleAnnotationPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || activeCanvasTool === "select") return;
    const point = annotationPoint(event);
    drawAnnotationSegment(lastPointRef.current ?? point, point);
    lastPointRef.current = point;
    currentStrokeRef.current?.points.push(point);
  };

  const handleAnnotationPointerUp = () => {
    isDrawingRef.current = false;
    lastPointRef.current = null;
    const stroke = currentStrokeRef.current;
    currentStrokeRef.current = null;
    if (!stroke || stroke.points.length === 0) return;
    // 上限 200 笔：撤销栈够长，又不会在长时间标注后吃掉内存
    strokesRef.current = [...strokesRef.current, stroke].slice(-200);
    setStrokeCount(strokesRef.current.length);
  };

  /** 撤销最后一笔（Ctrl/Cmd+Z）。旧版只有「清空」，画错一笔要全部重来。 */
  const undoAnnotation = useEventCallback(() => {
    if (strokesRef.current.length === 0) {
      setCanvasNotice("没有可撤销的标注。");
      return;
    }
    strokesRef.current = strokesRef.current.slice(0, -1);
    setStrokeCount(strokesRef.current.length);
    repaintAnnotations();
  });

  const clearAnnotation = () => {
    const canvas = annotationCanvasRef.current;
    const context = canvas?.getContext("2d");
    if (canvas && context) context.clearRect(0, 0, canvas.width, canvas.height);
    strokesRef.current = [];
    currentStrokeRef.current = null;
    setStrokeCount(0);
    hasAnnotationRef.current = false;
    setHasAnnotation(false);
    setCanvasNotice("已清空标注。");
  };

  const canvasToBlob = (canvas: HTMLCanvasElement) =>
    new Promise<Blob>((resolve, reject) => {
      try {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("empty blob"))), "image/png");
      } catch (error) {
        reject(error);
      }
    });

  const exportAnnotationToReference = async () => {
    const canvas = annotationCanvasRef.current;
    if (!canvas || !hasAnnotation) {
      setCanvasNotice("先用标注笔圈出区域。");
      return;
    }
    if (referenceImages.length >= MAX_REFERENCE_IMAGES) {
      setCanvasNotice(`参考图已达上限，最多 ${MAX_REFERENCE_IMAGES} 张。`);
      return;
    }

    const buildAnnotationOnlyBlob = async () => {
      const fallbackCanvas = document.createElement("canvas");
      fallbackCanvas.width = canvas.width;
      fallbackCanvas.height = canvas.height;
      const context = fallbackCanvas.getContext("2d");
      if (!context) throw new Error("no context");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
      context.drawImage(canvas, 0, 0);
      return canvasToBlob(fallbackCanvas);
    };

    let blob: Blob;
    let annotationOnly = false;
    const baseImage = baseImageRef.current;
    try {
      if (visibleResult && baseImage?.naturalWidth) {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = baseImage.naturalWidth;
        exportCanvas.height = baseImage.naturalHeight;
        const context = exportCanvas.getContext("2d");
        if (!context) throw new Error("no context");
        context.drawImage(baseImage, 0, 0);
        const scale = Math.min(canvas.width / baseImage.naturalWidth, canvas.height / baseImage.naturalHeight);
        const displayWidth = baseImage.naturalWidth * scale;
        const displayHeight = baseImage.naturalHeight * scale;
        const offsetX = (canvas.width - displayWidth) / 2;
        const offsetY = (canvas.height - displayHeight) / 2;
        context.drawImage(
          canvas,
          offsetX, offsetY, displayWidth, displayHeight,
          0, 0, baseImage.naturalWidth, baseImage.naturalHeight,
        );
        blob = await canvasToBlob(exportCanvas);
      } else {
        annotationOnly = true;
        blob = await buildAnnotationOnlyBlob();
      }
    } catch {
      try {
        annotationOnly = true;
        blob = await buildAnnotationOnlyBlob();
      } catch {
        setCanvasNotice("标注保存失败，请重试。");
        return;
      }
    }

    const file = new File([blob], `标注-${Date.now().toString().slice(-6)}.png`, { type: "image/png" });
    appendReferenceImage(file, "composition", 90);
    setContextPrompt((current) => appendUniqueText(current, ANNOTATION_CONTEXT_NOTE));
    clearAnnotation();
    setActiveCanvasTool("select");
    // 两个分支必须说不同的话：只有笔迹的那张（白底红线）对模型的作用和
    // 「原图 + 笔迹」完全不同，旧版两边同一句「已将标注设为参考图」，
    // 用户不会知道底图没被合进去，只会觉得模型没听懂圈的位置。
    setCanvasNotice(annotationOnly
      ? "已把标注单独设为参考图（未含底图）：模型只看到白底上的笔迹，建议在描述里补一句要改的位置。"
      : "已把「原图 + 标注」设为参考图。", annotationOnly ? "warn" : "info");
  };

  // ── 配置召回 ─────────────────────────────────────────────────────────────

  /**
   * 以「这张成片的」配置为准，缺字段才回落到当前编辑器 state。
   *
   * 与 copyProvenanceConfig / downloadResult（PNG 嵌入）共用同一个权威来源，
   * 避免「可以复现的东西会在两处各写一份各不相同」。
   */
  const buildProvenanceConfig = (image?: ImageResult) => {
    const workflow = image?.workflow;
    return {
      schemaVersion: workflow?.schemaVersion ?? WORKFLOW_SCHEMA_VERSION,
      prompt: (image ? promptForResult(image) : undefined) ?? prompt.trim(),
      contextPrompt: workflow?.contextPrompt ?? contextPrompt.trim(),
      negativePrompt: workflow?.negativePrompt ?? negativePrompt.trim(),
      workflowPreset: workflow?.workflowPreset ?? workflowPreset,
      workflowPresetLabel: workflow?.workflowPresetLabel ?? activePreset.label,
      promptHint: workflow?.promptHint ?? activePreset.promptHint,
      negativeHint: workflow?.negativeHint ?? activePreset.negativeHint,
      productionIntent: workflow?.productionIntent ?? productionIntent,
      imageSize: workflow?.imageSize ?? imageSize,
      imageSizes: workflow?.imageSizes ?? imageSizes,
      styleTemplate: workflow?.styleTemplate ?? styleTemplateId ?? undefined,
      qualityProfile: workflow?.qualityProfile ?? qualityProfile,
      seedHint: workflow?.seedHint ?? seedHint,
      regionalPrompts: workflow?.regionalPrompts
        ?? activeRegionalPrompts.map((item) => ({ text: item.text.trim() })),
      copies: workflow?.copies ?? copies,
      concurrency: workflow?.concurrency ?? concurrency,
      modelId: image?.modelId ?? modelId,
      referenceImages: workflow?.referenceImages ?? referenceImages.map((ref) => ({
        name: ref.name,
        role: ref.role ?? activePreset.defaultRole,
        size: ref.size,
        strength: ref.strength ?? 80,
      })),
    };
  };

  /**
   * 复制「这张成片的」配置，而不是「编辑器现在的」配置。
   *
   * 旧版无论点哪张图，导出的 JSON 全部读当前 state —— 只有 modelId 来自那张图。
   * 于是「复制配置 → 粘贴回来复现」得到的是现在的参数配上旧模型名，
   * 这个功能存在的唯一理由（复现某张图）恰好是它做不到的事。
   * 传入的成片带 workflow 元数据时以它为准，缺字段才回落到当前 state。
   */
  const copyProvenanceConfig = async (image?: ImageResult) => {
    const fromResult = Boolean(image?.workflow);
    const config = buildProvenanceConfig(image);
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setCanvasNotice(fromResult ? "已复制这张成片的配置。" : "已复制当前配置。");
  };

  /** 把解析出的工作流配置写回编辑器（粘贴 JSON 与 PNG 内嵌工作流共用）。 */
  const applyWorkflowRecallConfig = (config: WorkflowRecallConfig) => {
    if (config.prompt !== undefined) setPrompt(config.prompt);
    if (config.contextPrompt !== undefined) setContextPrompt(config.contextPrompt);
    if (config.negativePrompt !== undefined) setNegativePrompt(config.negativePrompt);
    if (config.workflowPreset && WORKFLOW_PRESETS.some((preset) => preset.id === config.workflowPreset)) {
      setWorkflowPreset(config.workflowPreset);
    }
    if (config.productionIntent) setProductionIntent(config.productionIntent);
    if (config.imageSizes?.length) {
      setImageSizes(normalizeSizeSelection(config.imageSizes));
    } else if (config.imageSize) {
      setImageSizes(normalizeSizeSelection([config.imageSize]));
    }
    if (config.styleTemplate !== undefined) {
      setStyleTemplateId(getStyleById(config.styleTemplate)?.id ?? null);
    }
    if (config.qualityProfile) setQualityProfile(config.qualityProfile);
    if (config.seedHint !== undefined) setSeedHint(config.seedHint);
    if (config.copies) setCopies(config.copies);
    if (config.concurrency) setConcurrency(config.concurrency);
    restoreRegionalPrompts(config.regionalPrompts);
    if (config.referenceImageRolesByName) {
      onReferenceImagesChange(referenceImages.map((image) => {
        const role = config.referenceImageRolesByName?.[image.name];
        return role ? { ...image, role } : image;
      }));
    }
  };

  const restoreProvenanceConfig = () => {
    const result = parseWorkflowRecallConfig(restoreConfigText);
    if (!result.ok) {
      setRestoreConfigMessage(result.error);
      return;
    }

    applyWorkflowRecallConfig(result.config);
    setRestoreConfigMessage("配置已导入。");
  };

  /** 拖入带内嵌工作流的 PNG 时的一键还原：沿用粘贴还原路径，并补回模型。 */
  const restoreProvenanceConfigFromPng = useEventCallback((workflowJson: string) => {
    const result = parseWorkflowRecallConfig(workflowJson);
    if (!result.ok) {
      setRestoreConfigMessage(result.error);
      setCanvasNotice("这张图片的内嵌工作流无法还原。", "warn");
      return;
    }

    setTemplateUndo({ label: "还原 PNG 工作流", snapshot: captureTemplateState() });
    let embeddedModelId: string | undefined;
    try {
      const raw = JSON.parse(workflowJson) as { modelId?: unknown };
      embeddedModelId = typeof raw.modelId === "string" ? raw.modelId : undefined;
    } catch {
      // parseWorkflowRecallConfig 已保证可解析，这里只是取额外字段
    }
    if (embeddedModelId && embeddedModelId !== modelId) onModelChange(embeddedModelId);

    applyWorkflowRecallConfig(result.config);
    setLeftPanelTab("prompt");
    setRestoreConfigMessage("已还原 PNG 内嵌的工作流。");
    setCanvasNotice(embeddedModelId && embeddedModelId !== modelId
      ? `已还原 PNG 内嵌的工作流，并切回 ${modelBaseName(embeddedModelId)}。可撤销。`
      : "已还原 PNG 内嵌的工作流。可撤销。");
  });

  const restoreHistoryEntry = (entry: PersistedGenerationEntry) => {
    const workflow = entry.workflow;
    /**
     * 恢复历史会整份覆盖编辑器，因此先存一份撤销快照 —— 与「套用场景 / 套用模板」
     * 同一套机制。旧版这里没有快照：点错一条历史记录，正在写的提示词、尺寸、张数
     * 全部消失且无法回退。
     */
    setTemplateUndo({ label: "恢复历史", snapshot: captureTemplateState() });
    /**
     * 模型也要跟着回到当时那个。
     *
     * 旧版只改本地状态、从不调 onModelChange，于是恢复一条 PixAI 的历史后，
     * 界面显示的是历史里的参数、真正发请求用的却是当前模型 —— 出图与预期不符，
     * 且完全没有任何提示。
     */
    const historyModelId = entry.results.find((result) => result.modelId)?.modelId;
    if (historyModelId && historyModelId !== modelId) onModelChange(historyModelId);
    setPrompt(extractPromptSection(entry.prompt));
    setContextPrompt(workflow?.contextPrompt ?? "");
    setNegativePrompt(workflow?.negativePrompt ?? "");
    if (workflow?.workflowPreset && WORKFLOW_PRESETS.some((preset) => preset.id === workflow.workflowPreset)) {
      setWorkflowPreset(workflow.workflowPreset);
    }
    if (workflow?.productionIntent) setProductionIntent(workflow.productionIntent);
    if (workflow?.imageSizes?.length) {
      setImageSizes(normalizeSizeSelection(workflow.imageSizes));
    } else if (workflow?.imageSize) {
      setImageSizes(normalizeSizeSelection([workflow.imageSize]));
    }
    // 历史记录里的提示词已包含风格文本，这里不再恢复风格，避免二次套用
    setStyleTemplateId(null);
    if (workflow?.qualityProfile) setQualityProfile(workflow.qualityProfile);
    setSeedHint(workflow?.seedHint ?? "");
    if (workflow?.copies) setCopies(workflow.copies);
    if (workflow?.concurrency) setConcurrency(workflow.concurrency);
    restoreRegionalPrompts(workflow?.regionalPrompts);
    if (workflow?.referenceImages?.length) {
      const rolesByName = Object.fromEntries(workflow.referenceImages.map((image) => [image.name, image.role]));
      onReferenceImagesChange(referenceImages.map((image) => {
        const role = rolesByName[image.name];
        return role ? { ...image, role } : image;
      }));
    }
    setLeftPanelTab("prompt");
    // 提示走画布通知：setRestoreConfigMessage 只渲染在右栏「导入配置」手风琴里，
    // 而历史列表在另一个 tab —— 旧版恢复成功后用户看不到任何反馈。
    setRestoreConfigMessage("已恢复最近任务。");
    setCanvasNotice(
      historyModelId && historyModelId !== modelId
        ? `已恢复这条历史，并切回 ${modelBaseName(historyModelId)}。可撤销。`
        : "已恢复这条历史的全部参数。可撤销。",
    );
  };

  // ── 引导 ────────────────────────────────────────────────────────────────

  const startPanelResize = (side: "left" | "right", event: React.PointerEvent<HTMLButtonElement>) => {
    // 收起态右栏宽度被 CSS 钉在 72px，先展开再让拖动接管，否则拖了没反应。
    if (side === "right" && !inspectorExpanded) setInspectorExpanded(true);
    const container = studioBodyRef.current?.clientWidth ?? 1200;
    panelResizeRef.current = {
      side,
      startX: event.clientX,
      startWidth: side === "left" ? panelWidths.left : panelWidths.right,
      container,
    };
    setResizingSide(side);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  const handlePanelResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const drag = panelResizeRef.current;
    if (!drag) return;
    const delta = event.clientX - drag.startX;
    if (drag.side === "left") {
      // 右栏至少 220、中栏至少 320，其余空间让给左栏。
      const max = drag.container - 220 - 320;
      const next = Math.min(Math.max(drag.startWidth + delta, 200), Math.max(max, 200));
      setPanelWidths((current) => (current.left === next ? current : { ...current, left: next }));
    } else {
      const max = drag.container - 200 - 320;
      const next = Math.min(Math.max(drag.startWidth - delta, 220), Math.max(max, 220));
      setPanelWidths((current) => (current.right === next ? current : { ...current, right: next }));
    }
  };

  const endPanelResize = () => {
    panelResizeRef.current = null;
    setResizingSide(null);
  };

  /**
   * 键盘调栏 + 双击复位。
   *
   * 分隔条原本只认 pointer 事件：不用鼠标的人完全没法调栏宽，而拖坏了比例
   * 也只能一点点拖回去。方向键每次 24px、Shift 加速到 96px，Home/双击回默认值。
   */
  const nudgePanel = useEventCallback((side: "left" | "right", delta: number) => {
    const container = studioBodyRef.current?.clientWidth ?? 1200;
    setPanelWidths((current) => {
      if (side === "left") {
        const max = Math.max(container - 220 - 320, 200);
        const next = Math.min(Math.max(current.left + delta, 200), max);
        return current.left === next ? current : { ...current, left: next };
      }
      const max = Math.max(container - 200 - 320, 220);
      const next = Math.min(Math.max(current.right + delta, 220), max);
      return current.right === next ? current : { ...current, right: next };
    });
  });

  const resetPanel = useEventCallback((side: "left" | "right") => {
    setPanelWidths((current) =>
      side === "left" ? { ...current, left: 440 } : { ...current, right: 320 },
    );
    setCanvasNotice(side === "left" ? "左栏宽度已复位。" : "右栏宽度已复位。");
  });

  const handleResizeKeyDown = useEventCallback(
    (side: "left" | "right", event: React.KeyboardEvent<HTMLButtonElement>) => {
      const step = event.shiftKey ? 96 : 24;
      // 左栏向右拖是变宽，右栏向右拖是变窄，所以右栏的方向要反过来。
      const sign = side === "left" ? 1 : -1;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        nudgePanel(side, -step * sign);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        nudgePanel(side, step * sign);
      } else if (event.key === "Home" || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        resetPanel(side);
      }
    },
  );

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

  useEffect(() => {
    let cancelled = false;
    const missing = shots.filter((shot) => !shotUrls[shot.id] && !shotUrlPendingRef.current.has(shot.id));
    if (!missing.length) return;
    missing.forEach((shot) => shotUrlPendingRef.current.add(shot.id));
    (async () => {
      // 并行读 IndexedDB：30 张缩略图从串行 N×RTT 降到 ~max(RTT)
      const entries = (await Promise.all(missing.map(async (shot) => {
        const blob = await getShotBlob(shot.id);
        return blob ? ([shot.id, URL.createObjectURL(blob)] as const) : null;
      }))).filter((entry): entry is readonly [string, string] => !!entry);
      missing.forEach((shot) => shotUrlPendingRef.current.delete(shot.id));
      if (cancelled) {
        entries.forEach(([, url]) => URL.revokeObjectURL(url));
        return;
      }
      if (entries.length) {
        setShotUrls((current) => ({ ...current, ...Object.fromEntries(entries) }));
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);

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
      <header className="pro-studio-topbar">
        {/* 左：站点标识 + 工作站名。专业模式顶栏已与全局导航合并，这里承担全站 header 角色。 */}
        <div className="flex min-w-0 items-center gap-2">
          <Link
            href="/"
            aria-label="回到首页"
            className="lg-float flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-ios-lg"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Emu" width={32} height={32} className="h-full w-full object-cover" />
          </Link>
          <h2 className="flex min-w-0 items-baseline gap-1.5 truncate text-ios-subhead font-bold text-[rgba(0,0,0,0.84)]">
            <span className="pro-title-desktop shrink-0">Emu · 创作工作站</span>
            <span className="pro-title-mobile">Emu</span>
          </h2>
          <p className="hidden truncate text-ios-caption1 font-semibold text-[rgba(0,0,0,0.40)] lg:block">{activeWorkspace.title}</p>
        </div>
        <div className="pro-mode-segment" id="pro-tour-segment" aria-label="中央视图切换">
          {WORKSPACE_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              onClick={() => activateWorkspace(mode.id)}
              className={cn(workspaceMode === mode.id && "is-active")}
              title={mode.title}
            >
              {mode.label}
            </button>
          ))}
        </div>
        {/*
          队列速览是按钮，不是状态灯。看到「失败 2」的下一个动作必然是
          「去看是哪两个」，纯 <span> 点下去没反应，用户只能自己去右栏找 tab。
          1024px 以下由 CSS 收起，让位给顶栏其余动作。
        */}
        <div className="pro-topbar-chips" role="group" aria-label="队列速览">
          <button type="button" data-state="done" onClick={() => executeCommand("open_gallery")} title="查看已完成的成片">
            已完成 {completedSlots}
          </button>
          <button type="button" data-state="running" onClick={() => executeCommand("open_queue")} title="查看正在生成的任务">
            进行中 {runningSlots}
          </button>
          <button type="button" data-state="failed" onClick={() => executeCommand("open_queue")} title="查看失败任务与原因">
            失败 {failedSlots}
          </button>
        </div>
        <div className="pro-topbar-actions flex shrink-0 items-center gap-2">
          {/* 全局导航右区并入：余额 / 历史 / 充值 / 账号，与工作站动作同栏。 */}
          {isLoggedIn && user && (
            <>
              <WalletBadge showTopUp={false} showCheckin={false} className="hidden min-w-0 xl:flex" />
              <CheckinCalendar className="hidden shrink-0 xl:flex" />
              <Link
                href="/history"
                aria-label="历史"
                title="历史"
                className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.56)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)] shadow-[0_8px_22px_rgba(45,49,66,0.06)] transition-all hover:bg-[rgba(255,255,255,0.74)] lg:inline-flex"
              >
                <History className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/pricing"
                aria-label="充值"
                title="充值"
                className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl bg-[#007AFF] px-3 py-1.5 text-ios-footnote font-semibold text-white shadow-[0_8px_22px_rgba(0,122,255,0.30)] transition-all hover:bg-[#0066DD] lg:inline-flex"
              >
                <CreditCard className="h-3.5 w-3.5" />
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => executeCommand("show_commands")}
            aria-label="查看工作台快捷键"
            title="快捷键（?）"
            className="pro-topbar-tool inline-flex items-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.56)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.58)] shadow-[0_8px_22px_rgba(45,49,66,0.06)] transition-all hover:bg-[rgba(255,255,255,0.74)]"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={startTour}
            aria-label="播放引导"
            title="播放引导"
            className="pro-topbar-tool inline-flex items-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.56)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.56)] shadow-[0_8px_22px_rgba(45,49,66,0.06)] transition-all hover:bg-[rgba(255,255,255,0.74)]"
          >
            <CircleHelp className="h-3.5 w-3.5" />
            <span className="pro-action-label">播放引导</span>
          </button>
          {isLoggedIn && user && (
            <div className="pro-topbar-tool hidden items-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.56)] px-3 py-1.5 xl:inline-flex">
              <User className="h-3.5 w-3.5 text-[rgba(0,0,0,0.44)]" aria-hidden="true" />
              <span className="max-w-[88px] truncate text-ios-footnote font-medium text-[rgba(0,0,0,0.56)]">
                {user.display_name || user.username}
              </span>
              <button
                type="button"
                onClick={logout}
                aria-label="退出登录"
                title="退出登录"
                className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-[rgba(0,0,0,0.44)] transition-colors hover:text-[rgba(0,0,0,0.72)]"
              >
                <LogOut className="h-3 w-3" />
              </button>
            </div>
          )}
          {onExitProfessionalMode && (
            <button
              type="button"
              onClick={onExitProfessionalMode}
              aria-label="返回普通模式"
              title="返回普通模式"
              className="pro-topbar-tool inline-flex items-center gap-2 rounded-ios-xl bg-[rgba(255,255,255,0.56)] px-3 py-1.5 text-ios-footnote font-semibold text-[rgba(0,0,0,0.56)] shadow-[0_8px_22px_rgba(45,49,66,0.06)] transition-all hover:bg-[rgba(255,255,255,0.74)]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="pro-action-label">返回普通模式</span>
            </button>
          )}
        </div>
      </header>

      {/*
        手机版的进度条。桌面版有顶栏三个数字 chip 和队列面板，手机版把它们都藏了，
        于是点完生成之后除了按钮变灰之外没有任何反馈，用户只能反复切到「产出」面板看。
      */}
      {(isLoading || runningSlots > 0) && (
        <div className="pro-mobile-progress" role="status" aria-live="polite">
          <div
            className="pro-run-progress-track"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={runTotal}
            aria-valuenow={runSettled}
            aria-label="生成进度"
          >
            <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
          </div>
          <span>
            {runSettled} / {runTotal}
            {runEtaLabel ? ` · ${runEtaLabel}` : ""}
          </span>
        </div>
      )}

      <div className="pro-mobile-bottom-area">
        <nav className="pro-mobile-nav" aria-label="工作面导航">
          {MOBILE_PANELS.map((panel) => (
            <button
              key={panel.id}
              type="button"
              aria-current={mobilePanel === panel.id ? "page" : undefined}
              onClick={() => activateMobilePanel(panel.id)}
              className={cn(mobilePanel === panel.id && "is-active")}
            >
              {panel.label}
            </button>
          ))}
        </nav>

        {/* 手机版生成按钮：有提示词才显示 */}
        {prompt.trim() && <div className="pro-mobile-generate-bar">
          <button
            type="button"
            onClick={handleRunClick}
            data-disabled={!canRun || undefined}
            aria-label={isLoading ? "正在生成" : `生成 ${copies} 张`}
            title={canRun ? "生成（⌘ Enter）" : isLoading ? "正在生成" : "先写画面描述"}
            className="pro-mobile-generate-btn"
          >
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>正在生成…</span>
              </>
            ) : (
              <span>生成 {copies} 张</span>
            )}
          </button>
        </div>}
      </div>

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
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-left-panel-prompt"
              aria-labelledby="pro-left-tab-prompt"
            >
              <div className="pro-accordion" id="pro-tour-prompt">
                <span className="pro-panel-title">
                  <Sparkles className="h-4 w-4" />
                  画面描述
                  <button type="button" className="pro-inline-panel-link" onClick={() => setLeftPanelTab("assets")}>
                    <Images className="h-3.5 w-3.5" />
                    参考图
                    <em>{referenceImages.length}</em>
                  </button>
                </span>
                <div className="relative">
                  {/*
                    id 必须留在这块「画面描述」上：`/` 热键与空态 CTA 都是
                    document.querySelector("#pro-prompt-input").focus()，旧版这个 id 挂在
                    下面折叠起来的「补充说明」里 —— 按 `/` 会展开一个用户没想写的框，
                    真正要写的主输入框反而没拿到焦点。
                    resize-y + 200px 起高：一段完整的商品描述在 128px 里只能看到 4 行。
                  */}
                  <textarea
                    id="pro-prompt-input"
                    aria-label="画面描述"
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    placeholder="例如：奶白色护肤精华放在哑光石台上，柔和晨光，背景虚化。"
                    className="min-h-[200px] w-full resize-y rounded-ios-2xl border-0 bg-[rgba(255,255,255,0.42)] px-3.5 py-3 pb-12 text-ios-footnote text-[rgba(0,0,0,0.78)] outline-none ring-0 transition-all focus:bg-[rgba(255,255,255,0.64)] focus:ring-2 focus:ring-[rgba(0,122,255,0.18)]"
                  />
                  <ReferenceImageUpload variant="prompt" value={referenceImages} onChange={onReferenceImagesChange} onWorkflowDetected={restoreProvenanceConfigFromPng} />
                </div>
                <div className="pro-prompt-meter">
                  {promptStats.chars ? (
                    <>
                      <span>{promptStats.chars} 字</span>
                      <strong>{promptStats.state}</strong>
                    </>
                  ) : (
                    <span>尚未输入</span>
                  )}
                </div>
              </div>

              <details
                className="pro-accordion"
                id="pro-tour-resources"
                open={sectionOpen.resources}
                onToggle={(event) => toggleSection("resources", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Library className="h-4 w-4" />
                    创作模板
                    <em className="pro-title-count">{CREATIVE_TEMPLATE_COUNT}</em>
                  </span>
                </summary>
                <p className="pro-section-note">场景与模型配方统一管理；套用前会列出被替换的字段。</p>
                <CreatorResourcePanel
                  onApplyResource={applyCreatorResource}
                  onApplyScenario={applyScenario}
                  undoLabel={templateUndo?.label}
                  onUndo={undoTemplateApply}
                />
              </details>

              {/*
                服务端配方（/v1/templates）：选好就直接提交，走自己的计价与队列，
                不经过左栏的提示词与运行条。上面那节是「填进当前表单」，这节是「直接出图」，
                两者的区别写在小字里，避免用户以为重复。
              */}
              <details
                className="pro-accordion"
                open={sectionOpen.presets}
                onToggle={(event) => toggleSection("presets", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Wand2 className="h-4 w-4" />
                    模板出图
                  </span>
                </summary>
                <p className="pro-section-note">选好配方直接提交，独立计价，不改动当前表单。</p>
                <TemplatePanel
                  token={token}
                  onSubmit={(config, resultUrl) => {
                    if (resultUrl) onTemplateResult?.(resultUrl);
                    else setCanvasNotice("模板生成已提交；结果稍后出现在成片墙。", "info");
                  }}
                />
              </details>

              <details
                className="pro-accordion"
                open={sectionOpen.style}
                onToggle={(event) => toggleSection("style", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Palette className="h-4 w-4" />
                    风格
                    {activeStyle && <em className="pro-title-count">{activeStyle.name}</em>}
                  </span>
                </summary>
                <p className="pro-section-note">选择风格后，生成时会加入对应提示词。</p>
                <StyleGrid
                  category={styleCategory}
                  selectedId={styleTemplateId}
                  onCategoryChange={setStyleCategory}
                  onToggle={handleToggleStyle}
                />
                {activeStyle && (
                  <button type="button" onClick={() => setStyleTemplateId(null)} className="pro-add-row-button">
                    取消风格「{activeStyle.name}」
                  </button>
                )}
              </details>

              <details
                className="pro-accordion pro-collapsed-mobile"
                open={sectionOpen.more}
                onToggle={(event) => toggleSection("more", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <SlidersHorizontal className="h-4 w-4" />
                    更多要求
                    {(activeRegionalPrompts.length > 0 || contextPrompt.trim() || negativePrompt.trim() || hasBrandKit(brandKit)) && (
                      <em className="pro-title-count">已设置</em>
                    )}
                  </span>
                </summary>
                <p className="pro-section-note">仅在需要精细控制时填写；留空不会影响生成。</p>

                <section className="pro-requirement-group">
                  <div className="pro-requirement-heading">
                    <span>构图要求</span>
                    {activeRegionalPrompts.length > 0 && <em>{activeRegionalPrompts.length}</em>}
                  </div>
                  <p>补充留白、位置或主体大小，不模拟不存在的区域蒙版。</p>
                  <div className="pro-regional-list">
                    {regionalPrompts.map((item) => (
                      <div key={item.id} className={cn("pro-regional-row", !item.enabled && "is-muted")}>
                        <button
                          type="button"
                          onClick={() => updateRegionalPrompt(item.id, { enabled: !item.enabled })}
                          className={cn("pro-layer-toggle", item.enabled && "is-active")}
                          title={item.enabled ? "停用这条要求（不发送）" : "启用这条要求"}
                          aria-label={item.enabled ? "停用这条要求" : "启用这条要求"}
                        />
                        <input
                          value={item.text}
                          onChange={(event) => updateRegionalPrompt(item.id, { text: event.target.value })}
                          placeholder="例如：左上角留出干净的文案空间"
                          className="w-full rounded-ios-xl border-0 bg-white/40 px-2.5 py-1.5 text-[11px] font-semibold text-[rgba(0,0,0,0.68)] outline-none transition-all focus:bg-white/60 focus:ring-2 focus:ring-[rgba(0,122,255,0.16)]"
                        />
                        <button type="button" onClick={() => removeRegionalPrompt(item.id)} className="pro-layer-remove">移除</button>
                      </div>
                    ))}
                  </div>
                  <button type="button" onClick={() => addRegionalPrompt()} className="pro-add-row-button">
                    <Plus className="h-3 w-3" />
                    添加构图要求
                  </button>
                </section>

                <section className="pro-requirement-group">
                  <div className="pro-requirement-heading">
                    <span>项目与品牌</span>
                    {hasBrandKit(brandKit) && <em>已保存</em>}
                  </div>
                  <textarea
                    id="pro-context-input"
                    value={contextPrompt}
                    onChange={(event) => setContextPrompt(event.target.value)}
                    placeholder="项目背景、受众、投放渠道或画面限制"
                    className="min-h-[88px] w-full resize-none rounded-ios-2xl border-0 bg-[rgba(255,255,255,0.38)] px-3.5 py-3 text-ios-footnote text-[rgba(0,0,0,0.72)] outline-none ring-0 transition-all focus:bg-[rgba(255,255,255,0.58)] focus:ring-2 focus:ring-[rgba(0,122,255,0.16)]"
                  />
                  <div className="pro-brand-form">
                    <input value={brandKit.brandName} onChange={(event) => setBrandKit((current) => ({ ...current, brandName: event.target.value }))} placeholder="品牌名称" />
                    <input value={brandKit.colors} onChange={(event) => setBrandKit((current) => ({ ...current, colors: event.target.value }))} placeholder="品牌主色" />
                    <input value={brandKit.tone} onChange={(event) => setBrandKit((current) => ({ ...current, tone: event.target.value }))} placeholder="品牌语气" />
                    <input value={brandKit.bannedWords} onChange={(event) => setBrandKit((current) => ({ ...current, bannedWords: event.target.value }))} placeholder="品牌禁用元素" />
                  </div>
                  <div className="pro-requirement-actions">
                    <button type="button" onClick={handleSaveBrandKit}>保存品牌</button>
                    <button type="button" onClick={handleClearBrandKit}>清空</button>
                  </div>
                  {brandKitMessage && <p className="pro-requirement-message">{brandKitMessage}</p>}
                </section>

                <section className="pro-requirement-group">
                  <div className="pro-requirement-heading"><span>避免内容</span></div>
                  <textarea
                    value={negativePrompt}
                    onChange={(event) => setNegativePrompt(event.target.value)}
                    placeholder="例如：水印、畸形手指、文字乱码、低清晰度"
                    className="min-h-[80px] w-full resize-none rounded-ios-2xl border-0 bg-[rgba(255,255,255,0.38)] px-3.5 py-3 text-ios-footnote text-[rgba(0,0,0,0.72)] outline-none ring-0 transition-all focus:bg-[rgba(255,255,255,0.58)] focus:ring-2 focus:ring-[rgba(0,122,255,0.16)]"
                  />
                </section>
              </details>
            </div>
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
                  <p className="rounded-ios-xl bg-white/30 px-3 py-2 text-[11px] font-semibold text-[rgba(0,0,0,0.38)]">
                    还没有参考图。可直接生成，也可以上传产品图或人物图。
                  </p>
                )}
              </div>
            </div>
          )}

          {leftPanelTab === "settings" && (
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-left-panel-settings"
              aria-labelledby="pro-left-tab-settings"
            >
              <details
                className="pro-accordion"
                open={sectionOpen.size}
                onToggle={(event) => toggleSection("size", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <SlidersHorizontal className="h-4 w-4" />
                    尺寸
                  </span>
                </summary>
                <p className="pro-section-note">
                  {isVideoModel
                    ? `影片按模型默认画幅生成（${generationModel(modelId)?.aspectRatios.slice(0, 3).join(" / ")}）。`
                    : "选择一个或多个版位。多选时，每张图会轮流使用不同尺寸。"}
                </p>
                {!isVideoModel && (
                <div className="pro-size-options">
                  {sizeOptions.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => toggleImageSize(option.id)}
                      className={cn(imageSizes.includes(option.id) && "is-active")}
                      title={option.usage}
                    >
                      <strong>{option.label}</strong>
                      <small>{option.usage}</small>
                    </button>
                  ))}
                </div>
                )}
                {/* 模型选择已上移到左栏常驻顶栏（.pro-model-row）：
                    它决定了这一页每一个可选项，藏在第三个 tab 的手风琴里没有道理。
                    这里不再放第二个 ModelPicker —— 两个实例共用 modelMenuOpen，
                    会同时展开成两张下拉。 */}
                {isVideoModel && (
                  <>
                    {modelDurations(modelId).length > 0 && (
                      <label className="pro-control-row">
                        <span>时长</span>
                        <select value={durationSeconds} onChange={(event) => setDurationSeconds(Number(event.target.value))}>
                          {modelDurations(modelId).map((seconds) => (
                            <option key={seconds} value={seconds}>{seconds} 秒</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {modelSupportsAudio(modelId) && (
                      <label className="pro-control-row">
                        <span>音效</span>
                        <select value={generateAudio ? "1" : "0"} onChange={(event) => setGenerateAudio(event.target.value === "1")}>
                          <option value="0">关闭</option>
                          <option value="1">开启</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                {isPixaiModel && (
                  <details
                    id="pro-tour-lora-section"
                    className="pro-accordion pro-collapsed-mobile min-w-0 max-w-full overflow-hidden"
                    open={loraPanelOpen}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setLoraPanelOpen(open);
                      if (open) setInspectorExpanded(false);
                    }}
                  >
                    <summary>
                      <span className="pro-panel-title">
                        <Sparkles className="h-4 w-4" />
                        LoRA 风格
                        {selectedLora && <em className="pro-title-count">已选</em>}
                      </span>
                    </summary>
                    <p className="pro-section-note">叠加 LoRA 模型改变画风。仅 PixAI 模型支持。</p>
                    <LoraLibraryPanel value={selectedLora} onChange={setSelectedLora} />
                  </details>
                )}
                <label className="pro-control-row">
                  <span>质量</span>
                  <select value={qualityProfile} onChange={(event) => setQualityProfile(event.target.value)}>
                    {qualityOptions.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="pro-control-row">
                  <span>用途</span>
                  <select value={productionIntent} onChange={(event) => setProductionIntent(event.target.value)}>
                    {PRODUCTION_INTENT_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{option.label}</option>
                    ))}
                  </select>
                </label>
                {/*
                  这个字段从来不是「随机种子」。

                  它最终只会作为 `Seed hint: xxx` 一行追加进提示词（见 generation-workflow
                  的 buildWorkflowPromptSection），上游 API 根本没有暴露 seed 参数。
                  旧版 placeholder 写「固定随机种子」——用户填了以为两次出图会一致，
                  结果完全不同，只会怀疑是系统坏了。这里改成它真实的作用：批次备注。
                */}
                <label className="pro-control-row pro-control-row--stack">
                  <span>批次备注</span>
                  <input
                    value={seedHint}
                    onChange={(event) => setSeedHint(event.target.value)}
                    placeholder="例如 618-主图-v3，会写入提示词便于复现"
                  />
                </label>
                <p className="pro-section-note">备注会附在提示词末尾一起提交，方便日后按批次检索。上游模型不支持固定种子，两次生成不会完全一致。</p>
              </details>

              <details
                className="pro-accordion"
                open={sectionOpen.count}
                onToggle={(event) => toggleSection("count", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Gauge className="h-4 w-4" />
                    数量
                  </span>
                </summary>
                <label className="pro-control-row pro-range-control">
                  <span>张数</span>
                  <input id="pro-copies" min={1} max={8} type="range" value={copies} aria-valuetext={`${copies} 张`} onChange={(event) => setCopies(Number(event.target.value))} />
                  <output htmlFor="pro-copies">{copies} 张</output>
                </label>
                <label className="pro-control-row pro-range-control">
                  <span>并行</span>
                  <input id="pro-concurrency" min={1} max={4} type="range" value={concurrency} aria-valuetext={`${concurrency} 个任务`} onChange={(event) => setConcurrency(Number(event.target.value))} />
                  <output htmlFor="pro-concurrency">{concurrency}</output>
                </label>
                <div className="mt-3 rounded-ios-2xl bg-[rgba(255,255,255,0.38)] px-3 py-2 text-ios-caption1 font-semibold text-[rgba(0,0,0,0.54)]">
                  预计 {copies} {runUnit} · {totalCoins} 币 · {isVideoModel
                    ? `${durationSeconds ?? defaultDuration(modelId)} 秒${generateAudio ? " · 含音效" : ""}`
                    : imageSizeLabel}
                </div>
              </details>

            </div>
          )}

          {/*
            运行条常驻左栏底部：主按钮和提示词框在同一列，鼠标不再横穿整个屏幕。
            右上角那颗生成按钮保留（键盘党和肌肉记忆），但主路径在这里。
            摘要行把「模型 · 画幅 · 张数 · 总币」摊开，用户不必点进第三个 tab 才知道花多少。
          */}
          <div className="pro-run-bar">
            <div className="pro-run-summary">
              <span>{modelBaseName(modelId)}</span>
              <span>{isVideoModel ? `${durationSeconds ?? defaultDuration(modelId)} 秒` : imageSizeLabel}</span>
              <span>{copies} {runUnit}</span>
              <strong>{totalCoins} 币</strong>
            </div>
            <button
              type="button"
              onClick={handleRunClick}
              aria-label={isLoading ? "正在生成" : `生成 ${copies} ${runUnit}`}
              title={canRun ? "生成（⌘ Enter）" : isLoading ? "正在生成" : "先写画面描述"}
              className="pro-run-primary"
              data-disabled={!canRun || undefined}
            >
              <Play className="h-4 w-4" />
              {isLoading ? (
                "正在生成…"
              ) : (
                <>
                  生成
                  {/* 张数与总币单独成节点：窄栏下先收这一段，「生成」二字永远留在按钮上 */}
                  <span className="pro-run-count"> {copies} {runUnit} · {totalCoins} 币</span>
                </>
              )}
            </button>
          </div>
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
        <main className="pro-canvas-stage pro-glass-panel" data-workspace-mode={workspaceMode}>
          <div className="pro-canvas-header">
            <div className="pro-panel-title">
              <Layers3 className="h-4 w-4" />
              {activeWorkspace.title}
            </div>
            {/*
              旧版是 {canvasNotice || capabilityNotice}：只要有任何一条普通通知在，
              「该模型不支持参考图」这类能力警告就被吃掉；且样式 white-space: nowrap
              会把长句截成「已调整版位：所选模型不支…」。现在两条各自渲染、可换行、
              error 级带关闭钮，且 error 用 role="alert" 让读屏器立刻播报。
            */}
            <div className="pro-canvas-notices">
              {capabilityNotice && (
                <em className="pro-canvas-notice" data-level="warn" role="status">
                  {capabilityNotice}
                </em>
              )}
              {notice && (
                <em
                  className="pro-canvas-notice"
                  data-level={notice.level}
                  role={notice.level === "error" ? "alert" : "status"}
                >
                  {notice.text}
                  {notice.level === "error" && (
                    <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </em>
              )}
            </div>
          </div>

          <div className="pro-canvas-preview" data-canvas-tool={activeCanvasTool} data-zoom={canvasZoom}>
            {workspaceMode === "viewer" ? (
              <div className="pro-viewer-grid">
                <div className="pro-gallery-toolbar">
                  <button type="button" onClick={() => setViewerGalleryMode("images")} className={cn(viewerGalleryMode === "images" && "is-active")}>
                    成片
                  </button>
                  <button type="button" onClick={() => setViewerGalleryMode("assets")} className={cn(viewerGalleryMode === "assets" && "is-active")}>
                    参考图
                  </button>
                  <button type="button" onClick={() => setViewerGalleryMode("boards")} className={cn(viewerGalleryMode === "boards" && "is-active")}>
                    <FolderOpen className="mr-1 inline h-3 w-3" />
                    文件夹 {shots.length > 0 && shots.length}
                  </button>
                </div>
                {viewerGalleryMode === "boards" ? renderBoardsPanel() : (
                <div className="pro-gallery-grid">
                  {viewerGalleryMode === "images" && allResults.map((image, index) => {
                    const ready = Boolean(image.image || image.imageUrl || image.videoUrl);
                    return (
                    /*
                     * 卡片外面多包一层：下载钮不能写在 <button> 里面（嵌套 button 是无效
                     * HTML，浏览器会把内层拆出去，点击行为随引擎而变），旧版把下载藏在
                     * 全屏灯箱里也是同一个原因 —— 现在它是卡片的兄弟节点，绝对定位盖在角上。
                     */
                    <div key={resultKey(image) || index} className="pro-gallery-item">
                    <button
                      type="button"
                      onClick={() => openResultOnCanvas(image)}
                      disabled={!ready}
                      title={ready ? "打开这张成片" : "等待生成"}
                      className={cn("pro-gallery-card", resultKey(image) === resultKey(visibleResult ?? image) && ready && "is-selected")}
                    >
                      {ready ? (
                        image.mediaType === "video" && image.videoUrl ? (
                          <video src={image.videoUrl} muted playsInline className="h-full w-full object-cover" />
                        ) : (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={resultSrc(image)} alt="生成结果" />
                        )
                      ) : (
                        <div className="pro-gallery-empty">等待生成</div>
                      )}
                      {/*
                        旧版是 SLOT_STATE_LABELS[slotItems[index]?.state]：allResults 按
                        images→tasks 顺序拼接，slotItems 按 tasks 倒序排列，两个数组用同一个
                        下标取值 —— 于是第 3 张成片可能显示第 3 个任务（完全无关）的状态。
                        现在按 id 查，查不到就说明它只存在于本地数组，直接按有无媒体判断。
                      */}
                      <span>{ready ? "已完成" : SLOT_STATE_LABELS[slotStateFor(image)]}</span>
                    </button>
                    {ready && image.mediaType !== "video" && (
                      <button
                        type="button"
                        className="pro-gallery-download"
                        onClick={() => void downloadResult(image)}
                        aria-label="下载这张成片"
                        title="下载这张成片"
                      >
                        <Download className="h-3 w-3" />
                      </button>
                    )}
                    </div>
                    );
                  })}
                  {viewerGalleryMode === "assets" && referenceImages.map((image) => (
                    <div key={image.id} className="pro-gallery-card">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={image.previewUrl} alt={image.name} />
                      <span>{image.name}</span>
                    </div>
                  ))}
                </div>
                )}
                {((viewerGalleryMode === "images" && allResults.length === 0) || (viewerGalleryMode === "assets" && referenceImages.length === 0)) && (
                  <div className="pro-canvas-empty">
                    <Images className="h-8 w-8 text-[rgba(0,0,0,0.28)]" />
                    <span>{viewerGalleryMode === "images" ? "还没有成片" : "还没有参考图"}</span>
                    {/*
                      空态的下一步是「去写提示词」，不是「回到画布」——
                      旧版这个按钮把用户送回一个同样空白的画布，等于原地打转。
                    */}
                    {viewerGalleryMode === "images" ? (
                      <button type="button" onClick={() => executeCommand("focus_prompt")} className="pro-empty-cta">
                        去写画面描述
                      </button>
                    ) : (
                      <button type="button" onClick={() => setLeftPanelTab("assets")} className="pro-empty-cta">
                        去添加参考图
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <>
                {visibleResult ? (
                  visibleResult.mediaType === "video" && visibleResult.videoUrl ? (
                    <video
                      src={visibleResult.videoUrl}
                      controls
                      playsInline
                      onClick={() => setLightboxOpen(true)}
                      className="pro-canvas-media h-full w-full cursor-zoom-in object-contain"
                    />
                  ) : canvasZoom === "actual" ? (
                    <div
                      ref={canvasViewportRef}
                      className="pro-canvas-actual"
                      data-panning={isPanning ? "true" : undefined}
                      onPointerDown={startPan}
                      onPointerMove={movePan}
                      onPointerUp={endPan}
                      onPointerCancel={endPan}
                      onDoubleClick={resetZoom}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={resultSrc(visibleResult)}
                        alt="生成结果"
                        draggable={false}
                        style={{
                          transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomScale})`,
                          transformOrigin: "center center",
                        }}
                      />
                    </div>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      ref={baseImageRef}
                      src={resultSrc(visibleResult)}
                      alt="生成结果"
                      onClick={() => setLightboxOpen(true)}
                      className="pro-canvas-media h-full w-full cursor-zoom-in object-contain"
                    />
                  )
                ) : isLoading || runningSlots > 0 ? (
                  /*
                    生成中的画布不再是一句「在左侧描述画面，然后生成」——
                    那句话在已经点了生成之后是错的，用户看着它会以为自己没点上。
                    现在是骨架屏 + 真实进度 + 预计剩余时间。
                  */
                  <div className="pro-canvas-skeleton" role="status" aria-live="polite">
                    <div className="pro-canvas-skeleton-frame" aria-hidden="true" />
                    <div className="pro-canvas-skeleton-copy">
                      <strong>正在生成 {runTotal} {runUnit}</strong>
                      <div
                        className="pro-run-progress-track"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={runTotal}
                        aria-valuenow={runSettled}
                        aria-label="生成进度"
                      >
                        <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
                      </div>
                      <span>
                        {runSettled} / {runTotal} 已落地
                        {runEtaLabel ? ` · 预计还需 ${runEtaLabel}` : ""}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="pro-canvas-empty">
                    <Bot className="h-8 w-8 text-[rgba(0,0,0,0.28)]" />
                    <span>在左侧描述画面，然后生成。</span>
                    <button type="button" onClick={() => executeCommand("focus_prompt")} className="pro-empty-cta">
                      去写画面描述
                    </button>
                  </div>
                )}
                {canvasZoom === "fit" && (
                  <canvas
                    ref={annotationCanvasRef}
                    className="pro-annotate-layer"
                    data-active={activeCanvasTool !== "select"}
                    onPointerDown={handleAnnotationPointerDown}
                    onPointerMove={handleAnnotationPointerMove}
                    onPointerUp={handleAnnotationPointerUp}
                    onPointerCancel={handleAnnotationPointerUp}
                    aria-label="画布标注层"
                  />
                )}
                {visibleResult && (
                  <div className="pro-zoom-toggle" aria-label="画布缩放">
                    <button type="button" onClick={() => setCanvasZoom("fit")} className={cn(canvasZoom === "fit" && "is-active")}>
                      适应
                    </button>
                    <button type="button" onClick={() => setCanvasZoom("actual")} className={cn(canvasZoom === "actual" && "is-active")}>
                      原图大小
                    </button>
                    {/* 原图模式下把当前倍率写出来：不然滚了半天不知道自己在几倍，也找不到回 100% 的路 */}
                    {canvasZoom === "actual" && (
                      <>
                        <button type="button" onClick={() => zoomAtPointer(1 / 1.25)} aria-label="缩小" title="缩小">
                          −
                        </button>
                        <button type="button" onClick={resetZoom} title="回到 100%（双击画布同效）">
                          {Math.round(zoomScale * 100)}%
                        </button>
                        <button type="button" onClick={() => zoomAtPointer(1.25)} aria-label="放大" title="放大">
                          ＋
                        </button>
                      </>
                    )}
                  </div>
                )}
                {viewableResults.length > 1 && (
                  <div className="pro-canvas-pager" role="group" aria-label="切换成片">
                    <button type="button" onClick={() => stepResult(-1)} aria-label="上一张（←）" title="上一张（←）">
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span aria-live="polite">{visibleResultIndex + 1} / {viewableResults.length}</span>
                    <button type="button" onClick={() => stepResult(1)} aria-label="下一张（→）" title="下一张（→）">
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </div>
                )}
                {/*
                  漂移提示不放进 pro-canvas-meta —— 那条信息条默认半透明、鼠标移上去才显形，
                  而「你看到的图不是当前设置的结果」正是必须主动撞进视线的一句话。
                */}
                {visibleResult && staleConfigFields.length > 0 && dismissedStaleResultKey !== resultKey(visibleResult) && (
                  <div className="pro-canvas-stale" role="status">
                    <AlertTriangle className="h-3 w-3" />
                    <span>这张图不是当前设置的结果（{staleConfigFields.join("、")}）</span>
                    <button type="button" onClick={restoreVisibleResultConfig} title="把编辑器改回产出这张图时的设置">
                      改回这张图的设置
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedStaleResultKey(resultKey(visibleResult))}
                      aria-label="忽略此提示"
                      title="忽略"
                      className="pro-canvas-stale-dismiss"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                )}
                {visibleResult && (
                  <div className="pro-canvas-meta">
                    <span>{formatPublicGenerationSummary(visibleResult)}</span>
                    {/*
                      下载原本只存在于全屏灯箱里 —— 要拿到文件必须先点开大图再找按钮。
                      成片最常做的一件事不该藏在二级界面。
                    */}
                    <button type="button" onClick={() => void downloadResult(visibleResult)} title="下载这张成片" aria-label="下载">
                      <Download className="h-3 w-3" />
                    </button>
                    {!(visibleResult.mediaType === "video") && (
                      <>
                        <button type="button" onClick={() => sendResultToAssets(visibleResult)}>
                          设为参考
                        </button>
                        <button type="button" onClick={() => saveResultToBoard(visibleResult)} title="保存到文件夹">
                          存入文件夹
                        </button>
                      </>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/*
            成片缩略条。
            旧版画布一次只看得到一张，想看这批里的其他张必须切到「成片墙」——
            而那是一次硬切换：画布、标注、缩放全部离开视线，看完还要再切回来。
            缩略条把「这批有哪些」压在画布下沿，切换成本降到一次点击。
          */}
          {workspaceMode === "canvas" && viewableResults.length > 1 && (
            <div className="pro-film-strip" role="listbox" aria-label="这批成片">
              {viewableResults.map((image, index) => (
                <button
                  key={resultKey(image) || index}
                  type="button"
                  role="option"
                  aria-selected={index === visibleResultIndex}
                  className={cn(index === visibleResultIndex && "is-active")}
                  onClick={() => openResultOnCanvas(image)}
                  title={`第 ${index + 1} 张`}
                >
                  {image.mediaType === "video" ? (
                    <span className="pro-film-strip-video">
                      <Play className="h-3 w-3" />
                    </span>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img src={resultSrc(image)} alt={`第 ${index + 1} 张成片`} draggable={false} />
                  )}
                  <em>{index + 1}</em>
                </button>
              ))}
            </div>
          )}

          <div className="pro-canvas-dock" id="pro-tour-canvas-tools">
            <div className="pro-tool-strip" role="group" aria-label="画布工具">
              {CANVAS_TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  type="button"
                  onClick={() => {
                    setActiveCanvasTool(tool.id);
                    if (workspaceMode !== "canvas") activateWorkspace("canvas");
                    if (canvasZoom !== "fit") setCanvasZoom("fit");
                    setCanvasNotice(tool.id === "select" ? "" : tool.hint);
                  }}
                  className={cn(activeCanvasTool === tool.id && "is-active")}
                  title={tool.hint}
                >
                  {tool.label}
                </button>
              ))}
            </div>
            {/*
              笔粗选择。旧版画笔固定 6px、橡皮固定 26px：圈一只眼睛太粗，
              涂掉一整片背景又太细，只能靠反复描。
            */}
            {activeCanvasTool !== "select" && (
              <div className="pro-brush-strip" role="group" aria-label="笔刷粗细">
                {BRUSH_SIZES.map((size) => (
                  <button
                    key={size.value}
                    type="button"
                    aria-pressed={brushSize === size.value}
                    title={`${size.label}（${size.value}px）`}
                    onClick={() => setBrushSize(size.value)}
                    className={cn(brushSize === size.value && "is-active")}
                  >
                    <span style={{ width: size.dot, height: size.dot }} aria-hidden="true" />
                    {size.label}
                  </button>
                ))}
              </div>
            )}
            <div className="pro-dock-actions">
              {strokeCount > 0 && (
                <button type="button" onClick={undoAnnotation} title="撤销最后一笔（Ctrl/⌘+Z）">
                  <Undo2 className="h-3 w-3" />
                  撤销
                </button>
              )}
              {hasAnnotation && (
                <>
                  <button type="button" onClick={exportAnnotationToReference} title="把标注设为参考图">
                    <ImagePlus className="h-3 w-3" />
                    设为参考
                  </button>
                  <button type="button" onClick={clearAnnotation} title="清空画布上的标注">
                    清空标注
                  </button>
                </>
              )}
              <button type="button" onClick={() => copyProvenanceConfig(visibleResult)} title="复制当前配置，可稍后导入。">
                <Clipboard className="h-3 w-3" />
                复制配置
              </button>
              {visibleResult && !(visibleResult.mediaType === "video") && (
                <button type="button" onClick={() => sendResultToAssets(visibleResult)} title="把当前成片设为参考图">
                  设为参考
                </button>
              )}
            </div>
          </div>
        </main>

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
        <aside className="pro-inspector pro-glass-panel">
          <div
            className="pro-inspector-tabs"
            id="pro-tour-inspector"
            role="tablist"
            aria-label="产出面板"
            aria-orientation="horizontal"
            onKeyDown={(event) => {
              const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!delta) return;
              event.preventDefault();
              const index = INSPECTOR_TABS.findIndex((tab) => tab.id === inspectorTab);
              const next = INSPECTOR_TABS[(index + delta + INSPECTOR_TABS.length) % INSPECTOR_TABS.length];
              setInspectorTab(next.id);
              setInspectorExpanded(true);
              requestAnimationFrame(() => document.getElementById(`pro-inspector-tab-${next.id}`)?.focus());
            }}
          >
            {INSPECTOR_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`pro-inspector-tab-${tab.id}`}
                aria-selected={inspectorTab === tab.id}
                aria-controls={`pro-inspector-panel-${tab.id}`}
                tabIndex={inspectorTab === tab.id ? 0 : -1}
                aria-label={tab.label}
                title={tab.label}
                onClick={() => {
                  // 再点一次当前 tab = 收起右栏，把宽度让给画布；这是唯一不需要额外控件的收放手势。
                  if (inspectorTab === tab.id && inspectorExpanded) {
                    setInspectorExpanded(false);
                    return;
                  }
                  setInspectorTab(tab.id);
                  setInspectorExpanded(true);
                  setLoraPanelOpen(false);
                }}
                className={cn(inspectorTab === tab.id && "is-active")}
              >
                {tab.id === "queue" ? (
                  <Gauge className="pro-inspector-tab-icon" aria-hidden="true" />
                ) : tab.id === "gallery" ? (
                  <Images className="pro-inspector-tab-icon" aria-hidden="true" />
                ) : (
                  <RotateCcw className="pro-inspector-tab-icon" aria-hidden="true" />
                )}
                <span className="pro-inspector-tab-label">{tab.label}</span>
              </button>
            ))}
          </div>
          {/*
            显式收放按钮。
            原本右栏只能靠「点左栏里任意按钮」这种隐式手势收起，用户根本猜不到；
            收起后也没有任何可见的把手能再展开。放在 tablist 外面，
            因为 role="tablist" 里不能塞非 tab 的按钮。
          */}
          <button
            type="button"
            className="pro-inspector-collapse"
            aria-expanded={inspectorExpanded}
            aria-label={inspectorExpanded ? "收起右栏" : "展开右栏"}
            title={inspectorExpanded ? "收起右栏" : "展开右栏"}
            onClick={() => setInspectorExpanded((current) => !current)}
          >
            {inspectorExpanded ? (
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </button>
          <p className="pro-panel-hint">{activeInspectorTab.hint}</p>

          {inspectorTab === "queue" && (
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-inspector-panel-queue"
              aria-labelledby="pro-inspector-tab-queue"
            >
              <details
                className="pro-accordion"
                open={sectionOpen.queue}
                onToggle={(event) => toggleSection("queue", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Gauge className="h-4 w-4" />
                    队列
                  </span>
                </summary>
                {/*
                  队列里也放一条进度：数字格子只说「进行中 3」，不说「3 还要多久」。
                */}
                {(isLoading || runningSlots > 0) && (
                  <div className="pro-run-progress" role="status" aria-live="polite">
                    <div
                      className="pro-run-progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={runTotal}
                      aria-valuenow={runSettled}
                      aria-label="生成进度"
                    >
                      <span style={{ width: `${Math.round(runProgress * 100)}%` }} />
                    </div>
                    <p>
                      {runSettled} / {runTotal} 已落地
                      {runEtaLabel ? ` · 预计还需 ${runEtaLabel}` : ""}
                    </p>
                  </div>
                )}
                <div className="pro-metric-grid">
                  <div className="pro-metric-card">
                    <span>任务</span>
                    <strong>{tasks.length || copies}</strong>
                  </div>
                  <div className="pro-metric-card">
                    <span>进行中</span>
                    <strong>{runningSlots}</strong>
                  </div>
                  <div className="pro-metric-card">
                    <span>已完成</span>
                    <strong>{completedSlots}</strong>
                  </div>
                  <div className="pro-metric-card">
                    <span>失败</span>
                    <strong>{failedSlots}</strong>
                  </div>
                </div>
                <QueueSlotList slots={slotItems} onSelect={openTaskSlot} onRetry={retrySlot} />
                {/* 重试走失败任务自带的配置，与编辑器当前有没有提示词无关，所以不看 canRun */}
                <button
                  type="button"
                  onClick={() => firstFailedTask ? retryTask(firstFailedTask) : run(Math.max(1, failedSlotCount))}
                  disabled={isLoading || failedSlotCount === 0}
                  title={failedSlotCount ? `用当前配置重新生成 ${failedSlotCount} 个失败任务` : "没有失败任务"}
                  className="mt-2 inline-flex w-full items-center justify-center gap-1 rounded-ios-xl bg-[rgba(255,255,255,0.46)] px-3 py-2 text-[11px] font-bold text-[rgba(0,0,0,0.56)] transition-colors hover:bg-white/70 disabled:text-[rgba(0,0,0,0.24)]"
                >
                  <RotateCcw className="h-3 w-3" />
                  重试失败任务
                </button>
              </details>

            </div>
          )}

          {inspectorTab === "gallery" && (
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-inspector-panel-gallery"
              aria-labelledby="pro-inspector-tab-gallery"
            >
              <details
                className="pro-accordion"
                open={sectionOpen.gallery}
                onToggle={(event) => toggleSection("gallery", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <Images className="h-4 w-4" />
                    图库
                  </span>
                </summary>
                <div className="pro-gallery-toolbar">
                  <button type="button" onClick={() => setInspectorGalleryMode("images")} className={cn(inspectorGalleryMode === "images" && "is-active")}>
                    成片
                  </button>
                  <button type="button" onClick={() => setInspectorGalleryMode("assets")} className={cn(inspectorGalleryMode === "assets" && "is-active")}>
                    参考图
                  </button>
                  <button type="button" onClick={() => setInspectorGalleryMode("boards")} className={cn(inspectorGalleryMode === "boards" && "is-active")}>
                    文件夹
                  </button>
                </div>
                {inspectorGalleryMode === "boards" ? renderBoardsPanel() : (
                <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto pr-1">
                  {inspectorGalleryMode === "images" && allResults.map((image, index) => (
                    <div key={image.resultId ?? image.slotId ?? index} className={cn("pro-provenance-card", (image.resultId ?? image.slotId) === selectedSlotId && "is-selected")}>
                      <div className={cn("aspect-square overflow-hidden rounded-ios-xl bg-[rgba(255,255,255,0.42)]", !image.image && !image.imageUrl && !image.videoUrl && "flex items-center justify-center")}>
                        {image.image || image.imageUrl || image.videoUrl ? (
                          image.mediaType === "video" && image.videoUrl ? (
                            <video src={image.videoUrl} muted playsInline className="h-full w-full object-cover" />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={resultSrc(image)} alt="生成结果" className="h-full w-full object-cover" />
                          )
                        ) : (
                          <Bot className="h-5 w-5 text-[rgba(0,0,0,0.28)]" />
                        )}
                      </div>
                      <div className="mt-2 space-y-1 text-[10px] font-semibold text-[rgba(0,0,0,0.46)]">
                        <div className="flex items-center gap-1">
                          <Clipboard className="h-3 w-3" />
                          <span className="truncate">生成信息</span>
                        </div>
                        <p className="truncate">{image.workflow?.workflowPresetLabel ?? activePreset.label}</p>
                        <p className="truncate">{formatPublicGenerationSummary(image)}</p>
                        <p className="truncate">{image.referenceImageNames?.join("、") || "未使用参考图"}</p>
                        <div className="grid grid-cols-2 gap-1">
                          <button
                            type="button"
                            onClick={() => openResultOnCanvas(image)}
                            disabled={!image.image && !image.imageUrl && !image.videoUrl}
                            className="mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[rgba(255,255,255,0.46)] px-2 py-1 text-[10px] font-bold text-[rgba(0,0,0,0.56)] transition-colors hover:bg-white/70 disabled:text-[rgba(0,0,0,0.24)]"
                          >
                            打开
                          </button>
                          <button
                            type="button"
                            onClick={() => copyProvenanceConfig(image)}
                            className="mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[rgba(255,255,255,0.46)] px-2 py-1 text-[10px] font-bold text-[rgba(0,0,0,0.56)] transition-colors hover:bg-white/70"
                          >
                            <Clipboard className="h-3 w-3" />
                            复制配置
                          </button>
                          <button
                            type="button"
                            onClick={() => saveResultToBoard(image)}
                            disabled={!image.image && !image.imageUrl && !image.videoUrl || image.mediaType === "video"}
                            title="保存到文件夹"
                            className="col-span-2 mt-1 inline-flex items-center justify-center gap-1 rounded-lg bg-[rgba(255,255,255,0.46)] px-2 py-1 text-[10px] font-bold text-[rgba(0,0,0,0.56)] transition-colors hover:bg-white/70 disabled:text-[rgba(0,0,0,0.24)]"
                          >
                            <FolderOpen className="h-3 w-3" />
                            存入文件夹
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                  {inspectorGalleryMode === "assets" && referenceImages.map((image) => (
                    <div key={image.id} className="pro-provenance-card">
                      <div className="aspect-square overflow-hidden rounded-ios-xl bg-[rgba(255,255,255,0.42)]">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.previewUrl} alt={image.name} className="h-full w-full object-cover" />
                      </div>
                      <div className="mt-2 space-y-1 text-[10px] font-semibold text-[rgba(0,0,0,0.46)]">
                        <p className="truncate">参考图</p>
                        <p className="truncate">{image.name}</p>
                        <p className="truncate">
                          {REFERENCE_IMAGE_ROLES.find((role) => role.id === (image.role ?? "general"))?.label} · 强度 {image.strength ?? 80}%
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
                )}
                {((inspectorGalleryMode === "images" && allResults.length === 0) || (inspectorGalleryMode === "assets" && referenceImages.length === 0)) && (
                  <div className="mt-2 rounded-ios-2xl bg-[rgba(255,255,255,0.34)] px-3 py-3 text-[11px] font-medium leading-relaxed text-[rgba(0,0,0,0.46)]">
                    <RotateCcw className="mr-1.5 inline h-3 w-3" />
                    {inspectorGalleryMode === "images" ? "生成后，这里会显示模型、参数和可导入配置。" : "添加参考图后，这里会显示素材。"}
                  </div>
                )}
              </details>
            </div>
          )}

          {inspectorTab === "history" && (
            <div
              className="pro-panel-stack"
              role="tabpanel"
              id="pro-inspector-panel-history"
              aria-labelledby="pro-inspector-tab-history"
            >
              <details
                className="pro-accordion"
                open={sectionOpen.history}
                onToggle={(event) => toggleSection("history", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <RotateCcw className="h-4 w-4" />
                    最近任务
                  </span>
                </summary>
                <p className="pro-section-note">点击记录，恢复当时的提示词和参数。</p>
                {/*
                  历史面板订阅的是 /history 页同一个共享 store，
                  所以在这里收藏一张图，已打开的历史页会立刻跟着变。
                  restoreHistoryEntry 接受的 PersistedGenerationEntry 与统一模型
                  HistoryEntry 字段兼容（后者多了 quota / starred / modelId 等可选项）。
                */}
                <HistoryInspectorPanel
                  onRestore={restoreHistoryEntry}
                  onUseAsReference={useHistoryEntryAsReference}
                  fallbackEntries={recentWorkflows}
                />
              </details>

              <details
                className="pro-accordion"
                open={sectionOpen.recall}
                onToggle={(event) => toggleSection("recall", event.currentTarget.open)}
              >
                <summary>
                  <span className="pro-panel-title">
                    <FileJson className="h-4 w-4" />
                    导入配置
                  </span>
                </summary>
                <p className="pro-section-note">粘贴从“复制配置”得到的内容，恢复提示词和参数。</p>
                <textarea
                  value={restoreConfigText}
                  onChange={(event) => setRestoreConfigText(event.target.value)}
                  placeholder='{"prompt": "...", "workflowPreset": "product-shot", ...}'
                  className="min-h-[82px] w-full resize-none rounded-ios-2xl border-0 bg-[rgba(255,255,255,0.38)] px-3.5 py-3 text-[11px] text-[rgba(0,0,0,0.68)] outline-none ring-0 transition-all focus:bg-[rgba(255,255,255,0.58)] focus:ring-2 focus:ring-[rgba(0,122,255,0.16)]"
                />
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={restoreProvenanceConfig}
                    className="inline-flex items-center justify-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.52)] px-3 py-2 text-[11px] font-bold text-[rgba(0,0,0,0.58)] transition-colors hover:bg-[rgba(255,255,255,0.74)]"
                  >
                    <FileJson className="h-3 w-3" />
                    导入
                  </button>
                  <button
                    type="button"
                    onClick={() => copyProvenanceConfig(visibleResult)}
                    className="inline-flex items-center justify-center gap-1.5 rounded-ios-xl bg-[rgba(255,255,255,0.52)] px-3 py-2 text-[11px] font-bold text-[rgba(0,0,0,0.58)] transition-colors hover:bg-[rgba(255,255,255,0.74)]"
                  >
                    <Clipboard className="h-3 w-3" />
                    复制当前配置
                  </button>
                </div>
                {restoreConfigMessage && (
                  <p className="mt-2 truncate text-[11px] font-semibold text-[rgba(0,0,0,0.42)]">{restoreConfigMessage}</p>
                )}
              </details>
            </div>
          )}
        </aside>
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
          <div className="w-full max-w-lg overflow-hidden rounded-ios-3xl bg-[rgba(248,248,250,0.97)] p-4 shadow-2xl">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h3 className="text-[17px] font-bold text-[rgba(0,0,0,0.84)]">工作台快捷键</h3>
                <p className="mt-0.5 text-[12px] font-semibold text-[rgba(0,0,0,0.52)]">输入框与输入法组合期间不会误触。</p>
              </div>
              <button type="button" onClick={() => executeCommand("close_overlay")} className="flex h-10 w-10 items-center justify-center rounded-full bg-black/5 text-[rgba(0,0,0,0.64)]" aria-label="关闭快捷键">
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
                    <strong className="block text-[14px] text-[rgba(0,0,0,0.78)]">{command.label}</strong>
                    <span className="block text-[11px] font-semibold text-[rgba(0,0,0,0.50)]">{command.description}</span>
                  </span>
                  <kbd className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-bold text-[rgba(0,0,0,0.58)] shadow-sm">{command.shortcut}</kbd>
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
    </section>
  );
}
