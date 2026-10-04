"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  FolderCheck,
  Globe,
  HardDrive,
  Loader2,
  MessageCircleQuestion,
  Navigation,
  Plus,
  Power,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AGENT_THINKING_LEVEL_HINTS,
  AGENT_THINKING_LEVEL_LABELS,
  AGENT_THINKING_LEVELS,
  agentThinkingLevelPatch,
  readCachedAgentSettings,
  resolveAgentThinkingLevel,
  saveAgentSettings,
  writeCachedAgentThinkingLevel,
  toAgentAttachmentRef,
  uploadAgentAttachments,
  type AgentAttachment,
  type AgentThinkingLevel,
} from "@/lib/agent-chat-client";
import { MAX_VIDEO_BYTES, uploadVideoDirect } from "@/lib/agent-uploads";
import type { AgentAttachmentRef } from "@/lib/agent-chat-types";
import {
  LOCAL_FILE_MODES,
  createDeviceBridgeController,
  describeLocalFileMode,
  getDeviceBridgeApi,
  modeFromStatus,
  supportsSetMode,
  type DeviceBridgeController,
  type LocalFileMode,
  type LocalFileModeIcon,
} from "@/lib/device-bridge-display";
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
  applySkillPick,
  moveActiveIndex,
  shouldOpenSlashMenu,
  slashQueryOf,
  type SlashMenuSkill,
} from "./SkillSlashMenu";

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
   * REQ-D2（2026-09-22）：回合进行中＝可引导（steer）。
   *
   * 为真且输入框有字时，送出钮换成「引导」语义：图标由 ↑ 换成方向标、
   * title 说明这条会作为指引插进当前回合、不打断它——与同一位置的停止钮
   * （空输入框时的红方块）语义彻底分开：**空框＝停止，有字＝引导**。
   *
   * 状态真相不在这里：这条指引到底「已注入本回合」还是「排队中·本回合结束后
   * 生效」，由网關 steer.status 帧决定，落在用户气泡的徽章上。这里只负责让
   * 按钮不冒充停止。缺省 false = 渲染与不传时逐位元一致。
   */
  steerActive?: boolean;
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
  /**
   * 可選介面（2026-10-03）：把「把檔案加進附件列」的既有入口（enqueueFiles，
   * 拖拽／貼上／選檔三條入口共用的同一條管道）註冊給外部呼叫。只暴露、不改入隊
   * 邏輯（多檔逐個處理、lazy 建號、狀態機都在既有函式裡）。不傳＝行為逐位元不變。
   */
  attachFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
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

/**
 * 上传等待的硬上限（缺陷 A 修复）。底层 fetch（原片直传 agent-uploads、站内
 * 代理 agent-chat-client）都没有 timeout、也没有 signal：高负载下请求可以一直
 * 在途不结束，附件 chip 就永久停在 uploading（实测 38MB 影片直传 150s+ 不落地）。
 * 到点视为逾时，让 chip 落明确终态。
 *
 * 值：原片可能数十 MB，取 3 分钟——38MB 在 0.25MB/s（约 2Mbps）的悲观上行也只要
 * ~152s，正常上传不会被误杀；同时把病态「永不完成」的请求挡在 180s。衍生档／
 * 关键帧只有几 MB 且走站内代理，60s 已极宽裕。
 */
export const VIDEO_UPLOAD_TIMEOUT_MS = 180_000;
const DERIVED_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * 非影片附件（普通文件）的等待硬上限。这条路走站内代理 `uploadAgentAttachments`，
 * 没有直传/抽帧降级链，卡住就只能永久停在 uploading。文件经 4MB 站内上限闸
 * （MAX_FILE_BYTES，见 enqueueFiles），几 MB 的档在悲观上行也只需数十秒；60s
 * 与衍生档同档，足够正常上传又不让病态请求无限挂起。逾时落 UploadTimeoutError，
 * 由 enqueueFiles 的 job.catch 写成带人话的 error chip（不静默消失）。
 */
export const PLAIN_UPLOAD_TIMEOUT_MS = 60_000;

/** 逾时专用错误：调用端据此区分「网络失败（可静默降级）」与「逾时（必须给人话）」。 */
export class UploadTimeoutError extends Error {
  constructor() {
    super("上传超时，请重试。");
    this.name = "UploadTimeoutError";
  }
}

/**
 * 给没有 signal 的等待加 deadline：到点 reject(UploadTimeoutError)，晚到的结果被丢弃。
 * 与 SEND_HARD_TIMEOUT_MS 同一姿势——时到必解锁，宁可让用户重试也不做假死状态。
 */
export function withUploadDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new UploadTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  /** 影片专用：關鍵幀縮圖的 Object URL 與時間點文案（本機 ingest 或降級抽幀皆會填）。 */
  frames?: { url: string; label: string }[];
  /** 抽帧进度（0…FRAME_COUNT），仅 extracting 期间有意义。 */
  framesDone?: number;
}

/**
 * 输入框跟着内容长高，上限交给 CSS 的 max-h-[15rem]（=240px＠16px 根字級）（到顶后自己滚）。
 * rows=1 的固定高度下，续写一段长愿望只能看见最后一行，看不到自己写了什么。
 */
function autoGrow(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

/**
 * 窄框用的短 placeholder（2026-09-30 手機截圖實錘）：390px 手機上 textarea 只有
 * ~190px，長句折成兩行、第二行被一行高的空框裁掉一半（「／资产图拖进来」只剩上半截）。
 * 手機也拖不了檔，「拖进来」那半句對它本來就是廢話。
 */
const DEFAULT_PLACEHOLDER = "描述你想做的，或把剧本／资产图拖进来";
const COMPACT_PLACEHOLDER = "描述你想做的画面或影片";
/**
 * 觸控裝置（coarse pointer）用的長 placeholder（2026-10-03 手機端）：手機拖不了檔，
 * 「拖进来」對它是做不到的動作，換「传上来」。DEFAULT_PLACEHOLDER 原值不動
 * （桌面繼續用，且 agent-chat-ui.test.ts 源碼釘死了它）。
 */
const TOUCH_PLACEHOLDER = "描述你想做的，或把剧本／资产图传上来";

/**
 * 基礎 placeholder 決策（純函數，可直測）：內建長句＋觸控裝置 → 「传上来」版；
 * 其餘（桌面、呼叫端自訂 placeholder）原樣通過。後續 placeholderFits 量字與
 * COMPACT fallback 都對這份被選中的基礎句做，邏輯不變。
 */
export function resolveBasePlaceholder(placeholder: string, coarsePointer: boolean): string {
  return coarsePointer && placeholder === DEFAULT_PLACEHOLDER ? TOUCH_PLACEHOLDER : placeholder;
}

/**
 * placeholder 量測的臨界安全邊際（px）。canvas 量字與實際排版間會有一兩 px 的
 * 舍入差，量到「剛好等於框寬」時瀏覽器仍會把 nowrap 的尾巴裁掉（2026-10-03
 * 390px 實錘：長句量到 288px、clientWidth 284px）。留 8px 讓臨界值一律回落
 * COMPACT_PLACEHOLDER，不再賭 0px 邊界。
 */
export const PLACEHOLDER_SAFETY_PX = 8;

/**
 * 純函數決策（可直測，無須 DOM）：量得的字寬加安全邊際後是否放得進 clientWidth。
 * clientWidth ≤ 0 時無從判量，回 true（沿用原行為：量不到就不誤切短句）。
 */
export function placeholderFitsWidth(measured: number, clientWidth: number): boolean {
  return clientWidth <= 0 || measured + PLACEHOLDER_SAFETY_PX <= clientWidth;
}

/**
 * canvas 量字用的字串。getComputedStyle(el).font 在部分瀏覽器對 textarea 會回
 * 空字串（2026-10-03 Chromium 手機實錘：回 ""），此時 ctx.font 落回預設 10px，
 * 量到 180px → 永遠「放得下」→ 長 placeholder 被 nowrap 裁尾（真凶）。
 * shorthand 非空時沿用；空時用長度屬性拼出可靠字串（桌面寬框仍量得出長句、不切短）。
 */
function resolveMeasureFont(style: CSSStyleDeclaration): string {
  if (style.font) return style.font;
  const stylePart = style.fontStyle && style.fontStyle !== "normal" ? `${style.fontStyle} ` : "";
  const weightPart = style.fontWeight ? `${style.fontWeight} ` : "";
  const sizePart = style.fontSize || "16px";
  const family = style.fontFamily || "sans-serif";
  return `${stylePart}${weightPart}${sizePart} ${family}`;
}

/** placeholder 在這個框寬下放不放得下一行（canvas 量字，與框同字型）。 */
function placeholderFits(el: HTMLTextAreaElement, text: string): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return true;
  ctx.font = resolveMeasureFont(window.getComputedStyle(el));
  return placeholderFitsWidth(ctx.measureText(text).width, el.clientWidth);
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

/**
 * 思考级别菜单（2026-10-03）：工具行同排、「+」右边的极简控件（暴君 2026-10-03
 * 三次退回悬浮形态后三选一定案，2026-10-03 二次定案改为无框语汇）。收起态＝
 * lucide `Brain` 图标 + 级别字（低/中/高/极限）+ 小 chevron，零框零底零影，
 * 与同排「+」「↑」同一套无框语言；展开态＝极简四列（级别名 + 当前档右端勾，
 * 说明文字挂每列 title），不再有长说明行。
 *
 * 状态归属：沿用设定既有的 localStorage 缓存 + 网关持久化链路——
 *   · 读：显式级別记录（agent-thinking-level-v1）优先，无记录由 settings 反推（resolve）。
 *   · 写：writeCachedAgentThinkingLevel（跨重载保留）+ saveAgentSettings(三栏 patch)
 *     （既有唯一写入者；interrupt_mode 由合并语义原样保留）。不另开 store。
 *
 * 交互：真 button 元素（Tab 可达 / Enter / Space 可開），Esc 關，焦點環走 --ring 主題，
 * 點擊外部收起（與历史 dropdown / 设定弹层同一條 outside-click 規矩）。
 */
function ThinkingLevelMenu({ disabled }: { disabled: boolean }) {
  // SSR 與首帧一律「中」：localStorage 只在挂载后读，避免 hydration 不一致。
  const [level, setLevel] = useState<AgentThinkingLevel>("medium");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // 展開面板搬到 createPortal(document.body)：另持一個 ref 供 outside-click 與定位量測。
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 面板 fixed 座標（相對視窗）。null ＝尚未量到，首frame 以 visibility:hidden 佔位量尺寸。
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    // 挂载后解析：显式记录优先，否则由缓存 settings 反推，反推不到顯示「中」。
    setLevel(resolveAgentThinkingLevel(readCachedAgentSettings()));
  }, []);

  // 开着时点外面就收——与历史 dropdown / 设定弹层同一条规矩（pointerdown + contains）。
  // 面板在 portal（document.body）内、不在 rootRef 子樹，所以兩棵樹都要算「裡面」。
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      const target = ev.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  /*
   * 面板定位（2026-10-04 改版）：以觸發鈕 rect 為錨，fixed 開在按鈕**正下方**、左緣對齊。
   *
   * 為什麼是 portal + fixed，而不是晶片容器內 absolute top-full（原定寫法）：
   * 助理頁＝PromptInput 卡片內的 AgentChatSurface，其 inline 態根節點帶
   * `overflow-hidden`，而 composer 根帶 `backdrop-filter`（lg-float）＝fixed 子元素的
   * containing block。absolute／fixed 留在樹內都會被祖先裁掉——本機 Playwright 實測
   * （1280×900，composer 貼 surface 底緣）：面板只從 surface 底部露出約 8px，其餘全被
   * overflow-hidden 切掉、點不到。搬到 document.body 的 portal 才不受該裁切，
   * 也才能保證面板四邊都在視窗內。
   *
   * 定位規則：預設在鈕下方（top = 鈕底 + 8px）；下方裝不下（面板高＋邊距超過視窗）才
   * 翻到鈕上方——「必要的翻轉」，不是預設。左右以鈕左緣對齊，靠到右邊界時往內收。
   */
  const place = useCallback((): void => {
    const trigger = rootRef.current;
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const panel = panelRef.current;
    const pw = panel ? panel.offsetWidth : 0;
    const ph = panel ? panel.offsetHeight : 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const GAP = 8;
    const MARGIN = 8;
    let top = r.bottom + GAP; // 預設：按鈕正下方
    if (ph > 0 && top + ph > vh - MARGIN && r.top - GAP - ph >= MARGIN) {
      top = r.top - GAP - ph; // 下方不足才翻到上方
    }
    if (ph > 0) top = Math.min(top, Math.max(MARGIN, vh - MARGIN - ph));
    let left = r.left; // 左緣與按鈕左緣對齊
    if (pw > 0) left = Math.min(left, Math.max(MARGIN, vw - MARGIN - pw));
    setCoords({ top, left });
  }, []);

  // 開面板：先量尺寸再入座（useLayoutEffect 在 paint 前跑，不會閃）。
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
  }, [open, place]);

  // 開著時視窗尺寸／任何祖先捲動（capture）都重新貼合錨點，面板不飄走。
  useEffect(() => {
    if (!open) return;
    const onMove = (): void => place();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    const vv = window.visualViewport;
    vv?.addEventListener("resize", onMove);
    vv?.addEventListener("scroll", onMove);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
      vv?.removeEventListener("resize", onMove);
      vv?.removeEventListener("scroll", onMove);
    };
  }, [open, place]);

  // Esc 收起（語義與舊版一致：只收起，不選、不清輸入框）。焦點在按鈕（rootRef 內）時
  // 走 root 的 onKeyDown；焦點若落進 portal 的選項，root 收不到，故另掛一支 window keydown。
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = useCallback((next: AgentThinkingLevel): void => {
    setLevel(next);
    writeCachedAgentThinkingLevel(next);
    // 既有唯一写入者：saveAgentSettings 合并当前缓存 + 三栏 patch（interrupt_mode 不动）。
    void saveAgentSettings(agentThinkingLevelPatch(next));
    setOpen(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "Escape" && open) {
        event.stopPropagation();
        setOpen(false);
      }
    },
    [open],
  );

  const label = AGENT_THINKING_LEVEL_LABELS[level];

  return (
    // 工具行同排、「+」右邊（暴君 2026-10-03 三選一定案）：控件進工具行流內，
    // 右邊緊跟「+」，與「+」和「↑」同一條基線。
    // 面板錨定改版（2026-10-04）：展開面板已搬到 createPortal(document.body) + fixed，
    // 以本容器的 getBoundingClientRect() 定位（rootRef 只當錨點量測與 outside-click 判定）。
    // 舊禁令「面板 absolute bottom-full 貼 composer 根、此容器不得 relative」整條作廢——
    // 它只服務 upward 開法；現在面板在按鈕下方、且必須離開被 overflow-hidden 裁切的樹。
    <div ref={rootRef} onKeyDown={onKeyDown} className="shrink-0 ml-0.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`思考级别：${label}（低/中/高/极限）`}
        title={`思考级别：${label}（低/中/高/极限）`}
        className={cn(
          // 2026-10-03 暴君定案：收起態＝腦圖標＋級別字＋小 chevron，零框零底零影零膠囊，
          // 與同排「+」「↑」同一套無框語彙（舊的白底細邊玻璃膠囊已刪）。
          // 只換顏色/透明度，無尺寸或位移變化——hover 零 layout shift。
          // 2026-10-03 手機端：窄屏補 44px 觸控高度（max-sm:min-h-11），桌面維持原行高。
          // 只加最小高度、不改寬/字級/位移——hover 與展開零 layout shift，items-center 保垂直置中。
          "flex w-max max-sm:min-h-11 shrink-0 items-center gap-1 whitespace-nowrap leading-none text-foreground/60",
          "transition-colors hover:text-[#7d6ee0] active:opacity-70",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          // 絕對定位盒走 shrink-to-fit；含塊是工具行 flex。w-max＋nowrap 鎖死單行不斷行。
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
        )}
      >
        {/* lucide Brain（与同排 Plus / ArrowUp 同一套家族图标，风格统一）。装饰用，对辅助技术隐藏。 */}
        <Brain className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="whitespace-nowrap text-ios-footnote font-medium">{label}</span>
        {/* 尾端小 chevron：展開時 rotate-180（純 transform，零 layout shift）。 */}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 opacity-60 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {/*
        展開面板：createPortal 到 document.body + fixed 定位（座標由 place() 以按鈕 rect
        算出，預設在按鈕**正下方**、左緣與按鈕左緣對齊）。搬出樹才不被助理頁
        .agent-chat-surface（inline 態帶 overflow-hidden）裁掉；不進流＝零 layout shift。
        **不得**用 agent-pop-in：它的 keyframes 帶 translateX(-50%)（給「left-1/2 置中彈層」
        用的），配 left 會把整個面板左移半個寬度、內容滑出面板外——那正是生產上「級別名跑到
        面板左緣之外、四列只剩說明行」的根因。
        樣式逐字複用助理頁既有浮層語彙：agent-pop 彈層材質 + rounded-[18px] + p-1 + 頂緣
        specular 高光線（來源＝歷史下拉 AgentChatSurface.tsx:1129、設定彈層
        AgentSettingsPopover.tsx:102）。選 agent-pop 而非 lg-float 的理由：①本面板已 portal
        到 body，agent-chat.css 的 ≤639.98px 手機字級階梯正是以 `.agent-pop`（「DOM 已搬離
        根容器」的彈層）為錨點，選它手機字才抬到 15px 地板；②面板浮在輸入框之外的頁面內容
        上，0.96 白比 lg-float 的 0.56 白好讀。
        寬度＝內容自適應（w-max）：四列只有級別名＋勾，不寫死 w-52 造成空曠或裁切。
        底緣保護：max-h + 內部可滾（overscroll-contain），空間不足時面板自己滾，底部不被裁掉。
        首frame coords 未量到＝visibility:hidden 佔位量尺寸，paint 前 place() 定位，不閃。
      */}
      {open && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              role="listbox"
              aria-label="思考级别"
              style={{
                top: coords?.top ?? 0,
                left: coords?.left ?? 0,
                visibility: coords ? "visible" : "hidden",
              }}
              className="agent-pop fixed z-50 w-max min-w-0 max-h-[min(60dvh,18rem)] overflow-y-auto overscroll-contain rounded-[18px] p-1"
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
              {AGENT_THINKING_LEVELS.map((lv) => (
                <button
                  key={lv}
                  type="button"
                  role="option"
                  aria-selected={lv === level}
                  onClick={() => pick(lv)}
                  /* 极简：说明行删掉，说明字串改挂 title（真源仍是 AGENT_THINKING_LEVEL_HINTS）。 */
                  title={AGENT_THINKING_LEVEL_HINTS[lv]}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[12px] px-2.5 py-2 text-left transition-colors",
                    "hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    lv === level && "bg-ios-blue/[0.10]",
                  )}
                >
                  <span className="whitespace-nowrap text-ios-footnote font-medium text-foreground">
                    {AGENT_THINKING_LEVEL_LABELS[lv]}
                  </span>
                  {lv === level && (
                    <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-ios-blue" aria-hidden="true" />
                  )}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * 本機檔案權限模式菜單（2026-10-04）：與相鄰的 ThinkingLevelMenu 同一套無框語彙，
 * 工具行流內、「+」右邊緊跟思考級別（同一顆工具列的兩顆同族控件）。
 *
 * 收起態＝模式圖示＋模式名＋小 chevron，零框零底零影；展開態＝四檔清單
 * （圖示＋標題＋副標＋右端勾），底下補一行「已授權 N 個資料夾」。
 *
 * 模式文案的唯一真源是 `@/lib/device-bridge-display` 的 LOCAL_FILE_MODES；
 * 本檔不得另寫一份字串。
 *
 * 漸進增強（比照 local-media-worker / device-bridge-display 的既有慣例）：
 *   · 無 window.eimuLocal（純瀏覽器）⇒ 整顆控件回 null，不渲染（不是報錯）。
 *   · 舊桌面產物（bridge.setMode 不存在）⇒ 可見但 disabled，副標提示「需更新桌面版」。
 *   · 舊 status 沒有 mode 欄位 ⇒ 由 enabled/roots 推導（modeFromStatus），不假裝真值。
 *
 * 授權入口不在這裡：控件只負責切模式與顯示已授權數量；「授權哪些資料夾」在對話流程問。
 */
const LOCAL_FILE_MODE_ICONS: Record<LocalFileModeIcon, LucideIcon> = {
  power: Power,
  "message-circle-question": MessageCircleQuestion,
  "folder-check": FolderCheck,
  globe: Globe,
};

export interface LocalFileModeMenuViewProps {
  open: boolean;
  onToggleOpen: () => void;
  onPick: (mode: LocalFileMode) => void;
  /** 舊產物（bridge.setMode 不存在）＝false ⇒ disabled。 */
  supported: boolean;
  /** status 是否已讀到；false 時不把任何一檔畫成「已選中」。 */
  known: boolean;
  mode: LocalFileMode;
  rootsCount: number;
  busy: boolean;
}

/** 純展示層（受控）：文案／圖示由純函式與 LOCAL_FILE_MODES 算好，本層只畫。 */
export function LocalFileModeMenuView({
  open,
  onToggleOpen,
  onPick,
  supported,
  known,
  mode,
  rootsCount,
  busy,
}: LocalFileModeMenuViewProps) {
  const currentSpec = LOCAL_FILE_MODES.find((m) => m.id === mode) ?? LOCAL_FILE_MODES[0];
  const current = describeLocalFileMode(mode);
  const CurrentIcon = known ? LOCAL_FILE_MODE_ICONS[currentSpec.icon] : HardDrive;
  const label = known ? current.title : "本机文件";
  const disabled = !supported;

  return (
    // 定位鏈（本控件仍走舊寫法）：面板 absolute bottom-full，containing block ＝
    // composer 根（此 chip 容器不掛 relative）。相鄰 ThinkingLevelMenu 已改為容器
    // relative + top-full 開在按鈕下方，兩者定位語彙不同，勿再宣稱「相同」。
    <div
      className="shrink-0 ml-1"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          onToggleOpen();
        }
      }}
    >
      <button
        type="button"
        onClick={onToggleOpen}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`本机文件权限：${label}`}
        title={disabled ? "本机文件权限：需更新桌面版" : `本机文件权限：${label}`}
        className={cn(
          // 與同排「+」「↑」「思考級別」同一套無框語彙：只換顏色/透明度，零 layout shift。
          "flex w-max max-sm:min-h-11 shrink-0 items-center gap-1 whitespace-nowrap leading-none text-foreground/60",
          "transition-colors hover:text-[#7d6ee0] active:opacity-70",
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-40",
          "touch-manipulation [-webkit-tap-highlight-color:transparent]",
        )}
      >
        <CurrentIcon className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" />
        <span className="whitespace-nowrap text-ios-footnote font-medium">{label}</span>
        {disabled && <span className="whitespace-nowrap text-ios-caption2 text-foreground/40">需更新桌面版</span>}
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && !disabled && (
        <div
          role="listbox"
          aria-label="本机文件权限"
          // 定位語彙沿用舊寫法（與同檔 SkillSlashMenu 同款）：absolute bottom-full left-1.5 mb-2，
          // 貼控件正上方、不進流＝零 layout shift（ThinkingLevelMenu 已改開按鈕下方，勿再對齊它）。
          className="lg-float absolute bottom-full left-1.5 z-50 mb-2 w-max min-w-0 rounded-ios-xl p-1"
        >
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px rounded-t-[inherit] bg-gradient-to-r from-transparent via-white to-transparent opacity-80" />
          {LOCAL_FILE_MODES.map((spec) => {
            const Icon = LOCAL_FILE_MODE_ICONS[spec.icon];
            const selected = known && spec.id === mode;
            return (
              <button
                key={spec.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={busy}
                onClick={() => onPick(spec.id)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-[12px] px-2.5 py-2 text-left transition-colors",
                  "hover:bg-black/[0.05] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  selected && "bg-ios-blue/[0.10]",
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-foreground/50" aria-hidden="true" />
                <span className="flex min-w-0 flex-col">
                  <span className="whitespace-nowrap text-ios-footnote font-medium text-foreground">
                    {spec.title}
                  </span>
                  {/* 副標＝本檔第二真源；僅本控件顯示，逐字取 LOCAL_FILE_MODES。 */}
                  <span className="mt-0.5 max-w-[15rem] text-ios-caption2 leading-snug text-foreground/50">
                    {spec.subtitle}
                  </span>
                </span>
                {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-ios-blue" aria-hidden="true" />}
              </button>
            );
          })}
          {/* 已授權數量：只「檢視」；授權入口在對話裡（本控件不做選擇資料夾按鈕）。 */}
          <p className="mt-1 border-t border-black/[0.06] px-2.5 pb-1.5 pt-2 text-ios-caption2 text-foreground/45">
            {rootsCount > 0 ? `已授权 ${rootsCount} 个文件夹` : "尚未授权任何文件夹"}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 薄殼：建立 controller、訂閱它（useSyncExternalStore）、把純函式吐出的語義交給展示層。
 * 純瀏覽器（無 window.eimuLocal）時 controller 快照 available:false ⇒ 本層回 null（漸進增強）。
 */
function LocalFileModeMenu() {
  const controllerRef = useRef<DeviceBridgeController | null>(null);
  if (controllerRef.current === null) controllerRef.current = createDeviceBridgeController(getDeviceBridgeApi);
  const controller = controllerRef.current;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    controller.init();
    // 卸載時取消訂閱 onBridgeStatus（dispose 內含 unsubscribe）。
    return () => controller.dispose();
  }, [controller]);

  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);

  // 開著時點外面就收——與 ThinkingLevelMenu / 歷史 dropdown 同一條 pointerdown + contains 規矩。
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (ev: PointerEvent): void => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDocPointerDown);
    return () => document.removeEventListener("pointerdown", onDocPointerDown);
  }, [open]);

  // SSR／hydration 首畫格：getServerSnapshot 一律 available:false ⇒ 伺服器與首畫格都回 null。
  if (!snap.available) return null;

  const supported = supportsSetMode(getDeviceBridgeApi());
  const resolution = modeFromStatus(snap.status);
  const rootsCount = Array.isArray(snap.status?.roots) ? snap.status.roots.length : 0;

  return (
    <div ref={rootRef} className="contents">
      <LocalFileModeMenuView
        open={open}
        onToggleOpen={() => setOpen((v) => !v)}
        onPick={(mode) => {
          setOpen(false);
          void controller.setMode(mode);
        }}
        supported={supported}
        known={resolution.known}
        mode={resolution.mode}
        rootsCount={rootsCount}
        busy={snap.busy}
      />
    </div>
  );
}

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
   * ＝文字形态還是指令（空框或首字符「/」）。两层都真才显示。
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
  // 框寬放不下長 placeholder 時換短句；框寬變化（轉屏、面板拖寬）即重量。
  const [compactPlaceholder, setCompactPlaceholder] = useState(false);
  // 觸控裝置判定（2026-10-03）：SSR 與首幀一律 false（=桌面長句，避免 hydration
  // mismatch），掛載後用 matchMedia("(pointer: coarse)") 判定一次再切「传上来」版。
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

  /** 普通文件：原样上传。无降级链，逾时必须落明确错误终态给人话（不得永久 uploading）。 */
  const uploadPlainFile = useCallback(
    async (session: string, id: string, file: File) => {
      const uploaded: AgentAttachment[] = await withUploadDeadline(
        uploadAgentAttachments(session, [file]),
        PLAIN_UPLOAD_TIMEOUT_MS,
      );
      const first = uploaded[0];
      if (!first) throw new Error("上传结果为空。");
      patchAttachment(id, { status: "ready", refs: [toAgentAttachmentRef(first)] });
    },
    [patchAttachment],
  );

  /**
   * 影片（D-16 + 本機前處理 W1）：**先把原檔在本機抽出衍生檔**（關鍵幀 JPEG＋poster
   * ＋probe JSON），只把衍生檔送上行，原片留在本機當預覽——不再把原片傳上雲端讓 agent 看。
   *
   * 漸進增強（任何一步失敗都回到今天的行為，不得弄壞既有附件流程）：
   *   1. 本機 ingest 可用 → 只上行衍生檔（載入關鍵幀縮圖，聊天框渲染原檔可播 + 關鍵幀列）。
   *   2. ingest 降級／失敗，或衍生檔上傳失敗 → 原片直傳網關（uploadVideoDirect，繞開
   *      Vercel 4.5MB 體上限）。
   *   3. 直傳失敗（無票 / 401 / 413 / 415 / 網絡）→ 舊抽幀路徑：抽 4 張 JPEG 上傳。
   * 上限（**600 秒** / 100 MB，以 video-frames.MAX_VIDEO_DURATION_SECONDS 為準）由抽幀
   * 與 ingest 的計劃層把關，原因直接顯示在 chip 上。
   */
  const uploadVideoFile = useCallback(
    async (session: string, id: string, file: File) => {
      const videoUrl = URL.createObjectURL(file);
      // 任何路徑下原檔預覽都先可見；上傳中態與今天一致。
      patchAttachment(id, { status: "uploading", videoUrl });

      // 1) 本機前處理：契約上永不拋；這裡仍兜底成 null 走回退路徑。
      let ingested: LocalMediaIngest | null = null;
      try {
        ingested = await ingestMediaLocally(file);
      } catch {
        ingested = null;
      }

      if (isIngestUsable(ingested)) {
        const frameUrls = ingested.keyframes.map((frame) => URL.createObjectURL(frame.blob));
        try {
          const frames = ingested.keyframes.map((frame, i) => ({
            url: frameUrls[i],
            label: formatFrameTime(frame.tSec),
          }));
          patchAttachment(id, { status: "uploading", frames, framesDone: frames.length });
          const uploaded = await withUploadDeadline(
            uploadAgentAttachments(session, toDerivedFiles(ingested, file.name)),
            DERIVED_UPLOAD_TIMEOUT_MS,
          );
          if (uploaded.length === 0) throw new Error("衍生檔上傳結果為空。");
          patchAttachment(id, {
            status: "ready",
            refs: uploaded.map(toAgentAttachmentRef),
            videoUrl,
            frames,
          });
          return;
        } catch {
          // 衍生檔上行失敗：釋放本機縮圖並清掉 frames，落回原檔路徑（不顯示錯誤）。
          frameUrls.forEach((url) => URL.revokeObjectURL(url));
          patchAttachment(id, { frames: undefined });
        }
      }

      // 2) 回退：今天的第一條路——原片直傳網關。
      try {
        const ref = await withUploadDeadline(
          uploadVideoDirect(session, file),
          VIDEO_UPLOAD_TIMEOUT_MS,
        );
        patchAttachment(id, { status: "ready", refs: [ref], videoUrl });
        return;
      } catch (err) {
        // 逾時必須落明確終態並給人話（不得留在 uploading）；其他直傳失敗
        // （無票/401/413/415/網絡）照舊靜默落抽幀降級路徑，不把錯誤拋給用戶。
        if (err instanceof UploadTimeoutError) throw err;
      }

      // 3) 直傳也失敗：既有抽幀降級路徑（行為與今天逐位一致）。
      let extracted: { files: File[]; timestamps: FrameTimestamp[] };
      try {
        patchAttachment(id, { status: "extracting", framesDone: 0 });
        extracted = await extractFramesFromFile(file, videoUrl, (done) =>
          patchAttachment(id, { framesDone: done }),
        );
      } catch (err) {
        // 抽幀失敗／超限：原片 URL 立刻釋放，別把 100 MB 掛在記憶體裡等用戶刪 chip。
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
        uploadAgentAttachments(session, extracted.files),
        DERIVED_UPLOAD_TIMEOUT_MS,
      );
      if (uploaded.length === 0) throw new Error("抽幀上傳結果為空。");
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
              errorMessage: "未能建立会话，请先登录或稍后重试。",
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

  /**
   * 选中一条技能（点行，或菜单开着时的 Enter/Tab）：
   * **只把「/技能名 」写回输入框**——不自动送出（送出=立刻扣费，与 D-5 花钱前必
   * 交用户确认冲突）、不动附件、不改送出逻辑。焦点与高度回收照打字路径走，
   * 光标落到末尾＝使用者下一个动作就是接着打需求。
   */
  const handleSlashPick = useCallback((skill: SlashMenuSkill) => {
    setText((current) => applySkillPick(current, skill));
    setSlashArmed(false);
    setSlashIndex(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el);
    });
  }, []);

  /** 菜单上报可见列表（进 ref，不触渲染）。 */
  const handleSlashSkills = useCallback((skills: SlashMenuSkill[]) => {
    slashSkillsRef.current = skills;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      /*
        打「/」直呼 Skill：菜单开着时上下键移动、Enter/Tab 选中、Esc 收起。
        只有菜单开着才走这一段；关着时下面每一行逐字不变（送出/换行/IME 契约不动）。
        IME 组字中的按键先让开：候选词要用上下键翻页、Enter 确认，不能被菜单吃掉。
      */
      if (slashMenuOpen) {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const delta = event.key === "ArrowDown" ? 1 : -1;
          setSlashIndex((index) => moveActiveIndex(index, delta, slashSkillsRef.current.length));
          return;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          // 选中 ≠ 送出：把技能名写回输入框就停手。没有可选项时也吞掉这次 Enter
          // （框里正打着一个指令，送出半截「/关键词」不是使用者要的）。
          event.preventDefault();
          const picked = slashSkillsRef.current[slashIndex];
          if (picked) handleSlashPick(picked);
          return;
        }
        if (event.key === "Escape") {
          // 收起菜单：不送出、不清输入框（清掉等于吃掉使用者打的指令）。
          event.preventDefault();
          setSlashArmed(false);
          return;
        }
      }
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
    [canSend, handleSend, handleSlashPick, slashIndex, slashMenuOpen],
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
      {/* 隐式文件选择：附件鈕在底部工具行左端，這裡只留 input 本體。 */}
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
          影片预览（D-16）：原片可播（本機 ingest 成功時也只在本機播、不上行）；
          關鍵幀縮圖列在本機 ingest 成功或降級抽幀態出現（原片直傳態無 frames）。
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
            // 斜线直呼：只在「打進那一顆 /」的當下開菜單（text 還是編輯前的值，
            // 量的是這一擊的變化）；選完技能接著打需求不再弹。
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
            // 空框只有一行高：placeholder 一律不折行（折了第二行必被裁半截），極窄時寧可截尾。
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
          三选一定案）。左組＝「+」容器＋chip，chip 是工具行流內的標準子項。 */}
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
              // 2026-10-03 手機端：窄屏（<640px）補 44px 觸控區（max-sm:h-11 w-11），桌面維持 36px。
              // 走 JSX className 而非 agent-chat.css：該檔的 44px 補丁選擇器只打工具行直接子級，
              // 打不到包在 relative 容器裡的這顆鈕。工具行 items-center 已在，加高不跑置中。
              "flex h-9 w-9 max-sm:h-11 max-sm:w-11 shrink-0 items-center justify-center rounded-full text-foreground/50",
              "touch-manipulation [-webkit-tap-highlight-color:transparent]",
              "transition-colors hover:text-[#7d6ee0] active:scale-[0.92] focus:outline-none focus-visible:text-[#7d6ee0]",
              "disabled:cursor-not-allowed disabled:text-foreground/25",
            )}
          >
            <Plus className="h-5 w-5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        {/* 思考级别菜单：工具行流內、「+」右邊（暴君 2026-10-03 三選一定案）。 */}
        <ThinkingLevelMenu disabled={!canAttach} />
        {/* 本機檔案權限模式：同一工具行、同一無框語彙的第二顆控件（純瀏覽器自隱）。 */}
        <LocalFileModeMenu />
      </div>

      {onStop && !canSend && !sending ? (
            /*
              D-26 补全：生成中且输入框为空 → 送出钮位置渲染停止钮。
              2026-09-20 视觉改版（预览验收语汇）：红底方块 → 幽灵红文字钮
              （text-ios-red + hover 淡红底），与送出钮同尺寸圆钮（h-9 w-9
              rounded-full，切换零跳动）；aria-label / title / 图标
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
                // 在途期間不上 disabled 的褪色：在途是「正在送」不是「不可用」，
                // 轉圈要用實色才看得見。
                // 非在途時 disabled＝同一個箭頭褪色待命（會話關閉 / 輸入框空）。
                !sending &&
                  "disabled:cursor-not-allowed disabled:opacity-40 disabled:saturate-[0.7] disabled:hover:translate-y-0",
                // 送出進行中：游標與縮放回饋都收掉，連點由 sendingRef 在邏輯層擋。
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
