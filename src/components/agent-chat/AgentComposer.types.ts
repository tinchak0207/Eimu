import type { MutableRefObject } from "react";
import type { AgentAttachmentRef } from "@/lib/agent-chat-types";

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
   * 生效」，由网关 steer.status 帧决定，落在用户气泡的徽章上。这里只负责让
   * 按钮不冒充停止。缺省 false = 渲染与不传时逐位元一致。
   */
  steerActive?: boolean;
  /**
   * 外部（面板）在途：这条送出还没落地，或本轮还没真正开始——空态首发要先建号
   * 铸票，网关还要把 prompt 送进 opencode 才回 ack（实测 10–15s）。
   *
   * 为真时送出钮位置立刻进入在途态：转圈、不可再点，输入框空白时也一样是转圈
   * 送出钮（不是 disabled 灰钮），并且压过「输入框空 → 停止钮」那条替换语义。
   * 「本轮尚未开始」的单一真相源在 AgentChatPanel（它同时知道 turnActive 与
   * onSend 的 promise），这里只负责渲染，不自己猜。缺省 false = 行为与不传时
   * 逐位元一致。
   */
  externalSendPending?: boolean;
  /**
   * 可选介面（2026-10-03）：把「把档案加进附件列」的既有入口（enqueueFiles，
   * 拖拽／贴上／选档三条入口共用的同一条管道）注册给外部呼叫。只暴露、不改入队
   * 逻辑（多档逐个处理、lazy 建号、状态机都在既有函式里）。不传＝行为逐位元不变。
   */
  attachFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
}

type PendingAttachmentStatus = "extracting" | "uploading" | "ready" | "error";

export interface PendingAttachment {
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
  /** 影片专用：关键帧缩图的 Object URL 与时间点文案（本机 ingest 或降级抽帧皆会填）。 */
  frames?: { url: string; label: string }[];
  /** 抽帧进度（0…FRAME_COUNT），仅 extracting 期间有意义。 */
  framesDone?: number;
  /**
   * 上行真实进度（0…1，来自 XHR upload.onprogress），仅 uploading 期间有意义。
   * undefined＝尚无可信真值（如本机 ingest 阶段），此时不假造百分比。
   */
  progress?: number;
  /**
   * 原始 File 引用：错误／取消后「重试」要能原样重送，不必使用者重新选档。
   * 只在 chip 生命周期内持有，不序列化、不进 [附件] 区块。
   */
  file?: File;
}
