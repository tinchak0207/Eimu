import { useCallback, type Dispatch, type SetStateAction } from "react";
import { AGENT_STEER_QUEUE_TTL_MS, type AgentChatState } from "@/lib/agent-chat-types";
import {
  deleteAgentSession,
  isSteerReplayRejected,
  isSteerUnavailableError,
  readCachedAgentSettings,
  replyAgentQuestion,
  requestSseTicket,
  resolveAgentConfirm,
  sendAgentMessage,
  steerAgentSession,
  steerReplayStatus,
  type DirectSendCapability,
} from "@/lib/agent-chat-client";
import { clearPersisted, type PersistedAgentChat } from "@/lib/agent-chat-persistence";
import type { FrameBatcher } from "@/lib/agent-chat-frame-batch";
import { INITIAL_BACKOFF_MS, newSteerId, type AgentChatAction } from "./core";
import type { ResumableAgentChat, UseAgentChatReturn } from "./types";

interface AgentChatCommandsProps {
  dispatch: Dispatch<AgentChatAction>;
  dispatchNotice: (tone: "info" | "error", text: string) => void;
  armSteerExpiry: (delayMs: number) => void;
  start: () => Promise<void>;
  openConnection: (explicitLastEventId?: number, preMintedTicket?: Awaited<ReturnType<typeof requestSseTicket>>) => Promise<void>;
  requestAbort: (sid: string) => Promise<void>;
  onSendBlockedByAuth?: (text: string) => void;
  currentAccountRef: { current: () => boolean };
  accountEpochRef: { current: number };
  sessionEpochRef: { current: number };
  ownerIdRef: { current: number | null };
  forceNewRef: { current: boolean };
  persistedRef: { current: PersistedAgentChat | null };
  canvasStateProviderRef: { current: (() => unknown) | undefined };
  stateRef: { current: AgentChatState };
  sessionIdRef: { current: string | null };
  esRef: { current: EventSource | null };
  retryTimerRef: { current: number | null };
  saveTimerRef: { current: number | null };
  frameBatcherRef: { current: FrameBatcher | null };
  activeTicketRef: { current: { sessionId: string; ticket: Awaited<ReturnType<typeof requestSseTicket>> } | null };
  directCapRef: { current: DirectSendCapability };
  mutedUntilNextSendRef: { current: boolean };
  lastSendAtRef: { current: number };
  backoffRef: { current: number };
  mountedRef: { current: boolean };
  closedRef: { current: boolean };
  closedReasonRef: { current: 'session' | 'auth' | 'manual' | null };
  setStartingSession: Dispatch<SetStateAction<boolean>>;
  setConnection: Dispatch<SetStateAction<UseAgentChatReturn["connection"]>>;
  setResumable: Dispatch<SetStateAction<ResumableAgentChat | null>>;
}

export function useAgentChatCommands(P: AgentChatCommandsProps): {
  send: (text: string, opts?: { sessionDirective?: string; silent?: boolean }) => Promise<void>;
  confirm: (requestId: string, approved: boolean) => Promise<boolean>;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<boolean>;
  retry: () => Promise<void>;
  abort: () => Promise<void>;
  end: () => Promise<void>;
} {
  const {
    dispatch,
    dispatchNotice,
    armSteerExpiry,
    start,
    openConnection,
    requestAbort,
    onSendBlockedByAuth,
    currentAccountRef,
    accountEpochRef,
    sessionEpochRef,
    ownerIdRef,
    forceNewRef,
    persistedRef,
    canvasStateProviderRef,
    stateRef,
    sessionIdRef,
    esRef,
    retryTimerRef,
    saveTimerRef,
    frameBatcherRef,
    activeTicketRef,
    directCapRef,
    mutedUntilNextSendRef,
    lastSendAtRef,
    backoffRef,
    mountedRef,
    closedRef,
    closedReasonRef,
    setStartingSession,
    setConnection,
    setResumable,
  } = P;

  const send = useCallback(
    async (text: string, opts?: { sessionDirective?: string; silent?: boolean }): Promise<void> => {
      if (!currentAccountRef.current()) return;
      const accountEpoch = accountEpochRef.current;
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return;
      if (closedRef.current) return;

      // 09-12 建号权收归发送按钮：空态（还没会话）＝先建号再发。forceNew 放行
      // 存档检查——用户在空态按发送就是明确要开新对话，不得被「继续上次」类
      // 检查卡住。start() 幂等且串行化（在飞管线搭车，不并发第二条 POST），
      // 失败不抛错（内部已走 setError 路）。
      if (!sessionIdRef.current) {
        forceNewRef.current = true;
        // 空态首发＝建号（+SSE 票）两段跨境往返的真空期：UI 必须立刻有回应，
        // 不能等 start() 回来才动——那段时间输入框已清空而画面全真空，
        // 使用者只看到「按了没反应」。旗标只涵盖自己触发的这条建号路径，
        // ensureSession（附件上传）不动。
        setStartingSession(true);
        try {
          await start();
        } finally {
          if (mountedRef.current && accountEpochRef.current === accountEpoch) setStartingSession(false);
        }
      }
      if (accountEpochRef.current !== accountEpoch || !mountedRef.current) return;
      // sessionId 判空必须留在乐观插入之前（铁律）：建号失败（未登录/网络/已
      // 关闭）时 sid 仍 null——不能把使用者的话回声进 transcript，否则留下一句
      // 永久的「幽灵」用户发言，且没有任何办法标记它其实从未送达。
      const sid = sessionIdRef.current;
      if (!sid) {
        // 登入失效这一种要分开处理：那句话没送出去（也不是使用者放弃），
        // 交给呼叫端留住、登入后补送——否则未登入访客在主输入区打的字当场消失
        // （composer 已清空，且 GitHub 登入是整页跳转，回来什么都不剩）。
        // 文案也要说得出路，不能只回一句「无法发送」。
        if (closedRef.current && closedReasonRef.current === "auth") {
          onSendBlockedByAuth?.(trimmed);
          dispatchNotice("error", "这条消息还没发出去（需要登录）——登录完成后会自动发出。");
          return;
        }
        dispatchNotice("error", "尚未建立会话，无法发送消息。");
        return;
      }
      // 记录发送时刻：僵尸自愈要区分「turn.done 之后用户又发了新消息」——
      // 那之后的内容帧属于新回合，不算还魂证据。
      lastSendAtRef.current = Date.now();
      // 新回合开始：解除用户中止静默窗（abort() 置位）。
      mutedUntilNextSendRef.current = false;
      // 捕获当前操作代（必须在上面的 lazy 建号之后——建号落地会 bump epoch，
      // 捕获过早会把自家新会话误判成「会话已切换」）：switchSession/
      // startNewSession/resume/start 建立新会话时递增它。下面 await 完
      // steer-abort/sendAgentMessage 前重新核对，若已变说明使用者在等待期间
      // 切换了会话，不能把消息送去旧会话。
      const epoch = sessionEpochRef.current;

      // REQ-D2（2026-09-22）：回合进行中的输入分两种语义，先判定再决定乐观插入的形态。
      //   steering=true（默认设定 interrupt_mode:"steer"）：走 steer 端点——回合中追加
      //   指引，**不打断当前回合**（这正是 D2 要吃的对称差）。回合卡在 question 断点时
      //   网关把它注入当前回合；没有断点时诚实排队（徽章显示「排队中·本回合结束后生效」）。
      //   非回合中（turnActive=false）⇒ steering=false ⇒ 下面的路径与改动前逐位等价。
      // interrupt_mode 从 localStorage 缓存即时读（设定弹层写入），不发网络请求阻塞发送。
      const steering = stateRef.current.turnActive && readCachedAgentSettings().interrupt_mode === "steer";
      const steerId = steering ? newSteerId() : "";

      // 乐观插入使用者消息。directive 是隐形上下文，只随请求上送，绝不进 transcript；
      // silent=true（模板注入）同样不进 transcript——用户只看到 agent 的引导，看不到被注入的 prompt。
      if (!opts?.silent) {
        // 分岔刻意写成 if/else 而不是三元：非 steer 那一条与改动前**逐字相同**
        //（既有 source 断言（agent-chat-ui.test.ts 的乐观插入顺序锁）钉著那行字面，
        //  也让「无 steer 时行为逐位等价」在原始码层看得见）。
        if (steering) {
          dispatch({ type: "user", text: trimmed, steer: { id: steerId, status: "queued" } });
        } else {
          dispatch({ type: "user", text: trimmed });
        }
      }

      // steer 腿：只追加指引，不碰 abort（停止仍由停止钮独占）。ack 的 status 是
      // 网关的诚实判定，本地把它落到同一条目上（与 SSE 帧共用 applySteerStatus）。
      // 409 契约（D2-2）：网关明说「当前没有可引导的回合」= 改走正常送出，
      // 内容绝不能被吞——这条旗标就是「落回下面正常送出腿」的唯一开关。
      let fellBackToPlainSend = false;
      if (steering) {
        try {
          const ack = await steerAgentSession(sid, trimmed, { steerId });
          if (accountEpochRef.current !== accountEpoch) return;
          dispatch({
            type: "steer-ack",
            steerId: ack.steer_id,
            status: ack.status,
            // 位置只在 queued 形态存在（injected 是本回合内即时生效，没有队列位置）。
            position: ack.status === "queued" ? ack.position : undefined,
            // 本端入队时刻：D2-3 逾时清扫的锚点（网关不送时间戳，只有本端知道）。
            queuedAt: ack.status === "queued" ? Date.now() : undefined,
          });
          if (ack.status === "queued") armSteerExpiry(AGENT_STEER_QUEUE_TTL_MS);
          dispatchNotice(
            "info",
            ack.status === "injected"
              ? "已注入本回合：助理会按这条指引继续"
              : `已排队${typeof ack.position === "number" ? `（第 ${ack.position} 条）` : ""}，本回合结束后生效`,
          );
        } catch (err) {
          if (accountEpochRef.current !== accountEpoch) return;
          // 送不进去就说实话：徽章改「未生效」，不让用户以为指令已经在跑。
          dispatch({ type: "steer-ack", steerId, status: "failed" });
          if (isSteerUnavailableError(err)) {
            // 网关 409：现在没有可引导的回合（没在跑／已中止）。改成普通消息送出去，
            // 用户的这句话必须落地——徽章与提示照旧保留（诚实标注引导形态未生效）。
            fellBackToPlainSend = true;
            dispatchNotice("info", "当前没有进行中的回合，已改为直接发送消息。");
          } else if (isSteerReplayRejected(err)) {
            // D2b：网关拒绝重放（同一个 steer_id 第二次投递）——**绝不落回正常送出**
            //（那等于把同一条指引送第二次，正是本刀要禁的事故）。上面那句「未能送达」
            // 是本地占位猜测，这里用网关带回来的真实状态纠正它：可能已经生效、已经中止，
            // 或（重启后未确认）uncertain。提示也要说清「不会重复发送」。
            dispatch({ type: "steer-rejection", steerId, status: steerReplayStatus(err) });
            dispatchNotice("info", "这条引导已经在处理中或已有结果，不会重复发送。");
          } else {
            dispatchNotice("error", err instanceof Error ? err.message : "引导未能提交，请重试。");
          }
        }
        // 只有真的走完 steer 腿（注入或排队）才在这里收口；409 落回下面的正常送出腿。
        if (!fellBackToPlainSend) return;
      }

      // 罪状 3：回合进行中再发消息，opencode 会把它排队静默吞掉——用户以为已
      // 送达，实际要等本轮跑完才被处理，画面上没有任何提示。interrupt_mode="queue"
      // 时照发并说明「本轮结束后处理」（steer 腿已在上面 return，不会到这）。
      if (stateRef.current.turnActive && !fellBackToPlainSend) {
        dispatchNotice("info", "已加入队列，本轮结束后自动处理");
      }

      // 会话代校验：上面的 await（steer-abort）期间若使用者切了会话/开了新
      // 会话，sid 已经是死会话，不能再把消息送过去——放弃发送并说清楚。
      if (accountEpochRef.current !== accountEpoch) return;
      if (sessionEpochRef.current !== epoch) {
        dispatchNotice("error", "会话已切换，消息未发送，请重新发送。");
        return;
      }

      try {
        // 09-12 直连腿：有现任且归属相符的票才带上上下文；client 内部负责
        // 「直连失手→中继一次」的回落，这里不需要 try-then-retry。
        const activeTicket = activeTicketRef.current;
        const direct =
          activeTicket && activeTicket.sessionId === sid
            ? { ticket: activeTicket.ticket, capability: directCapRef.current }
            : null;
        await sendAgentMessage(
          sid,
          trimmed,
          {
            canvasState: canvasStateProviderRef.current?.(),
            ...(opts?.sessionDirective ? { sessionDirective: opts.sessionDirective } : {}),
          },
          direct,
        );
      } catch (err) {
        if (accountEpochRef.current !== accountEpoch) return;
        dispatchNotice("error", err instanceof Error ? err.message : "消息传送失败，请重试。");
      }
    },
    [dispatchNotice, armSteerExpiry, start, onSendBlockedByAuth],
  );

  const confirm = useCallback(
    async (requestId: string, approved: boolean): Promise<boolean> => {
      if (!currentAccountRef.current()) return false;
      const accountEpoch = accountEpochRef.current;
      if (closedRef.current) return false;
      const sid = sessionIdRef.current;
      if (!sid) return false;
      try {
        await resolveAgentConfirm(sid, requestId, approved);
        // 裁决结果由网关以 confirm.resolved 事件送回，reducer 会收起卡片并留痕。
        return accountEpochRef.current === accountEpoch;
      } catch (err) {
        if (accountEpochRef.current !== accountEpoch) return false;
        dispatchNotice("error", err instanceof Error ? err.message : "回复确认失败，请重试。");
        return false;
      }
    },
    [dispatchNotice],
  );

  const answerQuestion = useCallback(
    async (requestId: string, answers: string[][]): Promise<boolean> => {
      if (!currentAccountRef.current()) return false;
      const accountEpoch = accountEpochRef.current;
      if (closedRef.current) return false;
      const sid = sessionIdRef.current;
      if (!sid) return false;
      try {
        await replyAgentQuestion(sid, requestId, answers);
        return accountEpochRef.current === accountEpoch;
      } catch (err) {
        if (accountEpochRef.current !== accountEpoch) return false;
        dispatchNotice("error", err instanceof Error ? err.message : "回复问题失败，请重试。");
        return false;
      }
    },
    [dispatchNotice],
  );

  const retry = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    if (closedRef.current) return;
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (!sessionIdRef.current) {
      await start();
      return;
    }
    backoffRef.current = INITIAL_BACKOFF_MS;
    await openConnection();
  }, [start, openConnection]);

  const abort = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    const accountEpoch = accountEpochRef.current;
    if (closedRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await requestAbort(sid);
      if (accountEpochRef.current !== accountEpoch || sessionIdRef.current !== sid) return;
      // 静默窗开启：server 端 abort 落地后，opencode 的残响帧（迟到
      // delta/前缀补发）不再渲染，直到下一次 send()。
      mutedUntilNextSendRef.current = true;
      // 网关对用户中止刻意不发帧（收尾由 turn.done 表达），而 turn.done 要等
      // opencode 真正 idle 才到——中间 turnActive 一直是真，停止钮赖著不走、
      // 送出钮回不来，使用者只看到「按了终止像没反应」，连按就是反覆打网关。
      // 这里本端立刻合成一帧终态收尾：event_id 用 0（reducer 的续传去重守卫是
      // eventId > 0 && eventId <= lastEventId，0 一律放行，Math.max 也不推进
      // lastEventId，不污染游标记帐）；data 是空物件（AgentTurnDone =
      // Record<string, never>）。顺序铁律：先 flush 待渲染的 pre-abort 正文帧，
      // 再放终态帧——否则是「已收尾才长字」，turnActive 会被那批帧翻回真（假活）。
      frameBatcherRef.current?.flush();
      dispatch({ name: "turn.done", event_id: 0, data: {} });
      // REQ-D2 停止优先：网关同一支 handleAbortSession 已把待投 steer 全数作废
      // （dropPendingSteers），本端同步改判排队中的徽章——不等那批 aborted 帧，
      // 用户按下停止的那一刻画面就该显示「已中止」。已 injected/applied 的条目不退。
      dispatch({ type: "steer-abort-queued" });
    } catch (err) {
      if (accountEpochRef.current !== accountEpoch) return;
      // 失败时不合成终态帧：真回合还在跑，翻成收尾就是说谎；后续 delta 本就会
      // 自愈（reducer 收到内容帧会把 turnActive 设回真）。
      dispatchNotice("error", err instanceof Error ? err.message : "中止失败，请重试。");
    }
  }, [dispatch, dispatchNotice, requestAbort]);

  const end = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    const accountEpoch = accountEpochRef.current;
    closedRef.current = true;
    closedReasonRef.current = 'manual';
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setConnection("closed");
    // 本端直接收尾：让 reducer 走一次 session.closed，UI 才看到「已结束」。
    // 先 flush 缓冲：待渲染的正文帧必须落在终结帧之前，否则终结后还在长字。
    frameBatcherRef.current?.flush();
    dispatch({ name: "session.closed", event_id: 0, data: { reason: "user_ended" } });
    // 这条连线已经终局，并批器连同时间锚一起作废（下一条连线在 openConnection 重建）。
    frameBatcherRef.current?.drop();

    const sid = sessionIdRef.current;
    if (sid) {
      try {
        await deleteAgentSession(sid);
      } catch {
        // 释放资源是 best-effort；就算删不掉，本端也已经不再重连。
      }
    }
    if (accountEpochRef.current !== accountEpoch) return;
    // D-8：会话结束，本地存档同步清除，下次进来干净开场。
    clearPersisted(ownerIdRef.current);
    persistedRef.current = null;
    setResumable(null);
  }, [dispatch]);

  return { send, confirm, answerQuestion, retry, abort, end };
}
