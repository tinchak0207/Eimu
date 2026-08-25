"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { ImagePlus, Loader2, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  toAgentAttachmentRef,
  uploadAgentAttachments,
  type AgentAttachment,
} from "@/lib/agent-chat-client";
import type { AgentAttachmentRef } from "@/lib/agent-chat-types";
import {
  FRAME_COUNT,
  extractFramesFromFile,
  isVideoFile,
  type FrameTimestamp,
} from "@/lib/video-frames";

export interface AgentComposerProps {
  /** 为 true 时（disabled 属性或会话已关闭）整个输入区禁用。 */
  disabled: boolean;
  onSend: (text: string) => void;
  placeholder?: string;
  /** 上传附件所需的目标会话 id。没传时附件按钮禁用。 */
  sessionId?: string | null;
  /**
   * D-24 无缝续写：把外面接进来的半句话填进输入框，光标落到末尾，不自动送出。
   * 直接送出会立刻触发扣费，与 D-5「花钱前必定交用户确认」冲突。
   *
   * 带 nonce：同一句话点第二次也要能重新填进来，靠内容比较会被去重。
   * 填完调用 onPrefillConsumed，让上游清掉信号，避免重渲染时反复覆盖用户新打的字。
   */
  prefill?: { text: string; nonce: number } | null;
  onPrefillConsumed?: () => void;
}

/** 允许选择的文件类型；列表与网关约定一致，避免上传后无法解析的格式。 */
const ACCEPTED_TYPES = [
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".xml",
  ".yaml",
  ".yml",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".mp4",
  ".mov",
  ".zip",
].join(",");

type PendingAttachmentStatus = "extracting" | "uploading" | "ready" | "error";

interface PendingAttachment {
  id: string;
  fileName: string;
  status: PendingAttachmentStatus;
  errorMessage?: string;
  /**
   * 上传成功后的 ref，送出时写进 [附件] 区块。
   * 影片一条 chip 对应 4 个 ref（4 张抽出的帧），所以这里是数组。
   */
  refs?: AgentAttachmentRef[];
  /** 影片专用：原片的 Object URL（预览可播，D-16）。移除／送出时必须 revoke。 */
  videoUrl?: string;
  /** 影片专用：4 张缩图的 Object URL 与时间点文案。 */
  frames?: { url: string; label: string }[];
  /** 抽帧进度（0…FRAME_COUNT），仅 extracting 期间有意义。 */
  framesDone?: number;
}

/**
 * 输入框跟着内容长高，上限交给 CSS 的 max-h-32（到顶后自己滚）。
 * rows=1 的固定高度下，续写一段长愿望只能看见最后一行，看不到自己写了什么。
 */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/** 释放一条 chip 持有的所有 Object URL（原片 + 缩图）。 */
function releaseUrls(att: PendingAttachment) {
  if (att.videoUrl) URL.revokeObjectURL(att.videoUrl);
  att.frames?.forEach((f) => URL.revokeObjectURL(f.url));
}

/** 附件的存储路径（path），写进 [附件] 区块的「1. {path} | {mime} | {size}」。 */
function attachmentLine(ref: AgentAttachmentRef): string {
  const mime = ref.mime ?? "application/octet-stream";
  const size = typeof ref.size === "number" ? String(ref.size) : "?";
  return `${ref.path} | ${mime} | ${size}`;
}

function buildAttachmentBlock(attachments: AgentAttachmentRef[]): string {
  const lines = attachments
    .map((ref, i) => `${i + 1}. ${attachmentLine(ref)}`)
    .join("\n");
  return `\n[ATTACHMENTS_BLOCK]\n[附件]\n${lines}\n[/ATTACHMENTS_BLOCK]`;
}

let attachmentSeq = 0;

function AgentComposerComponent({
  disabled,
  onSend,
  placeholder = "描述新需求，或要求修改上一轮的图…",
  sessionId,
  prefill,
  onPrefillConsumed,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 键盘规避：composer 根元素需要被抬升/复位，所以给它一个 ref。
  const composerRef = useRef<HTMLDivElement>(null);
  const trimmed = text.trim();

  const handlePick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** 就地改一条 chip，不碰其他条（每个文件的失败互不牵连）。 */
  const patchAttachment = useCallback((id: string, patch: Partial<PendingAttachment>) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  /** 普通文件：原样上传。 */
  const uploadPlainFile = useCallback(
    async (session: string, id: string, file: File) => {
      const uploaded: AgentAttachment[] = await uploadAgentAttachments(session, [file]);
      const first = uploaded[0];
      if (!first) throw new Error("上传结果为空。");
      patchAttachment(id, { status: "ready", refs: [toAgentAttachmentRef(first)] });
    },
    [patchAttachment],
  );

  /**
   * 影片（D-16）：先抽 4 帧再上传这 4 张 JPEG，原片本身不上传。
   * 视觉模型看不了影片，抽帧是唯一能让它"看到"内容的路径；原片留在本地供预览播放。
   * 超限（60 秒 / 100 MB）由 extractFramesFromFile 抛错，原因直接显示在 chip 上。
   */
  const uploadVideoFile = useCallback(
    async (session: string, id: string, file: File) => {
      const videoUrl = URL.createObjectURL(file);
      patchAttachment(id, { status: "extracting", framesDone: 0, videoUrl });

      let extracted: { files: File[]; timestamps: FrameTimestamp[] };
      try {
        extracted = await extractFramesFromFile(file, videoUrl, (done) =>
          patchAttachment(id, { framesDone: done }),
        );
      } catch (err) {
        // 抽帧失败／超限：原片 URL 立刻释放，别把 100 MB 挂在内存里等用户删 chip。
        URL.revokeObjectURL(videoUrl);
        patchAttachment(id, { videoUrl: undefined });
        throw err;
      }

      const frames = extracted.files.map((f, i) => ({
        url: URL.createObjectURL(f),
        label: extracted.timestamps[i]?.label ?? `第 ${i + 1} 帧`,
      }));
      patchAttachment(id, { status: "uploading", frames, framesDone: extracted.files.length });

      const uploaded = await uploadAgentAttachments(session, extracted.files);
      if (uploaded.length === 0) throw new Error("抽帧上传结果为空。");
      patchAttachment(id, { status: "ready", refs: uploaded.map(toAgentAttachmentRef) });
    },
    [patchAttachment],
  );

  /**
   * 公共入队函数：把一批 File 逐个加入 chip 行并触发上传。
   * 拖拽、Ctrl+V 粘贴、隐式文件选择三条入口共用这一条管道。
   */
  const enqueueFiles = useCallback(
    (files: File[]) => {
      if (disabled) return;
      if (!sessionId) return;
      if (files.length === 0) return;
      const session = sessionId;

      // 每个文件独立处理，各自的失败不拖累其他文件。
      Array.from(files).forEach((file) => {
        const id = `att-${++attachmentSeq}`;
        setAttachments((prev) => [...prev, { id, fileName: file.name, status: "uploading" }]);

        const job = isVideoFile(file)
          ? uploadVideoFile(session, id, file)
          : uploadPlainFile(session, id, file);

        job.catch((err) => {
          const message = err instanceof Error ? err.message : "上传失败。";
          patchAttachment(id, { status: "error", errorMessage: message });
        });
      });
    },
    [disabled, sessionId, uploadPlainFile, uploadVideoFile, patchAttachment],
  );

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      enqueueFiles(Array.from(event.target.files ?? []));
      // 清空 input.value，好让同一文件能再次选择。
      event.target.value = "";
    },
    [enqueueFiles],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) releaseUrls(gone);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  // 组装最终文本：附加 [附件] 区块（只纳入已传成功的），然后交给 onSend。
  // 影片一条 chip 展开成 4 行（4 张帧各自一个 path），编号连续。
  const handleSend = useCallback(() => {
    if (!trimmed) return;
    const readyRefs = attachments
      .filter((a) => a.status === "ready")
      .flatMap((a) => a.refs ?? []);
    const finalText = readyRefs.length > 0 ? `${trimmed}\n${buildAttachmentBlock(readyRefs)}` : trimmed;
    onSend(finalText);
    setText("");
    // 清空文字后高度要跟着收回来，否则空框还占着刚才那几行。
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // 送出后 chip 清空：这些 Object URL 已经没有可见引用，必须一起释放。
    attachments.forEach(releaseUrls);
    setAttachments([]);
  }, [trimmed, onSend, attachments]);

  /**
   * D-24：把半句话接进输入框并把光标放到末尾——用户下一个动作就是继续打字。
   * 框里已经有字时接在后面而不是覆盖：覆盖等于把人刚打的东西吃掉。
   * 只认 nonce 变化，所以「同一句话点两次」也生效，而重渲染不会重复注入。
   */
  const consumedNonceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill) return;
    const incoming = prefill.text.trim();
    if (!incoming || consumedNonceRef.current === prefill.nonce) return;
    consumedNonceRef.current = prefill.nonce;
    setText((current) => {
      const base = current.trimEnd();
      return base ? `${base} ${incoming}` : incoming;
    });
    // 聚焦要等这次 setState 刷完，否则 selectionStart 落在旧内容的长度上。
    //
    // 这里故意不 return cancelAnimationFrame：下一行的 onPrefillConsumed 会把上游的
    // prefill 置空，依赖变化 → 清理函数在 rAF 回调之前就跑，光标永远等不到。
    // 组件卸载时 textareaRef.current 已被 React 置 null，回调自己会退出。
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    });
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]);

  // 卸载时兜底释放：用户直接关掉聊天面板时不会走 removeAttachment。
  // 依赖空数组 + ref 读最新值，避免每次 attachments 变化都重挂 effect。
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach(releaseUrls);
    };
  }, []);

  /**
   * 移动端虚拟键盘规避。
   *
   * iOS 弹键盘时 window.innerHeight 不变，只有 visualViewport 缩小，
   * composer 所在的卡片是定高（AGENT_SURFACE_HEIGHT），系统自动滚页未必
   * 能把输入区完全抬出键盘——于是 composer 被盖住、看不到自己在打什么。
   * 这里监听 visualViewport 的 resize/scroll（弹键盘、滚页都会触发），
   * 量出 composer 底部相对键盘顶部的实际越界量，用 transform 抬到键盘上方；
   * 不假设窗口高度，也不依赖具体布局。桌面（fine pointer）完全不介入。
   */
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    if (window.matchMedia("(pointer: fine)").matches) return;
    const vv = window.visualViewport ?? null;
    const KEYBOARD_GAP = 8;
    const apply = () => {
      const rect = el.getBoundingClientRect();
      const offsetTop = vv ? vv.offsetTop : 0;
      const height = vv ? vv.height : window.innerHeight;
      // composer 底部在可视区里比键盘顶（= 可视区底）低多少。
      const overlap = rect.bottom - offsetTop - height + KEYBOARD_GAP;
      if (overlap > 4) {
        el.style.transform = "translateY(" + -overlap + "px)";
        el.style.transition = window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "none"
          : "transform 0.2s cubic-bezier(0.4, 0, 0.2, 1)";
      } else {
        el.style.transform = "";
        el.style.transition = "";
      }
    };
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
    }
    window.addEventListener("resize", apply);
    apply();
    return () => {
      if (vv) {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      }
      window.removeEventListener("resize", apply);
      el.style.transform = "";
      el.style.transition = "";
    };
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter 发送，Shift+Enter 换行。
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (!trimmed) return;
        handleSend();
      }
    },
    [trimmed, handleSend],
  );

  /** Ctrl+V 粘贴：有文件时走附件管道，纯文本/HTML 放行。 */
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      enqueueFiles(Array.from(files));
    },
    [disabled, enqueueFiles],
  );

  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      if (disabled) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    [disabled],
  );

  const handleDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    [],
  );

  const handleDragLeave = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepthRef.current -= 1;
      if (dragDepthRef.current <= 0) {
        dragDepthRef.current = 0;
        setDragActive(false);
      }
    },
    [],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = event.dataTransfer.files;
      if (files.length === 0) return;
      // 有文件进来必须先拦下浏览器的默认行为（否则会直接打开文件/跳页），
      // 再判断 disabled —— 禁用的输入区拖文件进来同样不能触发打开。
      event.preventDefault();
      if (disabled) return;
      enqueueFiles(Array.from(files));
    },
    [disabled, enqueueFiles],
  );

  const canAttach = !disabled && Boolean(sessionId);
  // 已经抽出帧的影片才进预览区（extracting 期间没有缩图可显示）。
  const videoPreviews = attachments.filter(
    (a): a is PendingAttachment & { videoUrl: string } =>
      Boolean(a.videoUrl) && (a.frames?.length ?? 0) > 0,
  );

  return (
    <div
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "agent-composer relative flex items-end gap-2 rounded-[20px] bg-[rgba(120,120,128,0.07)] px-3 py-1.5 touch-manipulation [-webkit-tap-highlight-color:transparent] focus-within:ring-2 focus-within:ring-ios-blue/30",
        dragActive && "!ring-2 !ring-ios-blue/45 !bg-ios-blue/[0.04]",
      )}
    >
      {/* 拖拽悬停提示：只是视觉反馈，不吃鼠标事件（pointer-events-none）。 */}
      {dragActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-2 inset-y-1 flex items-center justify-center rounded-[16px] bg-ios-blue/[0.08] text-sm font-medium text-ios-blue"
        >
          松开以添加附件
        </div>
      )}
      {/*
        附件按钮：点击打开隐式文件选择，一次可选多个文件，选完即逐个上传。
        上传中的 chip 显示 spinner，失败显示错误态（可移除重传或删除）。
      */}
      <button
        type="button"
        onClick={handlePick}
        disabled={!canAttach}
        aria-label="添加附件"
        title="添加附件（图片 / 视频 / 文档）"
        className={cn(
          "flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full",
          "bg-ios-blue/10 text-ios-blue transition-colors",
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
          "hover:bg-ios-blue/[0.16] active:bg-ios-blue/[0.22] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30",
          "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-foreground/45",
        )}
      >
        <ImagePlus className="h-5 w-5" aria-hidden="true" />
      </button>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPTED_TYPES}
        onChange={handleFileInput}
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
      />

      <div className="flex min-w-0 max-w-[42rem] flex-1 flex-col">
        {/* 待发送附件 chip 行：成功 / 上传中 / 错误 三种状态都带移除按钮。 */}
        {attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {attachments.map((att) => (
              <span
                key={att.id}
                className={cn(
                  "inline-flex max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-ios-caption1",
                  att.status === "error" && "bg-destructive/10 text-destructive",
                  att.status === "ready" &&
                    "bg-ios-blue/10 text-muted-foreground",
                  (att.status === "uploading" || att.status === "extracting") &&
                    "bg-black/5 text-foreground/45",
                )}
              >
                {(att.status === "uploading" || att.status === "extracting") && (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                )}
                <span className="truncate" title={att.errorMessage ?? att.fileName}>
                  {att.fileName}
                </span>
                {/* 抽帧进度用文字给，不另起进度条：一行 chip 装不下也没必要。 */}
                {att.status === "extracting" && (
                  <span className="shrink-0 tabular-nums" aria-live="polite">
                    抽帧 {att.framesDone ?? 0}/{FRAME_COUNT}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={`移除 ${att.fileName}`}
                  className="shrink-0 rounded-full p-2 text-current transition-colors hover:bg-black/[0.08] active:bg-black/[0.14] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation [-webkit-tap-highlight-color:transparent]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/*
          影片预览（D-16）：4 张缩图一列显示，原片可播。
          放在 chip 行下方而不是塞进 chip 里 —— chip 是一行文字的量级，
          缩图列需要自己的高度，挤进去两者都会变形。
        */}
        {videoPreviews.length > 0 && (
          <div className="mb-1.5 flex flex-col gap-2">
            {videoPreviews.map((att) => (
              <div key={`preview-${att.id}`} className="flex items-center gap-2">
                <video
                  src={att.videoUrl}
                  controls
                  muted
                  playsInline
                  preload="metadata"
                  aria-label={`原片：${att.fileName}`}
                  className="h-16 w-24 shrink-0 rounded-ios-md bg-black object-cover"
                />
                <div className="flex min-w-0 gap-1.5 overflow-x-auto">
                  {att.frames?.map((frame, i) => (
                    // eslint-disable-next-line @next/next/no-img-element -- Object URL 不能走 next/image
                    <img
                      key={frame.url}
                      src={frame.url}
                      alt={`第 ${i + 1} 帧，${frame.label}`}
                      title={frame.label}
                      className="h-16 w-16 shrink-0 rounded-ios-md object-cover"
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <label htmlFor="agent-composer-input" className="sr-only">
          输入消息
        </label>
        {/* 移动端虚拟键盘把回车键显示成「发送」，回车即送出（Shift+Enter 换行不变）。
            2026-08-25 空间压实：min-h 从 ~3 行收到 ~2 行半——autoGrow 长高、
            max-h 到顶自滚，min-h 只兜空框下限，不再是常驻留白。 */}
        <textarea
          id="agent-composer-input"
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            autoGrow(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          enterKeyHint="send"
          disabled={disabled}
          placeholder={placeholder}
          rows={3}
          className={cn(
            "min-h-[60px] max-h-52 w-full resize-none bg-transparent py-1.5 text-base text-foreground sm:min-h-[72px] sm:text-[15px]",
            "placeholder:text-muted-foreground/70 focus:outline-none",
            "touch-manipulation [-webkit-tap-highlight-color:transparent]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      <button
        type="button"
        onClick={handleSend}
        disabled={disabled || !trimmed}
        aria-label="发送"
        className={cn(
          "flex h-11 w-11 sm:h-8 sm:w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200",
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
          "bg-ios-blue text-white shadow-[0_2px_8px_rgba(0,122,255,0.32)]",
          "hover:opacity-90 active:scale-[0.94]",
          "focus:outline-none focus:ring-2 focus:ring-ios-blue/40",
          "disabled:cursor-not-allowed disabled:bg-[rgba(120,120,128,0.18)] disabled:text-white/80 disabled:shadow-none",
        )}
      >
        <Send className="h-5 w-5" aria-hidden="true" />
      </button>
    </div>
  );
}

export const AgentComposer = memo(AgentComposerComponent);