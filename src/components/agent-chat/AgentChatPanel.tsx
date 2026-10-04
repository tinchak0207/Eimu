"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowDown, Loader2, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentAssistantTextItem, AgentChatState, AgentToolAuthScope } from "@/lib/agent-chat-types";
import type { BatchAnchor } from "@/lib/agent-batch-anchor";
import { describeGroup, groupPendingConfirms } from "@/lib/agent-confirm-groups";
import { AgentTranscript, type AgentTranscriptProps } from "./AgentTranscript";
import { AgentComposer, SEND_HARD_TIMEOUT_MS, type AgentComposerProps } from "./AgentComposer";
import { AgentConfirmCard } from "./AgentConfirmCard";
import { AgentQuestionCard } from "./AgentQuestionCard";
import { AgentBatchProgress } from "./AgentBatchProgress";
import { AgentSubagentBar } from "./AgentSubagentBar";
import { AgentAnchorCard } from "./AgentAnchorCard";
import { NEAR_BOTTOM_PX } from "./scroll-threshold";
import { AGENT_EXAMPLE_PROMPTS } from "@/lib/agent-example-prompts";
import "./agent-chat.css";

export interface AgentChatPanelProps {
  state: AgentChatState;
  connection: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  disabled?: boolean;
  /** 回传 promise，输入区才能等到「投递完成」再收在途态（09-18 跨线契约放宽）。 */
  onSend: (text: string) => void | Promise<void>;
  /**
   * 中止请求在飞（hook 的 aborting 镜像）。为真时「停下」钮变成「正在中止」态，
   * 避免连点双发；缺席（undefined）时行为与接线前逐位元一致。
   */
  stopPending?: boolean;
  /**
   * 空态 lazy 建号在飞（hook 的 startingSession）。为真时空态显式说「正在建立会话…」，
   * 推荐语不再渲染——不然用户以为没发出去而重复点（两条消息、两次计费）。
   */
  sessionStarting?: boolean;
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>;
  onAnswerQuestion: (requestId: string, answers: string[][]) => Promise<boolean | void>;
  onRetryConnection: () => void;
  /** 当前会话 id，传给输入区做附件上传；空态未建号时由 onEnsureSession lazy 建号。 */
  sessionId?: string | null;
  /** 空态选档时透传给输入区的 lazy 建号入口（附件＝用户明确动作）。 */
  onEnsureSession?: AgentComposerProps["onEnsureSession"];
  /** 出图卡动作回调：接线前省略，按钮保持 disabled。 */
  imageActions?: AgentTranscriptProps["imageActions"];
  /** 出片卡动作回调：接线前省略，按钮保持 disabled。 */
  videoActions?: AgentTranscriptProps["videoActions"];
  /** 出音频卡动作回调：接线前省略，按钮保持 disabled。 */
  audioActions?: AgentTranscriptProps["audioActions"];
  /** 批量生成的中止信号。存在时批量进度卡带上「停止」按钮。 */
  onStopGeneration?: () => void;
  /**
   * D-26 首张锚定。缺席（或推不出可复现参数）时不显示锚定卡——
   * 一颗按下去不保证同风格的「锚定」按钮比没有按钮更糟。
   */
  anchor?: BatchAnchor | null;
  onAnchor?: () => void;
  onReanchor?: () => void;
  onAnchorDismiss?: () => void;
  anchorBusy?: boolean;
  /** D-24 无缝续写：透传给输入区，把半句话填进框里而不是直接送出。 */
  prefill?: AgentComposerProps["prefill"];
  onPrefillConsumed?: () => void;
  /**
   * 2026-10-03：把输入区「附件入队」的既有入口（AgentComposer.enqueueFiles）透传出去。
   * 媒体卡「改图」把抓回的图组 File 经它加进附件列（不另造第二条上传管道）。
   */
  attachFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
  /**
   * D-17：外面正在问「继续上次还是开新的」，此时还没有会话。
   * 这不是连接故障，状态行要说在等你选，而不是亮一颗「未连接」的灯。
   */
  awaitingChoice?: boolean;
  /**
   * 2026-08-25 模板库：用户发出第一条消息时通知上层（收起右侧模板库）。
   * 只在从空对话发出时触发——后续消息不再打扰。
   */
  onFirstUserMessage?: () => void;
}

/**
 * 合并确认组的裁决聚合：逐个 id 平行送出，Promise.allSettled 收拢结果——
 * 任一子项 reject 或明确回 false 都算整组失败（回 false），让卡片解锁可
 * 整组重试；全部成功（fulfilled 且非 false）才回 true。抽成纯函数，
 * node --test 可直接灌 deferred promise 断言，不必模拟 DOM 点击。
 */
export async function resolveConfirmGroup(
  requestIds: string[],
  approved: boolean,
  onConfirm: (requestId: string, approved: boolean) => Promise<boolean | void>,
): Promise<boolean> {
  const results = await Promise.allSettled(requestIds.map((id) => onConfirm(id, approved)));
  return results.every((r) => r.status === "fulfilled" && r.value !== false);
}

/**
 * 空态模板 chip 的三态（纯函数，可直测）：
 * - "pending"：这一颗刚被按下、本轮还没开始 → 转圈（进行中态）；
 * - "disabled"：面板正在途，其余 chip 一律禁用（空态并发 send 是已记录的竞态，
 *   两条消息、两次计费）；
 * - "idle"：可以按。
 *
 * 被点的那一颗优先于「全部禁用」——否则使用者看不出自己按的是哪一颗。
 */
export function exampleChipState(
  example: string,
  pendingExample: string | null,
  sendPending: boolean,
): "pending" | "disabled" | "idle" {
  if (pendingExample === example) return "pending";
  return sendPending ? "disabled" : "idle";
}

/*
 * 2026-10-03 手机排版刀 3：「回到底部」浮动钮。
 * 判定与动作抽成纯函数，node --test 可直接灌数字断行为（jsdom 没有真滚动）。
 * 阈值复用 scroll-threshold.ts 的 NEAR_BOTTOM_PX（与自动贴底同一条线：
 * 离底超过它＝使用者已往上翻，才值得浮出这颗钮）。
 */

/** 使用者是否已往上翻离底部（距底 ≥ NEAR_BOTTOM_PX）。 */
export function isScrolledUp(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight >= NEAR_BOTTOM_PX;
}

/** 卷到底：预设 smooth；prefers-reduced-motion 时 instant（不强迫看位移动画）。 */
export function scrollTranscriptToBottom(
  el: { scrollHeight: number; scrollTo: (options: { top: number; behavior: ScrollBehavior }) => void },
  reduceMotion: boolean,
): void {
  el.scrollTo({ top: el.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
}

/**
 * 回到底部圆钮（仅窄屏渲染：sm:hidden，桌面 DOM 存在但不渲染＝像素零变化）。
 * 44×44 触控靶、lg-float 玻璃、active 压感；进出场 140ms 淡入淡出用
 * opacity 切换（absolute 定位不布局，开关零 layout shift）。
 */
export function AgentBackToBottomButton({
  scrolledUp,
  onClick,
}: {
  scrolledUp: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="回到底部"
      aria-hidden={scrolledUp ? undefined : true}
      tabIndex={scrolledUp ? 0 : -1}
      onClick={onClick}
      className={cn(
        "agent-back-to-bottom lg-float absolute bottom-3 right-4 z-20 flex h-11 w-11 items-center justify-center rounded-full text-foreground/60",
        "transition-opacity duration-150 hover:text-foreground active:scale-95",
        "touch-manipulation [-webkit-tap-highlight-color:transparent] sm:hidden",
        scrolledUp ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      <ArrowDown className="h-5 w-5" aria-hidden="true" />
    </button>
  );
}

const CONNECTION_META: Record<AgentChatPanelProps["connection"], { label: string; dotClass: string }> = {
  // 2026-09-20 色彩纪律（预览验收语汇）：灰阶 + ios-blue accent + 红仅错误。
  // 连接状态点全部收灰阶；「等你选择」用蓝（accent）。
  idle: { label: "未连接", dotClass: "bg-black/25" },
  connecting: { label: "连接中…", dotClass: "bg-foreground/35" },
  open: { label: "已连接", dotClass: "bg-foreground/35" },
  reconnecting: { label: "正在重新连接…", dotClass: "bg-foreground/35" },
  closed: { label: "会话已结束", dotClass: "bg-destructive" },
};

/**
 * 本机档案授权回传（缺陷 C）：把工具卡三选一翻成一句带 scope＋root 的授权指令，
 * 走既有 onSend 管道送进对话——授权本就发生在对话里（与网关冻结契约一致），
 * 因此不新增端点、不另造授权 API。纯函式，可直测文案。
 */
export function buildLocalFilesAuthorizationMessage(scope: AgentToolAuthScope, root?: string): string {
  const label =
    scope === "once" ? "允许一次" : scope === "session" ? "本会话允许此目录" : "永久允许（加入本机授权清单）";
  const rootPart = root ? `，root=${root}` : "";
  return `授权本机文件访问：scope=${scope}${rootPart}（我选择「${label}」）。请调用 local_files_authorize 记录该授权，然后继续读取。`;
}

function AgentChatPanelComponent({
  state,
  connection,
  disabled = false,
  onSend,
  stopPending = false,
  sessionStarting = false,
  onConfirm,
  onAnswerQuestion,
  onRetryConnection,
  sessionId,
  onEnsureSession,
  imageActions,
  videoActions,
  audioActions,
  onStopGeneration,
  anchor,
  onAnchor,
  onReanchor,
  onAnchorDismiss,
  anchorBusy = false,
  prefill,
  onPrefillConsumed,
  attachFilesRef,
  awaitingChoice = false,
  onFirstUserMessage,
}: AgentChatPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // 输入区锚点：虚拟键盘弹起后，拿它判断「输入区是不是被键盘盖住了」。
  const composerAnchorRef = useRef<HTMLDivElement>(null);

  // 本机文件授权（缺陷 C）：工具卡三选一点击 → 经既有 onSend 送授权指令进对话。
  const authorizeLocalFiles = useCallback(
    (scope: AgentToolAuthScope, root?: string) => onSend(buildLocalFilesAuthorizationMessage(scope, root)),
    [onSend],
  );

  /** 空态快捷示例：点一下就发送（ChatGPT 同款模式），当回合结束后输入区自动沉到底部。
   *  清单真源抽到 lib/agent-example-prompts.ts（新人礼弹窗要预填第一条，两处共引用一份）。 */
  const EXAMPLES = AGENT_EXAMPLE_PROMPTS;
  // 用户是否停在列表底部附近。串流/新条目只在「本来就在底部」时自动贴底，
  // 往上翻历史时不许把滚动条强拉回底部（「往上翻不强拉」）。
  const isNearBottomRef = useRef(true);
  // 刀 3：往上翻离底 ≥NEAR_BOTTOM_PX 才浮出「回到底部」钮（仅窄屏可见）。
  const [scrolledUp, setScrolledUp] = useState(false);

  // 推荐语连点保险：同一 frame 内两次点击时 re-render 还没到，靠 ref 同步上锁。
  // 不锁＝两条消息、两次计费（空态并发 send 是已记录的竞态）。
  const exampleSendRef = useRef(false);
  /** 被按下的那一颗模板 chip（进行中态）；sendPending 期间三颗一起禁用。 */
  const [pendingExample, setPendingExample] = useState<string | null>(null);
  /**
   * 09-18「送出在途」单一真相源（面板层）。
   *
   * 病灶：按下送出 / 模板 chip 到「本轮真的开始」之间有一段真空——空态首发要先
   * 建号铸票，网关还要把 prompt 送进 opencode 才回 ack（实测 10–15s）。这段
   * 时间里输入框已空、画面没有回馈，人会以为没送出去而重复点（两条消息、
   * 两次计费）。这里由上层掌握「本轮尚未开始」这个状态（面板同时知道 turnActive
   * 与 onSend 的 promise），再喂给 AgentComposer 决定送出钮的忙碌态。
   *
   * 解除只有三条，全部在面板侧：①turnActive 由 false 变 true（reducer 在使用者
   * 讯息落地那一刻就翻，等价「本轮已开始」）②onSend 的 promise 结算
   * ③硬保险 SEND_HARD_TIMEOUT_MS 到点（沿用输入区同一个常量，防锁死）。
   */
  const [sendPending, setSendPending] = useState(false);
  /** 硬保险计时器句柄；解锁时清掉，别留悬空的 setTimeout 攥着 setState。 */
  const sendPendingTimerRef = useRef<number | null>(null);

  /** 幂等解除：清计时器 + 落 state。promise 结算与硬保险到点都会调它。 */
  const endSendPending = useCallback(() => {
    if (sendPendingTimerRef.current !== null) {
      window.clearTimeout(sendPendingTimerRef.current);
      sendPendingTimerRef.current = null;
    }
    setSendPending(false);
  }, []);

  /** 立起在途态并重新计时硬保险（重复调用不会叠出两个计时器）。 */
  const beginSendPending = useCallback(() => {
    if (sendPendingTimerRef.current !== null) {
      window.clearTimeout(sendPendingTimerRef.current);
    }
    setSendPending(true);
    sendPendingTimerRef.current = window.setTimeout(endSendPending, SEND_HARD_TIMEOUT_MS);
  }, [endSendPending]);

  const handleExampleSend = (ex: string) => {
    if (exampleSendRef.current) return;
    exampleSendRef.current = true;
    // 点击这一刻立刻进在途态：送出钮位置转圈、三颗 chip 全部禁用、
    // 被点的那一颗自己转圈。
    beginSendPending();
    setPendingExample(ex);
    // 硬保险 20s（20_000ms ＝ 输入区导出的 SEND_HARD_TIMEOUT_MS，两边同源）：
    // 请求卡死也不能把推荐语永久锁死。
    const unlockTimer = window.setTimeout(() => { exampleSendRef.current = false; }, SEND_HARD_TIMEOUT_MS);
    Promise.resolve(onSend(ex)).catch(() => {}).finally(() => {
      window.clearTimeout(unlockTimer);
      exampleSendRef.current = false;
      setPendingExample(null);
      // 模板路径：promise 结算（网关已收下这条 prompt＝本轮真的开始了）→ 解除。
      endSendPending();
    });
  };
  const { items, pendingConfirms, pendingQuestions, closed, closedReason, turnActive, lastEventId, turnStatus } = state;

  /*
   * 本轮真的开始（turnActive 由 false 变 true）或会话已结束 → 在途态解除。
   * 另外两条平行的解除在 beginSendPending 的两端：promise 结算与 20s 硬保险。
   *
   * 故意不拿 lastEventId（第一个 SSE 帧）当解除信号：连线期间任何一帧（含
   * session / canvas 类的记账帧）都会推进它，用它等于在真空期把锁提前放掉、
   * 把这次的修复原地抵消；turnActive 已经涵盖「第一个内容帧到达」这条语义
   * （reducer 收到内容帧必翻 turnActive）。
   */
  useEffect(() => {
    if (turnActive || closed) endSendPending();
  }, [turnActive, closed, endSendPending]);

  // 卸载：面板关掉之后不该还有 setTimeout 攥着 setState。
  useEffect(
    () => () => {
      if (sendPendingTimerRef.current !== null) {
        window.clearTimeout(sendPendingTimerRef.current);
        sendPendingTimerRef.current = null;
      }
    },
    [],
  );

  // 罪状 4：子代理条目不进消息流，聚到转录区上方的状态栏（组件内部裁到至多 3 张）。
  const subagentItems = useMemo(() => {
    const out: Extract<AgentChatState["items"][number], { kind: "subagent" }>[] = [];
    for (const it of items) {
      if (it.kind === "subagent") out.push(it);
    }
    return out;
  }, [items]);

  // D-25：解读上下文 = 该轮已收到的 message.delta 文本（最新一条 assistant 条目的累计文本）。
  // 只取 transcript 里已有的东西，不造契约没有的字段；没有助手文本时确认卡退回纯花费确认。
  const lastAssistantText = (() => {
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const it = items[i];
      if (it.kind === "assistant") return (it as AgentAssistantTextItem).text;
    }
    return undefined;
  })();

  // 新条目 / 串流进行时滚到底部，让最新内容可见。
  // 只在用户本来就停在底部附近时贴底：往上翻历史时新内容到达也不拽人下去。
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isNearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items.length, lastEventId, turnActive]);

  // 罪状 5：同批同模型的确认卡合并成一张「model ×N 共 N 币」；
  // 不同模型（或金额不同）各自成组逐张出。裁决时逐笔 resolve。
  const confirmGroups = useMemo(() => groupPendingConfirms(pendingConfirms), [pendingConfirms]);

  // 滚动时实时记录「在不在底部附近」。2026-09-20 起阈值与 Surface 侧统一：
  // import scroll-threshold.ts 的 NEAR_BOTTOM_PX（Route A 并行在建），不再就地
  // 写死 128。翻看最后几条时也算「在底部」，新内容会温柔地贴上来；翻到历史
  // 深处就不再自动滚。
  const handleTranscriptScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const up = isScrolledUp(el.scrollHeight, el.scrollTop, el.clientHeight);
    isNearBottomRef.current = !up;
    setScrolledUp(up);
  };

  // 刀 3：点了回到底部——立刻把自己标回「贴底」（串流继续跟随），再卷动。
  const handleBackToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = true;
    setScrolledUp(false);
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTranscriptToBottom(el, reduceMotion);
  }, []);

  // 虚拟键盘 / 捏合缩放：视觉视口被吃掉后，底部输入区可能被键盘盖住。
  // visualViewport 的 resize/scroll 是唯一可靠的信号——部分浏览器（键盘 overlay
  // 模式、iOS 某些路径）下 window.innerHeight 不会跟着变，layout viewport 也不缩。
  // 只在「视口真的被吃掉 ≥80px」且「输入区底部掉出可视区」时把输入区滚回可见；
  // 键盘收起、纯地址栏伸缩不触发，避免和用户翻历史打架。
  useEffect(() => {
    if (typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const adjust = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const anchor = composerAnchorRef.current;
        if (!anchor) return;
        if (vv.height < window.innerHeight - 80) {
          const rect = anchor.getBoundingClientRect();
          const visibleBottom = vv.offsetTop + vv.height;
          if (rect.bottom > visibleBottom - 12) {
            anchor.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
          }
        }
      });
    };
    vv.addEventListener("resize", adjust);
    vv.addEventListener("scroll", adjust);
    return () => {
      vv.removeEventListener("resize", adjust);
      vv.removeEventListener("scroll", adjust);
      cancelAnimationFrame(raf);
    };
  }, []);

  // 等用户二选一时，「未连接」的红灯是误报：没连是因为在等他决定。
  const meta = awaitingChoice
    ? { label: "等你选择上面的对话", dotClass: "bg-ios-blue" }
    : CONNECTION_META[connection];
  /*
   * 2026-09-20 行为变更（暴君批准，agent-chat-preview 已验收）：决策卡在场
   * 不再锁输入框。旧契约（R9-3 死线 4）用 disabled + 「等待卡片选择…」表达
   * 优先级；新设计改为 composer 上缘一条 2px ios-blue 细提示条＋提示性
   * placeholder——用户在决策卡在场时发送的文字照常走 onSend（gateway 侧本
   * 就支持排队）。输入框只剩「面板禁用 / 会话关闭」两个真正的禁用理由。
   */
  const composerDisabled = disabled || closed;
  const decisionPending = pendingQuestions.length > 0 || pendingConfirms.length > 0;
  const composerPlaceholder = decisionPending
    ? "先选上方方案，或直接补充要求…"
    : undefined;

  /*
   * 输入区本体（含决策卡在场时上缘的 2px 蓝色细提示条）。空态与对话态两处
   * 摆位共用同一份 JSX：onSend 在途接线、stop / externalSendPending 等行为
   * 契约只有这一份，不许出现第二份拷贝。
   */
  const composerNode = (
    <div ref={composerAnchorRef} className="agent-composer-anchor max-sm:px-1">
      {decisionPending ? (
        <div className="mx-3 mb-2 h-[2px] rounded-full bg-ios-blue/70" aria-hidden="true" />
      ) : null}
      <AgentComposer
        disabled={composerDisabled}
        placeholder={composerPlaceholder}
        onSend={(text) => {
          // 第一条用户消息 = 右侧模板库退场的时刻（首条消息落地即收起）。
          if (items.length === 0) onFirstUserMessage?.();
          // 09-18 送出在途（面板＝单一真相源）：按下这一刻就立起来，送出钮位置
          // 立刻转圈，直到本轮真的开始 / promise 结算 / 20s 硬保险（见 sendPending）。
          beginSendPending();
          let result: void | Promise<void>;
          try {
            result = onSend(text);
          } catch (err) {
            // 同步 throw＝这条根本没送出去，立刻解锁（不留假死按钮）。
            endSendPending();
            throw err;
          }
          // 回传 promise：输入区据此把送出钮钉在在途态直到投递落地；
          // 面板自己也挂在同一个 promise 上（结算即解除在途）。
          Promise.resolve(result).catch(() => {}).finally(endSendPending);
          return result;
        }}
        sessionId={sessionId}
        onEnsureSession={onEnsureSession}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
        attachFilesRef={attachFilesRef}
        /* D-26 补全：生成中（turnActive）把中止信号送进输入区——
           输入框为空时送出钮位置变停止钮，不再只能干等。 */
        onStop={turnActive ? onStopGeneration : undefined}
        stopPending={stopPending}
        /* REQ-D2：回合进行中＝可引导。空框仍是停止钮（红方块），有字才是引导
           （方向标）——两个语义在同一位置上按「有没有字」分流，不互相冒充。 */
        steerActive={turnActive}
        /* 09-18：面板的在途态喂下去——送出钮位置立刻转圈（输入框空白也一样是
           转圈送出钮，不退回 disabled 灰钮），本轮真的开始前不被停止钮分支盖掉。 */
        externalSendPending={sendPending}
      />
    </div>
  );

  return (
    <section className="agent-panel" aria-label="智能体对话">
      {/* 状态行（2026-08-21 收缩）：常驻「已连接/连接中」由 Surface Header 的
          呼吸绿点承担，这里只在需要人做决定/知晓时出现——等待二选一、
          断线可重试、会话关闭带原因。 */}
      {(awaitingChoice || connection === "reconnecting" || (closed && closedReason)) && (
        <div className="agent-panel-status flex items-center gap-2 px-0.5 pb-2 pt-1 max-sm:px-1">
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dotClass)} aria-hidden="true" />
          <span className="text-ios-caption1 font-medium text-foreground/45">{meta.label}</span>
          {connection === "reconnecting" && (
            <button
              type="button"
              onClick={onRetryConnection}
              className="agent-retry ml-auto inline-flex items-center gap-1.5 rounded-full bg-ios-blue/10 px-3 py-1 text-ios-caption1 font-semibold text-ios-blue transition-colors hover:bg-ios-blue/[0.18] focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue/30"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              重试
            </button>
          )}
          {closed && closedReason && !awaitingChoice && (
            // min-w-0：truncate 需要宽度约束才生效——flex item 的自动最小尺寸
            // 是 min-content，没有它时一条长 reason（含 URL/路径）不缩不截，
            // 直接把状态行撑出面板宽度。
            <span className="ml-auto min-w-0 truncate text-ios-caption1 text-foreground/45">
              原因：{closedReason}
            </span>
          )}
        </div>
      )}

      {/* D-26：批量愿望的燃烧进度常驻在顶部，不用点开才知道烧到哪。
          窄屏 gutter（2026-10-03）：父层卡片只给 12px，这里补 4px 凑成 16px
          设计 gutter；桌面一字不动（max-sm 只在 ≤639.98px 生效）。 */}
      <div className="pb-1 max-sm:px-1">
        <AgentBatchProgress items={items} onStop={onStopGeneration} stopPending={stopPending} />
      </div>

      {/* 罪状 4：子代理状态栏，置顶于转录区之上、从上到下堆叠（至多 3 张）。
          窄屏 gutter 同上：12px（父卡）+4px＝16px。 */}
      <div className="pb-1 max-sm:px-1">
        <AgentSubagentBar items={subagentItems} />
      </div>

      {/* 转录区：aria-live 的 polite live region；空态给开场提示，不显示一片空白。
          溢出防护层（2026-09-20 根因清剿）：min-w-0 + overflow-x-hidden 保证
          「未来任何超宽内容」都撑不出横向滚动条——overflow-y:auto 时
          overflow-x:visible 会被规范计算成 auto，一条超宽子项就是一条带箭头的
          原生横向滚动条。内容侧仍各自负责换行/截断（气泡=break-words、
          行内 code=break-all、表格/pre=自滚），防护层只是最后一道。 */}
      {/* 刀 3：relative 锚点层——「回到底部」钮挂在卷动容器旁（absolute 不跟
          内容卷）；flex-1 + flex-col 与原单层结构几何等价，桌面像素零变化。 */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        aria-live="polite"
        onScroll={handleTranscriptScroll}
        className="agent-transcript min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5 pb-2 pt-0 max-sm:px-1"
      >
        {/* 第二轮就绪优化刀A：空态（欢迎语）不再等 SSE open —— idle/connecting/open
            都显示（「没内容且没坏」）。建号+ticket+SSE 握手在背后接，error 态仍由
            connection meta 条目单独呈现，此处只排除 reconnecting/closed。 */}
        {items.length === 0 && connection !== "reconnecting" && connection !== "closed" ? (
          /* 空态单一 DOM（09-20 零位移定案，取代 09-18 忙碌分流＋09-20 同构容器版）：
             前两版都在忙碌态换了一套布局——第一版裸 composer＋忙碌行，第二版同构容器
             但置中群体不同（欢迎态置中「标题+输入框+推荐语」整组，忙碌态只置中输入框）
             → 输入框位置照样跳。正解＝不分流：欢迎态 DOM 从头到尾一套，建号/首发在飞时
             推荐语照常渲染（占位不动）但强制 disabled＝点不到就不会重复送出（防二次
             计费）；在途回馈交给送出钮转圈（AgentComposer sending 态）。 */
          <div className="relative flex min-h-full flex-col items-center justify-center px-5">
            {/* 2026-10-01 空态淡虹彩光晕（玻璃 E 取色：蓝/薰衣草/粉，整体调淡）：从标题后方散开的
                软边径向渐变；尺寸夹在容器内（h-full/w-full 封顶 520px）、不溢出撑滚动条，
                渐变在自身边缘前衰减到 0——不是 inset-0 满版色块（09-20 教训：
                满版装饰必露硬边）；有讯息即随空态一起消失；纯装饰不吃事件、不占位（零位移）。 */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute left-1/2 top-1/2 h-full max-h-[520px] w-full max-w-[520px] -translate-x-1/2 -translate-y-1/2"
              style={{
                background:
                  "radial-gradient(closest-side at 50% 42%, rgba(140,123,240,0.13), transparent 70%), radial-gradient(closest-side at 26% 58%, rgba(91,141,239,0.11), transparent 72%), radial-gradient(closest-side at 74% 60%, rgba(229,141,186,0.11), transparent 72%)",
              }}
            />
            {/* pb-[8vh] 于 2026-09-24 移除：左卡改 fit-content 垂直置中后，这 8vh 是残留补偿，保留会置中偏上。 */}
            <div className="relative flex w-full flex-col items-center">
              <h2 className="text-2xl font-semibold tracking-tight text-foreground">想做点什么？</h2>
              <div className="mt-8 w-full">
                {composerNode}
              </div>
              <div className="mt-5 flex w-full flex-wrap items-center justify-center gap-2">
                {EXAMPLES.map((ex) => {
                  // 三态：被点的那一颗转圈，其余在途期间禁用（防重复点＝重复计费）。
                  // 建号/首发在飞（sessionStarting/turnActive）＝全部强制禁用，
                  // 但 DOM 与占位不动＝输入框零位移（09-20 暴君「移位也是劣化」）。
                  const chipState =
                    sessionStarting || turnActive ? "disabled" : exampleChipState(ex, pendingExample, sendPending);
                  return (
                    <button
                      key={ex}
                      type="button"
                      onClick={() => handleExampleSend(ex)}
                      disabled={chipState !== "idle"}
                      aria-busy={chipState === "pending" ? true : undefined}
                      className={cn(
                        // 2026-09-24 用户版面方案：纯文字行改玻璃胶囊 chip，min-h-11 保底 44px 触摸靶。
                        // 2026-10-01：半透明玻璃＋淡紫柔影，hover 微浮起（与输入框同一语汇）。
                        "min-h-11 rounded-full border border-white/80 bg-white/45 px-4 py-2 text-ios-footnote font-medium text-foreground/70 shadow-[0_2px_10px_rgba(140,123,240,0.06)] backdrop-blur-md",
                        "transition-all duration-200",
                        chipState === "idle"
                          ? "cursor-pointer hover:-translate-y-[1px] hover:bg-white/75 hover:text-foreground hover:shadow-[0_6px_18px_rgba(140,123,240,0.12)]"
                          : "cursor-not-allowed",
                        chipState === "disabled" && "opacity-50",
                        // 进行中那一颗：转圈与文字同排（chip 胶囊的既有排版与字级）。
                        chipState === "pending" && "inline-flex items-center gap-1.5",
                      )}
                    >
                      {chipState === "pending" && (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
                      )}
                      {ex}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        ) : (
          <AgentTranscript items={items} imageActions={imageActions} videoActions={videoActions} audioActions={audioActions} sessionId={sessionId} turnStatus={turnStatus} onAuthorizeLocalFiles={authorizeLocalFiles} />
        )}

        {/*
          思考中间态。送出到第一个字之间是一段真空——网关要先跑一轮推理才吐
          message.delta，这段时间画面上什么都不动，人会以为自己没送出去。

          条件是「这轮还开着，但最后一条不是助手文本」：
          - 最后一条是使用者消息 → 还没开始回，真空期，要显示。
          - 最后一条是工具调用 → agent 在跑工具（出图），还没接着讲话，也要显示。
          - 最后一条是助手文本 → 字已经在流出来了，光标本身就是回馈，不必再叠一个。
          回合一结束 turnActive 落下，泡泡跟着消失，不用另外清理。
        */}
        {turnActive && items[items.length - 1]?.kind !== "assistant" && (
          <div className="agent-thinking flex items-center gap-2 px-1 py-2 max-sm:px-0" role="status" aria-label="助手正在思考">
            <span className="flex items-end gap-[3px]" aria-hidden="true">
              {[0, 160, 320].map((delay) => (
                <span
                  key={delay}
                  className="inline-block animate-bounce rounded-full bg-black/[0.22]"
                  style={{ width: 6, height: 6, animationDelay: `${delay}ms`, animationDuration: "1.1s" }}
                />
              ))}
            </span>
            <span className="text-ios-caption1 text-foreground/45">正在思考…</span>
          </div>
        )}
      </div>

      {/* 刀 3：回到底部浮动钮（仅窄屏可见，元件内 sm:hidden）。空态没有
          历史可翻，不挂。 */}
      {items.length > 0 ? (
        <AgentBackToBottomButton scrolledUp={scrolledUp} onClick={handleBackToBottom} />
      ) : null}
      </div>

      {/* 串流状态的无障碍宣告：画面本身已用光标呈现，这里补屏幕阅读器播报。 */}
      <span className="sr-only" role="status" aria-live="polite">
        {turnActive ? "助手正在输入…" : "助手回复完成"}
      </span>

      {/* D-26 首张锚定：紧贴输入区上方，和确认卡互斥。
          有待裁决的花费确认时不问锚定——同时摆两张要人做决定的卡，
          会让人分不清自己按下的是哪一个。花费确认优先，它才是要扣钱的那张。 */}
      {anchor && pendingConfirms.length === 0 && pendingQuestions.length === 0 && onAnchor && onReanchor && onAnchorDismiss && (
        <div className="pb-1.5">
          <AgentAnchorCard
            anchor={anchor}
            onAnchor={onAnchor}
            onReanchor={onReanchor}
            onDismiss={onAnchorDismiss}
            busy={anchorBusy}
          />
        </div>
      )}

      {/* 待确认卡片浮在输入区上方，任何时刻 0..n 张。
          D-25：解读 = 该轮已收到的 message.delta 文本（lastAssistantText），
          与 confirm 事件的 description 一起由确认卡拼装成「我这么理解你的愿望」；
          缺省时确认卡退回纯花费确认。
          2026-08-16：卡片区有界 + 内部滚动——高卡片不会被面板高度裁掉底部
          选项，也不会把 transcript 挤到零高度。2026-09-20 限高放宽 45dvh→
          62dvh：四选项的问答卡在 45dvh 下第三个选项被拦腰截断（「看起来像
          页面崩了」），62dvh 常见卡完整可见、极端长卡仍走内部滚动。
          罪状 5/6：同批同模型合并成一张卡（model ×N 共 N 币），一键裁决逐笔
          resolve；确认卡容器限高 + 内部滚动，禁止整页溢出。 */}
      {confirmGroups.length > 0 && (
        // 溢出防护层 + 细滚动条（可见性）：overflow-x-hidden 让超宽卡片永远
        // 撑不出横向滚动条；agent-scroll-thin 是 agent-chat.css 抽出的共用配方
        // （与转录区同一份），让「这里可以滚」看得出来。
        <div className="agent-scroll-thin min-h-0 min-w-0 max-h-[min(62dvh,30rem)] shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5 pb-1.5 max-sm:px-1">
          <div className="flex flex-col gap-2">
            {confirmGroups.map((group) => {
              const merged = group.count > 1;
              return (
                <AgentConfirmCard
                  key={group.requestIds[0]}
                  confirm={{
                    requestId: group.requestIds[0],
                    amountCoins: group.amountCoins,
                    ...(merged
                      ? { description: describeGroup(group) }
                      : group.description !== undefined
                        ? { description: group.description }
                        : {}),
                    seq: 0,
                  }}
                  onConfirm={(_requestId, approved) =>
                    resolveConfirmGroup(group.requestIds, approved, onConfirm)
                  }
                  contextText={lastAssistantText}
                />
              );
            })}
          </div>
        </div>
      )}

      {pendingConfirms.length === 0 && pendingQuestions.length > 0 && (
        // 问答卡容器：与确认卡容器同一套溢出防护 + 细滚动条配方（见上）。
        <div className="agent-scroll-thin min-h-0 min-w-0 max-h-[min(62dvh,30rem)] shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain px-0.5 pb-1.5 max-sm:px-1">
          {/* 问题卡串行：一次只出一张，答完（reducer 移除该 requestId）再浮出下一张，
              不让多张叠在一起同时逼用户做决定。 */}
          <div className="flex flex-col gap-2">
            {pendingQuestions.slice(0, 1).map((question) => (
              <AgentQuestionCard
                key={question.requestId}
                question={question}
                onAnswer={onAnswerQuestion}
              />
            ))}
          </div>
        </div>
      )}

      {/* 输入区锚点：键盘弹起时以此为基准判断可见性，滚回可视区。
          2026-09-20 空态重构（暴君批准）：输入框在空态移进上方居中的空态区
          （composerNode），这里只在有讯息（或 reconnecting/closed 的非空态）
          时回落底部 sticky；两处共用同一份 JSX，行为契约零重复。
          决策卡在场不锁输入（行为变更）：用 composer 上缘 2px 蓝色细提示条＋
          placeholder 表达「先选上方方案，或直接补充要求…」，发送照常走 onSend。 */}
      {items.length === 0 && connection !== "reconnecting" && connection !== "closed"
        ? null
        : composerNode}
    </section>
  );
}

export const AgentChatPanel = memo(AgentChatPanelComponent);
