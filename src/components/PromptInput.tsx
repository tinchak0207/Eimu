"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Bot, X } from "lucide-react";
import type { AgentSseEvent } from "@/lib/agent-chat-types";
import { Textarea } from "@/components/ui/textarea";
import { getRandomSuggestions, Suggestion } from "@/lib/suggestions";
import { STYLE_PRESETS, type StylePreset } from "@/lib/prompt-enhancer";
import { generationCoins, generationModel, type AspectRatio, type OutputResolution } from "@/lib/generation-model-catalog";
import { insertPromptSnippet, replacePromptStyleSuffix } from "@/lib/prompt-compose";
import type { ReferenceImage } from "@/lib/image-types";
import { usePricingRevision } from "@/hooks/use-pricing-revision";
import type { ReflectedParams } from "@/lib/agent-param-reflect";
import { cn } from "@/lib/utils";
import { usePixaiEdit, usePixaiUpscale } from "@/components/prompt-input/use-pixai-tools-panel";
import { useAgentHint } from "@/components/prompt-input/use-agent-hint";
import { MODES_WITHOUT_TEXTAREA, useHeightLock } from "@/components/prompt-input/use-height-lock";
import { ActionRow } from "@/components/prompt-input/ActionRow";
import { EditPanel } from "@/components/prompt-input/EditPanel";
import { GenerateControls } from "@/components/prompt-input/GenerateControls";
import { UpscalePanel } from "@/components/prompt-input/UpscalePanel";

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
  /**
   * agent session 切換時回調（畫布 session 隔離）：
   * 新 session 開起來時舊畫布必須清掉，否則新 agent session 的節點會
   * 疊在上一次 canvas session 的節點上，用戶分不清哪些是這次做的。
   */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * 畫布工作站浮動面板態：面板自己有確定高度（桌面全高 / 手機 46dvh 抽屜），
   * 聊天區改為填滿面板剩餘空間，由 transcript 內部滾動。仍然用
   * --agent-surface-height 固定高的話，60dvh 的聊天區塞進 46dvh 的抽屜，
   * 輸入區和最新一條訊息會被面板底邊裁掉。
   */
  fillAvailableHeight?: boolean;
  /**
   * 工作站態把「收合面板」等面板級按鈕併入聊天 header（觸發前後同一個 UI，
   * 面板不再自長頂欄）。主頁態不傳。
   */
  chatHeaderExtra?: import("react").ReactNode;
}

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

/** 聊天区在卡片里的高度（CSS 变量，globals.css 定义；占位与实体同高防跳动）。 */
const AGENT_SURFACE_HEIGHT = "var(--agent-surface-height)";

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
  onSessionChange,
  fillAvailableHeight = false,
  chatHeaderExtra,
}: PromptInputProps) {
  // 订阅定价覆写：管理员改价后本页报价立即重算。
  usePricingRevision();
  const [input, setInput] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>(initialSuggestions);

  const prevDisplayModeRef = useRef(displayMode);
  useEffect(() => {
    prevDisplayModeRef.current = displayMode;
  }, [displayMode]);

  // ── 全模式共用外框高度（Task 3 抽成 use-height-lock.ts）──
  // generate/edit 實測自然高鎖為全模式外框高；測量根仍是本組件 JSX 裡
  // 綁定 contentRef 的那個 section（包含所有模式面的同一 DOM 節點）。
  const { contentRef, contentHeight } = useHeightLock({ displayMode, modelId, fillAvailableHeight });

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

  // ── D-24 状态A：渐进披露第一层（Task 3 抽成 use-agent-hint.ts）──
  // 提示开关 / sessionStorage 记号 / 5 秒计时 / 送出抑制全在 hook 里；
  // suppress 由 hook 回傳，generate / edit / upscale 三条送出路径闭包共享同一下发。
  const { agentHintOpen, spendAgentHint, suppress } = useAgentHint({ displayMode, input, isLoading });

  // 改图 / 放大各自维护来源图、阶段与结果；模式切换只换控件区，状态保留。
  const {
    editSource,
    setEditSource,
    editRatio,
    setEditRatio,
    editStage,
    setEditStage,
    editError,
    setEditError,
    editResultUrl,
    setEditResultUrl,
    editBusy,
    handleEditSubmit,
  } = usePixaiEdit({ prompt: input, isLoggedIn, onEditResult, suppress });
  const {
    upscaleSource,
    setUpscaleSource,
    upscaleSourceSize,
    setUpscaleSourceSize,
    upscaleStage,
    setUpscaleStage,
    upscaleError,
    setUpscaleError,
    upscaleResultUrl,
    setUpscaleResultUrl,
    upscaleBusy,
    handleUpscaleSubmit,
  } = usePixaiUpscale({ isLoggedIn, onUpscaleResult, suppress });

  const selectedModel = generationModel(modelId);
  const isVideo = selectedModel?.kind === "video";
  // 当前模型是否支持参考图：不支持时隐藏上传入口，而不是让用户上传完被清空。
  const referenceImagesSupported = Boolean(selectedModel?.referenceImages);

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
      suppress();
      onSubmit(input);
      return;
    }
    if (!isLoading && input.trim()) {
      // 送出即代表这次「卡住」已结束：关掉提示，生成完成后的看图时段不再弹。
      suppress();
      onSubmit(input);
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

  // ── 参考图：拖拽 / Ctrl+V 粘贴 两路补充入口（与 ReferenceImageUpload 按钮共用同一管道）。
  //    只在 generate 模式且当前模型支持参考图时生效；不支持的模型干脆不挂，
  //    避免「上传完被 effect 清空」的怪体验。
  const refUploadRef = useRef<{ acceptFiles: (files: File[]) => Promise<void> } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!referenceImagesSupported || displayMode !== "generate") return;
    dragDepthRef.current += 1;
    setDragActive(true);
  }, [referenceImagesSupported, displayMode]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    if (!referenceImagesSupported || displayMode !== "generate") return;
    void refUploadRef.current?.acceptFiles(files);
  }, [referenceImagesSupported, displayMode]);

  /** Ctrl+V：剪贴板里有图片文件才拦下走参考图；纯文本/HTML 正常放行。 */
  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    if (!referenceImagesSupported || displayMode !== "generate") return;
    event.preventDefault();
    void refUploadRef.current?.acceptFiles(files);
  }, [referenceImagesSupported, displayMode]);

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
    <section
      ref={contentRef}
      className={cn(
        "lg-card relative overflow-x-clip rounded-ios-3xl p-5 pb-6 sm:p-6 sm:pb-7",
        // 工作站面板態：卡片成為 flex 鏈的一環（高度由面板分配，不由內容撐）。
        fillAvailableHeight && "flex min-h-0 flex-1 flex-col",
      )}
      style={
        !fillAvailableHeight && contentHeight !== null
          ? { height: contentHeight, display: "flex", flexDirection: "column" }
          : undefined
      }
    >
      {/* Specular top edge */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white to-transparent opacity-80" aria-hidden="true" />

      {/* 2026-08-22：高度鎖升級到 section 級——generate/edit 實測整卡自然高，
          所有模式共用。內容區 flex-1 吸收底行高度差（agent 面底行換成極簡
          返回條也不影響外框），底部行 shrink-0。切換零跳動、零溢出。 */}
      <div
        className={cn(
          "relative space-y-4 min-h-0",
          (fillAvailableHeight || contentHeight !== null) && "flex flex-1 flex-col",
        )}
      >

        {/* ── 画面描述 ── 改图模式复用同一个输入框，只换 placeholder；
            放大模式不需要描述，进入时随动画「消散」。 ── */}
        <div
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={cn(
            "relative",
            textareaHidden && "hidden",
            textareaDissolving && "dust-exit",
            textareaReforming && "dust-enter",
            dragActive && "rounded-ios-2xl ring-2 ring-[rgba(0,122,255,0.45)] bg-[rgba(0,122,255,0.04)]",
          )}
        >
          {dragActive && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-ios-xl bg-[rgba(0,122,255,0.08)] text-sm font-semibold text-[#007AFF]"
            >
              松开以添加参考图
            </div>
          )}
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={displayMode === "edit" ? "描述想改成什么样子…" : "描述你的想法。例如：让这瓶香水出现在落日海滩，自然光线，质感高级。"}
            rows={5}
            className="min-h-[180px] rounded-ios-2xl border-0 bg-[rgba(0,0,0,0.04)] px-5 py-4 pb-14 text-[16px] leading-6 text-[rgba(0,0,0,0.85)] placeholder:text-[rgba(0,0,0,0.44)] focus:bg-[rgba(0,122,255,0.04)] focus:ring-2 focus:ring-[rgba(0,122,255,0.20)] resize-none transition-all duration-200 [background-image:none]"
          />
          {displayMode === "generate" && referenceImagesSupported && (
            <ReferenceImageUpload
              variant="prompt"
              value={referenceImages}
              onChange={onReferenceImagesChange}
              ref={refUploadRef}
            />
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

        {/* ── 模式控件区：只有这里参与模式切换动画 ──
            2026-08-22：高度改由外層 contentRef 容器統一鎖定（實測自然高），
            這層只負責在鎖定態用 flex-1 拉滿外框（agent/upscale 內容少也填滿），
            內容超出外框時內部滾動，不推高卡片。工作站態走 flex 鏈。 */}
        <div
          className={cn(
            "dust-transition",
            // 工作站面板态：模式控件区必须加入 flex 链（flex + min-h-0），
            // 否则 agent 聊天区的 flex-1 没有 flex 父容器会失效，
            // transcript 被内容撑高、composer 被推出面板外裁掉。
            fillAvailableHeight && "flex min-h-0 flex-1 flex-col",
            // 非工作站態：外層已定高（flex-col），這裡 flex-1 拉滿。
            // agent 面**不加** overflow-y-auto：聊天面自己管滾動（transcript 內滾），
            // 外層再滾一根只會在卡片右上角卡出一小段尷尬滾動條（2026-08-22 裁定）。
            !fillAvailableHeight && displayMode !== "agent" && "flex min-h-0 flex-1 flex-col overflow-y-auto",
            !fillAvailableHeight && displayMode === "agent" && "flex min-h-0 flex-1 flex-col",
            animState === "exit" && "dust-exit",
            animState === "enter" && "dust-enter",
          )}
        >
          {displayMode === "generate" && (
            <GenerateControls
              suggestions={suggestions}
              handleSuggestionSelect={handleSuggestionSelect}
              updateSuggestions={updateSuggestions}
              models={models}
              modelId={modelId}
              onModelChange={onModelChange}
              aspectRatio={aspectRatio}
              onAspectRatioChange={onAspectRatioChange}
              outputResolution={outputResolution}
              onOutputResolutionChange={onOutputResolutionChange}
              durationSeconds={durationSeconds}
              onDurationChange={onDurationChange}
              generateAudio={generateAudio}
              onGenerateAudioChange={onGenerateAudioChange}
              stylePreset={stylePreset}
              handleStyleChange={handleStyleChange}
              onToggleProfessionalMode={onToggleProfessionalMode}
            />
          )}

          {displayMode === "edit" && (
            <EditPanel
              editSource={editSource}
              setEditSource={setEditSource}
              editRatio={editRatio}
              setEditRatio={setEditRatio}
              editStage={editStage}
              setEditStage={setEditStage}
              editError={editError}
              setEditError={setEditError}
              editResultUrl={editResultUrl}
              setEditResultUrl={setEditResultUrl}
            />
          )}

          {displayMode === "upscale" && (
            <UpscalePanel
              upscaleSource={upscaleSource}
              setUpscaleSource={setUpscaleSource}
              upscaleSourceSize={upscaleSourceSize}
              setUpscaleSourceSize={setUpscaleSourceSize}
              upscaleStage={upscaleStage}
              setUpscaleStage={setUpscaleStage}
              upscaleError={upscaleError}
              setUpscaleError={setUpscaleError}
              upscaleResultUrl={upscaleResultUrl}
              setUpscaleResultUrl={setUpscaleResultUrl}
            />
          )}

          {/* ── AI 助理（D-1 / D-24 状态B）──
              和改图、放大同一层：toggle 一下换掉这块控件区，卡片底板、下面那排
              按钮、右边结果画布、底下案例区全部原地不动。不跳 /agent 独立页。
              高度写死在这里而不是靠内容撑：聊天区内部靠 flex-1 + min-h-0 自己滚，
              外层不给定高度的话 transcript 会把卡片撑到无限长，输入区被推出屏幕。
              例外：工作站浮動面板態（fillAvailableHeight）外層已有確定高度，
              改為 flex-1 填滿——固定 60dvh 塞進窄手機抽屜會裁掉輸入區。
              agent 面的「改图/放大/专业控制/开始创作」列本来就不需要：
              agent 面只有输入区自己送出，摆一排模式切换会跟 composer 抢底部空间。 */}
          {displayMode === "agent" && (
            <div
              className="flex min-h-0 flex-1 flex-col pt-1"
              // 2026-08-22：父容器（模式控件區）非工作站態已寫死同一高度，
              // 這裡 flex-1 填滿即可；不再自己設 height（雙重定高無益）。
              style={fillAvailableHeight ? { flex: "1 1 0%", minHeight: 0 } : { flex: "1 1 0%", minHeight: 0 }}
            >
              <AgentChatSurface
                variant="inline"
                // 挂载时读一次：外面已经打好的半句话，或别的页面交接过来的一句话。
                initialPrompt={agentSeed || input.trim()}
                onExit={() => onModeChange("generate")}
                {...(chatHeaderExtra ? { headerExtra: chatHeaderExtra } : {})}
                {...(onParamsReflected ? { onParamsReflected } : {})}
                {...(onImageResult ? { onImageResult } : {})}
                {...(onCanvasEvent ? { onCanvasEvent } : {})}
                {...(canvasStateProvider ? { canvasStateProvider } : {})}
                {...(onSessionChange ? { onSessionChange } : {})}
                currentModelId={modelId}
              />
            </div>
          )}
        </div>

        {/* ── 已套用状态 + 专业模式 + 出图按钮（Task 9 抽成 ActionRow）──
            agent 面整排换返回条；不参与模式动画，底行 shrink-0 原地不动。 */}
        <ActionRow
          displayMode={displayMode}
          mode={mode}
          onModeChange={onModeChange}
          fillAvailableHeight={fillAvailableHeight}
          stylePreset={stylePreset}
          handleStyleChange={handleStyleChange}
          isProfessionalMode={isProfessionalMode}
          onToggleProfessionalMode={onToggleProfessionalMode}
          handlePrimaryAction={handlePrimaryAction}
          primaryDisabled={primaryDisabled}
          editBusy={editBusy}
          editStage={editStage}
          upscaleBusy={upscaleBusy}
          upscaleStage={upscaleStage}
          isLoading={isLoading}
          isVideo={isVideo}
        />
      </div>
    </section>
  );
}
