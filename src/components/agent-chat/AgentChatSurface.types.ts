import type { MutableRefObject } from "react";
import type { ReflectedParams } from "@/lib/agent-param-reflect";

export interface AgentChatSurfaceProps {
  /** page = 独立路由页；inline = 从卡片入口进来的内嵌聊天区（D-1）。 */
  variant?: "page" | "inline";
  /** 嵌入态（工作站面板）：外层已有拖拽把手与容器，Surface 不再自带把手，
      边距收紧——单层容器，不留二次 padding。 */
  embedded?: boolean;
  /**
   * 入口按下那一刻输入框里已经打好的半句话（D-24「承接使用者已打的半句话」）。
   * 不自动送出：半句话直接送出去可能立刻触发扣费，与 D-5「花钱前必定交用户确认」
   * 冲突。这里呈现成一颗可点的续写药丸，点一下才进对话。
   */
  initialPrompt?: string;
  /**
   * 会话深链（wish 插件 ?agent=1&session=<uuid>）：入口变化时恢复该会话。
   * 09-12：autoStart 已撤（建号权在发送按钮），挂载本来即空态不建号——这里
   * 只是把落点从「空态」换成 switchSession 目标会话；
   * 目标不存在/已被回收时保留当前会话，由 switchSession 显示失败原因。
   */
  initialSessionId?: string;
  /** inline 变体的退出去向（回工作台）。page 变体不用。 */
  onExit?: () => void;
  /** 2026-08-22：工作站态把「收合成细栏」按钮并入这里的图标组——
      面板不再自长一条顶栏，触发前后是同一个 header。 */
  headerExtra?: import("react").ReactNode;
  /**
   * D-12：助理实际用过的参数回流给工作台控件。
   * 只在内嵌变体有意义（独立页背后没有控件可回填），缺席就不回流。
   * 当前控件上的模型要一起传进来——比例/解析度的合法集合取决于模型。
   */
  onParamsReflected?: (params: ReflectedParams) => void;
  currentModelId?: string;
  /**
   * 每次 agent 产出新图时回调，把 URL 推进右侧 ImageDisplay。
   * 不只是聊天区显示——右侧不更新等于没有。
   */
  onImageResult?: (url: string) => void;
  /** 画布 SSE 事件分流（v3 embed）：canvas.* 事件转交右侧 CanvasEmbed。 */
  onCanvasEvent?: (event: import("@/lib/agent-chat-types").AgentSseEvent) => void;
  /** 发送前提供画布摘要（v3 embed）。 */
  canvasStateProvider?: () => unknown;
  /** 当 agent session 变化时通知父组件（用于同步清空画布）。 */
  onSessionChange?: (sessionId: string | null) => void;
  /**
   * 双向同步：把 switchSession 能力上抛给父层。画布选中某个带
   * session_id 的 workflow 节点时，父层要能切到该节点所属的会话——
   * 这条通道就是那根把手（画布 → chat 方向唯一入口）。
   */
  switchSessionRef?: MutableRefObject<((sessionId: string) => Promise<boolean>) | null>;
  /** 暴君裁定 2026-09-01：套模板需要「留旧开新」；父层传 ref 上抛 startNewSession。 */
  startNewSessionRef?: MutableRefObject<(() => Promise<boolean>) | null>;
  /**
   * 2026-08-25 模板库点卡：要自动发出的第一条用户消息（模板 initialPrompt）。
   * 与 initialPrompt（半句话药丸，点了才送）不同：点模板卡本身就是发送动作，
   * 这条直接送出，不让用户再点一次发送。nonce 变化即触发一次。
   *
   * echo（2026-09-27）：这条讯息要不要当成「使用者自己说的话」进 transcript。
   * 模板注入＝一长串机器配方，默认不进（silent）；但宣传片结尾那句是使用者自己
   * 打的，必须进——不然送出后到他看到第一个字之前是一片空白（暴君：TTFT 前空白）。
   */
  agentInjection?: { text: string; nonce: number; directive?: string; echo?: boolean } | null;
  /** 用户发出消息时回调（上层收起右侧模板库）。 */
  onUserMessage?: () => void;
  /**
   * 一句话因为「没登入」送不出去时上抛（上层留住，登入后补送）。
   * 详见 use-agent-chat 的 UseAgentChatOptions.onSendBlockedByAuth。
   */
  onSendBlockedByAuth?: (text: string) => void;
  /**
   * 外部「把这句话预填进输入框」（新人礼首登弹窗的主按钮）。只搬运不发送——
   * 半句话直接送出去会立刻开一轮扣费生成（D-5），所以走与 D-24 药丸同一条
   * prefill 通路：输入框有字、光标在末尾、焦点在框上，人再按送出。
   * 只认 nonce 变化，输入区吃掉后不重播（见下面的 effect）。
   */
  prefillRequest?: { text: string; nonce: number } | null;
}
