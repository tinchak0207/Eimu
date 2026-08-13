"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ArrowUpRight, Bot, ImagePlus, Pencil, RefreshCw, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { StylePresets } from "@/components/StylePresets";
import { ModelPicker } from "@/components/ModelPicker";
import { getRandomSuggestions, Suggestion } from "@/lib/suggestions";
import { STYLE_PRESETS, type StylePreset } from "@/lib/prompt-enhancer";
import {
  generationCoins,
  generationModel,
  modelAspectRatios,
  modelDurations,
  modelResolutions,
  modelSupportsAudio,
  resolutionFromImageSize,
  resolutionLabel,
  type AspectRatio,
  type OutputResolution,
} from "@/lib/generation-model-catalog";
import { PIXAI_EDIT_MODEL_ID, PIXAI_UPSCALE_MODEL_ID } from "@/lib/image-model-ids.js";
import { insertPromptSnippet, replacePromptStyleSuffix } from "@/lib/prompt-compose";
import type { ReferenceImage } from "@/lib/image-types";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import { LOCAL_TEST_MODE } from "@/lib/sub2api";
import {
  PixaiError,
  resolveToPayload,
  runEdit,
  runUpscale,
  uploadMedia,
} from "@/components/pixai-tools/shared";
import type { PickedImage } from "@/components/pixai-tools/PixaiSourceInput";
import type { ReflectedParams } from "@/lib/agent-param-reflect";
import { imageHelpers } from "@/lib/image-helpers";
import { cn } from "@/lib/utils";

/**
 * 卡片的四个面。agent 与 edit / upscale 是同一层级的 toggle——
 * D-1「内嵌在卡片里的按钮」＋ D-24 状态B「改图/放大入口旁常驻可开关」，
 * 按下去换的是卡片中间那块控件区，不是换页。
 */
export type PromptInputMode = "generate" | "edit" | "upscale" | "agent";

interface PromptInputProps {
  onSubmit: (prompt: string) => void;
  isLoading?: boolean;
  isLoggedIn?: boolean;
  suggestions: Suggestion[];
  stylePreset: StylePreset;
  onStyleChange: (preset: StylePreset) => void;
  aspectRatio: AspectRatio;
  onAspectRatioChange: (ratio: AspectRatio) => void;
  outputResolution: OutputResolution;
  onOutputResolutionChange: (resolution: OutputResolution) => void;
  durationSeconds?: number;
  onDurationChange: (duration: number) => void;
  generateAudio: boolean;
  onGenerateAudioChange: (enabled: boolean) => void;
  externalPrompt?: string;
  referenceImages: ReferenceImage[];
  onReferenceImagesChange: (images: ReferenceImage[]) => void;
  models: string[];
  modelId: string;
  onModelChange: (modelId: string) => void;
  isProfessionalMode: boolean;
  onToggleProfessionalMode: () => void;
  mode: PromptInputMode;
  onModeChange: (mode: PromptInputMode) => void;
  animState: "idle" | "exit" | "enter";
  displayMode: PromptInputMode;
  onEditResult?: (url: string) => void;
  onUpscaleResult?: (url: string) => void;
  /**
   * D-12：助理动过的参数回流到工作台控件。聊天区就地长在这张卡片里，
   * 所以这条回流不再经过 ImagePlayground 的整页翻面，直接从这里往上抛。
   */
  onParamsReflected?: (params: ReflectedParams) => void;
  /**
   * 别的页面（D-18 图库卡「交给 AI 助理继续做」）交接过来的一句话。
   * 它跟 agent 模式同一批 setState 落地，所以聊天区挂载时就能读到。
   */
  agentSeed?: string;
  /** agent 产出新图时回调，把 URL 推进右侧 ImageDisplay。 */
  onImageResult?: (url: string) => void;
  /** 畫布 SSE 事件分流（v3 embed），轉交 AgentChatSurface → useAgentChat。 */
  onCanvasEvent?: (event: AgentSseEvent) => void;
  /** 發送前提供畫布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
}

/**
 * 三行控制共用同一条左侧标签栏，让画质／风格／示例读起来是同一层级。
 * 每行控件统一 36px 高，标签因此可以直接垂直居中对齐。
 */
const LABEL_CLASS = "w-8 shrink-0 text-ios-footnote font-medium text-[rgba(0,0,0,0.50)]";

/**
 * 始终单行横向滑动，绝不换行：换行会把标签挤到两行中间形成错位，
 * 并留下「4+1」「5+2」这样的孤儿行。宽屏放得下就是一整行，
 * 放不下就横滑，两种情况标签都对齐。
 */
const RAIL_CLASS =
  "flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

/**
 * 每一行都是「固定宽度标签 + 可收缩控件区」。min-w-0 不是保险而是必需：
 * 控件区里的胶囊都是 flex-shrink:0 + nowrap，少了它，行的 min-content 会等于
 * 所有胶囊的总宽，向上顶宽卡片、顶宽 grid 列，最终把整个页面推得横向溢出。
 * 装不下时应该是控件区内部横滑，而不是把版面撑破。
 */
const ROW_CLASS = "flex min-w-0 items-center gap-2";

/** D-24 状态A 一个 session 只提示一次的记号。 */
const AGENT_HINT_SEEN_KEY = "agent-hint-seen-v1";

/** 改图比例胶囊：跟随原图 = 服务端回退 1024x1024，其余按固定尺寸传给 edit API。 */
type PixaiRatioKey = "original" | "1:1" | "4:3" | "3:4" | "9:16";
const PIXAI_RATIO_SIZES: Record<Exclude<PixaiRatioKey, "original">, string> = {
  "1:1": "1024x1024",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "9:16": "768x1365",
};
const PIXAI_RATIO_CHIPS: PixaiRatioKey[] = ["original", "1:1", "4:3", "3:4", "9:16"];

type PixaiStage = "idle" | "uploading" | "generating" | "done" | "error";

/**
 * 参考图上传必须懒加载：它依赖 react-dropzone → file-selector，后者内嵌了
 * 一整份 MIME 副档名对照表（数千条，实测 40.2KB raw / 9.4KB gz）。
 * 静态 import 会把这份表拉进首屏 chunk。
 *
 * 占位符与真实控件同为「absolute inset-x-3 bottom-3 + 44px 圆形按钮」，
 * 且 textarea 本身有 pb-14 预留空间，所以 chunk 落地前后零版面跳动。
 */
const ReferenceImageUpload = dynamic(
  () => import("@/components/ReferenceImageUpload").then((mod) => mod.ReferenceImageUpload),
  {
    ssr: false,
    loading: () => (
      <div className="absolute inset-x-3 bottom-3 z-20 flex items-center gap-2" aria-hidden="true">
        <div className="min-h-11 min-w-11 rounded-full bg-white/85 shadow-[0_2px_10px_rgba(0,0,0,0.10)]" />
      </div>
    ),
  },
);

/**
 * 聊天区按需载入：首屏不需要 SSE 客户端和整套 transcript 组件。
 * 占位符高度与真实聊天区一致（同一个 AGENT_SURFACE_HEIGHT），
 * chunk 落地前后卡片不跳动。
 */
const AgentChatSurface = dynamic(
  () => import("@/components/agent-chat/AgentChatSurface").then((mod) => mod.AgentChatSurface),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center text-ios-footnote text-[rgba(0,0,0,0.46)]">
        正在唤醒 AI 助理...
      </div>
    ),
  },
);

/**
 * 聊天区在卡片里的高度。
 * 下限 420px：低于这个值 transcript 只剩两三行，读不成对话。
 * 62dvh：手机地址栏收放时 vh 会骗人，dvh 才跟着实际可视区走。
 * 上限 720px：大屏上再高就把右边结果画布和下面的案例区推出首屏。
 */
const AGENT_SURFACE_HEIGHT = "clamp(500px, 72dvh, 860px)";

/** 这两个面不需要卡片顶部那个描述框：放大没有描述，agent 自带输入区。 */
const MODES_WITHOUT_TEXTAREA = new Set<PromptInputMode>(["upscale", "agent"]);

export function PromptInput({
  suggestions: initialSuggestions,
  isLoading,
  isLoggedIn,
  onSubmit,
  stylePreset,
  onStyleChange,
  aspectRatio,
  onAspectRatioChange,
  outputResolution,
  onOutputResolutionChange,
  durationSeconds,
  onDurationChange,
  generateAudio,
  onGenerateAudioChange,
  externalPrompt,
  referenceImages,
  onReferenceImagesChange,
  models,
  modelId,
  onModelChange,
  isProfessionalMode,
  onToggleProfessionalMode,
  mode,
  onModeChange,
  animState,
  displayMode,
  onEditResult,
  onUpscaleResult,
  onParamsReflected,
  agentSeed = "",
  onImageResult,
  onCanvasEvent,
  canvasStateProvider,
}: PromptInputProps) {
  // 订阅定价覆写：管理员改价后本页报价立即重算。
  usePricingRevision();
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>(initialSuggestions);
  const { token, user } = useAuth();
  const { toast } = useToast();

  // 改图 / 放大各自维护来源图、阶段与结果；模式切换只换控件区，状态保留。
  const [editSource, setEditSource] = useState<PickedImage | null>(null);
  const [editRatio, setEditRatio] = useState<PixaiRatioKey>("original");
  const [editStage, setEditStage] = useState<PixaiStage>("idle");
  const [editError, setEditError] = useState("");
  const [editResultUrl, setEditResultUrl] = useState("");
  const [upscaleSource, setUpscaleSource] = useState<PickedImage | null>(null);
  const [upscaleSourceSize, setUpscaleSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [upscaleStage, setUpscaleStage] = useState<PixaiStage>("idle");
  const [upscaleError, setUpscaleError] = useState("");
  const [upscaleResultUrl, setUpscaleResultUrl] = useState("");

  const prevDisplayModeRef = useRef(displayMode);
  useEffect(() => {
    prevDisplayModeRef.current = displayMode;
  }, [displayMode]);

  // 放大模式没有描述框；agent 模式自带输入区（AgentComposer），
  // 两个框并排会出现「我该往哪打字」的歧义，所以这里也让它消散。
  // 切走时文本框需要重新「凝聚」回来，内容还在（state 没清）。
  const textareaHidden = MODES_WITHOUT_TEXTAREA.has(displayMode);
  const textareaDissolving = MODES_WITHOUT_TEXTAREA.has(mode) && animState === "exit";
  const textareaReforming =
    MODES_WITHOUT_TEXTAREA.has(prevDisplayModeRef.current) &&
    !MODES_WITHOUT_TEXTAREA.has(displayMode) &&
    animState === "enter";

  useEffect(() => {
    if (externalPrompt) {
      setInput((current) => insertPromptSnippet(current, externalPrompt));
    }
  }, [externalPrompt]);

  // ── D-24 状态A：渐进披露第一层 ──
  // 打了第一个字之后停顿 >5 秒（= 卡住了，不是打字中），才在输入框下面浮一条
  // 「Agent 帮你完成」。一个 session 只出现一次，用过或关掉就不再烦。
  // 不能一进页面就弹：那是广告，不是帮忙。
  const [agentHintOpen, setAgentHintOpen] = useState(false);
  const [agentHintSpent, setAgentHintSpent] = useState(false);
  // 已送出（生成中/完成後看圖）→ 抑制提示：提示只屬於「還沒送出、卡在輸入」的時段。
  // input 內容一變（使用者重新寫新任務）就解除，讓新任務也能獲得一次提示機會。
  const [agentHintSuppressed, setAgentHintSuppressed] = useState(false);
  const agentHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // 只跟 sessionStorage：换 tab 重来一次可以，同一 session 内不重复。
    try {
      if (sessionStorage.getItem(AGENT_HINT_SEEN_KEY) === "1") setAgentHintSpent(true);
    } catch {
      // 隐私模式下 sessionStorage 会抛，当成没看过即可
    }
  }, []);

  useEffect(() => {
    if (agentHintTimerRef.current) clearTimeout(agentHintTimerRef.current);
    // 只在生成模式、已经打了字、还没用掉、还没送出、且不正在生成的情况下计时。
    // isLoading = 生成请求已发出：任务在跑时不弹「AI 助理帮你完成」，避免打断等待。
    // agentHintSuppressed = 已送出：生成完成後看圖/檢查圖片期間也不彈，直到重新輸入新任务。
    if (agentHintSpent || agentHintSuppressed || displayMode !== "generate" || input.trim().length === 0 || isLoading) {
      setAgentHintOpen(false);
      return;
    }
    agentHintTimerRef.current = setTimeout(() => setAgentHintOpen(true), 5000);
    return () => {
      if (agentHintTimerRef.current) clearTimeout(agentHintTimerRef.current);
    };
  }, [input, displayMode, agentHintSpent, agentHintSuppressed, isLoading]);

  // 送出後 suppress 只被「输入内容变化」解除：改成新任务的字才重新计时。
  useEffect(() => {
    setAgentHintSuppressed(false);
  }, [input]);

  const spendAgentHint = () => {
    setAgentHintOpen(false);
    setAgentHintSpent(true);
    try {
      sessionStorage.setItem(AGENT_HINT_SEEN_KEY, "1");
    } catch {
      // 存不下就只在本次挂载内生效，不影响主流程
    }
  };

  const activeStyle = useMemo(
    () => STYLE_PRESETS.find((preset) => preset.key === stylePreset),
    [stylePreset],
  );
  const selectedModel = generationModel(modelId);
  const aspectRatios = modelAspectRatios(modelId);
  const resolutions = modelResolutions(modelId);
  const durations = modelDurations(modelId);
  const isVideo = selectedModel?.kind === "video";
  const supportsAudio = modelSupportsAudio(modelId);

  const editBusy = editStage === "uploading" || editStage === "generating";
  const upscaleBusy = upscaleStage === "uploading" || upscaleStage === "generating";

  const handleSuggestionSelect = (prompt: string) => {
    setInput((current) => insertPromptSnippet(current, prompt));
  };

  const handleStyleChange = (preset: StylePreset) => {
    onStyleChange(preset);
    const style = STYLE_PRESETS.find((candidate) => candidate.key === preset);
    setInput((current) => replacePromptStyleSuffix(
      current,
      style?.suffix,
      STYLE_PRESETS.map((candidate) => candidate.suffix),
    ));
  };

  const updateSuggestions = () => setSuggestions(getRandomSuggestions());

  const handleSubmit = () => {
    // Not logged in: always allow click → parent will open auth modal
    if (!isLoggedIn) {
      setAgentHintOpen(false);
      setAgentHintSuppressed(true);
      onSubmit(input);
      return;
    }
    if (!isLoading && input.trim()) {
      // 送出即代表这次「卡住」已结束：关掉提示，生成完成后的看图时段不再弹。
      setAgentHintOpen(false);
      setAgentHintSuppressed(true);
      onSubmit(input);
    }
  };

  const redirectToGithub = () => {
    window.location.href = "/api/auth/github/start";
  };

  const pickSourceFile = (
    e: React.ChangeEvent<HTMLInputElement>,
    onPick: (image: PickedImage) => void,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    onPick({
      source: { kind: "file", file, mimeType: file.type || "image/png" },
      previewUrl: URL.createObjectURL(file),
      label: file.name,
    });
  };

  const handleEditSubmit = async () => {
    if (!editSource) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!input.trim()) {
      toast({ title: "请描述想改成什么样子", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    // 编辑请求已送出：之后的看图/调整时段不再弹「AI 助理帮你完成」。
    setAgentHintOpen(false);
    setAgentHintSuppressed(true);
    try {
      setEditError("");
      setEditStage("uploading");
      const payload = await resolveToPayload(editSource.source);
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setEditStage("generating");
      const size = editRatio === "original" ? "1024x1024" : PIXAI_RATIO_SIZES[editRatio];
      const url = await runEdit({ mediaId, prompt: input.trim(), size, token: tokenValue, userId: user?.id ?? 0 });
      setEditResultUrl(url);
      setEditStage("done");
      onEditResult?.(url);
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setEditError(message);
      setEditStage("error");
      toast({ title: "改图失败", description: message, variant: "destructive" });
    }
  };

  const handleUpscaleSubmit = async () => {
    if (!upscaleSource) {
      toast({ title: "请先选择图片", variant: "destructive" });
      return;
    }
    if (!LOCAL_TEST_MODE && !isLoggedIn) {
      redirectToGithub();
      return;
    }
    const tokenValue = token ?? "";
    // 放大请求已送出：之后的看图/调整时段不再弹「AI 助理帮你完成」。
    setAgentHintOpen(false);
    setAgentHintSuppressed(true);
    try {
      setUpscaleError("");
      setUpscaleStage("uploading");
      const payload = await resolveToPayload(upscaleSource.source);
      const mediaId = await uploadMedia(payload, tokenValue, user?.id ?? 0);
      setUpscaleStage("generating");
      const sizeLabel = upscaleSourceSize ? `${upscaleSourceSize.width}x${upscaleSourceSize.height}` : undefined;
      const url = await runUpscale({ mediaId, factor: 2, size: sizeLabel, token: tokenValue, userId: user?.id ?? 0 });
      setUpscaleResultUrl(url);
      setUpscaleStage("done");
      onUpscaleResult?.(url);
    } catch (e) {
      const message = e instanceof PixaiError ? e.message : e instanceof Error ? e.message : "生成失败，请重试";
      setUpscaleError(message);
      setUpscaleStage("error");
      toast({ title: "放大失败", description: message, variant: "destructive" });
    }
  };

  const handlePrimaryAction = () => {
    // agent 模式没有这颗按钮，也不该有键盘旁路：送出归聊天区。
    if (displayMode === "agent") return;
    if (displayMode === "edit") { handleEditSubmit(); return; }
    if (displayMode === "upscale") { handleUpscaleSubmit(); return; }
    handleSubmit();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (displayMode === "generate") {
        handleSubmit();
      } else {
        handlePrimaryAction();
      }
    }
  };

  const primaryDisabled = displayMode === "edit"
    ? editBusy || !editSource || !input.trim()
    : displayMode === "upscale"
      ? upscaleBusy || !upscaleSource
      : isLoading || (isLoggedIn && !input.trim());

  return (
    // rounded-ios-3xl matches the navbar pill and the result canvas; this card
    // used to be the only 48px corner on the page. No lg-ambient here — its
    // 200px blurred blob landed inside the textarea and read as a smudge.
    // Bottom padding runs one step larger than the top to optically absorb the
    // CTA's blue glow, which otherwise looks like it is touching the edge.
    // overflow-x-clip 是最后一道保险：任何一行万一还是撑宽了，也只在卡片内被裁掉，
    // 不会把整页推得横向滚动。clip 只作用于 X 轴，Y 轴保持 visible，
    // 参考图预览浮层（absolute -bottom-3）仍可正常溢出。
    // 卡片本身不参与模式切换动画：模式切换只「散开／重组」中间控件区，
    // 底板、描述框与底部那一排按钮原地不动。
    <section className="lg-card relative overflow-x-clip rounded-ios-3xl p-5 pb-6 sm:p-6 sm:pb-7">
      {/* Specular top edge */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" aria-hidden="true" />

      <div className="relative space-y-4">

        {/* ── 画面描述 ── 改图模式复用同一个输入框，只换 placeholder；
            放大模式不需要描述，进入时随动画「消散」。 ── */}
        <div
          className={cn(
            "relative",
            textareaHidden && "hidden",
            textareaDissolving && "dust-exit",
            textareaReforming && "dust-enter",
          )}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={displayMode === "edit" ? "描述想改成什么样子…" : "描述你的想法。例如：让这瓶香水出现在落日海滩，自然光线，质感高级。"}
            rows={5}
            className="min-h-[180px] rounded-ios-2xl border-0 bg-[rgba(0,0,0,0.04)] px-5 py-4 pb-14 text-[16px] leading-6 text-[rgba(0,0,0,0.85)] placeholder:text-[rgba(0,0,0,0.44)] focus:bg-[rgba(0,122,255,0.04)] focus:ring-2 focus:ring-[rgba(0,122,255,0.20)] resize-none transition-all duration-200 [background-image:none]"
          />
          {displayMode === "generate" && (
            <ReferenceImageUpload variant="prompt" value={referenceImages} onChange={onReferenceImagesChange} />
          )}
          <p className="pointer-events-none absolute bottom-3 right-4 hidden select-none text-ios-caption1 text-[rgba(0,0,0,0.46)] sm:block">
            按 Enter 生成 · Shift + Enter 换行
          </p>
        </div>

        {/* ── D-24 状态A：停顿 >5 秒才浮现的「Agent 帮你完成」 ──
            带一个具体例子，不是抽象承诺——「一只帅气的猫 → 自动选好模型/风格/比例」。
            点下去把已经打的半句话一起带进对话（不用重打）。 */}
        {agentHintOpen && displayMode === "generate" && !isLoading && (
          <div className="lg-float animate-[dust-enter-kf_320ms_cubic-bezier(0.22,1,0.36,1)_forwards] flex items-start gap-2.5 rounded-ios-2xl bg-[rgba(0,122,255,0.06)] px-3.5 py-2.5 ring-1 ring-[rgba(0,122,255,0.14)]">
            <Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#007AFF]" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => {
                  spendAgentHint();
                  // 已经打进框里的半句话由 initialPrompt 一起带进聊天区（D-24），
                  // 使用者不用重打一遍。
                  onModeChange("agent");
                }}
                className="cursor-pointer text-left text-ios-footnote font-semibold text-[#007AFF] hover:underline"
              >
                想不下去？让 AI 助理帮你完成
              </button>
              <p className="mt-0.5 text-ios-caption1 leading-relaxed text-[rgba(0,0,0,0.50)]">
                只写「一只帅气的猫」就够，助理自动选好模型、风格、比例
                {selectedModel ? (
                  <>
                    ，约 {generationCoins(modelId, { resolution: outputResolution, durationSeconds, generateAudio })} 币/张
                  </>
                ) : null}
                。
              </p>
            </div>
            <button
              type="button"
              onClick={spendAgentHint}
              aria-label="不用了"
              className="shrink-0 cursor-pointer rounded-full p-1 text-[rgba(0,0,0,0.46)] transition-colors duration-200 hover:bg-[rgba(0,0,0,0.06)] hover:text-[rgba(0,0,0,0.72)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* ── 模式控件区：只有这里参与模式切换动画 ── */}
        <div
          className={cn(
            "dust-transition",
            animState === "exit" && "dust-exit",
            animState === "enter" && "dust-enter",
          )}
        >
          {displayMode === "generate" && (
            <>
              {/* ── 示例：紧跟描述框，因为它填的就是上面这个框 ── */}
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>示例</span>
                <div className={RAIL_CLASS}>
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion.text}
                      type="button"
                      onClick={() => handleSuggestionSelect(suggestion.prompt)}
                      title={suggestion.prompt}
                      className="style-chip"
                    >
                      {suggestion.text}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={updateSuggestions}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[rgba(0,0,0,0.52)] lg-transition hover:bg-[rgba(0,0,0,0.05)] hover:text-[rgba(0,0,0,0.72)] cursor-pointer"
                  aria-label="换一批示例"
                  title="换一批示例"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* ── 生成设置：模型 + 比例 + 清晰度 + 时长 + 风格，同一套胶囊语言。
                  与上方「写什么」的分组靠留白完成，不画分隔线——线只会加重分割感。 ── */}
              <div className="space-y-2.5 pt-1">
                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>模型</span>
                  <div className={RAIL_CLASS}>
                    <ModelPicker
                      models={models}
                      value={modelId}
                      onChange={onModelChange}
                      resolution={outputResolution}
                      durationSeconds={durationSeconds}
                      generateAudio={generateAudio}
                      onOpenProfessionalMode={onToggleProfessionalMode}
                    />
                  </div>
                </div>

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>比例</span>
                  <div className={RAIL_CLASS}>
                    {aspectRatios.map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => onAspectRatioChange(ratio)}
                        className={cn("style-chip", aspectRatio === ratio && "active")}
                      >
                        {ratio}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>画质</span>
                  <div className={RAIL_CLASS}>
                    {resolutions.map((resolution) => (
                      <button
                        key={resolution}
                        type="button"
                        onClick={() => onOutputResolutionChange(resolution)}
                        className={cn("style-chip gap-1.5", outputResolution === resolution && "active")}
                      >
                        {resolutionLabel(resolution)}
                        <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                          · {generationCoins(modelId, { resolution, durationSeconds, generateAudio })} 币/张
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {isVideo && durations.length > 0 ? (
                  <div className={ROW_CLASS}>
                    <span className={LABEL_CLASS}>时长</span>
                    <div className={RAIL_CLASS}>
                      {durations.map((duration) => (
                        <button
                          key={duration}
                          type="button"
                          onClick={() => onDurationChange(duration)}
                          className={cn("style-chip gap-1.5", durationSeconds === duration && "active")}
                        >
                          {duration} 秒
                          <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                            {generationCoins(modelId, {
                              resolution: outputResolution,
                              durationSeconds: duration,
                              generateAudio,
                            })} 币
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {isVideo && supportsAudio ? (
                  <div className={ROW_CLASS}>
                    <span className={LABEL_CLASS}>音讯</span>
                    <div className={RAIL_CLASS}>
                      <button
                        type="button"
                        onClick={() => onGenerateAudioChange(!generateAudio)}
                        aria-pressed={generateAudio}
                        aria-label={generateAudio ? "关闭生成音讯" : "开启生成音讯"}
                        title={generateAudio ? "关闭生成音讯" : "开启生成音讯"}
                        className={cn("style-chip gap-1.5", generateAudio && "active")}
                      >
                        {generateAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                        生成音讯
                        <span className="tabular-nums text-[rgba(0,0,0,0.52)]">
                          {generationCoins(modelId, {
                            resolution: outputResolution,
                            durationSeconds,
                            generateAudio,
                          })} 币
                        </span>
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className={ROW_CLASS}>
                  <span className={LABEL_CLASS}>风格</span>
                  {/* 无「默认」胶囊：全部未高亮即默认态。多一颗胶囊会把这一行挤到
                      换行，而清除入口已由下方「已套用 ✕」和再点一次选中项承担。 */}
                  <div className={RAIL_CLASS}>
                    <StylePresets value={stylePreset} onChange={handleStyleChange} inline />
                  </div>
                </div>
              </div>
            </>
          )}

          {displayMode === "edit" && (
            <div className="space-y-2.5 pt-1">
              {/* 原图：胶囊即上传入口，选中后变为缩略图胶囊，可移除 */}
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>原图</span>
                <div className={RAIL_CLASS}>
                  {editSource ? (
                    <span className="style-chip gap-1.5 pr-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={editSource.previewUrl} alt="" className="h-5 w-5 shrink-0 rounded-md object-cover" />
                      <span className="max-w-[120px] truncate">{editSource.label}</span>
                      <button
                        type="button"
                        onClick={() => { setEditSource(null); setEditResultUrl(""); setEditError(""); setEditStage("idle"); }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full lg-transition hover:bg-[rgba(0,0,0,0.08)] cursor-pointer"
                        aria-label="移除原图"
                        title="移除原图"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <label className="style-chip cursor-pointer gap-1.5">
                      <ImagePlus className="h-3.5 w-3.5" />
                      上传原图
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          pickSourceFile(e, (image) => {
                            setEditSource(image);
                            setEditResultUrl("");
                            setEditError("");
                            setEditStage("idle");
                          });
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>比例</span>
                <div className={RAIL_CLASS}>
                  {PIXAI_RATIO_CHIPS.map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setEditRatio(key)}
                      className={cn("style-chip", editRatio === key && "active")}
                    >
                      {key === "original" ? "跟随原图" : key}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">
                改图 {generationCoins(PIXAI_EDIT_MODEL_ID, { resolution: "1k" })} 币起（按解析度浮动）
              </p>

              {editStage === "error" && editError && (
                <p className="text-ios-footnote text-[#FF3B30]">{editError}</p>
              )}

              {editStage === "done" && editResultUrl && (
                <div className="flex items-center gap-2 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={editResultUrl} alt="改图结果" className="h-10 w-10 shrink-0 rounded-ios-md object-cover" />
                  <span className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.55)]">改图完成</span>
                  <button
                    type="button"
                    onClick={() => imageHelpers.download(editResultUrl, "edit")}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
                  >
                    下载
                  </button>
                </div>
              )}
            </div>
          )}

          {displayMode === "upscale" && (
            <div className="space-y-2.5 pt-1">
              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>原图</span>
                <div className={RAIL_CLASS}>
                  {upscaleSource ? (
                    <span className="style-chip gap-1.5 pr-1">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={upscaleSource.previewUrl}
                        alt=""
                        className="h-5 w-5 shrink-0 rounded-md object-cover"
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          if (el.naturalWidth && el.naturalHeight) {
                            setUpscaleSourceSize({ width: el.naturalWidth, height: el.naturalHeight });
                          }
                        }}
                      />
                      <span className="max-w-[120px] truncate">{upscaleSource.label}</span>
                      <button
                        type="button"
                        onClick={() => { setUpscaleSource(null); setUpscaleSourceSize(null); setUpscaleResultUrl(""); setUpscaleError(""); setUpscaleStage("idle"); }}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full lg-transition hover:bg-[rgba(0,0,0,0.08)] cursor-pointer"
                        aria-label="移除原图"
                        title="移除原图"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </span>
                  ) : (
                    <label className="style-chip cursor-pointer gap-1.5">
                      <ImagePlus className="h-3.5 w-3.5" />
                      上传原图
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          pickSourceFile(e, (image) => {
                            setUpscaleSource(image);
                            setUpscaleResultUrl("");
                            setUpscaleError("");
                            setUpscaleStage("idle");
                          });
                        }}
                      />
                    </label>
                  )}
                </div>
              </div>

              <div className={ROW_CLASS}>
                <span className={LABEL_CLASS}>倍數</span>
                <div className={RAIL_CLASS}>
                  <span className="style-chip active">2×</span>
                </div>
              </div>

              <p className="text-ios-footnote text-[rgba(0,0,0,0.46)]">
                固定 2 倍放大 · 价格{" "}
                {generationCoins(PIXAI_UPSCALE_MODEL_ID, {
                  resolution: upscaleSourceSize
                    ? resolutionFromImageSize(`${upscaleSourceSize.width}x${upscaleSourceSize.height}`)
                    : "1k",
                })}{" "}
                币{upscaleSourceSize ? "（按解析度浮动）" : "起（按解析度浮动）"}
              </p>

              {upscaleStage === "error" && upscaleError && (
                <p className="text-ios-footnote text-[#FF3B30]">{upscaleError}</p>
              )}

              {upscaleStage === "done" && upscaleResultUrl && (
                <div className="flex items-center gap-2 rounded-ios-2xl border border-[rgba(0,0,0,0.08)] p-2">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={upscaleResultUrl} alt="放大结果" className="h-10 w-10 shrink-0 rounded-ios-md object-cover" />
                  <span className="min-w-0 flex-1 truncate text-ios-footnote text-[rgba(0,0,0,0.55)]">放大完成</span>
                  <button
                    type="button"
                    onClick={() => imageHelpers.download(upscaleResultUrl, "upscale")}
                    className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[rgba(0,0,0,0.05)] px-3 text-ios-footnote font-medium text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
                  >
                    下载
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── AI 助理（D-1 / D-24 状态B）──
              和改图、放大同一层：toggle 一下换掉这块控件区，卡片底板、下面那排
              按钮、右边结果画布、底下案例区全部原地不动。不跳 /agent 独立页。
              高度写死在这里而不是靠内容撑：聊天区内部靠 flex-1 + min-h-0 自己滚，
              外层不给定高度的话 transcript 会把卡片撑到无限长，输入区被推出屏幕。 */}
          {displayMode === "agent" && (
            <div className="flex flex-col pt-1" style={{ height: AGENT_SURFACE_HEIGHT }}>
              <AgentChatSurface
                variant="inline"
                // 挂载时读一次：外面已经打好的半句话，或别的页面交接过来的一句话。
                initialPrompt={agentSeed || input.trim()}
                onExit={() => onModeChange("generate")}
                {...(onParamsReflected ? { onParamsReflected } : {})}
                {...(onImageResult ? { onImageResult } : {})}
                {...(onCanvasEvent ? { onCanvasEvent } : {})}
                {...(canvasStateProvider ? { canvasStateProvider } : {})}
                currentModelId={modelId}
              />
            </div>
          )}
        </div>

        {/* ── 已套用状态 + 专业模式 + 出图按钮 ──
            这一排不参与模式动画，始终原地不动：改图／放大切换、已套用风格、
            专业控制开关都随用户随时开关。
            手机上纵向堆叠：`w-full` 的 CTA 混在 flex-wrap 行里，宽度要靠换行才
            正确，很容易被同行的 ml-auto 顶出边界。改成 column，CTA 天然满宽。 */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {/* 改图 / 放大 快捷入口 — 左侧，专业控制 toggle 左边 */}
          <div className="flex items-center gap-1.5 shrink-0 self-start">
            <button
              type="button"
              onClick={() => onModeChange(mode === "edit" ? "generate" : "edit")}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "edit"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <Pencil className="h-3 w-3" />改图
            </button>
            <button
              type="button"
              onClick={() => onModeChange(mode === "upscale" ? "generate" : "upscale")}
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "upscale"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <ZoomIn className="h-3 w-3" />放大
            </button>
            {/* Agent 入口（D-1 / D-24 状态B）：与改图、放大**完全同一颗按钮的语法**
                ——同样的 toggle、同样的选中态、同样只换中间控件区。
                D-24 状态B 写的是「改图/放大入口旁常驻可开关」，
                所以它没有自己的常亮蓝底，未选中时和邻居一样是灰的。
                承接半句话（D-24）由 initialPrompt 负责，不用重打一遍。 */}
            <button
              type="button"
              onClick={() => onModeChange(mode === "agent" ? "generate" : "agent")}
              aria-pressed={mode === "agent"}
              title="交给 AI 助理：说一句话，它自动选模型、风格、比例并出图"
              className={cn(
                "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all duration-200",
                mode === "agent"
                  ? "bg-[rgba(0,122,255,0.12)] text-[#007AFF] ring-1 ring-[rgba(0,122,255,0.25)]"
                  : "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.65)] hover:bg-[rgba(0,0,0,0.09)]"
              )}
            >
              <Bot className="h-3 w-3" />AI 助理
            </button>
          </div>

          {activeStyle ? (
            <div className="lg-tint-blue inline-flex h-9 min-w-0 max-w-full shrink-0 items-center gap-1 self-start rounded-full pl-3.5 pr-1 text-ios-footnote font-medium text-[#007AFF]">
              <span className="truncate">已套用 {activeStyle.label}</span>
              <button
                type="button"
                onClick={() => handleStyleChange("none")}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full lg-transition hover:bg-[rgba(0,122,255,0.14)] cursor-pointer"
                aria-label={`清除${activeStyle.label}风格`}
                title="清除风格"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : null}

          {/* 专业模式 toggle switch */}
          <button
            type="button"
            onClick={onToggleProfessionalMode}
            aria-pressed={isProfessionalMode}
            title="打开专业工作站：多图队列、局部要求、项目信息"
            className={cn(
              "pro-mode-toggle self-start sm:ml-auto",
              isProfessionalMode && "active",
            )}
          >
            <span className="pro-mode-toggle-track" aria-hidden="true">
              <span className="pro-mode-toggle-thumb" />
            </span>
            <span className="pro-mode-toggle-label">专业控制</span>
          </button>

          {/* Single CTA — elevated blue, strong shadow, scale on hover。
              改图／放大模式下，同一颗按钮承担对应动作。
              agent 模式下这颗按钮**不存在**：送出由聊天区自己的输入区负责，
              这里再摆一颗「开始创作」会有两个送出口，按哪个都说不清。 */}
          {displayMode !== "agent" && (
          <button
            type="button"
            onClick={handlePrimaryAction}
            disabled={primaryDisabled}
            className="inline-flex h-11 w-full shrink-0 items-center justify-center gap-2 rounded-ios-xl bg-[#007AFF] px-6 text-ios-body font-semibold text-white shadow-[0_6px_24px_rgba(0,122,255,0.40),0_2px_8px_rgba(0,122,255,0.24)] transition-all duration-200 hover:bg-[#0066DD] hover:shadow-[0_10px_32px_rgba(0,122,255,0.52),0_4px_12px_rgba(0,122,255,0.30)] hover:scale-[1.025] active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-[rgba(0,0,0,0.16)] disabled:shadow-none disabled:scale-100 cursor-pointer sm:w-auto"
          >
            {displayMode === "edit" ? (
              editBusy ? (
                <><Spinner className="h-4 w-4 text-white" />{editStage === "uploading" ? "上传中" : "改图中"}</>
              ) : (
                <><Pencil className="h-4 w-4" />开始改图<ArrowUpRight className="h-4 w-4" /></>
              )
            ) : displayMode === "upscale" ? (
              upscaleBusy ? (
                <><Spinner className="h-4 w-4 text-white" />{upscaleStage === "uploading" ? "上传中" : "放大中"}</>
              ) : (
                <><ZoomIn className="h-4 w-4" />开始放大<ArrowUpRight className="h-4 w-4" /></>
              )
            ) : (
              isLoading ? (
                <><Spinner className="h-4 w-4 text-white" />正在生成</>
              ) : (
                <>{isVideo ? "生成视频" : "开始创作"}<ArrowUpRight className="h-4 w-4" /></>
              )
            )}
          </button>
          )}
        </div>

      </div>
    </section>
  );
}
