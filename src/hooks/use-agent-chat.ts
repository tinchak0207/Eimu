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
import { agentChatReducer, appendUserTurn, applyQuotaSnapshot, resumeZombieTurn } from "@/lib/agent-chat-reducer";
import {
  AgentChatError,
  buildEventsUrl,
  createAgentSession,
  deleteAgentSession,
  fetchAgentQuota,
  requestSseTicket,
  patchAgentSessionMemory,
  resolveAgentConfirm,
  replyAgentQuestion,
  sendAgentMessage,
  abortAgentSession,
  readCachedAgentSettings,
  tryAuthHeaders,
  isTerminalAuthError,
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

/**
 * 殭屍还魂自愈的防抖窗口：turn.done 之后这个时间内到的内容帧当同 tick 毛刺，
 * 不触发自愈（watchdog 发完 turn.done 紧跟的补发帧不属于「还魂」证据）。
 */
const ZOMBIE_HEAL_GAP_MS = 800;

// ─────────────────────────── 静默教训提炼（L0）

const LESSON_DIGEST_THROTTLE_MS = 3 * 60 * 1000; // 同会话 3 分钟只提炼一次
const LESSON_DIGEST_MIN_USER_TURNS = 2; // 至少 2 轮用户消息才值得提炼
const lastLessonDigestAt = new Map<string, number>();

/**
 * 回合收官的静默教训提炼：fire-and-forget，无 UI、不 await、不打断主流程。
 * 像送礼不提前告知——用户只该看到「回复」，不该看到「我在记你的习惯」。
 *
 * - 节流：同会话 3 分钟内最多一次（每轮都打 LLM 是浪费）
 * - 短会话跳过：少于一问一答的回合没有教训可提炼
 * - 失败静默：fetch 异常 / 无会话 / 语料不足都直接忽略，绝不上抛
 */
function fireAndForgetLessonDigest(
  sessionId: string | null,
  getItems: () => AgentTranscriptItem[],
): void {
  if (!sessionId) return;
  const now = Date.now();
  const last = lastLessonDigestAt.get(sessionId) ?? 0;
  if (now - last < LESSON_DIGEST_THROTTLE_MS) return;

  const items = getItems();
  const userTurns = items.filter((i) => i.kind === "user").length;
  if (userTurns < LESSON_DIGEST_MIN_USER_TURNS) return;

  lastLessonDigestAt.set(sessionId, now);

  const payload = {
    session_id: sessionId,
    items: items.map((item) => {
      // 只带提炼需要的字段：文本 / 工具名 / 状态；图片只留参考信息，绝不带 base64。
      if (item.kind === "user" || item.kind === "assistant") {
        return { kind: item.kind, text: typeof item.text === "string" ? item.text.slice(0, 4000) : "" };
      }
      if (item.kind === "tool") {
        return {
          kind: "tool" as const,
          status: item.status,
          tool: item.tool,
          argsSummary: item.argsSummary ? String(item.argsSummary).slice(0, 2000) : undefined,
        };
      }
      return { kind: item.kind as string };
    }),
  };

  // fire-and-forget：不 await、不 catch 上抛，浏览器自己吞掉网络失败。
  // 認證頭必須帶：/api/agent/profile/lessons 走 resolveAgentCaller，缺
  // Authorization/x-user-id 會被當成「未登入」回 401，記錄從沒送達過。
  // 未登入（null）時直接靜默跳過——旁生請求不值得換一個 console 錯誤。
  const headers = tryAuthHeaders();
  if (!headers) return;
  headers["Content-Type"] = "application/json";
  void fetch("/api/agent/profile/lessons", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    keepalive: true, // 页面关掉时仍在途的请求也让它尽量送达
  }).catch(() => undefined);
}

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
  | { type: "reset" }
  // 殭屍还魂自愈：turn.done 宣告收尾后内容帧仍到达，把回合拉回流式中。
  // hook 侧判定时机（防抖/是否新发送），落地交给纯 helper，与上面同范式。
  | { type: "zombie-resurrect" };

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
    case "zombie-resurrect":
      return resumeZombieTurn(state);
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
  send: (text: string, opts?: { sessionDirective?: string; silent?: boolean }) => Promise<void>;
  /** true = 网关已受理该次裁决；false = 请求失败（已连带发出错误 notice）。 */
  confirm: (requestId: string, approved: boolean) => Promise<boolean>;
  /** true = 网关已受理该次回答；false = 请求失败（已连带发出错误 notice）。 */
  answerQuestion: (requestId: string, answers: string[][]) => Promise<boolean>;
  retry: () => Promise<void>;
  end: () => Promise<void>;
  abort: () => Promise<void>;
  /** 是否有一个 abort 请求正在飞行中（供 UI 禁用「停止」按钮，避免重复点击双发）。 */
  aborting: boolean;
  // D-17：上次会话存档。非空时，autoStart 不会自动开新会话，交给 UI 二选一。
  resumable: ResumableAgentChat | null;
  resume: () => Promise<void>;
  /** 切换到指定的历史会话（对话历史 dropdown）。 */
  switchSession: (targetSessionId: string) => Promise<boolean>;
  /** 开新对话：旧会话保留在历史里可切回（不删除）。 */
  startNewSession: () => Promise<boolean>;
  discardAndStartNew: () => Promise<void>;
}

export function useAgentChat(options?: UseAgentChatOptions): UseAgentChatReturn {
  const { autoStart = false, onCanvasEvent, canvasStateProvider } = options ?? {};

  const [state, dispatch] = useReducer(chatReducer, EMPTY_AGENT_CHAT_STATE);
  const [connection, setConnection] = useState<UseAgentChatReturn["connection"]>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableAgentChat | null>(null);
  // 供 UI 判断「停止」按钮是否该禁用——ref 本身不触发渲染，需要这份 state 镜像。
  const [aborting, setAborting] = useState(false);

  // ── refs：给稳定的 callback 阅最新值，避免闭包抓到旧 state。
  const stateRef = useRef(state);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const connectSeqRef = useRef(0);
  // 操作身份代：switchSession/startNewSession/resume/start 建立新的活跃会话时
  // 一并递增（与 connectSeqRef 分开维护，虽然目前总是同步递增——保留独立
  // 计数器是为了不动 openConnection 既有的 seq 守卫行为）。send() 在入口
  // 捕获当前 epoch，await 之后若已变则说明会话已切换，放弃发送。
  const sessionEpochRef = useRef(0);
  // abort() 与 send() 内部的 steer-abort 共享的在途 guard：同一会话上只允许
  // 一个 abort 网络请求在飞行，第二个调用者复用同一个 promise 而不是再发一次。
  const abortInFlightRef = useRef<Promise<void> | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const closedRef = useRef(false);
  const startedRef = useRef(false);
  // 09-01 競態治本：同時只允許一條建號管線在飛行。startNewSession 防的是
  // mount autoStart 還沒落地時套模板會併發第二條管線，兩條鏈各自
  // setSessionId 相繼落地，第二條 transition 觸發 use-canvas-chat 的
  // newCanvasSession() 把模板剛鋪好的節點清掉（生產 7bf591f5 空快照實錘）。
  // 09-01 物種 F：start() 的建號也註冊進來——StrictMode dev 雙掛載把
  // autoStart effect 跑兩遍，兩條 POST 相繼落地就是 DB 裡 11-75ms 成對的
  // 零事件孤兒；第二遍 start() 搭在飛管線的車，不再發第二條 POST。
  const startPipelineRef = useRef<Promise<boolean> | null>(null);
  // 最近一次 start() 建出、且尚未承載任何消息的新鮮會話 id。
  // 模板套用撞上在途管線時直接復用它，不再併發建第二個 session。
  const freshSessionIdRef = useRef<string | null>(null);
  // 殭屍还魂自愈（物種 A）的计时锚点：最近一次 turn.done（回合被宣告死亡的
  // 时刻）与最近一次用户发送。内容帧在「回合已收尾 + 其间没有新发送 +
  // 距 turn.done > ZOMBIE_HEAL_GAP_MS」时到达＝误判后的殭屍输出，恢复流式态。
  const lastTurnDoneAtRef = useRef<number | null>(null);
  const lastSendAtRef = useRef(0);
  // 用戶主動中止的靜默窗：abort() 成功到下一次 send() 之间，上游仍会漏进
  // 迟到的 message/reasoning delta（opencode 已排队的前缀补发）。这段窗口里
  // 丢弃内容帧——用户既然叫停，画面就不该再自己长出字来。
  const mutedUntilNextSendRef = useRef(false);
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
  // 2026-08-27 修正（终验期发现）：setup 阶段必须把 mountedRef 置回 true——
  // dev StrictMode 对同一 hook 实例按 setup→cleanup→setup 跑两遍，旧版只在
  // cleanup 里写 false，第二遍 setup 后 ref 恒为 false：start()/resume() 的
  // await 回来时全部被 mounted 守卫丢弃，sessionId 永远落不了 state
  // （症状：会话已在网关建号，前端却停在 null，画布/模板库全链失联）。
  useEffect(() => {
    mountedRef.current = true;
    // dev StrictMode / 熱重載會對同一 hook 實例按 setup→cleanup→setup 跑兩遍：
    // 幽靈 cleanup 在下面寫下的「終結旗標」（closed/started）若不在第二遍
    // setup 復位，之後的 start()/startNewSession() 會整體啞火 —— 會話建號
    // 成功卻永遠落不了地。正式卸載時這三行不會再執行，語義不受影響。
    closedRef.current = false;
    startedRef.current = false;
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
          if (isTerminalAuthError(err)) {
            closedRef.current = true;
            setConnection("closed");
            setError(err instanceof Error ? err.message : "登录已失效，请重新登录。");
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
      if (
        evt.name.startsWith("canvas.") ||
        evt.name === "image.done" ||
        evt.name === "image.failed" ||
        evt.name === "turn.done" ||
        evt.name === "session.closed" ||
        // 第一次 workflow_start 調用即分流：右側面板要在工作流真正落地前就切畫布。
        (evt.name === "tool.invoke" && evt.data.tool === "workflow_start")
      ) {
        onCanvasEventRef.current?.(evt);
      }
      // 静默教训提炼（L0）：每轮 turn.done 后，旁生一个后台请求从本轮回合
      // 提炼账户级教训。全程无 UI、不 await、不打断主流程——像送礼不提前告知。
      // 节流：同会话 3 分钟内只提炼一次，避免每轮都打 LLM。
      if (evt.name === "turn.done") {
        // 殭屍自愈的时间锚点：回合在此刻被宣告收尾。
        lastTurnDoneAtRef.current = Date.now();
        fireAndForgetLessonDigest(sessionIdRef.current, () => stateRef.current?.items ?? []);
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
      // 用戶中止靜默窗：遲到的文本幀直接丟，連還魂檢查都不進——
      // （a）殘響 delta 不再往已凍結的氣泡裡續寫；（b）殘響不把發送鈕
      // 翻回「中止助理生成」。canvas.* 幀照常派發（服務器側已在跑的
      // 出圖終態是真結果），但不觸發還魂。下一輪 send() 解除。
      if (
        (evt.name === "message.delta" || evt.name === "reasoning.delta") &&
        mutedUntilNextSendRef.current
      ) {
        return;
      }
      // 殭屍还魂自愈（物種 A）：watchdog 误判发出的 turn.done 不撤回，retry
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
      dispatch(evt);
    },
    [dispatch],
  );

  // abort() 与 send() 内部的 steer-abort 唯一入口：同一时刻只允许一个 abort
  // 网络请求在飞行，第二个调用者（无论来自哪个入口）复用同一个 in-flight
  // promise，不再多发一次。aborting 是给 UI 用的 state 镜像——ref 本身不
  // 触发渲染，UI 要禁用「停止」按钮就得靠这个 state。
  const requestAbort = useCallback((sid: string): Promise<void> => {
    if (abortInFlightRef.current) return abortInFlightRef.current;
    setAborting(true);
    const p = abortAgentSession(sid).finally(() => {
      abortInFlightRef.current = null;
      setAborting(false);
    });
    abortInFlightRef.current = p;
    return p;
  }, []);

  // 建号核心：createAgentSession → 落地 → 种子余额 → 开连线。不管理
  // startedRef / startPipelineRef——start() 与 startNewSession() 的串行化外壳
  // 都从这里过；核心若自己去查管线，会 await 到调用方正在飞的那条，死锁。
  const runStartCore = useCallback(async (): Promise<boolean> => {
    try {
      const session = await createAgentSession();
      if (!mountedRef.current) return false;
      sessionIdRef.current = session.session_id;
      freshSessionIdRef.current = session.session_id;
      setSessionId(session.session_id);
      sessionEpochRef.current += 1; // 新会话建立：任何还在飞行、捕获了旧 epoch 的 send() 都该放弃。
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
      return true;
    } catch (err) {
      if (!mountedRef.current) return false;
      const message = err instanceof Error ? err.message : "无法开始 Agent 会话。";
      setError(message);
      if (isTerminalAuthError(err)) {
        closedRef.current = true;
        setConnection("closed");
      } else {
        startedRef.current = false; // 让 retry 能从头再试
      }
      return false;
    }
  }, [dispatch, openConnection]);

  const start = useCallback(async (): Promise<void> => {
    if (closedRef.current || startedRef.current) return;
    // D-17：有未过期的存档，且不是「刚点了开新会话」——先不自动建号，
    // 把决定权留给 UI（继续上次 / 结束开新）。autoStart 走这里时自动停住。
    const existing = loadPersisted();
    if (existing && !forceNewRef.current) return;
    forceNewRef.current = false;
    startedRef.current = true;
    // 物種 F 双建号竞态：已有建号管线在飞就搭车共用那次建号，不发第二条
    // POST。StrictMode dev 双挂载把 autoStart effect 跑两遍，第二条 POST 的
    // 会话被后落的落地序列顶掉，留下零事件孤儿（11-75ms 成对 session row）。
    if (startPipelineRef.current) {
      await startPipelineRef.current;
      return;
    }
    const pipeline = runStartCore();
    startPipelineRef.current = pipeline;
    try {
      await pipeline;
    } finally {
      if (startPipelineRef.current === pipeline) startPipelineRef.current = null;
    }
  }, [runStartCore]);

  const send = useCallback(
    async (text: string, opts?: { sessionDirective?: string; silent?: boolean }): Promise<void> => {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) return;
      if (closedRef.current) return;

      // sessionId 判空必须在乐观插入之前：否则没有会话时使用者的话已经被
      // 回声进 transcript，随后又弹一条「无法发送」的 notice——留下一句
      // 永久的「幽灵」用户发言，且没有任何办法标记它其实从未送达。
      const sid = sessionIdRef.current;
      if (!sid) {
        dispatchNotice("error", "尚未建立会话，无法发送消息。");
        return;
      }
      // 记录发送时刻：殭屍自愈要区分「turn.done 之后用户又发了新消息」——
      // 那之后的内容帧属于新回合，不算还魂证据。
      lastSendAtRef.current = Date.now();
      // 新回合開始：解除用戶中止靜默窗（abort() 置位）。
      mutedUntilNextSendRef.current = false;
      // 捕获当前操作代：switchSession/startNewSession/resume/start 建立新会话
      // 时会递增它。下面 await 完 steer-abort/sendAgentMessage 前重新核对，
      // 若已经变了说明使用者在等待期间切换了会话，不能把消息送去旧会话。
      const epoch = sessionEpochRef.current;
      // 這個會話開始承載內容：不再是「新鮮會話」，模板之後再套須真正開新。
      if (freshSessionIdRef.current === sid) freshSessionIdRef.current = null;

      // 乐观插入使用者消息。directive 是隐形上下文，只随请求上送，绝不进 transcript；
      // silent=true（模板注入）同样不进 transcript——用户只看到 agent 的引导，看不到被注入的 prompt。
      if (!opts?.silent) {
        dispatch({ type: "user", text: trimmed });
      }

      // 罪状 3：回合进行中再发消息，opencode 会把它排队静默吞掉——用户以为已
      // 送达，实际要等本轮跑完才被处理，画面上没有任何提示。按用户设定显式化：
      // steer（默认）先打断本轮再发送；queue 照发并说明「本轮结束后处理」。
      // interrupt_mode 从 localStorage 缓存即时读（设定弹层写入），不发网络请求
      // 阻塞发送；abort 失败不阻塞发送——打断了也要把话送到，只把实情说清楚。
      if (stateRef.current.turnActive) {
        const mode = readCachedAgentSettings().interrupt_mode;
        if (mode === "steer") {
          try {
            await requestAbort(sid);
            dispatchNotice("info", "已打断上一轮，正在按新指示执行");
          } catch {
            dispatchNotice("error", "上一轮未能打断，新消息已排队");
          }
        } else {
          dispatchNotice("info", "已加入队列，本轮结束后自动处理");
        }
      }

      // 会话代校验：上面的 await（steer-abort）期间若使用者切了会话/开了新
      // 会话，sid 已经是死会话，不能再把消息送过去——放弃发送并说清楚。
      if (sessionEpochRef.current !== epoch) {
        dispatchNotice("error", "会话已切换，消息未发送，请重新发送。");
        return;
      }

      try {
        await sendAgentMessage(sid, trimmed, {
          canvasState: canvasStateProviderRef.current?.(),
          ...(opts?.sessionDirective ? { sessionDirective: opts.sessionDirective } : {}),
        });
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "消息传送失败，请重试。");
      }
    },
    [dispatchNotice, requestAbort],
  );

  const confirm = useCallback(
    async (requestId: string, approved: boolean): Promise<boolean> => {
      if (closedRef.current) return false;
      const sid = sessionIdRef.current;
      if (!sid) return false;
      try {
        await resolveAgentConfirm(sid, requestId, approved);
        // 裁决结果由网关以 confirm.resolved 事件送回，reducer 会收起卡片并留痕。
        return true;
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "回复确认失败，请重试。");
        return false;
      }
    },
    [dispatchNotice],
  );

  const answerQuestion = useCallback(
    async (requestId: string, answers: string[][]): Promise<boolean> => {
      if (closedRef.current) return false;
      const sid = sessionIdRef.current;
      if (!sid) return false;
      try {
        await replyAgentQuestion(sid, requestId, answers);
        return true;
      } catch (err) {
        dispatchNotice("error", err instanceof Error ? err.message : "回复问题失败，请重试。");
        return false;
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
      await requestAbort(sid);
      // 靜默窗開啟：server 端 abort 落地後，opencode 的殘響幀（遲到
      // delta/前綴補發）不再渲染，直到下一次 send()。
      mutedUntilNextSendRef.current = true;
    } catch (err) {
      dispatchNotice("error", err instanceof Error ? err.message : "中止失败，请重试。");
    }
  }, [dispatchNotice, requestAbort]);

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
      sessionEpochRef.current += 1; // 续接成功=建立新的活跃会话身份，飞行中的旧 send() 该放弃。
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
      // 老会话补注账户记忆：建号时记忆可能还是空的（或当时没这功能）。
      void patchAgentSessionMemory(sid);
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
      if (isTerminalAuthError(err)) {
        closedRef.current = true;
        setConnection("closed");
        setError(err instanceof Error ? err.message : "登录已失效，请重新登录。");
        return;
      }
      // 其它错（网络 / 网关 5xx）：不做回收判定，保留存档，让 UI 还能再试。
      setError(err instanceof Error ? err.message : "恢复上次对话失败，请重试。");
    }
  }, [dispatch, dispatchNotice, openConnection, start]);

  /**
   * 切换到指定的历史会话（对话历史 dropdown 的「回到某个会话」）。
   *
   * 与 resume() 的差别：目标会话由参数指定而不是 localStorage 存档。
   * transcript 处理：若存档恰好就是这个会话则原样 restore；否则从空白
   * transcript 开始——agent 端（网关 + opencode）的完整上下文仍在，
   * 后续对话不会失忆，只是本地不再回放旧消息。
   */
  const switchSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      if (closedRef.current || !targetSessionId) return false;
      // 断掉当前流：switch 语义就是换轨，旧流的尾部事件不该再进来。
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      // 换轨前也要清掉可能已排定的重连计时器：上一条连线的 onerror 若恰好
      // 在使用者点切换的前一拍排了 scheduleReconnect，这个陈旧计时器之后
      // 触发时会读到 sessionIdRef.current（此时已经指向新会话）去重新开线，
      // 与本函数自己稍后调用的 openConnection 打架，产生重复 EventSource。
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      backoffRef.current = INITIAL_BACKOFF_MS;
      // 复用 connectSeqRef 当调用序号，挡连续调用竞态：两次快速切换（例如
      // 双击历史 dropdown 里两个不同会话）各自铸的票不管哪个先回来都可能
      // 赢——这里把「谁最后调用」定义为「谁的 seq 最大」，较早调用的票回来
      // 时序号已落后（被后一次调用或其 openConnection 推进），直接丢弃，
      // 不让它覆盖后一次调用已经写好的 sessionIdRef / state。
      const seq = ++connectSeqRef.current;
      try {
        const ticket = await requestSseTicket(targetSessionId);
        if (seq !== connectSeqRef.current || !mountedRef.current) return false;
        sessionIdRef.current = targetSessionId;
        setSessionId(targetSessionId);
        sessionEpochRef.current += 1; // 换轨=新的活跃会话身份，飞行中捕获旧 epoch 的 send() 该放弃。
        sessionTouchedInThisVisit = true;
        // 存档属于目标会话：原样回放；属于别的会话：保留它但重置画面。
        const saved = persistedRef.current;
        if (saved && saved.sessionId === targetSessionId) {
          dispatch({ type: 'restore', items: saved.items, lastEventId: saved.lastEventId });
          await openConnection(saved.lastEventId, ticket);
        } else {
          dispatch({ type: 'reset' });
          await openConnection(0, ticket);
        }
        void patchAgentSessionMemory(targetSessionId);
        return true;
      } catch (err) {
        // 序号已落后：这次调用已被后续调用取代，静默丢弃，不覆盖后者的结果/错误提示。
        if (seq !== connectSeqRef.current) return false;
        if (isSessionReclaimed(err)) {
          dispatchNotice('info', '该会话已被回收，无法恢复。');
        } else {
          setError(err instanceof Error ? err.message : '切换会话失败，请重试。');
        }
        return false;
      }
    },
    [dispatch, dispatchNotice, openConnection],
  );

  /**
   * 開新對話：建一個全新會話並切過去。舊會話不刪——它留在網關的對話歷史
   * 裡，隨時可以從 dropdown 切回（switchSession）。與 discardAndStartNew
   * 的差別：那個是「刪舊開新」（會話持久化前清理用），這個是「留舊開新」。
   */
  const startNewSession = useCallback(async (): Promise<boolean> => {
    if (closedRef.current) return false;
    // 競態治本：已有管線在飛行（mount autoStart 等）→ 不併發建第二個 session。
    // 等它落地：若它是剛建的新鮮會話就直接復用；否則在它落地後正常開新。
    if (startPipelineRef.current) {
      const ok = await startPipelineRef.current;
      if (closedRef.current) return false;
      if (ok && freshSessionIdRef.current && freshSessionIdRef.current === sessionIdRef.current) {
        return true; // 復用在途管線剛建出的新鮮會話
      }
    }
    // 串行化：同一時刻只放一條建號管線。
    if (startPipelineRef.current) return startPipelineRef.current;
    const pipeline = (async (): Promise<boolean> => {
    // 換軌前斷舊流：新會話的事件不該混進舊連線的尾部。
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    // 同 switchSession：清掉可能已排定的重连计时器，避免旧连线的 onerror
    // 排的 scheduleReconnect 之后拿新 sessionIdRef 去重开一条多余的连线。
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    backoffRef.current = INITIAL_BACKOFF_MS;
    dispatch({ type: "reset" });
    // 本地指向清空；舊存檔保留在 localStorage 但不再指向（retry 之後再走
    // start() 時由 forceNew 放行存檔檢查，新會話的首個事件後存檔自動改寫）。
    sessionIdRef.current = null;
    freshSessionIdRef.current = null;
    setSessionId(null);
    sessionEpochRef.current += 1; // 旧会话身份作废：飞行中捕获旧 epoch 的 send() 该放弃。
    setResumable(null);
    persistedRef.current = null;
    forceNewRef.current = true;
    startedRef.current = true;
    // 直接走建号核心：本函数自己就是串行化管线，若再经 start() 查
    // startPipelineRef 会 await 到自己这条管线，死锁。
    await runStartCore();
    return sessionIdRef.current !== null;
    })();
    startPipelineRef.current = pipeline;
    try {
      return await pipeline;
    } finally {
      if (startPipelineRef.current === pipeline) startPipelineRef.current = null;
    }
  }, [runStartCore]);

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
    switchSession,
    startNewSession,
    abort,
    aborting,
    discardAndStartNew,
  };
}
