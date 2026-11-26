import type { ThinkingLevel } from './types'

/**
 * 输入卡类型定义。字段谱系＝网页版 src/components/agent-chat/AgentComposer.types.ts，
 * 平台差异（白名单）：
 *   - 网页 `File` / Object URL → 小程序临时文件路径（Taro.chooseMedia 的 tempFilePath）；
 *   - 网页抽帧态 `extracting` / `frames` / `progress` → 小程序没有本机抽帧与 XHR 进度，
 *     只保留 uploading/ready/error 三态（不假造进度数字）。
 */

/** 小程序选中的本地媒体（Taro.chooseMedia 结果的规范化副本）。 */
export interface MiniPickedFile {
  /** 本地临时路径（Taro.chooseMedia tempFilePath）；上传时作为 filePath。 */
  path: string
  /** 展示与上传用的文件名（由临时路径 basename 推导）。 */
  name: string
  size: number
  mime: string
}

/** 网道附件 ref（形状照 src/lib/agent-chat-types/types-core.ts:53-62）。 */
export interface AgentAttachmentRef {
  kind: 'image' | 'video' | 'document'
  path?: string
  name?: string
  mime?: string
  size?: number
}

export type PendingAttachmentStatus = 'uploading' | 'ready' | 'error'

/** 待发送附件 chip。 */
export interface PendingAttachment {
  id: string
  fileName: string
  status: PendingAttachmentStatus
  errorMessage?: string
  /** 上传成功后的 ref，送出时写进 [附件] 区块。 */
  refs?: AgentAttachmentRef[]
  /** 本机临时路径（预览用；送出/移除后由小程序自行回收，无需 revoke URL）。 */
  localPath?: string
  /** 已取消/移除的令牌：晚到的上传结果据此丢弃，不写回已消失的 chip。 */
  cancel?: { aborted: boolean }
  /** 原始媒体引用：错误/取消后「重试」原样重送，不必重新选图。 */
  file?: MiniPickedFile
}

/**
 * 输入卡 props。前 10 项与网页版（及旧小程序版）逐项一致——AgentChatPanel 的
 * 现有调用方不需要改动；后 4 项是可选增强，不传时自动退化（见各注释）。
 */
export interface AgentComposerProps {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  onStop: () => void
  turnActive: boolean
  sending: boolean
  stopPending?: boolean
  disabled?: boolean
  thinkingLevel: ThinkingLevel
  onThinkingLevelChange: (level: ThinkingLevel) => void

  /** 上传附件所需会话 id；缺省＋无 onEnsureSession 时附件入口落诚实错误 chip。 */
  sessionId?: string | null
  /** 空态选图时的 lazy 建号入口；回传可用 sid 或 null。 */
  onEnsureSession?: () => Promise<string | null>
  /**
   * 直接送出最终文本（含 [附件] 区块）。缺省时走 onChange(finalText) → onSend()
   * 桥（父层 draft 受控，React 18 离散事件同步刷新后再发）。返回值可为 Promise：
   * 结算即解锁送出钮。
   */
  onSendText?: (text: string) => void | Promise<void>
  /** 外部在途镜像；缺省沿用 sending（与网页 externalSendPending 同语义）。 */
  externalSendPending?: boolean
}
