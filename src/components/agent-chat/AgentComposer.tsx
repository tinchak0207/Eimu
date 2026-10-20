"use client";

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { ArrowUp, Loader2, Navigation, Plus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  toAgentAttachmentRef,
  uploadAgentAttachments,
  type AgentAttachment,
} from "@/lib/agent-chat-client";
import { MAX_VIDEO_BYTES, UploadAbortedError, uploadAudioDirect, uploadVideoDirect } from "@/lib/agent-uploads";
import {
  FRAME_COUNT,
  extractFramesFromFile,
  formatFrameTime,
  isVideoFile,
  type FrameTimestamp,
} from "@/lib/video-frames";
import {
  ingestMediaLocally,
  isIngestUsable,
  toDerivedFiles,
  type LocalMediaIngest,
} from "@/lib/local-media-ingest";
import {
  SkillSlashMenu,
  shouldOpenSlashMenu,
  slashQueryOf,
  type SlashMenuSkill,
} from "./SkillSlashMenu";
import type { AgentComposerProps, PendingAttachment } from "./AgentComposer.types";
import {
  ACCEPTED_TYPES,
  DERIVED_UPLOAD_TIMEOUT_MS,
  MAX_FILE_BYTES,
  PLAIN_UPLOAD_TIMEOUT_MS,
  UploadTimeoutError,
  VIDEO_UPLOAD_TIMEOUT_MS,
  formatMb,
  isAudioFile,
  withUploadDeadline,
} from "./AgentComposer.upload-limits";
import { autoGrow, releaseUrls } from "./AgentComposer.attachments";
import {
  COMPACT_PLACEHOLDER,
  DEFAULT_PLACEHOLDER,
  placeholderFits,
  resolveBasePlaceholder,
} from "./AgentComposer.placeholder";
import { ThinkingLevelMenu } from "./AgentComposer.menus";
import { LocalFileModeMenu } from "./AgentComposer.local-file-mode";
import { useComposerSendPipeline } from "./AgentComposer.send-pipeline";
import { useComposerInteraction } from "./AgentComposer.interaction";

let attachmentSeq = 0;

export type { AgentComposerProps } from "./AgentComposer.types";
export { VIDEO_UPLOAD_TIMEOUT_MS, PLAIN_UPLOAD_TIMEOUT_MS, UploadTimeoutError, withUploadDeadline, SEND_HARD_TIMEOUT_MS } from "./AgentComposer.upload-limits";
export { resolveBasePlaceholder, PLACEHOLDER_SAFETY_PX, placeholderFitsWidth } from "./AgentComposer.placeholder";
export { hasPendingAttachments, computeCanSend, nextSendBusy } from "./AgentComposer.attachments";
export { LocalFileModeMenuView, type LocalFileModeMenuViewProps } from "./AgentComposer.local-file-mode";

function AgentComposerComponent({
  disabled,
  onSend,
  placeholder = DEFAULT_PLACEHOLDER,
  sessionId,
  onEnsureSession,
  prefill,
  onPrefillConsumed,
  onStop,
  steerActive = false,
  stopPending = false,
  externalSendPending = false,
  attachFilesRef,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /**
   * 打「/」直呼 Skill（2026-09-27）：输入框开头的「/」把能力条目当场叫出来。
   *
   * 闸门有两层，都在纯函数里：slashArmed＝使用者**真的打出那一颗「/」**的动作
   * （只有动作才开菜单，空框不主动弹一层盖住欢迎态）；shouldOpenSlashMenu(text)
   * ＝文字形态还是指令（空框或首字符「/」）。两层都真才显示。
   */
  const [slashArmed, setSlashArmed] = useState(false);
  /** 菜单当前选中行（受控）。查询词一变就复位到第一行。 */
  const [slashIndex, setSlashIndex] = useState(0);
  /**
   * 菜单当前可见列表（由菜单上报）。Enter/Tab 要按 slashIndex 取当前项，读它即可——
   * 用 ref 不用 state：列表本身没有独立渲染意义，为它多一轮渲染不值。
   */
  const slashSkillsRef = useRef<SlashMenuSkill[]>([]);
  // 送出进行中：钉住 spinner 到投递落地（onSend 的 promise 结算或硬保险到点）。
  const [sending, setSending] = useState(false);
  /**
   * 送出锁的同步镜像。连点发生在两次 re-render 之间时 state 还是旧值，
   * 只有 ref 能在同一帧里挡住第二次送出（否则 = 两条消息 + 两次计费）。
   */
  const sendingRef = useRef(false);
  /** 硬保险计时器句柄；解锁时清掉，避免悬空 setTimeout 反复 setState。 */
  const sendUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 键盘规避：composer 根元素需要被抬升/复位，所以给它一个 ref。
  const composerRef = useRef<HTMLDivElement>(null);
  // 框宽放不下长 placeholder 时换短句；框宽变化（转屏、面板拖宽）即重量。
  const [compactPlaceholder, setCompactPlaceholder] = useState(false);
  // 触控装置判定（2026-10-03）：SSR 与首帧一律 false（=桌面长句，避免 hydration
  // mismatch），挂载后用 matchMedia("(pointer: coarse)") 判定一次再切「传上来」版。
  const [coarsePointer, setCoarsePointer] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    setCoarsePointer(window.matchMedia("(pointer: coarse)").matches);
  }, []);
  const basePlaceholder = resolveBasePlaceholder(placeholder, coarsePointer);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = (): void => setCompactPlaceholder(!placeholderFits(el, basePlaceholder));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [basePlaceholder]);
  const trimmed = text.trim();
  /** 斜线菜单：查询词＝「/」之后的文字；两层闸门都真才显示（见上面 slashArmed）。 */
  const slashQuery = slashQueryOf(text);
  const slashMenuOpen = slashArmed && shouldOpenSlashMenu(text);

  const handlePick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** 就地改一条 chip，不碰其他条（每个文件的失败互不牵连）。 */
  const patchAttachment = useCallback((id: string, patch: Partial<PendingAttachment>) => {
    setAttachments((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  }, []);

  /**
   * 每颗 chip 在途上传的取消句柄（2026-10-04 缺陷 A）。取消钮／移除钮／重试都会
   * abort 对应请求；结算（成功或失败）后清掉，避免泄漏。
   */
  const uploadAbortsRef = useRef<Map<string, AbortController>>(new Map());
  const uploadMountedRef = useRef(true);
  const beginUpload = useCallback((id: string): AbortController => {
    const controller = new AbortController();
    uploadAbortsRef.current.set(id, controller);
    return controller;
  }, []);
  const endUpload = useCallback((id: string): void => {
    uploadAbortsRef.current.delete(id);
  }, []);
  /** 真实进度回调工厂：total>0 才报，绝不假造百分比。 */
  const progressReporter = useCallback(
    (id: string) => (loaded: number, total: number) => {
      if (total > 0) patchAttachment(id, { progress: Math.min(1, loaded / total) });
    },
    [patchAttachment],
  );

  /** 普通文件：原样上传。无降级链，逾时必须落明确错误终态给人话（不得永久 uploading）。 */
  const uploadPlainFile = useCallback(
    async (session: string, id: string, file: File, signal: AbortSignal) => {
      const uploaded: AgentAttachment[] = await withUploadDeadline(
        uploadAgentAttachments(session, [file], { onProgress: progressReporter(id), signal }),
        PLAIN_UPLOAD_TIMEOUT_MS,
      );
      const first = uploaded[0];
      if (!first) throw new Error("上传结果为空。");
      patchAttachment(id, { status: "ready", refs: [toAgentAttachmentRef(first)], progress: 1 });
    },
    [patchAttachment, progressReporter],
  );

  /**
   * 影片（D-16 + 本机前处理 W1）：**先把原档在本机抽出衍生档**（关键帧 JPEG＋poster
   * ＋probe JSON），只把衍生档送上行，原片留在本机当预览——不再把原片传上云端让 agent 看。
   *
   * 渐进增强（任何一步失败都回到今天的行为，不得弄坏既有附件流程）：
   *   1. 本机 ingest 可用 → 只上行衍生档（载入关键帧缩图，聊天框渲染原档可播 + 关键帧列）。
   *   2. ingest 降级／失败，或衍生档上传失败 → 原片直传网关（uploadVideoDirect，绕开
   *      Vercel 4.5MB 体上限）。
   *   3. 直传失败（无票 / 401 / 413 / 415 / 网络）→ 旧抽帧路径：抽 4 张 JPEG 上传。
   * 上限（**600 秒** / 100 MB，以 video-frames.MAX_VIDEO_DURATION_SECONDS 为准）由抽帧
   * 与 ingest 的计划层把关，原因直接显示在 chip 上。
   */
  const uploadVideoFile = useCallback(
    async (session: string, id: string, file: File, signal: AbortSignal) => {
      const videoUrl = URL.createObjectURL(file);
      // 任何路径下原档预览都先可见；上传中态与今天一致。
      patchAttachment(id, { status: "uploading", videoUrl });

      // 1) 本机前处理：契约上永不抛；这里仍兜底成 null 走回退路径。
      let ingested: LocalMediaIngest | null = null;
      try {
        ingested = await ingestMediaLocally(file);
      } catch {
        ingested = null;
      }
      if (signal.aborted) throw new UploadAbortedError();

      if (isIngestUsable(ingested)) {
        const frameUrls = ingested.keyframes.map((frame) => URL.createObjectURL(frame.blob));
        try {
          const frames = ingested.keyframes.map((frame, i) => ({
            url: frameUrls[i],
            label: formatFrameTime(frame.tSec),
          }));
          patchAttachment(id, { status: "uploading", frames, framesDone: frames.length });
          const uploaded = await withUploadDeadline(
            uploadAgentAttachments(session, toDerivedFiles(ingested, file.name), {
              onProgress: progressReporter(id),
              signal,
            }),
            DERIVED_UPLOAD_TIMEOUT_MS,
          );
          if (uploaded.length === 0) throw new Error("衍生档上传结果为空。");
          patchAttachment(id, {
            status: "ready",
            refs: uploaded.map(toAgentAttachmentRef),
            videoUrl,
            frames,
            progress: 1,
          });
          return;
        } catch (err) {
          if (err instanceof UploadAbortedError) {
            frameUrls.forEach((url) => URL.revokeObjectURL(url));
            throw err;
          }
          // 衍生档上行失败：释放本机缩图并清掉 frames，落回原档路径（不显示错误）。
          frameUrls.forEach((url) => URL.revokeObjectURL(url));
          patchAttachment(id, { frames: undefined });
        }
      }

      // 2) 回退：今天的第一条路——原片直传网关。
      try {
        const ref = await withUploadDeadline(
          uploadVideoDirect(session, file, { onProgress: progressReporter(id), signal }),
          VIDEO_UPLOAD_TIMEOUT_MS,
        );
        patchAttachment(id, { status: "ready", refs: [ref], videoUrl, progress: 1 });
        return;
      } catch (err) {
        // 逾时必须落明确终态并给人话（不得留在 uploading）；取消同理直接上抛。
        // 其他直传失败（无票/401/413/415/网络）照旧静默落抽帧降级路径。
        if (err instanceof UploadTimeoutError || err instanceof UploadAbortedError) throw err;
      }

      // 3) 直传也失败：既有抽帧降级路径（行为与今天逐位一致）。
      if (signal.aborted) {
        URL.revokeObjectURL(videoUrl);
        patchAttachment(id, { videoUrl: undefined });
        throw new UploadAbortedError();
      }
      let extracted: { files: File[]; timestamps: FrameTimestamp[] };
      try {
        patchAttachment(id, { status: "extracting", framesDone: 0 });
        extracted = await extractFramesFromFile(file, videoUrl, (done) =>
          patchAttachment(id, { framesDone: done }),
        );
      } catch (err) {
        // 抽帧失败／超限：原片 URL 立刻释放，别把 100 MB 挂在记忆体里等用户删 chip。
        URL.revokeObjectURL(videoUrl);
        patchAttachment(id, { videoUrl: undefined });
        throw err;
      }

      const frames = extracted.files.map((f, i) => ({
        url: URL.createObjectURL(f),
        label: extracted.timestamps[i]?.label ?? `第 ${i + 1} 帧`,
      }));
      patchAttachment(id, { status: "uploading", frames, framesDone: extracted.files.length });

      const uploaded = await withUploadDeadline(
        uploadAgentAttachments(session, extracted.files, { onProgress: progressReporter(id), signal }),
        DERIVED_UPLOAD_TIMEOUT_MS,
      );
      if (uploaded.length === 0) throw new Error("抽帧上传结果为空。");
      patchAttachment(id, { status: "ready", refs: uploaded.map(toAgentAttachmentRef), progress: 1 });
    },
    [patchAttachment, progressReporter],
  );

  /**
   * 音频（真歌等本地参考素材）：原档走**与视频同一条**网关票券直传大档路径
   * （uploadAudioDirect → POST /agent/v1/sessions/<id>/video-upload），绕开 Vercel
   * 4.5MB 体上限，上限同网关 100MB。不做本机抽帧／降级链——音频没有可抽的帧；
   * 失败（无票／401／413／415／网络／逾时／取消）由 enqueueFiles 的 job.catch 落人话错误 chip。
   */
  const uploadAudioFile = useCallback(
    async (session: string, id: string, file: File, signal: AbortSignal) => {
      const ref = await withUploadDeadline(
        uploadAudioDirect(session, file, { onProgress: progressReporter(id), signal }),
        VIDEO_UPLOAD_TIMEOUT_MS,
      );
      patchAttachment(id, { status: "ready", refs: [ref], progress: 1 });
    },
    [patchAttachment, progressReporter],
  );

  /**
   * 公共入队函数：把一批 File 逐个加入 chip 行并触发上传。
   * 拖拽、Ctrl+V 粘贴、隐式文件选择三条入口共用这一条管道。
   */
  const enqueueFiles = useCallback(
    async (files: File[]) => {
      if (disabled) return;
      if (files.length === 0) return;
      // 09-13 附件 lazy 建号：空态（还没发过消息）选档＝用户明确动作，与 send()
      // 同源走 ensureSession（复用 start() 串行化管线，不并发第二条 POST）。
      const session = sessionId ?? (await onEnsureSession?.());
      if (!uploadMountedRef.current) return;
      if (!session) {
        Array.from(files).forEach((file) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: `att-${++attachmentSeq}`,
              fileName: file.name,
              status: "error",
              errorMessage: "未能建立会话，请先登录或稍后重试。",
              file,
            },
          ]);
        });
        return;
      }

      // 缺陷 B 修复（2026-10-04）：重复附件去重。重复注入同一档会留下永远
      // uploading 的第二颗 chip（上游幂等重送／同会话同档第二次直传不落地），
      // hasPendingAttachments 因此永久为真 → 送出键永久 disabled（状态机死角）。
      // 去重键＝文件名＋位元组数＋最后修改时刻（同名不同内容、同大小不同档都不会
      // 被误合并）。已在途／已就绪的同键 chip 直接跳过；error／已取消的允许重加。
      const existingKeys = new Set(
        attachmentsRef.current
          .filter((a) => a.status === "ready" || a.status === "uploading" || a.status === "extracting")
          .map((a) => `${a.fileName}\u0000${a.file?.size ?? ""}\u0000${a.file?.lastModified ?? ""}`),
      );
      const batchKeys = new Set<string>();

      // 每个文件独立处理，各自的失败不拖累其他文件。
      Array.from(files).forEach((file) => {
        // 去重：与既有在途/就绪 chip 或本批已受理的同键档重复 → 静默跳过。
        const dedupKey = `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
        if (existingKeys.has(dedupKey) || batchKeys.has(dedupKey)) return;
        batchKeys.add(dedupKey);

        const id = `att-${++attachmentSeq}`;
        // 罪状 2b：超限文件不上传，直接落一颗带人话文案的错误 chip。
        // 影片／音频豁免 4MB 站内代理闸（原片走网关直传），改用网关的 100MB 上限。
        const directUpload = isVideoFile(file) || isAudioFile(file);
        const maxBytes = directUpload ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
        if (file.size > maxBytes) {
          setAttachments((prev) => [
            ...prev,
            {
              id,
              fileName: file.name,
              status: "error",
              errorMessage: `文件 ${formatMb(file.size)} MB 超过上限 ${formatMb(maxBytes)} MB，请压缩或拆分后再上传`,
              file,
            },
          ]);
          return;
        }
        setAttachments((prev) => [...prev, { id, fileName: file.name, status: "uploading", progress: 0, file }]);

        const controller = beginUpload(id);
        const job = isVideoFile(file)
          ? uploadVideoFile(session, id, file, controller.signal)
          : isAudioFile(file)
            ? uploadAudioFile(session, id, file, controller.signal)
            : uploadPlainFile(session, id, file, controller.signal);

        job
          .catch((err) => {
            // 取消（使用者按取消／移除）＝中性「已取消」，不是失败红字；chip 留在
            // 可重送态（不阻塞送出，有重试入口）。
            if (err instanceof UploadAbortedError) {
              patchAttachment(id, { status: "error", errorMessage: "已取消上传", progress: undefined });
              return;
            }
            const message = err instanceof Error ? err.message : "上传失败。";
            patchAttachment(id, { status: "error", errorMessage: message, progress: undefined });
          })
          .finally(() => endUpload(id));
      });
    },
    [
      disabled,
      sessionId,
      onEnsureSession,
      uploadPlainFile,
      uploadVideoFile,
      uploadAudioFile,
      patchAttachment,
      beginUpload,
      endUpload,
    ],
  );

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void enqueueFiles(Array.from(event.target.files ?? []));
      // 清空 input.value，好让同一文件能再次选择。
      event.target.value = "";
    },
    [enqueueFiles],
  );

  /**
   * A-3（2026-10-03）：把既有附件入口 enqueueFiles 注册给外部 ref。只注册，
   * 不改任何入队逻辑（多档逐个处理、lazy 建号、状态机都在既有函数里）；卸载时
   * 归 null。不传 ref ＝不注册，行为逐位元不变。
   */
  useEffect(() => {
    if (!attachFilesRef) return;
    attachFilesRef.current = (files: File[]) => {
      void enqueueFiles(files);
    };
    return () => {
      attachFilesRef.current = null;
    };
  }, [attachFilesRef, enqueueFiles]);

  const removeAttachment = useCallback((id: string) => {
    // 移除＝取消在途请求（若还在传），否则 XHR 会在 chip 消失后继续跑。
    uploadAbortsRef.current.get(id)?.abort();
    uploadAbortsRef.current.delete(id);
    setAttachments((prev) => {
      const gone = prev.find((a) => a.id === id);
      if (gone) releaseUrls(gone);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  /**
   * 取消上传（缺陷 A）：中止在途 XHR，chip 落中性「已取消上传」态——不阻塞送出，
   * 且因为 chip 保留 file 引用，带「重试」入口，chip 回到可重送状态。
   */
  const cancelAttachment = useCallback(
    (id: string) => {
      uploadAbortsRef.current.get(id)?.abort();
      uploadAbortsRef.current.delete(id);
      patchAttachment(id, { status: "error", errorMessage: "已取消上传", progress: undefined });
    },
    [patchAttachment],
  );

  const { retryAttachment, canSend, handleSend, attachmentsRef } = useComposerSendPipeline({
    attachments,
    trimmed,
    sending,
    sendingRef,
    externalSendPending,
    setSending,
    sendUnlockTimerRef,
    onSend,
    setText,
    textareaRef,
    prefill,
    onPrefillConsumed,
    uploadAbortsRef,
    uploadMountedRef,
    enqueueFiles,
    setAttachments,
  });

  const {
    handleSlashPick,
    handleSlashSkills,
    handleKeyDown,
    handlePaste,
    dragActive,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    canAttach,
    videoPreviews,
  } = useComposerInteraction({
    composerRef,
    textareaRef,
    setText,
    setSlashArmed,
    setSlashIndex,
    slashSkillsRef,
    slashMenuOpen,
    slashIndex,
    canSend,
    handleSend,
    disabled,
    enqueueFiles,
    attachments,
  });

  return (
    <div
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(event) => {
        // 点外壳/工具行空白处也聚焦输入：整块都是输入框，不是只有文字那一条。
        if (event.target === event.currentTarget) textareaRef.current?.focus();
      }}
      className={cn(
        // 2026-10-01 改版：上下两层（上＝通栏文字区，下＝工具行 上传｜发送）。
        // 旧版三者同排 items-end：多行时附件钮孤零零坠在左下、左侧空出一整列、文字区被挤窄。
        // 外框＝agent-composer-shell（agent-chat.css）：1px 淡虹彩描边（玻璃 E 取色）＋淡紫柔影，
        // 聚焦描边加深、投影加深，不再外套 ring（与描边叠成双框）。
        "agent-composer agent-composer-shell lg-float relative flex cursor-text flex-col rounded-[24px] px-2 pb-1.5 pt-2 touch-manipulation [-webkit-tap-highlight-color:transparent] outline-none",
        dragActive && "!ring-2 !ring-ios-blue/45 !bg-ios-blue/[0.04]",
      )}
    >
      {/* 顶缘 specular 亮线（MASTER.md §5 / DESIGN.md §5 权威配方，2026-09-20
          预览验收语汇）：lg-float 玻璃材质要有「上缘受光」的质感；纯装饰，
          不吃鼠标事件。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80"
      />
      {/* 拖拽悬停提示：只是视觉反馈，不吃鼠标事件（pointer-events-none）。 */}
      {dragActive && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-2 inset-y-1 flex items-center justify-center rounded-[16px] bg-ios-blue/[0.08] text-sm font-medium text-ios-blue"
        >
          松开以添加素材
        </div>
      )}
      {/* 隐式文件选择：附件钮在底部工具行左端，这里只留 input 本体。 */}
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

      <div className="flex min-w-0 flex-col px-1">
        {/* 待发送附件 chip 行：成功 / 上传中 / 错误 三种状态都带移除按钮。 */}
        {attachments.length > 0 && (
          <div className="mb-1 flex flex-wrap gap-1.5">
            {attachments.map((att) => {
              const inFlight = att.status === "uploading" || att.status === "extracting";
              const pct =
                att.status === "uploading" && att.progress !== undefined
                  ? Math.round(att.progress * 100)
                  : null;
              return (
                <span
                  key={att.id}
                  className={cn(
                    "inline-flex max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-ios-caption1",
                    att.status === "error" && "bg-destructive/10 text-destructive",
                    att.status === "ready" &&
                      "bg-ios-blue/10 text-muted-foreground",
                    inFlight && "bg-black/5 text-foreground/45",
                  )}
                >
                  {inFlight && (
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                  )}
                  <span className="truncate" title={att.errorMessage ?? att.fileName}>
                    {att.status === "error" && att.errorMessage
                      ? `${att.fileName}：${att.errorMessage}`
                      : att.fileName}
                  </span>
                  {/* 上传真实进度（XHR upload.onprogress 位元组真值）：拿不到真值就不编数字。 */}
                  {pct !== null && (
                    <span className="shrink-0 tabular-nums" aria-live="polite">
                      {pct}%
                    </span>
                  )}
                  {/* 抽帧进度用文字给：一行 chip 装不下也没必要另起进度条。 */}
                  {att.status === "extracting" && (
                    <span className="shrink-0 tabular-nums" aria-live="polite">
                      抽帧 {att.framesDone ?? 0}/{FRAME_COUNT}
                    </span>
                  )}
                  {/* 失败／取消且有原档 → 重试入口（重走同一条上传管道）。 */}
                  {att.status === "error" && att.file && (
                    <button
                      type="button"
                      onClick={() => retryAttachment(att.id)}
                      className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-ios-blue transition-colors hover:bg-ios-blue/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation [-webkit-tap-highlight-color:transparent]"
                    >
                      重试
                    </button>
                  )}
                  {/* 在途 → 取消钮：中止请求，chip 回可重送态、送出键恢复。 */}
                  {inFlight && (
                    <button
                      type="button"
                      onClick={() => cancelAttachment(att.id)}
                      aria-label={`取消上传 ${att.fileName}`}
                      className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-foreground/60 transition-colors hover:bg-black/[0.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30 touch-manipulation [-webkit-tap-highlight-color:transparent]"
                    >
                      取消
                    </button>
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
              );
            })}
          </div>
        )}

        {/*
          真实上传进度条（缺陷 A）：细 3px 灰轨 + 蓝填充，宽度＝XHR 真实位元组比例
          （绝不用假动画时间条）。只对拿得到真值的 uploading 项渲染；role=progressbar
          带真实 valuenow/valuemax，不虚报。
        */}
        {attachments.some((att) => att.status === "uploading" && att.progress !== undefined) && (
          <div className="mb-1.5 flex flex-col gap-1">
            {attachments
              .filter((att) => att.status === "uploading" && att.progress !== undefined)
              .map((att) => {
                const pct = Math.round((att.progress ?? 0) * 100);
                return (
                  <div key={`progress-${att.id}`} className="flex min-w-0 flex-col gap-0.5">
                    <div
                      className="h-[3px] w-full overflow-hidden rounded-full bg-black/[0.06]"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={pct}
                      aria-label={`${att.fileName} 上传进度`}
                    >
                      <div className="lg-transition h-full rounded-full bg-ios-blue" style={{ width: pct + "%" }} />
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/*
          影片预览（D-16）：原片可播（本机 ingest 成功时也只在本机播、不上行）；
          关键帧缩图列在本机 ingest 成功或降级抽帧态出现（原片直传态无 frames）。
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
                {att.frames && att.frames.length > 0 && (
                  <div className="flex min-w-0 gap-1.5 overflow-x-auto">
                    {att.frames.map((frame, i) => (
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
                )}
              </div>
            ))}
          </div>
        )}

        <label htmlFor="agent-composer-input" className="sr-only">
          输入消息
        </label>
        {/* 移动端虚拟键盘把回车键显示成「发送」，回车即送出（Shift+Enter 换行不变）。
            2026-09-20 轻量化定案（两版试错后）：钮回文字两侧（items-end 底对齐，
            长文时钮贴右下＝ChatGPT 同款），36px 小钮＋附件钮浅灰幽灵＝轻；
            max-h 124→240px（≈10 行才滚，不再三行出滚动条＝上一版「长文差」真凶之一）。 */}
        <textarea
          id="agent-composer-input"
          ref={textareaRef}
          value={text}
          onChange={(event) => {
            const next = event.target.value;
            // 斜线直呼：只在「打进那一颗 /」的当下开菜单（text 还是编辑前的值，
            // 量的是这一击的变化）；选完技能接著打需求不再弹。
            setSlashArmed(next.startsWith("/") && !text.startsWith("/"));
            if (next.startsWith("/")) setSlashIndex(0);
            setText(next);
            autoGrow(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          enterKeyHint="send"
          disabled={disabled}
          placeholder={compactPlaceholder && placeholder === DEFAULT_PLACEHOLDER ? COMPACT_PLACEHOLDER : basePlaceholder}
          rows={1}
          className={cn(
            "block min-h-[1.875rem] max-h-[15rem] w-full resize-none bg-transparent px-1.5 pb-1 pt-1 text-[0.9375rem] leading-[1.375rem] text-foreground",
            // 空框只有一行高：placeholder 一律不折行（折了第二行必被裁半截），极窄时宁可截尾。
            "placeholder:text-foreground/35 placeholder:whitespace-nowrap focus:outline-none",
            "touch-manipulation [-webkit-tap-highlight-color:transparent]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      {/*
        打「/」直呼 Skill 的浮层：贴在输入框正上方（元件自己 absolute bottom-full，
        零 layout shift）。只有两层闸门都真时才渲染——空框不主动弹一层盖住欢迎态。
      */}
      {slashMenuOpen ? (
        <SkillSlashMenu
          query={slashQuery}
          activeIndex={slashIndex}
          onActiveIndexChange={setSlashIndex}
          onPick={handleSlashPick}
          onClose={() => setSlashArmed(false)}
          onSkillsChange={handleSlashSkills}
        />
      ) : null}

      {/* 工具行：上传「+」（左）｜停止或发送「↑」（右），纯图标同一条基线，
          36px 隐形触控区不画底不画框。 */}
      <div
        onClick={(event) => {
          if (event.target === event.currentTarget) textareaRef.current?.focus();
        }}
        className="agent-composer-toolbar flex items-center justify-between"
      >
      {/*
        附件按钮：点击打开隐式文件选择，一次可选多个文件，选完即逐个上传。
        上传中的 chip 显示 spinner，失败显示错误态（可移除重传或删除）。
        2026-10-01：纯「+」（ImagePlus 的加号挂右上角，字形重心偏）；与发送箭头同基线。
      */}
      {/* 左上角：素材「+」＋工具行同排、「+」右边的思考级别菜单（暴君 2026-10-03
          三选一定案）。左组＝「+」容器＋chip，chip 是工具行流内的标准子项。 */}
      <div className="flex items-center">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={handlePick}
            disabled={!canAttach}
            aria-label="添加素材"
            title="添加素材（剧本 / 图片 / 影片 / 文档）"
            className={cn(
              // 2026-10-01 暴君：纯图标、不包圆形边——只有一个「+」。36px 是隐形触控区，不画底不画框。
              // 2026-10-03 手机端：窄屏（<640px）补 44px 触控区（max-sm:h-11 w-11），桌面维持 36px。
              // 走 JSX className 而非 agent-chat.css：该档的 44px 补丁选择器只打工具行直接子级，
              // 打不到包在 relative 容器里的这颗钮。工具行 items-center 已在，加高不跑置中。
              "flex h-9 w-9 max-sm:h-11 max-sm:w-11 shrink-0 items-center justify-center rounded-full text-foreground/50",
              "touch-manipulation [-webkit-tap-highlight-color:transparent]",
              "transition-colors hover:text-ios-purple active:scale-[0.92] focus:outline-none focus-visible:text-ios-purple",
              "disabled:cursor-not-allowed disabled:text-foreground/25",
            )}
          >
            <Plus className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {/* 思考级别菜单：工具行流内、「+」右边（暴君 2026-10-03 三选一定案）。 */}
        <ThinkingLevelMenu disabled={!canAttach} />
        {/* 本机档案权限模式：同一工具行、同一无框语汇的第二颗控件（纯浏览器自隐）。 */}
        <LocalFileModeMenu />
      </div>

      {onStop && !canSend && !sending ? (
            /*
              D-26 补全：生成中且输入框为空 → 送出钮位置渲染停止钮。
              2026-09-20 视觉改版（预览验收语汇）：红底方块 → 幽灵红文字钮
              （text-ios-red + hover 淡红底），与送出钮同尺寸圆钮（h-9 w-9
              rounded-full，切换零跳动）；aria-label / title / 图标
              （Square + Loader2 stopPending spinner）原样保留。

              09-18：再补一个条件 !sending —— 本轮还没开始（含面板喂进来的在途，
              sending 已收敛成「内部或面板在途」）时不许被停止钮盖掉：那一段真空期
              使用者需要的是「正在送」的转圈钮，不是一颗按下去可能没东西可停的停止钮。
            */
            <button
              type="button"
              onClick={onStop}
              disabled={stopPending}
              aria-label="中止助理生成"
              title={stopPending ? "正在中止，请稍候…" : "立即中止当前这轮生成"}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ios-red transition-colors duration-150 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
                "hover:bg-ios-red/[0.07] active:bg-ios-red/[0.12] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-red/30",
                stopPending && "disabled:cursor-wait disabled:opacity-60",
              )}
            >
              {stopPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
              )}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={disabled || !canSend}
              aria-label="发送"
              title={steerActive ? "引导本轮：这条会插进当前回合，不打断它" : undefined}
              data-steer={steerActive ? "true" : undefined}
              aria-busy={sending}
              className={cn(
                // 2026-10-01 暴君：纯图标、不包圆形——只有一个上箭头。36px 是隐形触控区。
                // agent-send-btn（agent-chat.css）＝箭头染玻璃 E 的薰衣草蓝、描边加粗放大；
                // 可送＝实色，hover 微抬升。
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all duration-200",
                "touch-manipulation [-webkit-tap-highlight-color:transparent]",
                "agent-send-btn",
                "hover:-translate-y-[1px] active:scale-[0.92]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                // 在途期间不上 disabled 的褪色：在途是「正在送」不是「不可用」，
                // 转圈要用实色才看得见。
                // 非在途时 disabled＝同一个箭头褪色待命（会话关闭 / 输入框空）。
                !sending &&
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:saturate-[0.7] disabled:hover:translate-y-0",
                // 送出进行中：游标与缩放回馈都收掉，连点由 sendingRef 在逻辑层挡。
                sending && "cursor-wait active:scale-100",
              )}
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : steerActive ? (
                /* REQ-D2：回合中送出的不是「新消息」而是「引导」——方向标替掉 ↑，
                   与「停止」的红方块两不相犯。 */
                <Navigation className="h-4 w-4" aria-hidden="true" />
              ) : (
                <ArrowUp className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          )}
      </div>
    </div>
  );
}

export const AgentComposer = memo(AgentComposerComponent);
