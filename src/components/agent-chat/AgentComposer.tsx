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
import { ArrowUp, ImagePlus, Loader2, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  toAgentAttachmentRef,
  uploadAgentAttachments,
  type AgentAttachment,
} from "@/lib/agent-chat-client";
import { MAX_VIDEO_BYTES, uploadVideoDirect } from "@/lib/agent-uploads";
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
  /**
   * 送出回调。允许返回 promise：真正的投递（跨网关往返，空态还要先建号+铸票）
   * 耗时可见，composer 靠它把「已按下」的进行中态维持到投递落地，
   * 期间送出钮换 spinner 并用 ref 挡连点。返回 void 时按立即完成处理。
   */
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
  /** 上传附件所需的目标会话 id；空态未建号时由 onEnsureSession lazy 建号。 */
  sessionId?: string | null;
  /** 空态（无 sessionId）选档时的 lazy 建号入口；回传可用 sid 或 null。 */
  onEnsureSession?: () => Promise<string | null>;
  /**
   * D-24 无缝续写：把外面接进来的半句话填进输入框，光标落到末尾，不自动送出。
   * 直接送出会立刻触发扣费，与 D-5「花钱前必定交用户确认」冲突。
   *
   * 带 nonce：同一句话点第二次也要能重新填进来，靠内容比较会被去重。
   * 填完调用 onPrefillConsumed，让上游清掉信号，避免重渲染时反复覆盖用户新打的字。
   */
  prefill?: { text: string; nonce: number } | null;
  onPrefillConsumed?: () => void;
  /**
   * D-26「随时可停」补全：语义 = 现在这一轮正在生成，可停。
   * 存在且输入框为空时，送出钮位置渲染停止钮；用户一旦打字（canSend）
   * 立即回到送出钮——生成中按送出走既有 steer 路径（先 abort 再发），
   * 两条语义不打架。缺省 = 没有可停的回合，渲染完全不变。
   */
  onStop?: () => void;
  /**
   * 中止请求在飞（网络往返未回来的镜像）。为真时停止钮禁用 + 换 spinner，
   * 用户得到「按下了」的反馈且不能连按。缺省 false = 行为与不传时逐位元一致。
   */
  stopPending?: boolean;
  /**
   * 外部（面板）在途：这条送出还没落地，或本輪还没真正开始——空態首發要先建號
   * 鑄票，網關還要把 prompt 送進 opencode 才回 ack（实測 10–15s）。
   *
   * 为真时送出钮位置立刻进入在途态：转圈、不可再点，输入框空白时也一样是转圈
   * 送出钮（不是 disabled 灰钮），并且压过「输入框空 → 停止钮」那条替换语义。
   * 「本輪尚未开始」的单一真相源在 AgentChatPanel（它同时知道 turnActive 与
   * onSend 的 promise），这里只负责渲染，不自己猜。缺省 false = 行为与不传时
   * 逐位元一致。
   */
  externalSendPending?: boolean;
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

/**
 * 罪状 2b：上传 413 无声标红。单请求体上限 = Vercel 平台硬顶 4.5MB
 * （attachments 路由只是透传代理，代码层无法调高平台限制），留出 multipart
 * 边界等开销后按 4MB 预检。超限文件在上传前就地给出人话错误，不再等 413。
 * 影片豁免此闸：原片走网关直传（uploadVideoDirect，绕开 Vercel），
 * 上限改用网关的 100MB（MAX_VIDEO_BYTES）。
 */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** 字节数 → 展示 MB（一位小数，四舍五入）。 */
function formatMb(bytes: number): string {
  return (Math.round((bytes / (1024 * 1024)) * 10) / 10).toFixed(1);
}

/**
 * 送出锁的硬保险上限（20s）。relay 路径的 fetch 没有 timeout，请求卡死时
 * 不能把送出钮永久锁死——到点无条件解锁，宁可让用户重试也不做假死按钮。
 *
 * 2026-09-18 起面板层（AgentChatPanel 的「本輪還沒开始」在途态）沿用同一个值，
 * 两处寿命一致：这里锁的是输入区自己的投递，那边锁的是面板在等的本輪开始。
 */
export const SEND_HARD_TIMEOUT_MS = 20_000;

interface PendingAttachment {
  id: string;
  fileName: string;
  status: PendingAttachmentStatus;
  errorMessage?: string;
  /**
   * 上传成功后的 ref，送出时写进 [附件] 区块。
   * 直传成功：影片一条 chip 对应 1 个 video ref（原片）；
   * 降级抽帧：对应 4 个 ref（4 张抽出的帧）。所以这里是数组。
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
 * 输入框跟着内容长高，上限交给 CSS 的 max-h-[140px]（到顶后自己滚）。
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

/** 是否存在仍在 uploading/extracting 的附件——存在时禁止送出。纯函数，可直测。 */
export function hasPendingAttachments(attachments: Pick<PendingAttachment, "status">[]): boolean {
  return attachments.some((a) => a.status === "uploading" || a.status === "extracting");
}

/** 送出资格：有文字或有已就绪附件，且没有仍在途的附件。纯函数，可直测。 */
export function computeCanSend(
  trimmedText: string,
  readyRefCount: number,
  attachments: Pick<PendingAttachment, "status">[],
): boolean {
  return (Boolean(trimmedText) || readyRefCount > 0) && !hasPendingAttachments(attachments);
}

/**
 * 「在途」的下一个值（纯函数，可直测）。内部送出锁或面板餵進來的在途任一为真
 * 就是在途；两边都放下才真的放下（面板收了在途、但输入区自己的投递还在飞，
 * 仍然是在途）。回传 null ＝与当前值相同、不必动——render 期收敛靠这个 bail out，
 * 不然每次渲染都要多跑一轮。
 */
export function nextSendBusy(
  current: boolean,
  internalSendInFlight: boolean,
  externalSendPending: boolean,
): boolean | null {
  const next = internalSendInFlight || externalSendPending;
  return next === current ? null : next;
}

let attachmentSeq = 0;

function AgentComposerComponent({
  disabled,
  onSend,
  placeholder = "描述你想做的…",
  sessionId,
  onEnsureSession,
  prefill,
  onPrefillConsumed,
  onStop,
  stopPending = false,
  externalSendPending = false,
}: AgentComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
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
   * 影片（D-16 + 原片直传网关）：优先把原片直传网关（绕开 Vercel 4.5MB 体上限），
   * 成功后一条 chip 只有一个 video ref，聊天框渲染成一个可播影片气泡，agent 也能
   * 按 path 取回原片剪辑。直传失败（无票 / 401 / 413 / 415 / 网络）静默降级为
   * 旧抽帧路径：抽 4 张 JPEG 上传，行为与今天一致；原片 Object URL 留在本地供预览。
   * 超限（60 秒 / 100 MB）由 extractFramesFromFile 抛错，原因直接显示在 chip 上。
   */
  const uploadVideoFile = useCallback(
    async (session: string, id: string, file: File) => {
      const videoUrl = URL.createObjectURL(file);
      // 直传期间就是普通「上传中」态；「抽帧 x/4」只在降级态有意义。
      patchAttachment(id, { status: "uploading", videoUrl });
      try {
        const ref = await uploadVideoDirect(session, file);
        patchAttachment(id, { status: "ready", refs: [ref], videoUrl });
        return;
      } catch {
        // 直传失败：静默落抽帧降级路径，不把直传错误抛给用户。
      }

      let extracted: { files: File[]; timestamps: FrameTimestamp[] };
      try {
        patchAttachment(id, { status: "extracting", framesDone: 0 });
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
    async (files: File[]) => {
      if (disabled) return;
      if (files.length === 0) return;
      // 09-13 附件 lazy 建号：空态（还没发过消息）选档＝用户明确动作，与 send()
      // 同源走 ensureSession（复用 start() 串行化管线，不并发第二条 POST）。
      const session = sessionId ?? (await onEnsureSession?.());
      if (!session) {
        Array.from(files).forEach((file) => {
          setAttachments((prev) => [
            ...prev,
            {
              id: `att-${++attachmentSeq}`,
              fileName: file.name,
              status: "error",
              errorMessage: "未能建立會話，請先登入或稍後重試。",
            },
          ]);
        });
        return;
      }

      // 每个文件独立处理，各自的失败不拖累其他文件。
      Array.from(files).forEach((file) => {
        const id = `att-${++attachmentSeq}`;
        // 罪状 2b：超限文件不上传，直接落一颗带人话文案的错误 chip。
        // 影片豁免 4MB 站内代理闸（原片走网关直传），改用网关的 100MB 上限。
        const maxBytes = isVideoFile(file) ? MAX_VIDEO_BYTES : MAX_FILE_BYTES;
        if (file.size > maxBytes) {
          setAttachments((prev) => [
            ...prev,
            {
              id,
              fileName: file.name,
              status: "error",
              errorMessage: `文件 ${formatMb(file.size)} MB 超过上限 ${formatMb(maxBytes)} MB，请压缩或拆分后再上传`,
            },
          ]);
          return;
        }
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
    [disabled, sessionId, onEnsureSession, uploadPlainFile, uploadVideoFile, patchAttachment],
  );

  const handleFileInput = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      void enqueueFiles(Array.from(event.target.files ?? []));
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

  // 罪状 2a：只附文件不打字，发送链路也要通——有已传成功的附件即具备发送资格。
  const readyRefs = attachments
    .filter((a) => a.status === "ready")
    .flatMap((a) => a.refs ?? []);
  // 有附件仍在 uploading/extracting（未决出成功或失败）时禁止送出：
  // 这些文件还没到 ready，既进不了本次的附件区块，也不该被随后的清空动作
  // 连带清掉（否则它们上传中的 promise 落地时会打在已从 state 里消失的 id 上，
  // patchAttachment 静默 no-op，等同于用户数据丢失）。
  const canSend = computeCanSend(trimmed, readyRefs.length, attachments);

  /*
   * 09-18「在途」的单一收敛点：输入区自己的送出锁（sendingRef）与面板餵進來的
   * 在途（externalSendPending）合成同一个 sending——aria-busy={sending} 与
   * 「在途就转圈」这组既有契约（另一条测试线钉着字面）在面板在途期间也必须为真。
   *
   * 为什么是 render 期调整而不是 useEffect：effect 在静态渲染（SSR）里根本不跑，
   * 靠它会让「面板在途」的第一帧 aria-busy 缺位。这是 React 官方「prop 变了就
   * 把 state 收敛」的模式（render 期 setState 会被立刻合并进同一帧，不闪中间态）。
   */
  const nextBusy = nextSendBusy(sending, sendingRef.current, externalSendPending);
  if (nextBusy !== null) setSending(nextBusy);

  /**
   * 幂等解锁：ref 与 state 一起清，并清掉硬保险计时器。
   * 三条路径都会调它（promise 结算 / 硬保险到点 / onSend 同步 throw），
   * 所以必须能重复调用而不出错。
   */
  const unlockSend = useCallback(() => {
    if (sendUnlockTimerRef.current !== null) {
      clearTimeout(sendUnlockTimerRef.current);
      sendUnlockTimerRef.current = null;
    }
    sendingRef.current = false;
    setSending(false);
  }, []);

  // 组装最终文本：附加 [附件] 区块（只纳入已传成功的），然后交给 onSend。
  // 影片一条 chip 展开成 4 行（4 张帧各自一个 path），编号连续。
  // 纯附件发送（空文本）：只发附件区块，不带前导换行。
  const handleSend = useCallback(() => {
    // 同步连点守卫：同一帧内第二次点击时 sending 还是旧值，只有 ref 挡得住。
    if (sendingRef.current) return;
    // 09-18：面板餵進來的在途同样要挡——Enter 这条入口不吃 disabled 属性，
    // 空態併發 send 是已记录的竞态（两条消息、两次计费）。
    if (externalSendPending) return;
    if (!canSend) return;
    // 快照「本次实际发出去」的附件：canSend 已挡掉 uploading/extracting，
    // 正常情况下这就等于当前 attachments 全量；仍按 id 过滤只清掉这些，
    // 防御 state 更新与点击之间的竞态（React 批处理导致 attachments 快照
    // 与本次渲染看到的不完全一致时，不误清尚在途的项）。
    const sentAttachments = attachments.filter((a) => a.status === "ready");
    const finalText = trimmed
      ? readyRefs.length > 0
        ? `${trimmed}\n${buildAttachmentBlock(readyRefs)}`
        : trimmed
      : buildAttachmentBlock(readyRefs).replace(/^\n+/, "");
    // 通过资格检查后立刻上锁，不等 re-render。
    sendingRef.current = true;
    setSending(true);
    sendUnlockTimerRef.current = setTimeout(unlockSend, SEND_HARD_TIMEOUT_MS);
    try {
      // 统一成 promise：void 回调走 resolved 分支，finally 立刻解锁。
      // catch 吞掉错误——用户可见的错误提示由 hook 的 notice 负责，
      // 这里只负责别留 unhandled rejection，并把锁放掉。
      Promise.resolve(onSend(finalText))
        .catch(() => {})
        .finally(unlockSend);
    } catch {
      // onSend 同步 throw（不是返回 rejected promise）＝ 这条消息根本没送出去：
      // 解锁后直接返回，不清输入框、不释放附件——吃掉使用者的话且没人接手
      // 比留一个可重试的框更糟。
      unlockSend();
      return;
    }
    setText("");
    // 清空文字后高度要跟着收回来，否则空框还占着刚才那几行。
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    // 只释放并移除本次实际发出去的附件，不连带清掉仍在途的项。
    const sentIds = new Set(sentAttachments.map((a) => a.id));
    sentAttachments.forEach(releaseUrls);
    setAttachments((prev) => prev.filter((a) => !sentIds.has(a.id)));
  }, [canSend, trimmed, readyRefs, onSend, attachments, unlockSend, externalSendPending]);

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

  // 卸载时清掉硬保险计时器：面板关掉后不该还有 setTimeout 攥着 setState。
  useEffect(() => {
    return () => {
      if (sendUnlockTimerRef.current !== null) {
        clearTimeout(sendUnlockTimerRef.current);
        sendUnlockTimerRef.current = null;
      }
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
        // 输入法组字中的 Enter 属于输入法（确认候选词），不是送出指令。
        // 必须在 preventDefault 之前返回：对组字中的 Enter 调用 preventDefault
        // 会让部分浏览器吃不到候选词确认，变成「按了 Enter 字不见」。
        // keyCode 229 是旧式 IME 的残留判定（Android/部分输入法不补 isComposing）。
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (!canSend) return;
        handleSend();
      }
    },
    [canSend, handleSend],
  );

  /** Ctrl+V 粘贴：有文件时走附件管道，纯文本/HTML 放行。 */
  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const files = event.clipboardData?.files;
      if (!files || files.length === 0) return;
      event.preventDefault();
      void enqueueFiles(Array.from(files));
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
      void enqueueFiles(Array.from(files));
    },
    [disabled, enqueueFiles],
  );

  const canAttach = !disabled;
  // 有原片 Object URL 的影片就进预览区：直传成功（无 frames）与降级抽帧都适用。
  const videoPreviews = attachments.filter(
    (a): a is PendingAttachment & { videoUrl: string } => Boolean(a.videoUrl),
  );

  return (
    <div
      ref={composerRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        "agent-composer lg-float relative flex items-end gap-1 rounded-[22px] p-1.5 touch-manipulation [-webkit-tap-highlight-color:transparent] outline-none focus-within:ring-[1.5px] focus-within:ring-ring/60",
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
          // 2026-09-20 暴君裁定：与送出钮同尺寸同風格（44px 圓鈕、主色 #2d3142
          // 實底＋signature 陰影＋hover 微抬升），不再幽靈灰；disabled 同淺灰。
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#2d3142] text-white shadow-[0_8px_20px_rgba(45,49,66,0.22)]",
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
          "transition-all duration-200 hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-[0.94] focus:outline-none focus:ring-2 focus:ring-ring/40",
          "disabled:cursor-not-allowed disabled:bg-[#bcc2ca] disabled:text-white/80 disabled:shadow-none disabled:hover:translate-y-0",
        )}
      >
        <ImagePlus className="h-[18px] w-[18px]" aria-hidden="true" />
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
                  {att.status === "error" && att.errorMessage
                    ? `${att.fileName}：${att.errorMessage}`
                    : att.fileName}
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
          影片预览（D-16）：原片可播；4 张缩图列仅在降级抽帧态出现（直传态无 frames）。
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
          rows={1}
          className={cn(
            "min-h-[44px] max-h-[124px] w-full resize-none bg-transparent py-[10px] text-[15px] leading-[22px] text-foreground",
            "placeholder:text-foreground/35 focus:outline-none",
            "touch-manipulation [-webkit-tap-highlight-color:transparent]",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>

      {onStop && !canSend && !sending ? (
        /*
          D-26 补全：生成中且输入框为空 → 送出钮位置渲染停止钮。
          2026-09-20 视觉改版（预览验收语汇）：红底方块 → 幽灵红文字钮
          （text-ios-red + hover 淡红底），44px 触控区，与送出钮同尺寸圆钮
          （h-11 w-11 rounded-full，切换零跳动）；aria-label / title / 图标
          （Square + Loader2 stopPending spinner）原样保留。

          09-18：再补一个条件 !sending —— 本輪還沒开始（含面板餵進來的在途，
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
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ios-red transition-colors duration-150 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]",
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
          aria-busy={sending}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200",
            "touch-manipulation [-webkit-tap-highlight-color:transparent]",
            // 2026-09-20 视觉改版（预览验收语汇）：主色 #2d3142 + signature
            // 阴影 + hover 微抬升；disabled 换浅灰 #bcc2ca。
            "bg-[#2d3142] text-white shadow-[0_8px_20px_rgba(45,49,66,0.22)]",
            "hover:-translate-y-[1px] hover:bg-[#272b39] active:scale-[0.94]",
            "focus:outline-none focus:ring-2 focus:ring-ring/40",
            // 在途期间不上 disabled 的灰階：在途是「正在送」不是「不可用」，
            // 白转圈压在浅灰底上等于没有回馈（深底＋白转圈才看得见）。
            // 非在途时 disabled 样式逐位元照旧（会话关闭 / 输入框空）。
            !sending &&
              "disabled:cursor-not-allowed disabled:bg-[#bcc2ca] disabled:text-white/80 disabled:shadow-none",
            // 送出进行中：光标与缩放反馈都收掉，连点由 sendingRef 在逻辑层挡。
            sending && "cursor-wait active:scale-100",
          )}
        >
          {sending ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          ) : (
            <ArrowUp className="h-[18px] w-[18px]" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

export const AgentComposer = memo(AgentComposerComponent);
