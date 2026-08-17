// Agent 聊天的 React 生命周期 hook：自己管 EventSource 的开、断、重连。
//
// 为什么不靠 native EventSource 自动重连：网关的 SSE ticket 10 分钟就过期，
// native 重连会拿死票无限重试。这里在 onerror 时关掉 EventSource，重新 mint
// 一张票、带 last_event_id 续传游标重开，配上指数退避（~1s 起、30s 封顶、加 jitter）。
//
// 停止重连的条件只有两个：state.closed（session.closed / 使用者 end()）与
// not_authenticated（登入失效）。除此之外断线就是重连，不往上抛。

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  AGENT_EVENT_NAMES,
  EMPTY_AGENT_CHAT_STATE,
  parseAgentSseEvent,
  type AgentAttachmentRef,
  type AgentChatState,
  type AgentEventName,
  type AgentNoticeItem,
  type AgentQuotaState,
  type AgentSseEvent,
} from "@/lib/agent-chat-types";
import { agentChatReducer, appendUserTurn, applyQuotaSnapshot } from "@/lib/agent-chat-reducer";
import {
  AgentChatError,
  buildEventsUrl,
  createAgentSession,
  deleteAgentSession,
  fetchAgentQuota,
  requestSseTicket,
  resolveAgentConfirm,
  replyAgentQuestion,
  sendAgentMessage,
  abortAgentSession,
} from "@/lib/agent-chat-client";
import {
  clearPersisted,
  loadPersisted,
  savePersisted,
  type PersistedAgentChat,
} from "@/lib/agent-chat-persistence";
import type { AgentTranscriptItem } from "@/lib/agent-chat-types";

// ─────────────────────────── 常数

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

/** 存档节流：transcript 变化后至少隔 1s 才写一次 localStorage，避免每次 SSE 帧都写。 */
const SAVE_THROTTLE_MS = 1_000;

// ─────────────────────────── 本 hook 专用的非 SSE action
// agentChatReducer 只吃 AgentSseEvent；乐观插入使用者消息、GET /quota 种子
// 余额、本端错误 notice 这三种「不是网关事件」的状态变更，在这里包成
// 额外 action，委派给对应的纯 helper。

type AgentChatAction =
  | AgentSseEvent
  | { type: "user"; text: string; attachments?: AgentAttachmentRef[] }
  | { type: "quota"; quota: AgentQuotaState }
  | { type: "notice"; tone: "info" | "error"; text: string }
  // D-8/D-17：恢复上次会话时，把存档灌回 state（还原 items + 续传游标）。
  | { type: "restore"; items: AgentTranscriptItem[]; lastEventId: number }
  // D-17：会话被回收 / 使用者选「开新会话」时，把 transcript 清空重来。
  | { type: "reset" };

function chatReducer(state: AgentChatState, action: AgentChatAction): AgentChatState {
  // 网关事件都有 name，本端合成 action 用 type —— 用 in 判别，两边互不干扰。
  if ("name" in action) {
    return agentChatReducer(state, action);
  }
  switch (action.type) {
    case "user":
      return appendUserTurn(state, action.text, action.attachments);
    case "quota":
      return applyQuotaSnapshot(state, action.quota);
    case "notice": {
      let count = 0;
      for (const item of state.items) {
        if (item.kind === "notice") count += 1;
      }
      const notice: AgentNoticeItem = {
        kind: "notice",
        id: `notice-local-${count}`,
        seq: 0,
        tone: action.tone,
        text: action.text,
      };
      return { ...state, items: [...state.items, notice] };
    }
    // 恢复存档：items 与续传游标来自持久化层；额度只留已知的，其余字段回初始。
    case "restore": {
      return {
        ...EMPTY_AGENT_CHAT_STATE,
        items: action.items.map((item) => ({ ...item })),
        lastEventId: action.lastEventId,
      };
    }
    case "reset":
      return EMPTY_AGENT_CHAT_STATE;
  }
}

// ─────────────────────────── D-17：会话是否已被网关回收
// sse-ticket 端点对「会话不存在」回 404（client 吃到 code "not_found"）；
// 400 通常是网关判定会话无效。401/403（unauthorized）是登录态问题，
// 不能当成「会话被回收」来清档重开。
function isSessionReclaimed(err: unknown): boolean {
  if (!(err instanceof AgentChatError)) return false;
  if (err.code === "unauthorized") return false;
  if (err.code === "not_found") return true;
  if (err.code === "bad_request") return true;
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500) return true;
  return false;
}

/**
 * 本次页面访问里是否已经开过（或续过）会话。
 *
 * 模块级而非 ref：聊天区现在是卡片上的一个 toggle，关掉就卸载，
 * 所有 ref 跟着组件一起死。这个标记要活得比组件久、但随刷新归零——
 * 模块作用域正好是这个生命周期。
 *
 * 用途是把 D-17 的「继续上次 / 开新的」二选一，收窄回它本来的场景：
 * **刷新、崩溃、隔天回来**。同一次访问里 toggle 关掉又打开，
 * 使用者的心智是「我把它收起来了」，不是「我结束了对话」——
 * 这时候弹二选一等于每次开合都问一遍你是谁，纯骚扰。
 */
let sessionTouchedInThisVisit = false;

// ─────────────────────────── hook

export interface UseAgentChatOptions {
  autoStart?: boolean;
  /** 畫布 SSE 事件分流（v3 embed）：canvas.* 事件轉交右側 CanvasEmbed。 */
  onCanvasEvent?: (event: AgentSseEvent) => void;
  /** 發送前提供畫布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
}

/**
 * D-17：还有一份「未过期」的上次会话存档时，用它让 UI 决定「继续还是开新」。
 * sessionId = 上次还在网关上的会话；itemCount / savedAt 用于展示。
 */
export interface UseAgentChatResumable {
  sessionId: string;
  itemCount: number;
  savedAt: number;
}

/** hook 内部缩写：持久化用例里就叫「可恢复的上次会话」。 */
type ResumableAgentChat = UseAgentChatResumable;

export interface UseAgentChatReturn {
  state: AgentChatState;
  connection: "idle" | "connecting" | "open" | "reconnecting" | "closed";
  sessionId: string | null;
  error: string | null;
  start: () => Promise<void>;
  send: (text: string) => Promise<void>;
  confirm: (requestId: string, approved: boolean) => Promise<void>;
  answerQuestion: (requestId: string, answers: string[][]) => Promise<void>;
  retry: () => Promise<void>;
  end: () => Promise<void>;
  abort: () => Promise<void>;
  // D-17：上次会话存档。非空时，autoStart 不会自动开新会话，交给 UI 二选一。
  resumable: ResumableAgentChat | null;
  resume: () => Promise<void>;
  discardAndStartNew: () => Promise<void>;
}

export function useAgentChat(options?: UseAgentChatOptions): UseAgentChatReturn {
  const { autoStart = false, onCanvasEvent, canvasStateProvider } = options ?? {};

  const [state, dispatch] = useReducer(chatReducer, EMPTY_AGENT_CHAT_STATE);
  const [connection, setConnection] = useState<UseAgentChatReturn["connection"]>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableAgentChat | null>(null);

  // ── refs：给稳定的 callback 阅最新值，避免闭包抓到旧 state。
  const stateRef = useRef(state);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const connectSeqRef = useRef(0);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const closedRef = useRef(false);
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  // v3 embed：onCanvasEvent 经 ref 转交，避免 EventSource 注册时抓到旧闭包。
  const onCanvasEventRef = useRef(onCanvasEvent);
  // v3 embed：canvasStateProvider 经 ref 转交，send 时抓最新摘要。
  const canvasStateProviderRef = useRef(canvasStateProvider);
  // D-17：最后一次读到的存档（供 resume 直接取，避免重新读 localStorage）。
  const persistedRef = useRef<PersistedAgentChat | null>(null);
  // D-17：刚点了「开新会话」/ 存档被清掉后，start() 不再被存档挡住。
  const forceNewRef = useRef(false);
  // D-8：存档节流的最后写入时间与待跑写入定时器。
  const lastSavedAtRef = useRef(0);
  const saveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    onCanvasEventRef.current = onCanvasEvent;
    canvasStateProviderRef.current = canvasStateProvider;
  }, [onCanvasEvent, canvasStateProvider]);

  // D-17：mount 时读一次本地存档，决定「有可恢复的上次会话」。
  useEffect(() => {
    const saved = loadPersisted();
    if (saved) {
      persistedRef.current = saved;
      // 同一次访问里刚 toggle 关掉又打开：不问，下面的 autoStart 直接静默续上。
      // 提前在这里判断而不是等 resume()，否则二选一卡会闪一帧。
      if (!sessionTouchedInThisVisit) {
        setResumable({ sessionId: saved.sessionId, itemCount: saved.items.length, savedAt: saved.savedAt });
      }
    }
    // 只在 mount 读一次，之后靠 resume / discardAndStartNew / end 维护状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // D-18：transcript 变化时节流写入存档（>=1s）；会话终结时清存档。
  // 不依赖 state 本身（省得每帧都写），靠 ref 保证取到最新 items。
  useEffect(() => {
    const sid = sessionIdRef.current;
    const s = stateRef.current;
    if (!sid || !s) return;

    // 会话已终结（双方任一关）：存档没意义了，直接清掉。
    if (s.closed) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      clearPersisted();
      persistedRef.current = null;
      setResumable(null);
      return;
    }

    const doSave = () => {
      savePersisted({
        sessionId: sid,
        lastEventId: s.lastEventId,
        savedAt: Date.now(),
        items: s.items,
      });
      lastSavedAtRef.current = Date.now();
    };

    const elapsed = Date.now() - lastSavedAtRef.current;
    if (elapsed >= SAVE_THROTTLE_MS) {
      doSave();
    } else {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        doSave();
      }, SAVE_THROTTLE_MS - elapsed);
    }
    // 依赖 state 让它在每次事件后重跑；内部用 stateRef 拿最新值。
  }, [state]);

  // state.closed（来自 session.closed）＝永久停止重连。
  useEffect(() => {
    if (!state.closed) return;
    closedRef.current = true;
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
    clearPersisted();
    persistedRef.current = null;
    setResumable(null);
    setConnection("closed");
  }, [state.closed]);

  // unmount 清理：关 ES、清计时器、标记不再 setState。
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      closedRef.current = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };
  }, []);

  const nextBackoff = useCallback((): number => {
    const base = Math.min(backoffRef.current, MAX_BACKOFF_MS);
    backoffRef.current = Math.min(base * 2, MAX_BACKOFF_MS);
    // jitter：0.5x ~ 1x，避免一堆客户端同时重连撞在一起。
    return Math.round(base * (0.5 + Math.random() * 0.5));
  }, []);

  const dispatchNotice = useCallback(
    (tone: "info" | "error", text: string) => {
      dispatch({ type: "notice", tone, text });
    },
    [dispatch],
  );

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
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      setConnection("connecting");

      let ticket = preMintedTicket;
      if (!ticket) {
        try {
          ticket = await requestSseTicket(sid);
        } catch (err) {
          if (seq !== connectSeqRef.current || !mountedRef.current) return;
          if (err instanceof AgentChatError && err.code === "not_authenticated") {
            closedRef.current = true;
            setConnection("closed");
            setError(err.message);
            return;
          }
          scheduleReconnect();
          return;
        }
        if (seq !== connectSeqRef.current || !mountedRef.current || closedRef.current) return;
      }
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
  }, []);

  // 一帧 SSE 的统一入口：parse → 丢掉不合契约的 → dispatch。
  const handleSseEvent = useCallback(
    (name: AgentEventName, seq: number) => (e: Event) => {
      if (seq !== connectSeqRef.current) return;
      const msg = e as MessageEvent;
      const raw = typeof msg.data === "string" ? msg.data : "";
      const evt = parseAgentSseEvent(name, raw);
      if (!evt) return;
      // v3 embed：canvas 事件 + 完成訊號（image.done/turn.done/session.closed）也
      // 分流給右側 CanvasEmbed（走 useCanvasChat），讓畫布能對「圖完成」做最終一
      // 致性收斂，不依賴 gateway 一定發出 canvas.node.updated。
      if (evt.name.startsWith("canvas.") || evt.name === "image.done" || evt.name === "turn.done" || evt.name === "session.closed") {
        onCanvasEventRef.current?.(evt);
      }
      if (evt.name === "session.closed") {
        // 终结事件：马上关 ES、清计时器，剩下的交给 state.closed effect。
        closedRef.current = true;
        if (esRef.current) {
          esRef.current.close();
          esRef.current = null;
        }
        if (retryTimerRef.current !== null) {
          window.clearTimeout(retryTimerRef.current);
          retryTimerRef.current = null;
        }
      }
      dispatch(evt);
    },
    [dispatch],
  );

  const start = useCallback(async (): Promise<void> => {
    if (closedRef.current || startedRef.current) return;
    // D-17：有未过期的存档，且不是「刚点了开新会话」——先不自动建号，
    // 把决定权留给 UI（继续上次 / 结束开新）。autoStart 走这里时自动停住。
    const existing = loadPersisted();
    if (existing && !forceNewRef.current) return;
    forceNewRef.current = false;
    startedRef.current = true;
    try {
      const session = await createAgentSession();
      if (!mountedRef.current) return;
      sessionIdRef.current = session.session_id;
      setSessionId(session.session_id);
      // 本次访问已经有过会话：之后 toggle 关掉再打开就静默续上，不再问。
      sessionTouchedInThisVisit = true;

      // 种子余额：quota.changed 只在变化时才发，开场得主动抓一次。
      try {
        const quota = await fetchAgentQuota();
        if (mountedRef.current) dispatch({ type: "quota", quota });
      } catch {
        // 种子是 best-effort，抓不到不阻挡开场。
      }

      await openConnection();
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : "无法开始 Agent 会话。";
      setError(message);
      if (err instanceof AgentChatError && err.code === "not_authenticated") {
        closedRef.current = true;
        setConnection("closed");
      } else {
        startedRef.current = false; // 让 retry 能从头再试
      }
    }
  }, [openConnection]);

  const send = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return;
      if (closedRef.current) return;

      // 乐观插入使用者消息。
      dispatch({ type: "user", text: trimmed });

      const sid = sessionIdRef.current;
      if (!sid) {
        dispatchNotice("error", "尚未建立会话，无法发送消息。");
        return;
      }
      try {
        await sendAgentMessage(sid, trimmed, {
          canvasState: canvasStateProviderRef.current?.(),
        });
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "消息传送失败，请重试。");
      }
    },
    [dispatchNotice],
  );

  const confirm = useCallback(
    async (requestId: string, approved: boolean): Promise<void> => {
      if (closedRef.current) return;
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await resolveAgentConfirm(sid, requestId, approved);
        // 裁决结果由网关以 confirm.resolved 事件送回，reducer 会收起卡片并留痕。
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "回复确认失败，请重试。");
      }
    },
    [dispatchNotice],
  );

  const answerQuestion = useCallback(
    async (requestId: string, answers: string[][]): Promise<void> => {
      if (closedRef.current) return;
      const sid = sessionIdRef.current;
      if (!sid) return;
      try {
        await replyAgentQuestion(sid, requestId, answers);
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "回复问题失败，请重试。");
      }
    },
    [dispatchNotice],
  );

  const retry = useCallback(async (): Promise<void> => {
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
    if (closedRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await abortAgentSession(sid);
    } catch (err) {
      dispatchNotice("error", err instanceof Error ? err.message : "中止失败，请重试。");
    }
  }, [dispatchNotice]);

  const end = useCallback(async (): Promise<void> => {
    closedRef.current = true;
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
    dispatch({ name: "session.closed", event_id: 0, data: { reason: "user_ended" } });

    const sid = sessionIdRef.current;
    if (sid) {
      try {
        await deleteAgentSession(sid);
      } catch {
        // 释放资源是 best-effort；就算删不掉，本端也已经不再重连。
      }
    }
    // D-8：会话结束，本地存档同步清除，下次进来干净开场。
    clearPersisted();
    persistedRef.current = null;
    setResumable(null);
  }, []);

  /**
   * D-17：继续上次会话。用存档里的 sessionId 铸票重开 SSE，带 last_event_id 续传；
   * 若铸票失败且是「会话已被回收」（4xx），清档退回开新会话。
   */
  const resume = useCallback(async (): Promise<void> => {
    if (closedRef.current) return;
    const saved = persistedRef.current;
    if (!saved) {
      // 没有可恢复存档：语义等同直接开新会话。
      await start();
      return;
    }

    const sid = saved.sessionId;
    const lastEventId = saved.lastEventId;

    // 先铸票探活。成功 = 会话还在网关，走正常 openConnection 续传。
    try {
      const ticket = await requestSseTicket(sid);
      if (!mountedRef.current) return;
      // 恢复上下文：sessionId + 存档（items/lastEventId）。
      sessionIdRef.current = sid;
      setSessionId(sid);
      sessionTouchedInThisVisit = true;
      dispatch({ type: "restore", items: saved.items, lastEventId });
      try {
        const quota = await fetchAgentQuota();
        if (mountedRef.current) dispatch({ type: "quota", quota });
      } catch {
        // 种子是 best-effort。
      }
      // 用存档的 lastEventId 当续传游标开 SSE；即便 restore 的 dispatch
      // 还没反映进 stateRef，也从上一次结尾接着收。探针票直接复用，
      // 不再多 mint 一张，避免多余请求也避免「票已用完」竞态。
      await openConnection(lastEventId, ticket);
      // 续接成功：不再显示「继续上次」提示（存档继续在 transcript 变化时更新）。
      setResumable(null);
      persistedRef.current = null;
    } catch (err) {
      // 铸票的探针失败；4xx = 会话已被网关回收 → 清档、开新会话说清楚。
      if (isSessionReclaimed(err)) {
        clearPersisted();
        persistedRef.current = null;
        setResumable(null);
        dispatchNotice("info", "上次对话已过期，已为你开新的。");
        forceNewRef.current = true;
        void start();
        return;
      }
      if (err instanceof AgentChatError && err.code === "not_authenticated") {
        closedRef.current = true;
        setConnection("closed");
        setError(err.message);
        return;
      }
      // 其它错（网络 / 网关 5xx）：不做回收判定，保留存档，让 UI 还能再试。
      setError(err instanceof Error ? err.message : "恢复上次对话失败，请重试。");
    }
  }, [dispatch, dispatchNotice, openConnection, start]);

  /** D-17：删掉上次的会话并开一个全新会话。 */
  const discardAndStartNew = useCallback(async (): Promise<void> => {
    // 别让存档挡住开新会话。
    forceNewRef.current = true;
    const saved = persistedRef.current;
    if (saved?.sessionId) {
      try {
        await deleteAgentSession(saved.sessionId);
      } catch {
        // 删不掉也没关系：它可能已被网关回收，清理是 best-effort。
      }
    }
    // 重置到空 state，清掉存档与可续标记。
    clearPersisted();
    persistedRef.current = null;
    setResumable(null);
    dispatch({ type: "reset" });
    // 清掉旧的连接/重连引用的会话，避免上一份残留在内存里。
    sessionIdRef.current = null;
    setSessionId(null);
    await start();
  }, [start]);

  // autoStart：mount 后自动开场。
  useEffect(() => {
    if (!autoStart) return;
    // 同一次访问里 toggle 关掉又打开，且手上有存档 → 静默续上，不弹二选一。
    // 刷新后 sessionTouchedInThisVisit 归零，D-17 的二选一照旧出现。
    if (sessionTouchedInThisVisit && loadPersisted()) {
      void resume();
      return;
    }
    void start();
    // start / resume 都是稳定的，只触发一次；start 内部会自己判断
    // 「有存档 → 不自动开」，把决定权留给 UI。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  return {
    state,
    connection,
    sessionId,
    error,
    start,
    send,
    confirm,
    answerQuestion,
    retry,
    end,
    resumable,
    resume,
    abort,
    discardAndStartNew,
  };
}
