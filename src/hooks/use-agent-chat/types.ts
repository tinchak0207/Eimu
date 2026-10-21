import type { AgentChatState, AgentSseEvent } from "@/lib/agent-chat-types";

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
export type ResumableAgentChat = UseAgentChatResumable;

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
