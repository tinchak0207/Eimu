// S20 接线 3：交付卡（设计文档 §3.9「交付只认 export 产物」）。
//
// 卡片的唯一事实源是 S17 的 deliverablesFromExport（export 节点 + status=done + 非草稿 + 已落盘产物）。
// 本档只做「产物 → 既有 SSE 帧」的映射，零新判定：
//   - mp4 / video/* → video.done（media_kind:"film"）
//   - image/*      → image.done（media_kind:"image"）
//   - 没有公网 url 的产物不发卡（记日志）；json/text 等非影音产物跳过。
// 文本/自然语言节点结构性地不可能产生卡：遍历起点就是 export 节点，模型自述不参与。
// 去重键 nodeId:sha256（进程内 Set，由调用方持有）；同键第二次不再发。
import type { SessionState } from "../types-gateway.ts"
import { deliverablesFromExport } from "./gates.ts"
import type { ProjectGraph } from "./types.ts"

export type DeliveryEmit = (name: string, data: Record<string, unknown>) => void

export interface DeliveryCardOutcome {
  /** 本次新发出的卡片数。 */
  emitted: number
  /** 跳过的产物数（无 url / 非影音）。 */
  skipped: number
}

function isVideoOutput(mime: string, ext: string): boolean {
  return mime === "video/mp4" || mime.startsWith("video/") || ext === ".mp4"
}

/**
 * 从工程图的 export 产物发交付卡。幂等：同 (nodeId, sha256) 只发一次（seen 由调用方跨调用持有）。
 */
export function emitDeliveryCards(
  state: SessionState | undefined,
  graph: Readonly<ProjectGraph>,
  emit: DeliveryEmit,
  seen: Set<string>,
): DeliveryCardOutcome {
  const sessionId = state?.sessionId ?? graph.sessionId
  let emitted = 0
  let skipped = 0
  for (const deliverable of deliverablesFromExport(graph)) {
    const { nodeId, output } = deliverable
    const url = typeof output.url === "string" ? output.url.trim() : ""
    if (!url) {
      skipped += 1
      console.warn(`[gateway] delivery card skipped: export ${nodeId}/${output.artifactId} 没有公网 url — session=${sessionId}`)
      continue
    }
    const mime = String(output.mime ?? "").toLowerCase()
    const ext = String(output.path ?? "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? ""
    const kind = mime.startsWith("image/") ? "image" : isVideoOutput(mime, ext) ? "video" : null
    if (!kind) {
      skipped += 1
      console.warn(`[gateway] delivery card skipped: export ${nodeId}/${output.artifactId} 不是影音产物（${mime || "unknown"}）— session=${sessionId}`)
      continue
    }
    const key = `${nodeId}:${output.sha256}`
    if (seen.has(key)) continue
    seen.add(key)
    if (kind === "video") emit("video.done", { url, cost_coins: 0, task_id: nodeId, media_kind: "film" })
    else emit("image.done", { url, cost_coins: 0, task_id: nodeId, media_kind: "image" })
    emitted += 1
  }
  return { emitted, skipped }
}
