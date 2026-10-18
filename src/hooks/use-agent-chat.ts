// Agent 聊天的 React 生命周期 hook：自己管 EventSource 的开、断、重连。
//
// 为什么不靠 native EventSource 自动重连：网关的 SSE ticket 10 分钟就过期，
// native 重连会拿死票无限重试。这里在 onerror 时关掉 EventSource，重新 mint
// 一张票、带 last_event_id 续传游标重开，配上指数退避（~1s 起、30s 封顶、加 jitter）。
//
// 停止重连的条件只有两个：state.closed（session.closed / 使用者 end()）与
// not_authenticated（登入失效）。除此之外断线就是重连，不往上抛。

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getStoredUser } from "@/lib/new-api-client";
import {
  AGENT_EVENT_NAMES,
  AGENT_STEER_QUEUE_TTL_MS,
  EMPTY_AGENT_CHAT_STATE,
  parseAgentSseEvent,
  type AgentAttachmentRef,
  type AgentChatState,
  type AgentEventName,
  type AgentNoticeItem,
  type AgentQuotaState,
  type AgentSseEvent,
  type AgentSteerStatus,
} from "@/lib/agent-chat-types";
import {
  agentChatReducer,
  appendUserTurn,
  applyQuotaSnapshot,
  applySteerRejection,
  applySteerStatus,
  expireQueuedSteers,
  markQueuedSteersAborted,
  resumeZombieTurn,
} from "@/lib/agent-chat-reducer";
import {
  AgentChatError,
  buildEventsUrl,
  createAgentSession,
  createDirectSendCapability,
  deleteAgentSession,
  fetchAgentQuota,
  fetchAgentSessionMessages,
  listAgentSessions,
  requestSseTicket,
  patchAgentSessionMemory,
  resolveAgentConfirm,
  replyAgentQuestion,
  sendAgentMessage,
  steerAgentSession,
  abortAgentSession,
  readCachedAgentSettings,
  isSteerUnavailableError,
  isSteerReplayRejected,
  steerReplayStatus,
  isTerminalAuthError,
  type DirectSendCapability,
} from "@/lib/agent-chat-client";
import { normalizeOpenCodeMessages } from "@/lib/agent-chat-history-normalize";
import { createFrameBatcher, type FrameBatcher } from "@/lib/agent-chat-frame-batch";
import {
  clearPersisted,
  loadPersisted,
  loadLegacyPersisted,
  savePersisted,
  type PersistedAgentChat,
} from "@/lib/agent-chat-persistence";
import type { AgentTranscriptItem } from "@/lib/agent-chat-types";

// ─────────────────────────── 常数

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** 运行时 transcript 硬上限。超出丢最旧。持久化截断仍由 persistence 自己的上限负责。 */
const MAX_RUNTIME_CHAT_ITEMS = 200;

/** 存档节流：transcript 变化后至少隔 1s 才写一次 localStorage，避免每次 SSE 帧都写。 */
const SAVE_THROTTLE_MS = 1_000;

/**
 * REQ-D2：steer id（本端生成）。值域与网关 steer-core.isValidSteerId 逐字对齐
 * （[A-Za-z0-9._-]{1,64}）——乐观插入的条目要立刻有 id 可以挂状态帧，
 * 等网关回号那一轮往返会让徽章闪一下空白。
 */
let steerSeq = 0;
function newSteerId(): string {
  steerSeq += 1;
  return `steer-${Date.now().toString(36)}-${steerSeq.toString(36)}`;
}

/**
 * 僵尸还魂自愈的防抖窗口：turn.done 之后这个时间内到的内容帧当同 tick 毛刺，
 * 不触发自愈（watchdog 发完 turn.done 紧跟的补发帧不属于「还魂」证据）。
 */
const ZOMBIE_HEAL_GAP_MS = 800;

// ─────────────────────────── 本 hook 专用的非 SSE action
// agentChatReducer 只吃 AgentSseEvent；乐观插入使用者消息、GET /quota 种子
// 余额、本端错误 notice 这三种「不是网关事件」的状态变更，在这里包成
// 额外 action，委派给对应的纯 helper。

type AgentChatAction =
  | AgentSseEvent
  | { type: "user"; text: string; attachments?: AgentAttachmentRef[]; steer?: { id: string; status: AgentSteerStatus; position?: number } }
  | { type: "quota"; quota: AgentQuotaState }
  | { type: "notice"; tone: "info" | "error"; text: string }
  // D-8/D-17：恢复上次会话时，把存档灌回 state（还原 items + 续传游标）。
  // savedAt = 存档写入时刻：存档里的「排队中」steer 徽章以它为兜底锚点判逾时（D2-3）。
  | { type: "restore"; items: AgentTranscriptItem[]; lastEventId: number; savedAt?: number }
  // D-17：会话被回收 / 使用者选「开新会话」时，把 transcript 清空重来。
  | { type: "reset" }
  // REQ-D2：steer 状态落地（本地 ack 与 SSE 帧共用同一个纯 helper）与「停止优先」
  // 的本地改判（用户按停止 → 排队中的 steer 全数改判中止）。
  | { type: "steer-ack"; steerId: string; status: AgentSteerStatus; position?: number; queuedAt?: number }
  // D2b：重放被拒（同一 steer_id 第二次投递）——把 catch 里落的「未能送达」占位
  // 纠正成网关带回来的真实状态（见 reducer.applySteerRejection）。
  | { type: "steer-rejection"; steerId: string; status: AgentSteerStatus }
  | { type: "steer-abort-queued" }
  // REQ-D2（D2-3）：排队逾时清扫——「排队中」超过 AGENT_STEER_QUEUE_TTL_MS 还没收到
  // 任何终态帧（网关重启后必然如此）→ 翻 failed「未能送达」，不留永久「排队中」。
  | { type: "steer-expire"; now: number }
  // 僵尸还魂自愈：turn.done 宣告收尾后内容帧仍到达，把回合拉回流式中。
  // hook 侧判定时机（防抖/是否新发送），落地交给纯 helper，与上面同范式。
  | { type: "zombie-resurrect" };

function capRuntimeChatItems(state: AgentChatState): AgentChatState {
  if (state.items.length <= MAX_RUNTIME_CHAT_ITEMS) return state;
  return { ...state, items: state.items.slice(-MAX_RUNTIME_CHAT_ITEMS) };
}

function chatReducer(state: AgentChatState, action: AgentChatAction): AgentChatState {
  return capRuntimeChatItems(reduceAgentChat(state, action));
}

function reduceAgentChat(state: AgentChatState, action: AgentChatAction): AgentChatState {
  // 网关事件都有 name，本端合成 action 用 type —— 用 in 判别，两边互不干扰。
  if ("name" in action) {
    return agentChatReducer(state, action);
  }
  switch (action.type) {
    case "user":
      return appendUserTurn(state, action.text, action.attachments, action.steer);
    case "steer-ack":
      return applySteerStatus(state, action.steerId, action.status, action.position, action.queuedAt);
    case "steer-rejection":
      return applySteerRejection(state, action.steerId, action.status);
    case "steer-abort-queued":
      return markQueuedSteersAborted(state);
    case "steer-expire":
      return expireQueuedSteers(state, { now: action.now, ttlMs: AGENT_STEER_QUEUE_TTL_MS });
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
      const restored: AgentChatState = {
        ...EMPTY_AGENT_CHAT_STATE,
        items: action.items.map((item) => ({ ...item })),
        lastEventId: action.lastEventId,
      };
      // D2-3：存档里的「排队中」徽章不能原样复活（网关的 pendingSteers 是 volatile，
      // 重启即消失且不再补终态帧）。以存档时刻为兜底锚点扫一趟，逾时的一律落
      // 「未能送达」；仍在时窗内的记下锚点，由下面排定的清扫定时器兜底。
      return expireQueuedSteers(restored, {
        now: Date.now(),
        ttlMs: AGENT_STEER_QUEUE_TTL_MS,
        ...(typeof action.savedAt === "number" ? { baselineAt: action.savedAt } : {}),
      });
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
  /** 画布 SSE 事件分流（v3 embed）：canvas.* 事件转交右侧 CanvasEmbed。 */
  onCanvasEvent?: (event: AgentSseEvent) => void;
  /** 发送前提供画布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
  /**
   * 这句话因为「没登入」送不出去时，把原文交给呼叫端留住（登入完成后补送）。
   *
   * 为什么 hook 要主动回报而不是让 composer 自己接错误：这条失败**不会 reject**。
   * `send()` 的 lazy 建号走 `start()`，而 `start()` 内部（runStartCore）自己
   * catch 掉 `not_authenticated` 并只做 setError/关闭连线，然后返回 false；
   * send() 接著走 `!sid` 分支回一句 notice 就 return —— promise 是 resolved。
   * composer 那条「onSend 同步 throw＝没送出去，不清输入框」的守卫因此永远到不了
   * （onSend 是 async 函式，同步 throw 根本不存在）。唯一知道真相的地方是这里。
   *
   * 只回报 auth 这一种：网路抖动/上游故障时把话留在 pending 格，会在使用者之后
   * 某次无关的登入突然替他送出去，那不是他要的（见 agent-session-guard 的
   * 「没送凭证」与「凭证被上游拒绝」之分）。
   */
  onSendBlockedByAuth?: (text: string) => void;
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
  /**
   * true = 空态首发正在 lazy 建号（建号 + 铸 SSE 票两段跨境往返）。
   * 这段真空期 UI 本来零变化，消费者据此渲染「正在建立对话」忙碌态 ——
   * 不能用合成 turn.status 代替：那会让 turnActive 提前为真，制造假回合。
   */
  startingSession: boolean;
  // D-17：上次会话存档。非空时 Surface 把存档收进「对话历史」并清空回空态
  //（09-12：建号权收归发送按钮，挂载不再自动开场，存档不再驱动任何自动建号）。
  resumable: ResumableAgentChat | null;
  resume: () => Promise<void>;
  /** 切换到指定的历史会话（对话历史 dropdown）。 */
  switchSession: (targetSessionId: string) => Promise<boolean>;
  /** 开新对话：旧会话保留在历史里可切回（不删除）。 */
  startNewSession: () => Promise<boolean>;
  /** 使用者明确动作（如点附件上传）时的 lazy 建号：回传当前 sid；建号失败回 null。
   *  与 send() 的 lazy 建号同源，复用 start() 串行化管线（在飞搭车，不并发第二条 POST）。 */
  ensureSession: () => Promise<string | null>;
  discardAndStartNew: () => Promise<void>;
  /**
   * 直接往 transcript 发一条系统通知（tone=info/error）。
   * 给旁路回馈用：RerunDialog 完成讯息这类「不在对话流里、但要留痕」的结果。
   */
  dispatchNotice: (tone: "info" | "error", text: string) => void;
}

export function useAgentChat(options?: UseAgentChatOptions): UseAgentChatReturn {
  const { onCanvasEvent, canvasStateProvider, onSendBlockedByAuth } = options ?? {};
  const { user, isLoading: authLoading } = useAuth();
  const ownerId = user?.id ?? null;
  const ownerIdRef = useRef<number | null>(ownerId);
  const accountEpochRef = useRef(0);
  const renderedOwnerIdRef = useRef(ownerId);
  renderedOwnerIdRef.current = ownerId;
  const currentAccountRef = useRef<() => boolean>(() => true);
  currentAccountRef.current = () => {
    if (ownerIdRef.current !== renderedOwnerIdRef.current) return false;
    if (ownerIdRef.current === 0) return true; // 显式本地测试账号不写登录凭证。
    try { return (getStoredUser()?.id ?? null) === ownerIdRef.current; } catch { return false; }
  };

  const [state, dispatch] = useReducer(chatReducer, EMPTY_AGENT_CHAT_STATE);
  const [connection, setConnection] = useState<UseAgentChatReturn["connection"]>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumable, setResumable] = useState<ResumableAgentChat | null>(null);
  // 供 UI 判断「停止」按钮是否该禁用——ref 本身不触发渲染，需要这份 state 镜像。
  const [aborting, setAborting] = useState(false);
  // 空态首发 lazy 建号的真空期旗标（见 UseAgentChatReturn.startingSession）。
  const [startingSession, setStartingSession] = useState(false);

  // ── refs：给稳定的 callback 阅最新值，避免闭包抓到旧 state。
  const stateRef = useRef(state);
  const stateAccountEpochRef = useRef(accountEpochRef.current);
  const sessionIdRef = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const connectSeqRef = useRef(0);
  // SSE 帧并批器（A3）：串流期每个 delta 一次 dispatch = 每个 token 一次整棵
  // 面板重渲染，按钮 onClick 要排在这些渲染后面。并批器只把「纯文字追加」帧
  // 折进同一个渲染窗口，其余帧语义不变。每个连线世代重建一个（见 openConnection）。
  const frameBatcherRef = useRef<FrameBatcher | null>(null);
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
  // 09-12：终结来源。'session'=网关 session.closed（含 idle 回收），属「该会话终局」，
  // 切历史会话/开新/续档＝开启新生命，入口据此解锁；'auth'=登入失效、'manual'=本端 end()，
  // 两者保持封锁。null=从未终结。closedRef 单独存在无法分辨来源，故补此旗。
  const closedReasonRef = useRef<'session' | 'auth' | 'manual' | null>(null);
  const startedRef = useRef(false);
  // 09-01 竞态治本：同时只允许一条建号管线在飞行。09-12 建号权收归发送按钮后，
  // 并发来源变成空态下同时触发的两条 send()（手滑双击、模板注入撞手动发送等）：
  // 第二条搭在飞管线的车，不发第二条 POST——否则两条链各自 setSessionId 相继落地，
  // 后落的顶掉先落的，DB 留下 11-75ms 成对的零事件孤儿（物种 F 实锤），且第二
  // 条 transition 触发 use-canvas-chat 的 newCanvasSession() 把模板刚铺好的节点清掉。
  const startPipelineRef = useRef<Promise<boolean> | null>(null);
  // 僵尸还魂自愈（物种 A）的计时锚点：最近一次 turn.done（回合被宣告死亡的
  // 时刻）与最近一次用户发送。内容帧在「回合已收尾 + 其间没有新发送 +
  // 距 turn.done > ZOMBIE_HEAL_GAP_MS」时到达＝误判后的僵尸输出，恢复流式态。
  const lastTurnDoneAtRef = useRef<number | null>(null);
  const lastSendAtRef = useRef(0);
  // 用户主动中止的静默窗：abort() 成功到下一次 send() 之间，上游仍会漏进
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
  // REQ-D2（D2-3）：排队逾时清扫定时器。「排队中」的 steer 等不到终态帧时（网关
  // 重启后 pendingSteers 消失、重连回放也补不回那张帧）由它把徽章翻成「未能送达」
  // ——绝不允许永久「排队中」。每次新的排队事件重排（后到的锚点更晚，覆盖前面即可）。
  const steerExpiryTimerRef = useRef<number | null>(null);
  // 09-12 直连发送腿：现任连线票（绑 sid 防跨会话误用）。null = 铸票在飞/
  // 失败/尚未开连线 → send 走中继（与旧行为等价）。生命周期与 openConnection
  // 一致：每次开新连线先清空、票到手才落位；switchSession/resume/reconnect
  // 全部途经 openConnection，无旁路。
  const activeTicketRef = useRef<{ sessionId: string; ticket: Awaited<ReturnType<typeof requestSseTicket>> } | null>(
    null,
  );
  // 票代能力闩锁（401/连续网路失手 → 本代停止直连探测）。重新铸票＝新世代，
  // 随 openConnection 重置——网关补丁上线后不需发版即自动升级回直连。
  const directCapRef = useRef<DirectSendCapability>(createDirectSendCapability());

  useEffect(() => {
    stateRef.current = state;
    stateAccountEpochRef.current = accountEpochRef.current;
  }, [state]);

  useEffect(() => {
    onCanvasEventRef.current = onCanvasEvent;
    canvasStateProviderRef.current = canvasStateProvider;
  }, [onCanvasEvent, canvasStateProvider]);

  // 账号切换作废全部旧请求/连接；缓存归属由服务端目录核实，本地只作加速。
  useEffect(() => {
    ownerIdRef.current = ownerId;
    accountEpochRef.current += 1;
    sessionEpochRef.current += 1;
    connectSeqRef.current += 1;
    esRef.current?.close();
    esRef.current = null;
    frameBatcherRef.current?.drop();
    for (const timer of [retryTimerRef, saveTimerRef, steerExpiryTimerRef]) {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    }
    sessionIdRef.current = null;
    persistedRef.current = null;
    activeTicketRef.current = null;
    startPipelineRef.current = null;
    abortInFlightRef.current = null;
    startedRef.current = false;
    closedRef.current = false;
    closedReasonRef.current = null;
    mutedUntilNextSendRef.current = false;
    forceNewRef.current = false;
    setSessionId(null);
    setResumable(null);
    setError(null);
    setAborting(false);
    setStartingSession(false);
    setConnection("idle");
    dispatch({ type: "reset" });
    if (authLoading || ownerId === null) return;
    let cancelled = false;
    const epoch = sessionEpochRef.current;
    const cached = loadPersisted(Date.now(), ownerId) ?? loadLegacyPersisted();
    void listAgentSessions().then((sessions) => {
      if (cancelled || ownerIdRef.current !== ownerId || sessionEpochRef.current !== epoch) return;
      if (cached && sessions.some((it) => it.session_id === cached.sessionId)) {
        persistedRef.current = cached;
        savePersisted(cached, ownerId);
        setResumable({ sessionId: cached.sessionId, itemCount: cached.items.length, savedAt: cached.savedAt });
      }
    }).catch(() => { /* 网络失败不展示未经归属核实的旧客户端缓存。 */ });
    return () => { cancelled = true; };
  }, [ownerId, authLoading]);

  // D-18：transcript 变化时节流写入存档（>=1s）；会话终结时清存档。
  // 不依赖 state 本身（省得每帧都写），靠 ref 保证取到最新 items。
  useEffect(() => {
    const sid = sessionIdRef.current;
    const s = stateRef.current;
    if (!sid || !s || stateAccountEpochRef.current !== accountEpochRef.current) return;

    // 会话已终结（双方任一关）：存档没意义了，直接清掉。
    if (s.closed) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      clearPersisted(ownerIdRef.current);
      persistedRef.current = null;
      setResumable(null);
      return;
    }

    const doSave = () => {
      const owner = ownerIdRef.current;
      if (owner === null || owner !== ownerId || sid !== sessionIdRef.current) return;
      savePersisted({
        sessionId: sid,
        lastEventId: s.lastEventId,
        savedAt: Date.now(),
        items: s.items,
      }, owner);
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
    if (!state.closed || stateAccountEpochRef.current !== accountEpochRef.current) return;
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
    clearPersisted(ownerIdRef.current);
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
    // dev StrictMode / 热重载会对同一 hook 实例按 setup→cleanup→setup 跑两遍：
    // 幽灵 cleanup 在下面写下的「终结旗标」（closed/started）若不在第二遍
    // setup 复位，之后的 start()/startNewSession() 会整体哑火 —— 会话建号
    // 成功却永远落不了地。正式卸载时这三行不会再执行，语义不受影响。
    closedRef.current = false;
    closedReasonRef.current = null;
    startedRef.current = false;
    return () => {
      mountedRef.current = false;
      closedRef.current = true;
      closedReasonRef.current = 'manual';
      // 卸载＝这条生命彻底结束：并批器的缓冲与计时器一并清掉，不给已卸载的
      // 组件留任何迟到的 setState（React 会警告，且渲染结果无人消费）。
      frameBatcherRef.current?.drop();
      frameBatcherRef.current = null;
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

  /**
   * REQ-D2（D2-3）：排定「排队中」徽章的清扫时刻——到时仍停在 queued 的一律翻
   * 「未能送达（未生效）」。为什么前端自己排：网关的 pendingSteers 是 volatile，
   * 重启后它连 steer_id 都不记得，永远不会补终态帧；等待这张永远不会来的帧＝
   * 永久假「排队中」。delayMs 由调用方给（新入队＝TTL；存档恢复＝剩余时窗）。
   */
  const armSteerExpiry = useCallback(
    (delayMs: number) => {
      if (steerExpiryTimerRef.current !== null) window.clearTimeout(steerExpiryTimerRef.current);
      steerExpiryTimerRef.current = window.setTimeout(() => {
        steerExpiryTimerRef.current = null;
        if (!mountedRef.current) return;
        dispatch({ type: "steer-expire", now: Date.now() });
      }, Math.max(1000, delayMs));
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

  // abort() 与 send() 内部的 steer-abort 唯一入口：同一时刻只允许一个 abort
  // 网络请求在飞行，第二个调用者（无论来自哪个入口）复用同一个 in-flight
  // promise，不再多发一次。aborting 是给 UI 用的 state 镜像——ref 本身不
  // 触发渲染，UI 要禁用「停止」按钮就得靠这个 state。
  const requestAbort = useCallback((sid: string): Promise<void> => {
    if (abortInFlightRef.current) return abortInFlightRef.current;
    const accountEpoch = accountEpochRef.current;
    setAborting(true);
    const p = abortAgentSession(sid).finally(() => {
      if (accountEpochRef.current !== accountEpoch || abortInFlightRef.current !== p) return;
      abortInFlightRef.current = null;
      setAborting(false);
    });
    abortInFlightRef.current = p;
    return p;
  }, []);

  // 建号核心：createAgentSession → 落地 → 种子余额 → 开连线。不管理
  // startedRef / startPipelineRef——start() 的串行化外壳从这里过；核心若自己
  // 去查管线，会 await 到调用方正在飞的那条，死锁。
  const runStartCore = useCallback(async (): Promise<boolean> => {
    const owner = ownerIdRef.current;
    const accountEpoch = accountEpochRef.current;
    const epoch = sessionEpochRef.current;
    if (owner === null) return false;
    try {
      const session = await createAgentSession();
      if (!mountedRef.current || accountEpochRef.current !== accountEpoch || ownerIdRef.current !== owner || sessionEpochRef.current !== epoch) return false;
      sessionIdRef.current = session.session_id;
      setSessionId(session.session_id);
      sessionEpochRef.current += 1; // 新会话建立：任何还在飞行、捕获了旧 epoch 的 send() 都该放弃。
      // 本次访问已经有过会话：之后 toggle 关掉再打开就静默续上，不再问。
      sessionTouchedInThisVisit = true;

      // 种子余额：quota.changed 只在变化时才发，开场得主动抓一次。
      // 改为背景任务：不挡 SSE 连线建立（quota.changed 本来就会推送增量，
      // 这里只是开场快照，晚几百毫秒到无感知）。
      void fetchAgentQuota()
        .then((quota) => {
          if (mountedRef.current && accountEpochRef.current === accountEpoch && ownerIdRef.current === owner) dispatch({ type: "quota", quota });
        })
        .catch(() => {
          // 种子是 best-effort，抓不到不阻挡开场。
        });

      await openConnection();
      if (!mountedRef.current || accountEpochRef.current !== accountEpoch || sessionIdRef.current !== session.session_id) return false;
      return true;
    } catch (err) {
      if (!mountedRef.current || accountEpochRef.current !== accountEpoch || ownerIdRef.current !== owner) return false;
      const message = err instanceof Error ? err.message : "无法开始 Agent 会话。";
      setError(message);
      if (isTerminalAuthError(err)) {
        closedRef.current = true;
        closedReasonRef.current = 'auth';
        setConnection("closed");
      } else {
        startedRef.current = false; // 让 retry 能从头再试
      }
      return false;
    }
  }, [dispatch, openConnection]);

  const start = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    const accountEpoch = accountEpochRef.current;
    if (closedRef.current) return;
    if (startedRef.current) {
      // 空态并发再入（09-12 lazy 建号后两条 send() 同抢一个空态）：建号在飞
      // 就搭车等它落地再返回，第二条调用者不至于因 sid 尚空误报「无法发送」。
      if (startPipelineRef.current) await startPipelineRef.current;
      return;
    }
    // D-17：有未过期的存档，且不是「刚点了开新会话」——不建号，
    // 把决定权留给 UI（存档收进对话历史，空态由用户发消息驱动）。
    // send() 的 lazy 建号带 forceNew 放行：空态按发送＝明确要开新会话。
    const existing = loadPersisted(Date.now(), ownerIdRef.current);
    if (existing && !forceNewRef.current) return;
    forceNewRef.current = false;
    startedRef.current = true;
    // 物种 F 双建号竞态：已有建号管线在飞就搭车共用那次建号，不发第二条
    // POST。空态下并发触发的两条 send()（双击发送、注入撞手动发送）都会
    // 走到这里；第二条 POST 的会话被后落的落地序列顶掉，留下零事件孤儿
    // （11-75ms 成对 session row）。
    if (startPipelineRef.current) {
      await startPipelineRef.current;
      return;
    }
    const pipeline = runStartCore();
    startPipelineRef.current = pipeline;
    try {
      await pipeline;
    } finally {
      if (accountEpochRef.current === accountEpoch && startPipelineRef.current === pipeline) startPipelineRef.current = null;
    }
  }, [runStartCore]);

  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (!currentAccountRef.current()) return null;
    const accountEpoch = accountEpochRef.current;
    if (closedRef.current) return sessionIdRef.current;
    if (!sessionIdRef.current) {
      forceNewRef.current = true;
      await start();
    }
    return accountEpochRef.current === accountEpoch ? sessionIdRef.current : null;
  }, [start]);

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

  /**
   * D-17：继续上次会话。用存档里的 sessionId 铸票重开 SSE，带 last_event_id 续传；
   * 若铸票失败且是「会话已被回收」（4xx），清档退回开新会话。
   */
  const resume = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    const owner = ownerIdRef.current;
    const accountEpoch = accountEpochRef.current;
    const seq = ++connectSeqRef.current;
    if (owner === null) return;
    // 09-12：session.closed（网关 idle 回收）是「该会话终局」，续档＝开启新生命，入口解锁；
    // auth（登入失效）/manual（本端 end()）保持封锁。
    if (closedRef.current && closedReasonRef.current !== 'session') return;
    closedRef.current = false;
    closedReasonRef.current = null;
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
      const [ticket, history] = await Promise.all([
        requestSseTicket(sid),
        fetchAgentSessionMessages(sid).catch(() => null),
      ]);
      if (!mountedRef.current || accountEpochRef.current !== accountEpoch || ownerIdRef.current !== owner || seq !== connectSeqRef.current) return;
      const serverItems = history && history.fallback !== "replay_only"
        ? normalizeOpenCodeMessages(history.messages).items : [];
      const items = serverItems.length ? serverItems : saved.items;
      const cursor = serverItems.length && history ? history.event_counter : lastEventId;
      // 恢复上下文：sessionId + 存档（items/lastEventId）。
      sessionIdRef.current = sid;
      setSessionId(sid);
      sessionEpochRef.current += 1; // 续接成功=建立新的活跃会话身份，飞行中的旧 send() 该放弃。
      // 新身份＝新生命：旧连线的待渲染缓冲作废（续传游标会用存档 cursor 重放覆盖）。
      frameBatcherRef.current?.drop();
      // 09-12：新的会话身份解除「用户中止静默窗」——否则 abort 过一次后，
      // 续档回放的 message/reasoning 帧会被 L567 整批丢弃，重建出来一片空白。
      mutedUntilNextSendRef.current = false;
      sessionTouchedInThisVisit = true;
      dispatch({ type: "restore", items, lastEventId: cursor, savedAt: saved.savedAt });
      // D2-3：存档里若还有「排队中」的 steer 徽章（网关重启后它的 volatile 队列已经
      // 没了，永远不会再补终态帧），按同一个 TTL 排一趟清扫——到点仍停 queued 的翻
      // 「未能送达」，页面不留在永久「排队中」。锚点用存档时刻（restore 已按它扫过
      // 一轮，活下来的都在时窗内，最晚的截止点就是 savedAt + TTL）。
      armSteerExpiry(saved.savedAt + AGENT_STEER_QUEUE_TTL_MS - Date.now());
      try {
        const quota = await fetchAgentQuota();
        if (mountedRef.current && accountEpochRef.current === accountEpoch && ownerIdRef.current === owner) dispatch({ type: "quota", quota });
      } catch {
        // 种子是 best-effort。
      }
      // 用存档的 lastEventId 当续传游标开 SSE；即便 restore 的 dispatch
      // 还没反映进 stateRef，也从上一次结尾接着收。探针票直接复用，
      // 不再多 mint 一张，避免多余请求也避免「票已用完」竞态。
      if (accountEpochRef.current !== accountEpoch || ownerIdRef.current !== owner || seq !== connectSeqRef.current) return;
      await openConnection(cursor, ticket);
      if (!mountedRef.current || accountEpochRef.current !== accountEpoch || sessionIdRef.current !== sid) return;
      // 续接成功：不再显示「继续上次」提示（存档继续在 transcript 变化时更新）。
      setResumable(null);
      persistedRef.current = null;
      // 老会话补注账户记忆：建号时记忆可能还是空的（或当时没这功能）。
      void patchAgentSessionMemory(sid);
    } catch (err) {
      if (accountEpochRef.current !== accountEpoch || ownerIdRef.current !== owner || seq !== connectSeqRef.current) return;
      // 铸票的探针失败；4xx = 会话已被网关回收 → 清档、说清楚，停在空态。
      if (isSessionReclaimed(err)) {
        clearPersisted(ownerIdRef.current);
        persistedRef.current = null;
        setResumable(null);
        // 09-12 建号权收归发送按钮：过期不再自动建号（自动建＝用户可能根本
        // 不再发消息＝零消息孤儿）。清空回空态，下一条消息 send() lazy 建新会话。
        dispatchNotice("info", "上次对话已过期，发新消息即开始新对话。");
        return;
      }
      if (isTerminalAuthError(err)) {
        closedRef.current = true;
        closedReasonRef.current = 'auth';
        setConnection("closed");
        setError(err instanceof Error ? err.message : "登录已失效，请重新登录。");
        return;
      }
      // 其它错（网络 / 网关 5xx）：不做回收判定，保留存档，让 UI 还能再试。
      setError(err instanceof Error ? err.message : "恢复上次对话失败，请重试。");
    }
  }, [dispatch, dispatchNotice, armSteerExpiry, openConnection, start]);

  /**
   * 切换到指定的历史会话（对话历史 dropdown 的「回到某个会话」）。
   *
   * 与 resume() 的差别：目标会话由参数指定而不是 localStorage 存档。
   * transcript 处理：若存档恰好就是这个会话则原样 restore；否则从全量历史
   * 重建 transcript（agent 端网关 + opencode 的完整上下文始终在，后续对话
   * 不会失忆）。
   * 2026-09-12 并行化：铸票与全史拉取同时发射、历史先到先渲染，冷路径不再
   * 串行叠两段跨境 RTT；票失败时已渲染的历史留在画面＋错误提示（可接受取舍，
   * 见函数体内注）。
   */
  const switchSession = useCallback(
    async (targetSessionId: string): Promise<boolean> => {
      if (!currentAccountRef.current()) return false;
      const accountEpoch = accountEpochRef.current;
      if (!targetSessionId) return false;
      // 09-12 主刀：网关 idle 回收（session.closed）是「该会话终局」，不是「本端终结」。
      // 点历史会话＝切向另一条会话、开启新生命，须解锁让 openConnection 重连回放；
      // auth（登入失效）/manual（本端 end()）保持封锁——只有「会话终局」该解锁。
      if (closedRef.current && closedReasonRef.current !== 'session') return false;
      closedRef.current = false;
      closedReasonRef.current = null;
      // 断掉当前流：switch 语义就是换轨，旧流的尾部事件不该再进来。
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      // 换轨＝换生命：旧连线的待渲染缓冲属于上一轨，连同计时器一起作废
      //（丢弃不漏内容——未 apply 的帧没推进 lastEventId，续传会回放）。
      frameBatcherRef.current?.drop();
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
        // 2026-09-12 并行化：铸票与全史拉取同时发射——冷路径原本串行
        // RTT(铸票)+RTT(拉史)，跨境往返每个 ~500-600ms 叠加（前作教训见
        // agent-chat-ready-latency-campaign）。票只是提前发射，下面仍
        // `await ticketPromise` 取结果/抛错进本 catch，语义不变；额外挂的
        // no-op .catch 是防 early-return 路径（让位给更新切换）从不 await
        // 这张票时产生 unhandled rejection。
        const ticketPromise = requestSseTicket(targetSessionId);
        ticketPromise.catch(() => {});
        // 存档归属判定提前（本来就在下游，只是提前取值；切换期间无人改
        // persistedRef，逻辑不变）：目标会话有本机存档 → 不需要全史，
        // 直接省掉那个 RTT。
        const saved = persistedRef.current;
        // 2026-09-12 全量历史重建（判准不变，改为与票平行发射）：无存档
        // 时由 GET /api/agent/sessions/[id] 拉 opencode 全量历史重建
        // transcript，SSE 从 event_counter 起只接增量，不再依赖网关 1000
        // 帧 ring buffer 回放（长会话会被截断成空白）。契约：
        //   { messages, event_counter, replay_first_id, fallback?:"replay_only" }。
        // fetch 失败／normalize 契约漂移 → null＝降级讯号（等价旧 catch 降级，
        // 不往上抛错）。
        const historyPromise = fetchAgentSessionMessages(targetSessionId)
              .then((history) => {
                const { items } = normalizeOpenCodeMessages(history.messages);
                // 可用性判定——任一不满足即降级，宁可走旧路也不blank欺场：
                //   * 网关标 fallback:"replay_only" = 全量历史不可得；
                //   * 重建不出任何条目时若照样 restore+游标=event_counter，
                //     ≤counter 的回放帧会被 reducer 去重守卫全吞，画面彻底空白，
                //     语义劣于现行路径（空会话 counter=0 也落入此分支，降级后
                //     与现行 reset+openConnection(0) 完全等价）。
                if (history.fallback === "replay_only" || items.length === 0) return null;
                // 游标必取 event_counter：重建已涵盖 ≤counter 的全部内容，
                // SSE 只收其后的增量帧——取 0 会双渲（铁律）。
                return { items, cursor: history.event_counter };
              })
              .catch(() => null);
        // 历史先到先渲染：两段在路上谁先落地谁先见，用户更早看到旧讯息，
        // 不必等票。
        let restored: { items: AgentTranscriptItem[]; cursor: number } | null = null;
        if (historyPromise) {
          const history = await historyPromise;
          // fetch 在路上可能已有更新的切换在飞：序号落后就让位，不渲染错
          // 会话（未 await 的票由其 no-op catch 兜住，不会漏报）。
          if (seq !== connectSeqRef.current || !mountedRef.current) return false;
          if (history) {
            restored = history;
            dispatch({ type: "restore", items: restored.items, lastEventId: restored.cursor });
          }
        }
        const ticket = await ticketPromise;
        if (seq !== connectSeqRef.current || !mountedRef.current) return false;
        sessionIdRef.current = targetSessionId;
        setSessionId(targetSessionId);
        sessionEpochRef.current += 1; // 换轨=新的活跃会话身份，飞行中捕获旧 epoch 的 send() 该放弃。
        // 09-12：新身份解除中止静默窗，保证历史会话回放的 message/reasoning 帧不被丢。
        mutedUntilNextSendRef.current = false;
        sessionTouchedInThisVisit = true;
        if (!restored && saved && saved.sessionId === targetSessionId) {
          // 存档属于目标会话：原样回放＋用存档游标续传（原语义）。
          dispatch({ type: "restore", items: saved.items, lastEventId: saved.lastEventId });
          await openConnection(saved.lastEventId, ticket);
        } else if (restored) {
          // 历史已先到渲染，票落地即接增量，勿二次 restore（rebuild 已涵盖 ≤cursor）。
          // 取舍：若票失败走外层 catch，已渲染的历史 items 留在画面——用户看得到
          // 内容＋错误横幅/notice，而非旧版「空白＋错误」，判定可接受。
          await openConnection(restored.cursor, ticket);
        } else {
          // 历史不可得（fetch 失败／replay_only／空 items）：降级走现行路径；
          // reset 放在票成功＋身份切换之后（与现行顺序语义一致，序号守卫
          // 已在上方 await 票后把关）。
          dispatch({ type: "reset" });
          await openConnection(0, ticket);
        }
        if (!mountedRef.current || accountEpochRef.current !== accountEpoch || sessionIdRef.current !== targetSessionId) return false;
        void patchAgentSessionMemory(targetSessionId);
        return true;
      } catch (err) {
        // 序号已落后：这次调用已被后续调用取代，静默丢弃，不覆盖后者的结果/错误提示。
        if (seq !== connectSeqRef.current) return false;
        if (isSessionReclaimed(err)) {
          dispatchNotice('info', '该会话已被回收，无法恢复。');
        } else {
          const msg = err instanceof Error ? err.message : '切换会话失败，请重试。';
          // 除了写进 error（仅在非活跃时以横幅显示），再补一条 transcript notice：
          // 切换失败多发生在当前连线仍活跃时，横幅被 isActive 挡下，notice 才看得到。
          setError(msg);
          dispatchNotice('error', msg);
        }
        return false;
      }
    },
    [dispatch, dispatchNotice, openConnection],
  );

  /**
   * 开新对话＝回到空态（09-12 建号权收归发送按钮）。旧实现在这里立即建号；
   * 现在只做清空/断流/换身份，新会话由首条消息 send() lazy 建出。旧会话不删——
   * 它留在网关的对话历史里，随时可以从 dropdown 切回（switchSession）。与
   * discardAndStartNew 的差别：那个是「删旧开新」（会话持久化前清理用），
   * 这个是「留旧开新」。
   */
  const startNewSession = useCallback(async (): Promise<boolean> => {
    if (!currentAccountRef.current()) return false;
    const owner = ownerIdRef.current;
    const accountEpoch = accountEpochRef.current;
    // 09-12：开新会话＝新生命语义，session.closed 后入口解锁重建；auth/manual 仍封锁。
    if (closedRef.current && closedReasonRef.current !== 'session') return false;
    closedRef.current = false;
    closedReasonRef.current = null;
    // 竞态治本（09-01 血泪保留）：有建号管线在飞（发送按钮刚 lazy 建号）→
    // 等它结算再清。不等的话它在清空之后落地，等于空态被它击穿。
    if (startPipelineRef.current) {
      await startPipelineRef.current;
      if (closedRef.current || ownerIdRef.current !== owner || accountEpochRef.current !== accountEpoch) return false;
    }
    // 换轨前断旧流：新会话的事件不该混进旧连线的尾部。
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    // 换生命：旧连线的待渲染缓冲作废（同 switchSession 的理由）。
    frameBatcherRef.current?.drop();
    // 同 switchSession：清掉可能已排定的重连计时器，避免旧连线的 onerror
    // 排的 scheduleReconnect 之后拿新 sessionIdRef 去重开一条多余的连线。
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    backoffRef.current = INITIAL_BACKOFF_MS;
    dispatch({ type: "reset" });
    // 09-12 建号权收归 send：开新=回空态，本地指向与 localStorage 存档一并清。
    // 不清必成陷阱：mount 的「同次访问静默续接」与跨访问的「继续上次」二选一
    // 都会把用户刚抛弃的旧对话凭空复活（旧设计靠新会话首个事件覆写存档，
    // lazy 世界里开新后可能根本不再 send，存档就永远搁著发霉）。
    clearPersisted(ownerIdRef.current);
    sessionIdRef.current = null;
    setSessionId(null);
    sessionEpochRef.current += 1; // 旧会话身份作废：飞行中捕获旧 epoch 的 send() 该放弃。
    // 09-12：新会话身份解除中止静默窗，与新生命语义一致（与 switch/resume 对齐）。
    mutedUntilNextSendRef.current = false;
    setResumable(null);
    persistedRef.current = null;
    // 空态放行位：startedRef 放下＝手上没有会话，下一次 send() 的 start()
    // 才能真建号；forceNew 让 start() 不被残留存档的二选一检查拦住。
    startedRef.current = false;
    forceNewRef.current = true;
    return true;
  }, [dispatch]);

  /** D-17：删掉上次的会话并开一个全新会话。 */
  const discardAndStartNew = useCallback(async (): Promise<void> => {
    if (!currentAccountRef.current()) return;
    const owner = ownerIdRef.current;
    const epoch = sessionEpochRef.current;
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
    if (ownerIdRef.current !== owner || sessionEpochRef.current !== epoch) return;
    // 重置到空 state，清掉存档与可续标记。
    clearPersisted(ownerIdRef.current);
    persistedRef.current = null;
    setResumable(null);
    dispatch({ type: "reset" });
    // 清掉旧的连接/重连引用的会话，避免上一份残留在内存里。
    sessionIdRef.current = null;
    setSessionId(null);
    await start();
  }, [start]);

  // 09-12：autoStart 已整块拆除——「开面板即建号」是零消息会话堆积的源头，
  // 建号权收归 send()（空态首发 lazy 建号）。旧 effect 的 toggle 重开静默
  // resume 分支一并退役：重开＝空态，旧会话去历史 dropdown 切回。

  return {
    state: ownerIdRef.current === ownerId ? state : EMPTY_AGENT_CHAT_STATE,
    connection: ownerIdRef.current === ownerId ? connection : "idle",
    sessionId: ownerIdRef.current === ownerId ? sessionId : null,
    error: ownerIdRef.current === ownerId ? error : null,
    start,
    send,
    confirm,
    answerQuestion,
    retry,
    end,
    resumable: ownerIdRef.current === ownerId ? resumable : null,
    resume,
    switchSession,
    startNewSession,
    ensureSession,
    abort,
    aborting,
    startingSession,
    discardAndStartNew,
    dispatchNotice,
  };
}
