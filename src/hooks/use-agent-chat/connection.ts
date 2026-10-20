import { useCallback, type Dispatch, type SetStateAction } from "react";
import type { AgentChatState, AgentSseEvent } from "@/lib/agent-chat-types";
import { AGENT_EVENT_NAMES } from "@/lib/agent-chat-types";
import { buildEventsUrl, createDirectSendCapability, isTerminalAuthError, requestSseTicket, type DirectSendCapability } from "@/lib/agent-chat-client";
import { parseAgentSseEvent, type AgentEventName } from "@/lib/agent-chat-types";
import { createFrameBatcher, type FrameBatcher } from "@/lib/agent-chat-frame-batch";
import { INITIAL_BACKOFF_MS, ZOMBIE_HEAL_GAP_MS, type AgentChatAction } from "./core";
import type { UseAgentChatReturn } from "./types";

interface AgentChatConnectionProps {
  dispatch: Dispatch<AgentChatAction>;
  nextBackoff: () => number;
  setConnection: Dispatch<SetStateAction<UseAgentChatReturn["connection"]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  mountedRef: { current: boolean };
  stateRef: { current: AgentChatState };
  sessionIdRef: { current: string | null };
  esRef: { current: EventSource | null };
  retryTimerRef: { current: number | null };
  connectSeqRef: { current: number };
  frameBatcherRef: { current: FrameBatcher | null };
  closedRef: { current: boolean };
  closedReasonRef: { current: 'session' | 'auth' | 'manual' | null };
  activeTicketRef: { current: { sessionId: string; ticket: Awaited<ReturnType<typeof requestSseTicket>> } | null };
  directCapRef: { current: DirectSendCapability };
  backoffRef: { current: number };
  onCanvasEventRef: { current: ((event: AgentSseEvent) => void) | undefined };
  lastTurnDoneAtRef: { current: number | null };
  mutedUntilNextSendRef: { current: boolean };
  lastSendAtRef: { current: number };
}

export function useAgentChatConnection(P: AgentChatConnectionProps): {
  openConnection: (explicitLastEventId?: number, preMintedTicket?: Awaited<ReturnType<typeof requestSseTicket>>) => Promise<void>;
} {
  const {
    dispatch,
    nextBackoff,
    setConnection,
    setError,
    mountedRef,
    stateRef,
    sessionIdRef,
    esRef,
    retryTimerRef,
    connectSeqRef,
    frameBatcherRef,
    closedRef,
    closedReasonRef,
    activeTicketRef,
    directCapRef,
    backoffRef,
    onCanvasEventRef,
    lastTurnDoneAtRef,
    mutedUntilNextSendRef,
    lastSendAtRef,
  } = P;

  // 开一条连线：mint ticket → new EventSource → 挂 10 个事件监听。
  // 用 connectSeq 挡掉慢票竞态：旧的 mint 回来时若序号已变就直接丢。
  // resume 场景下，stateRef 还停留在旧值（restore 的 dispatch 要等 React 下一帧），
  // 所以允许显式传入 lastEventId 作为续传游标；若调用方已铸好票（resume）
  // 则直接用，不再多 mint 一张。
  const openConnection = useCallback(
    async (explicitLastEventId?: number, preMintedTicket?: Awaited<ReturnType<typeof requestSseTicket>>): Promise<void> => {
      if (closedRef.current) return;
      const sid = sessionIdRef.current;
      if (!sid) return;

      const seq = ++connectSeqRef.current;
      // 旧连线的缓冲残帧属于上一条生命，换世代即丢——丢掉不会漏内容：还没
      // apply 的帧必然没推进 lastEventId，而下面的 resumeFrom 取自
      // stateRef.current.lastEventId，网关续传会把它们原样回放。
      frameBatcherRef.current?.drop();
      frameBatcherRef.current = createFrameBatcher({ apply: (evt) => dispatch(evt) });
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnection("connecting");
      // 新连线世代开始：旧票作废、闩锁重设——直连腿对新票代重新探测，
      // 老网关每代最多付一次 401 学费，补丁上线后下一张票即自动转直连。
      activeTicketRef.current = null;
      directCapRef.current = createDirectSendCapability();

      let ticket = preMintedTicket;
      if (!ticket) {
        try {
          ticket = await requestSseTicket(sid);
        } catch (err) {
          if (seq !== connectSeqRef.current || !mountedRef.current) return;
          if (isTerminalAuthError(err)) {
            closedRef.current = true;
            closedReasonRef.current = 'auth';
            setConnection("closed");
            setError(err instanceof Error ? err.message : "登录已失效，请重新登录。");
            return;
          }
          scheduleReconnect();
          return;
        }
        if (seq !== connectSeqRef.current || !mountedRef.current || closedRef.current) return;
      }
      // 票到手才落位；绑定 sid 供 send 核对归属，防止拿到前一会话的残票去打新会话。
      activeTicketRef.current = { sessionId: sid, ticket };
      const resumeFrom = typeof explicitLastEventId === "number" ? explicitLastEventId : stateRef.current.lastEventId;
      const url = buildEventsUrl(ticket.events_url, ticket.ticket, resumeFrom);
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      if (seq !== connectSeqRef.current || !mountedRef.current) return;
      backoffRef.current = INITIAL_BACKOFF_MS; // 成功开通就重置退避
      setConnection("open");
      setError(null);
    };

    for (const name of AGENT_EVENT_NAMES) {
      es.addEventListener(name, handleSseEvent(name, seq));
    }

    es.onerror = () => {
      if (seq !== connectSeqRef.current) return;
      if (closedRef.current || !mountedRef.current) return;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnection("reconnecting");
      scheduleReconnect();
    };

    function scheduleReconnect() {
      if (closedRef.current || !mountedRef.current) return;
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        void openConnection();
      }, nextBackoff());
    }
    // dispatch 来自 useReducer，恒稳定；列进依赖只为让并批器的 apply 闭包
    // 有据可依（行为与原来的空依赖等价）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 缺 handleSseEvent：它是本档案在 openConnection 之后（第 601 行）才宣告的 useCallback，列入依赖阵列会在首帧 render 求值时触发 TDZ（Cannot access 'handleSseEvent' before initialization）；nextBackoff 已补进依赖。
  }, [dispatch, nextBackoff]);

  // 一帧 SSE 的统一入口：parse → 丢掉不合契约的 → dispatch。
  const handleSseEvent = useCallback(
    (name: AgentEventName, seq: number) => (e: Event) => {
      if (seq !== connectSeqRef.current) return;
      const msg = e as MessageEvent;
      const raw = typeof msg.data === "string" ? msg.data : "";
      const evt = parseAgentSseEvent(name, raw);
      if (!evt) return;
      // v3 embed：canvas 事件 + 完成讯号（image.done/turn.done/session.closed）也
      // 分流给右侧 CanvasEmbed（走 useCanvasChat），让画布能对「图完成」做最终一
      // 致性收敛，不依赖 gateway 一定发出 canvas.node.updated。
      if (
        evt.name.startsWith("canvas.") ||
        evt.name === "image.done" ||
        evt.name === "image.failed" ||
        evt.name === "turn.done" ||
        evt.name === "session.closed" ||
        // 第一次 workflow_start 调用即分流：右侧面板要在工作流真正落地前就切画布。
        (evt.name === "tool.invoke" && evt.data.tool === "workflow_start")
      ) {
        onCanvasEventRef.current?.(evt);
      }
      if (evt.name === "turn.done") {
        // 僵尸自愈的时间锚点：回合在此刻被宣告收尾。
        lastTurnDoneAtRef.current = Date.now();
      }
      if (evt.name === "session.closed") {
        // 终结事件：马上关 ES、清计时器，剩下的交给 state.closed effect。
        // 来源标 'session'（网关回收/终结）——switchSession/resume/startNewSession
        // 入口据此判为「可开启新生命」而解锁重连，非 auth/manual 的永久封锁。
        closedRef.current = true;
        closedReasonRef.current = 'session';
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      }
      // 用户中止静默窗：迟到的文本帧直接丢，连还魂检查都不进——
      // （a）残响 delta 不再往已冻结的气泡里续写；（b）残响不把发送钮
      // 翻回「中止助理生成」。canvas.* 帧照常派发（服务器侧已在跑的
      // 出图终态是真结果），但不触发还魂。下一轮 send() 解除。
      if (
        (evt.name === "message.delta" || evt.name === "reasoning.delta") &&
        mutedUntilNextSendRef.current
      ) {
        return;
      }
      // 僵尸还魂自愈（物种 A）：watchdog 误判发出的 turn.done 不撤回，retry
      // 的内容帧却继续灌进同一条连线。回合已收尾、其间没有新的用户发送、
      // 且距 turn.done 已超过防抖窗口（>800ms 才算真还魂，同 tick 补发帧不算）
      // 时，内容帧一到就把会话拉回流式中——发送钮翻回「中止助理生成」，
      // 不再停在「系统说死亡但内容还在冒」的断点假象。文本/工具帧的
      // turnActive 恢复 reducer 本来就会做，这里统一补一发，让 canvas.* 这类
      // 不经 reducer 分支的内容帧也能翻回按钮；turn.done 重复帧不触发。
      if (
        evt.name === "message.delta" ||
        evt.name === "reasoning.delta" ||
        evt.name === "tool.invoke" ||
        evt.name === "tool.result" ||
        evt.name.startsWith("canvas.")
      ) {
        const snapshot = stateRef.current;
        const doneAt = lastTurnDoneAtRef.current;
        if (
          !mutedUntilNextSendRef.current &&
          !snapshot.closed &&
          !snapshot.turnActive &&
          lastSendAtRef.current < (doneAt ?? Number.MAX_SAFE_INTEGER) &&
          (doneAt === null || Date.now() - doneAt > ZOMBIE_HEAL_GAP_MS)
        ) {
          dispatch({ type: "zombie-resurrect" });
        }
      }
      // 并批出口：文字帧进缓冲（同窗口折成一次渲染），其余帧在 batcher 内部
      // 先 flush 缓冲再自己落地。上面所有副作用都在本行之前同步跑完，顺序不变。
      const batcher = frameBatcherRef.current;
      if (batcher) batcher.push(evt);
      else dispatch(evt);
    },
    [dispatch],
  );

  return { openConnection };
}
