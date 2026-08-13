"use client";

import { memo, useCallback, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
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
  placeholder = "输入消息…",
  sessionId,
  prefill,
  onPrefillConsumed,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files;
      const session = sessionId;
      if (!files || files.length === 0) return;
      if (!session) return;

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

      // 清空 input.value，好让同一文件能再次选择。
      event.target.value = "";
    },
    [sessionId, uploadPlainFile, uploadVideoFile, patchAttachment],
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

  const canAttach = !disabled && Boolean(sessionId);
  // 已经抽出帧的影片才进预览区（extracting 期间没有缩图可显示）。
  const videoPreviews = attachments.filter(
    (a): a is PendingAttachment & { videoUrl: string } =>
      Boolean(a.videoUrl) && (a.frames?.length ?? 0) > 0,
  );

  return (
    <div className="agent-composer flex items-end gap-2 rounded-[22px] bg-white/70 px-3 py-2 ring-1 ring-black/[0.08] shadow-[0_2px_16px_rgba(0,0,0,0.05)] backdrop-blur-xl">
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
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          "text-[#007AFF] transition-colors",
          "hover:bg-[rgba(0,122,255,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]",
          "disabled:cursor-not-allowed disabled:text-[rgba(0,0,0,0.30)]",
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
                  att.status === "error" && "bg-[rgba(255,59,48,0.10)] text-[#FF3B30]",
                  att.status === "ready" &&
                    "bg-[rgba(0,122,255,0.10)] text-[rgba(0,0,0,0.75)]",
                  (att.status === "uploading" || att.status === "extracting") &&
                    "bg-[rgba(0,0,0,0.05)] text-[rgba(0,0,0,0.45)]",
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
                  className="shrink-0 rounded-full p-0.5 text-current transition-colors hover:bg-[rgba(0,0,0,0.08)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(0,122,255,0.30)]"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
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
        <textarea
          id="agent-composer-input"
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            autoGrow(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          placeholder={placeholder}
          rows={1}
          className={cn(
            "max-h-32 w-full resize-none bg-transparent py-2 text-[15px] text-[rgba(0,0,0,0.85)]",
            "placeholder:text-[rgba(0,0,0,0.36)] focus:outline-none",
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
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200",
          "bg-[#007AFF] text-white shadow-[0_2px_8px_rgba(0,122,255,0.32)]",
          "hover:opacity-90 active:scale-[0.94]",
          "focus:outline-none focus:ring-2 focus:ring-[rgba(0,122,255,0.40)]",
          "disabled:cursor-not-allowed disabled:bg-[rgba(0,122,255,0.30)] disabled:text-white/70 disabled:shadow-none",
        )}
      >
        <Send className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}

export const AgentComposer = memo(AgentComposerComponent);