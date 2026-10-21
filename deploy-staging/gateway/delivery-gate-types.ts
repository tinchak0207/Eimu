/** 单一 Expert 的交付契约（与 src/lib/expert-registry.ts deliverableContract 同形）。 */
export interface ExpertDeliveryContract {
  requiredFields: string[]
  qcSignatureRequired: boolean
}

export type DeliveryContracts = Record<string, ExpertDeliveryContract>

export interface DeliveryGateResult {
  /** true = 无契约可判 / 契约栏位齐；false = 有契约且缺栏位。 */
  ok: boolean
  /** 合同栏位中「在交付文本里找不到栏位名」的那些（已去重、保持契约顺序）。 */
  missing: string[]
  /** 人话理由（仅 ok:false 时给）。 */
  reason?: string
}

export interface ArtifactVerifyRecord {
  name: string
  verify_status?: string | null
  url?: string | null
  /** 仅无 URL 且当前安全读取的 hash/bytes 与登记值一致时为 true。 */
  local_available?: boolean
}

/** 被审交付（由 subagent.ts finishRun 在 Expert 终态时登记）。 */
export interface CriticPassTarget {
  /** 被审 Expert id（DELIVERY_CONTRACTS 域内；critic 自身永不入列）。 */
  agent: string
  label: string
  runId: string
  /** 交付正文（finishRun 手上就是未截断全文）。 */
  text: string
  /** Captured from this author's actual successful output receipts, not authored prose. */
  artifacts?: string[]
  /** Actual generation input / server workflow parameters, never the author's review prose. */
  mediaIntent?: Array<{ artifact: string; prompt?: string; camera?: unknown; durationSeconds?: number; sourceCallId?: string }>
  workflowReview?: { workflowId: string; nodeId: string; artifact: string }
  onReview?: (result: { state: "passed" | "failed" | "partial"; criticRunId: string; receipt: unknown }) => void
}

/**
 * 触发判据输入（全部为真才触发；纯函数便于四态单测）。
 * 语义钉死：任一为假 → 回 false，呼叫端零动作（零回归）。
 */
export interface CriticPassInput {
  /** 父会话 beast_mode（MOE Expert 链的前提）。 */
  beastMode: boolean
  /** 待审份数（本窗口内契约域内已完成、且尚未送审的 Expert 交付）。 */
  expertDeliveries: number
  /**
   * 其中带**真实成品证据**（交付正文含真实媒体 URL）的份数（2026-10-04 F3-B）。
   * 缺省 undefined ＝ 呼叫端未提供（退回旧行为）；提供时须 >0 才可能触发——
   * probe／报告类交付（无成品 URL）一律不进入成品契约内审。
   */
  deliverableEvidence?: number
  /** 本轮是否已有 critic 派遣（含在途）。 */
  criticDispatched: boolean
  /** 最终文本是否自行声明「未经独立审核」。 */
  unreviewedDeclared: boolean
  /** 该会话是否已用过本 pass（持久旗标，每会话 ≤1 次）。 */
  alreadyPassed: boolean
}

export type ReviewClass = "review" | "scaffold" | "clean"
