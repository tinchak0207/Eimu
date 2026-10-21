/** audio.done 的可选元数据：真歌名 / 封面 / 歌词对齐状态。
 *  全部缺席时事件与改动前逐位元相同（老前端不受影响）；缺哪个不带哪个。 */
export interface AudioDoneMeta {
  title?: string
  cover?: string
  lyric_status?: string
}
export type DenySource = "deny_glob" | "path_gate" | "sandbox_unavailable" | "unknown"

export interface DenyProvenance {
  /** 拒绝成因类别。当前网关此分支只会真正产生 deny_glob（与 unknown）；其余为其他层预留。 */
  source: DenySource
  /** 命中的 deny glob 原文；无明确归因时为 null。 */
  pattern: string | null
  /** 机器可读的结构化理由。 */
  reason: string
  /** 给模型的可操作替代写法；无则 null。 */
  hint: string | null
}
export interface DenyAuditRecord {
  ts: string
  session_id: string
  call_id: string
  tool: string
  operation: string
  source: DenySource
  pattern: string | null
  reason: string
  hint: string | null
}
export interface ShadowedRule {
  rule: string
  kind: "subsumed" | "pathological_breadth"
  /** 遮蔽它的更宽规则（subsumed 时非 null；过宽类为 null）。 */
  shadowedBy: string | null
  reason: string
}
